// This implements the interface from the 'bonjour' npm package using the
// avahi-browse command. Not all features are implemented.

import * as dbus from 'dbus-next';
import * as events from 'events';

import * as dnssd from '../dnssd';

const PROTO_INET = 0;
const PROTO_INET6 = 1;
const IF_UNSPEC = -1;

interface Server extends dbus.ClientInterface {
    GetVersionString(): Promise<string>;
    GetAPIVersion(): Promise<number>;
    GetHostName(): Promise<string>;
    SetHostName(name: string): Promise<void>;
    GetHostNameFqdn(): Promise<string>;
    GetDomainName(): Promise<string>;
    IsNSSSupportAvailable(): Promise<boolean>;
    GetState(): Promise<number>;
    on(event: 'StateChanged', listener: (state: number, error: string) => void): this;
    GetLocalServiceCookie(): Promise<number>;
    GetAlternativeHostName(name: string): Promise<string>;
    GetAlternativeServiceName(name: string): Promise<string>;
    GetNetworkInterfaceNameByIndex(index: number): Promise<string>;
    GetNetworkInterfaceIndexByName(name: string): Promise<number>;
    ResolveHostName(iface: number, protocol: number, name: string, aprotocol: number, flags: number): Promise<Parameters<(err: any, iface: number, protocol: number, name: string, aprotocol: number, flags: number) => void>>;
    ResolveAddress(iface: number, protocol: number, address: string, flags: number): Promise<Parameters<(err: any, iface: number, protocol: number, aprotocol: number, address: string, name: string, flags: number) => void>>;
    ResolveService(iface: number, protocol: number, name: string, type: string, domain: string, aprotocol: number, flags: number): Promise<Parameters<(iface: number, protocol: number, name: string, type: string, domain: string, host: string, aprotocol: number, address: string, port: number, txt: Buffer[], flags: number) => void>>;
    EntryGroupNew(): Promise<dbus.ObjectPath>;
    DomainBrowserNew(iface: number, protocol: number, domain: string, btype: number, flags: number): Promise<dbus.ObjectPath>;
    ServiceTypeBrowserNew(iface: number, protocol: number, domain: string, flags: number): Promise<dbus.ObjectPath>;
    ServiceBrowserNew(iface: number, protocol: number, type: string, domain: string, flags: number): Promise<dbus.ObjectPath>;
    ServiceResolverNew(iface: number, protocol: number, name: string, type: string, domain: string, aprotocol: number, flags: number): Promise<dbus.ObjectPath>;
    HostNameResolverNew(iface: number, protocol: number, name: string, aprotocol: number, flags: number): Promise<dbus.ObjectPath>;
    AddressResolverNew(iface: number, protocol: number, address: string, flags: number): Promise<dbus.ObjectPath>;
    RecordBrowserNew(iface: number, protocol: number, name: string, clazz: number, type: number, flags: number): Promise<dbus.ObjectPath>;
}

interface ServiceBrowser extends dbus.ClientInterface {
    Free(): Promise<void>;
    // Can't use signal handlers on proxy due to race condition: https://github.com/lathiat/avahi/issues/9
    // on(event: 'ItemNew', listener: (iface: number, protocol: number, name: string, type: string, domain: string, flags: number) => void): this;
    // on(event: 'ItemRemove', listener: (iface: number, protocol: number, name: string, type: string, domain: string, flags: number) => void): this;
    // on(event: 'Failure', listener: (error: string) => void): this;
    // on(event: 'AllForNow', listener: () => void): this;
    // on(event: 'CacheExhausted', listener: () => void): this;
}

type ServerObject = {
    proxy: dbus.ProxyObject;
    iface: Server;
};

let cachedServer: ServerObject | undefined;

async function getServer(): Promise<ServerObject> {
    if (cachedServer === undefined) {
        const bus = dbus.systemBus();
        // dbus-next will queue messages and wait forever for a connection
        // so we have to hack in a timeout, otherwise we end up with a deadlock
        // on systems without D-Bus.
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(Error("Timeout while connecting to D-Bus"));
            }, 100);
            (bus as any).on('connect', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
        const proxy = await bus.getProxyObject('org.freedesktop.Avahi', '/');
        const iface = proxy.getInterface<Server>('org.freedesktop.Avahi.Server');
        const version = await iface.GetAPIVersion();
        cachedServer = { proxy, iface };
    }

    return cachedServer;
}

export async function getInstance(): Promise<dnssd.Client> {
    const server = await getServer();
    return new AvahiClient(server);
}

class AvahiClient implements dnssd.Client {
    private destroyOps = new Array<() => void>();

    constructor(public readonly server: ServerObject) {
    }

    public createBrowser(options: dnssd.BrowseOptions): Promise<dnssd.Browser> {
        return new Promise((resolve, reject) => {
            const browser = new AvahiBrowser(this, options);
            browser.once('ready', () => {
                browser.removeAllListeners('error');
                resolve(browser);
            });
            browser.once('error', err => {
                browser.removeAllListeners('ready');
                reject(err);
            });
        });
    }

    // interface method implementation
    public destroy(): void {
        this.destroyOps.forEach(op => op());
        this.destroyOps.length = 0;
    }

