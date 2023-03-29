
import bonjour from 'bonjour';
import * as events from 'events';
import * as os from 'os';

import * as dnssd from '../dnssd';

export function getInstance(): dnssd.Client {
    return new BonjourClient();
}

class BonjourClient extends events.EventEmitter implements dnssd.Client {
    private readonly bClients: { [ifaceAddress: string]: bonjour.Bonjour } = {};
    private readonly ifaceAddresses = new Array<string>();
    private readonly ifaceTimer = setInterval(() => this.updateInterfaces(), 500);

    forEachClient(func: (bClient: bonjour.Bonjour) => void) {
        for (const a in this.bClients) {
            func(this.bClients[a]);
        }
    }

    public createBrowser(opts: dnssd.BrowseOptions): Promise<dnssd.Browser> {
        const browser = new BonjourBrowser(this, opts);
        return Promise.resolve(browser);
    }

    public destroy(): void {
        clearInterval(this.ifaceTimer);
        for (const a in this.bClients) {
            this.destroyClient(a);
        }
        this.removeAllListeners();
    }

    // The bonjour package doesn't seem to be able to handle broadcasting and
    // receiving on all interfaces. So, we are monitoring network interfaces
    // ourselves and creating a bonjour.Bonjour instance for each network
    // interface (actually, each address of each interface, which could be
    // more than one).
    private updateInterfaces() {
        type Address = { iface: number, address: string };
        const newAddresses = new Array<Address>();
        const ifaces = os.networkInterfaces();
        for (let i in ifaces) {
            // on Windows, only the local link address has a scopeid that matches
            // the index of the network interface.
            const localLinkAddr = ifaces[i].find(v => v.address.startsWith('fe80:'));
            if (!localLinkAddr) {
                continue;
            }
            const ifaceIndex = (<os.NetworkInterfaceInfoIPv6>localLinkAddr).scopeid;

            // only supporting IPv6 for now
            const addresses = ifaces[i].filter(v => v.internal === false && v.family === 'IPv6').map(v =>
                `${v.address}%${process.platform === 'win32' ? (<os.NetworkInterfaceInfoIPv6>v).scopeid : i}`);
            newAddresses.push(...addresses.map(v => <Address>{ iface: ifaceIndex, address: v }));
        }
        const added = newAddresses.filter(a => this.ifaceAddresses.indexOf(a.address) === -1);
        const removed = this.ifaceAddresses.filter(a => newAddresses.findIndex(v => v.address === a) === -1);
        if (added.length) {
            for (const a of added) {
                this.ifaceAddresses.push(a.address);
                this.createClient(a.iface, a.address);
            }
        }
        if (removed.length) {
            const indexes = removed.map(a => this.ifaceAddresses.indexOf(a));
            indexes.forEach(i => {
                const [a] = this.ifaceAddresses.splice(i, 1);
                this.destroyClient(a);
            }, this);
        }
    }

    /**
     * Asynchronously create an new bonjour.Bonjour client object
     * @param ifaceIndex the index of the network interface
     * @param ifaceAddress the IP address
     */
    private createClient(ifaceIndex: number, ifaceAddress: string): void {
        // On Windows, we need the full IP address as part of the multicast socket
        // interface or things don't work right. On Linux, we have to strip the
        // IP address or things don't work right.
        const iface = (os.platform() === 'win32') ? ifaceAddress : ifaceAddress.replace(/.*%/, '::%');

        // work around bonjour issue where error is not handled
        new Promise<bonjour.Bonjour>((resolve, reject) => {
            const bClient = bonjour(<any>{
                type: 'udp6',
                ip: 'ff02::fb',
                interface: iface,
            });
            (<any>bClient)['iface'] = ifaceIndex;
            (<any>bClient)._server.mdns.on('ready', () => resolve(bClient));
            (<any>bClient)._server.mdns.on('error', (err: any) => reject(err));
        }).then(bClient => {
            if (this.ifaceAddresses.indexOf(ifaceAddress) < 0) {
                // iface was removed while we were waiting for promise
                bClient.destroy();
                return;
            }
            this.bClients[ifaceAddress] = bClient;
            this.emit('clientAdded', bClient);
        }).catch(err => {
            if (err.code === 'EADDRNOTAVAIL') {
                // when a new network interface first comes up, we can get this
                // error when we try to bind to the socket, so keep trying until
                // we are bound or the interface goes away.
                setTimeout(() => {
                    if (this.ifaceAddresses.indexOf(ifaceAddress) >= 0) {
                        this.createClient(ifaceIndex, ifaceAddress);
                    }
                }, 500);
            }
            // FIXME: other errors are currently ignored
        });
    }

