// This implements the interface from the 'bonjour' npm package using the
// dns-sd command. Not all features are implemented.

import * as events from 'events';

import * as dns from './dnssd-client';
import * as dnssd from '../dnssd';

export function isPresent(): boolean {
    return dns.checkDaemonRunning();
}

export function getInstance(): dnssd.Client {
    return new DnssdClient();
}

class DnssdClient implements dnssd.Client {
    private destroyOps = new Array<() => void>();

    // interface method implementation
    public browse(options: dnssd.BrowseOptions): Promise<dnssd.Browser> {
        return new Promise((resolve, reject) => {
            const browser = new DnssdBrowser(this, options);
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
        let i = this.destroyOps.findIndex(v => v == op);
        if (i >= 0) {
            this.destroyOps.splice(i, 1);
        }
    }
}

class DnssdBrowser extends events.EventEmitter implements dnssd.Browser {
    private running: boolean;
    private service: dns.Service;
    private destroyOp: () => void;
    readonly services: DnssdService[] = new Array<DnssdService>();

    constructor(private dnssd: DnssdClient, private options: dnssd.BrowseOptions) {
        super();
        this.destroyOp = this.dnssd.pushDestroyOp(() => this.destroy());

        const regType = `_${this.options.service}._${this.options.transport || 'tcp'}`;
        const domain = ''; // TODO: is this part of options?

        dns.Service.browse(0, 0, regType, domain, async (s, f, i, e, n, t, d) => {
            if (e) {
                this.emit('error', new dns.ServiceError(e, 'Error while browsing.'));
                return;
            }
            if (f & dns.ServiceFlags.Add) {
                const resolveService = await s.resolve(f, i, n, t, d, (s, f, i, e, n, h, p, txt) => {
                    if (e) {
                        this.emit('error', new dns.ServiceError(e, 'Resolving service failed.'));
                        return;
                    }
                    const service = new DnssdService(i, n, t, d, h, p, txt);
                    this.services.push(service);
                    this.emit('added', service);
                });
                await resolveService.processResult();
                resolveService.destroy();
            }
            else {
                const i = this.services.findIndex(s => s.match(i, n, t, d));
                if (i >= 0) {
                    const [service] = this.services.splice(i, 1);
                    this.emit('removed', service);
                }
            }
        }).then(async service => {
            this.service = service;
            this.running = true;
            this.emit('ready');
            while (this.running) {
                await service.processResult();
            }
        }).catch(err => {
            this.emit('error', err);
        });
    }

    destroy(): void {
        this.dnssd.popDestroyOp(this.destroyOp);
        this.running = false;
        if (this.service) {
            this.service.destroy();
            this.service = undefined;
        }
    }
}

class DnssdService extends events.EventEmitter implements dnssd.Service {
    public readonly service: string;
    public readonly transport: 'tcp' | 'udp';
    public readonly ipv: 'IPv4' | 'IPv6';
    public readonly address: string;
    public readonly txt: dnssd.TxtRecords;

    constructor(
        private readonly iface: number,
        public readonly name: string,
        private readonly type: string,
        public readonly domain: string,
        public readonly host: string,
        public readonly port: number,
        txt: string[])
    {
        super();
        const [service, transport] = type.split('.');
        // remove leading '_'
        this.service = service.slice(1);
        this.transport = <'tcp' | 'udp'> transport.slice(1);
        this.txt = DnssdService.parseText(txt);
    }

    match(iface: number, name: string, type: string, domain: string): boolean {
        return this.iface == iface && this.name == name && this.type == type && this.domain == domain;
    }

    private static parseText(txt: string[]): dnssd.TxtRecords {
        const result = <dnssd.TxtRecords> new Object();
        if (!txt) {
            return result;
        }

        txt.forEach(v => {
            const [key, value] = v.split(/=/);
            result[key] = value;
        });

        return result;
    }
}