    /**
     * Adds an operation to be performed when destroy() is called.
     * @param op operation to add
     * @return the op argument
     */
    pushDestroyOp(op: () => void): () => void {
        this.destroyOps.push(op);
        return op;
    }

    /**
     * Removes an operation that was added with pushDestroyOp()
     * @param op the operation to remove
     */
    popDestroyOp(op: () => void): void {
        let i = this.destroyOps.findIndex(v => v === op);
        if (i >= 0) {
            this.destroyOps.splice(i, 1);
        }
    }
}

class AvahiBrowser extends events.EventEmitter implements dnssd.Browser {
    private browser: ServiceBrowser | undefined;
    private readonly services: AvahiService[] = new Array<AvahiService>();
    private readonly bus: dbus.MessageBus;

    constructor(private readonly client: AvahiClient, private options: dnssd.BrowseOptions) {
        super();
        // Due to race condition: https://github.com/lathiat/avahi/issues/9
        // we have to add signal listeners now before creating browser objects
        // otherwise we miss signals.
        this.bus = client.server.proxy.bus;
        (this.bus as any).on('message', (msg: dbus.Message) => {
            if (msg.type !== dbus.MessageType.SIGNAL) {
                return;
            }
            if (msg.interface !== 'org.freedesktop.Avahi.ServiceBrowser') {
                return;
            }
            // TODO: should also check msg.path, but we can receive messages
            // before ServiceBrowserNew() returns when we don't know the path
            // yet.
            switch (msg.member) {
                case 'ItemNew': {
                    const [iface, protocol, name, type, domain, flags] = msg.body;
                    client.server.iface.ResolveService(iface, protocol, name, type, domain, protocol, 0).then(
                        ([iface, protocol, name, type, domain, host, aprotocol, addr, port, txt, flags]) => {
                            const service = new AvahiService(iface, protocol, name, type, domain, host, aprotocol, addr, port, txt, flags);
                            this.services.push(service);
                            this.emit('added', service);
                        });
                }
                    break;
                case 'ItemRemove': {
                    const [iface, protocol, name, type, domain, flags] = msg.body;
                    const i = this.services.findIndex(s => s.match(iface, protocol, name, type, domain));
                    if (i >= 0) {
                        const [service] = this.services.splice(i, 1);
                        this.emit('removed', service);
                    }
                }
                    break;
                case 'Failure': {
                    const [error] = msg.body;
                    this.emit('error', new Error(error));
                }
                    break;
            }
        });
        const addMatchMessage = new dbus.Message({
            destination: 'org.freedesktop.DBus',
            path: '/org/freedesktop/DBus',
            interface: 'org.freedesktop.DBus',
            member: 'AddMatch',
            signature: 's',
            body: [`type='signal',sender='org.freedesktop.Avahi',interface='org.freedesktop.Avahi.ServiceBrowser'`]
        });
        this.bus.call(addMatchMessage).then(() => this.emit('ready')).catch((err) => this.emit('error', err));
    }

    public async start(): Promise<void> {
        const proto = this.options.ipv === 'IPv6' ? PROTO_INET6 : PROTO_INET;
        const type = `_${this.options.service}._${this.options.transport || 'tcp'}`;
        const objPath = await this.client.server.iface.ServiceBrowserNew(IF_UNSPEC, proto, type, '', 0);
        const proxy = await this.bus.getProxyObject('org.freedesktop.Avahi', objPath);
        this.browser = proxy.getInterface<ServiceBrowser>('org.freedesktop.Avahi.ServiceBrowser');
    }

    public async stop(): Promise<void> {
        await this.browser?.Free();
        this.browser = undefined;
    }

    destroy(): void {
        this.removeAllListeners();
        this.stop();
    }

}

class AvahiService implements dnssd.Service {
    public readonly service: string;
    public readonly transport: 'tcp' | 'udp';
    public readonly ipv: 'IPv4' | 'IPv6';
    public readonly txt: dnssd.TxtRecords;

    constructor(
        public readonly iface: number,
        private readonly protocol: number,
        public readonly name: string,
        private readonly type: string,
        public readonly domain: string,
        public readonly host: string,
        aprotocol: number,
        public readonly address: string,
        public readonly port: number,
        txt: Buffer[],
        flags: number) {
        const [service, transport] = type.split('.');
        // remove leading '_'
        this.service = service.slice(1);
        this.transport = <'tcp' | 'udp'>transport.slice(1);
        this.ipv = protocol === PROTO_INET6 ? 'IPv6' : 'IPv4';
        this.txt = AvahiService.parseText(txt);
    }

    match(iface: number, protocol: number, name: string, type: string, domain: string): boolean {
        return this.iface === iface && this.protocol === protocol &&
            this.name === name && this.type === type && this.domain === domain;
    }

    private static parseText(txt?: Buffer[]): dnssd.TxtRecords {
        const result = <dnssd.TxtRecords>new Object();
        if (txt) {
            txt.forEach(v => {
                // dbus-next is supposed to treat array of bytes as buffer but
                // it currently treats it as a regular array of numbers.
                if (!(v instanceof Buffer)) {
                    v = Buffer.from(v);
                }
                const [key, value] = v.toString().split(/=/);
                result[key] = value;
            });
        }
        return result;
    }
}