    /**
     * Destroys the bonjour.Bonjour client associated with ifaceAddress
     * @param ifaceAddress the IP address
     */
    private destroyClient(ifaceAddress: string): void {
        const bClient = this.bClients[ifaceAddress];
        delete this.bClients[ifaceAddress];
        this.emit('clientRemoved', bClient);
        bClient.destroy();
    }
}

/** Per-client browser object. */
type ClientBrowser = {
    /** Bonjour client associated with specific network interface and address. */
    bClient: bonjour.Bonjour,
    /** Bonjour browser for the Bonjour client. */
    browser: bonjour.Browser,
    /** Services discovered by the browser. */
    services: BonjourService[],
    /** Update timer - undefined if not started. */
    updateInterval?: NodeJS.Timer,
};

class BonjourBrowser extends events.EventEmitter implements dnssd.Browser {
    private started = false;
    private readonly browsers = new Array<ClientBrowser>();

    constructor(private readonly client: BonjourClient, private readonly opts: dnssd.BrowseOptions) {
        super();
        this.addBrowser = this.addBrowser.bind(this);
        this.removeBrowser = this.removeBrowser.bind(this);
        client.on('clientAdded', this.addBrowser);
        client.on('clientRemoved', this.removeBrowser);
        client.forEachClient(c => this.addBrowser(c));
    }

    public async start(): Promise<void> {
        for (const b of this.browsers) {
            this.startClientBrowser(b);
        }
        this.started = true;
    }

    public async stop(): Promise<void> {
        for (const b of this.browsers) {
            this.stopClientBrowser(b);
        }
        this.started = false;
    }

    public destroy(): void {
        this.removeAllListeners();
        this.client.off('clientAdded', this.addBrowser);
        this.client.off('clientRemoved', this.removeBrowser);
        this.stop();
    }

    private addBrowser(bClient: bonjour.Bonjour) {
        const browser = bClient.find({
            type: this.opts.service,
            protocol: this.opts.transport,
        });
        const services = new Array<BonjourService>();
        browser.on('up', s => {
            (<any>s)['iface'] = (<any>bClient)['iface'];
            for (const b of this.browsers) {
                for (const bs of b.services) {
                    const bss = bs.bService;
                    if ((<any>s)['iface'] === (<any>bss)['iface'] && s.name === bs.name && s.type === bss.type && s.fqdn === bss.fqdn.replace(/\.$/, '')) {
                        // ignore duplicates
                        return;
                    }
                }
            }
            const service = new BonjourService(s);
            services.push(service);
            this.emit('added', service, false);
        });
        browser.on('down', s => {
            const index = services.findIndex(v => v.bService === s);
            const [service] = services.splice(index, 1);
            this.emit('removed', service, false);
        });
        const clientBrowser = { bClient: bClient, browser: browser, services: services };
        this.browsers.push(clientBrowser);

        // If a new client is added after we have already started browsing, we need
        // to start that browser as well.
        if (this.started) {
            this.startClientBrowser(clientBrowser);
        }
    }

    private removeBrowser(bClient: bonjour.Bonjour): void {
        const i = this.browsers.findIndex(v => v.bClient === bClient);
        const [removed] = this.browsers.splice(i, 1);
        this.stopClientBrowser(removed);
        for (const s of removed.services) {
            this.emit('removed', s);
        }
    }

    private startClientBrowser(clientBrowser: ClientBrowser): void {
        clientBrowser.browser.start();
        clientBrowser.updateInterval = setInterval(() => {
            // poll again every 1 second
            clientBrowser.browser.update();
        }, 1000);
    }

    private stopClientBrowser(clientBrowser: ClientBrowser): void {
        if (clientBrowser.updateInterval) {
            clearInterval(clientBrowser.updateInterval);
            clientBrowser.browser.stop();
        }
    }
}

class BonjourService implements dnssd.Service {
    public readonly name: string;
    public readonly service: string;
    public readonly transport: 'tcp' | 'udp';
    public readonly iface: number;
    public readonly host: string;
    public readonly domain: string;
    public readonly ipv: 'IPv4' | 'IPv6';
    public readonly address: string;
    public readonly port: number;
    public readonly txt: dnssd.TxtRecords;

    constructor(public readonly bService: bonjour.Service) {
        this.name = bService.name;
        this.service = bService.type;
        this.transport = <'tcp' | 'udp'>bService.protocol;
        this.iface = (<any>bService)['iface'];
        this.host = bService.host;
        this.domain = (<any>bService).domain;
        this.ipv = 'IPv6';
        this.address = (<any>bService).addresses[0]; // FIXME
        this.port = bService.port;
        this.txt = <dnssd.TxtRecords>bService.txt;
    }
}
