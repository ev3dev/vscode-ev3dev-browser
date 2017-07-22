// This implements the interface from the 'bonjour' npm package using the
// dns-sd command. Not all features are implemented.

import * as bonjour from 'bonjour';
import * as bonjour2 from '../bonjour';
import * as dns from './dnssd-client';
import * as events from 'events';
import * as vscode from 'vscode';

export function isPresent(): boolean {
    return dns.checkDaemonRunning();
}

export function getInstance(): bonjour2.Bonjour {
    return new DnsSd();
}

class DnsSd implements bonjour2.Bonjour {
    private destroyOps = new Array<() => void>();

    // interface method implementation
    public find(options: bonjour.BrowserOptions, onUp?: (service: bonjour.Service) => void): bonjour.Browser {
        const browser = new DnsSdBrowser(this, options);
        if (onUp) {
            browser.on('up', onUp);
        }
        return browser;
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

class DnsSdBrowser extends events.EventEmitter implements bonjour.Browser {
    private running: boolean;
    private service: dns.Service;
    private destroyOp: () => void;
    readonly services: bonjour.Service[] = new Array<bonjour.Service>();

    constructor(private dnssd: DnsSd, private options: bonjour.BrowserOptions) {
        super();
    }

    start(): void {
        if (this.destroyOp) {
            throw 'Already started';
        }
        this.destroyOp = this.dnssd.pushDestroyOp(() => this.stop());

        const regType = `_${this.options.type}._${this.options.protocol || 'tcp'}`;
        const domain = ''; // TODO: is this part of options?

        dns.Service.browse(0, 0, regType, domain, async (s, f, i, e, n, t, d) => {
            if (e) {
                vscode.window.showErrorMessage(`Error while browsing services: ${e}`);
                return;
            }
            const service = this.getOrCreateService(n, t, d);
            // the native js bonjour does not consider iface variations as separate
            // services, so we have to do some funny things to get them grouped together
            service.pushPending(`${i}`);
            if (f & dns.ServiceFlags.Add) {
                const resolveService = await s.resolve(f, i, n, t, d, (s, f, i, e, n, h, p, t) => {
                    if (e) {
                        vscode.window.showErrorMessage(`Error while resolving service: ${e}`);
                        return;
                    }
                    service.host = h.replace(/\.$/, '');
                    service.port = p;
                    service.txt = DnsSdBrowser.parseText(t);
                    // don't emit the 'up' event until we are sure we are completely resolved
                    if (service.popPending(`${i}`)) {
                        this.emit('up', service);
                    }
                });
                await resolveService.processResult();
                resolveService.destroy();
            }
            else {
                const i = this.services.findIndex(s => s.fqdn == `${n}.${t}${d}`);
                if (i >= 0) {
                    const [service] = this.services.splice(i, 1);
                    this.emit('down', service);
                }
            }
        }).then(async service => {
            this.service = service;
            this.running = true;
            while (this.running) {
                await service.processResult();
            }
        }).catch(err => {
            vscode.window.showErrorMessage(`Failed to browse mDnsResponder: ${err.message}`);
        });
    }

    update(): void {
        throw 'Not implemented';
    }

    stop(): void {
        if (!this.destroyOp) {
            throw 'Not started';
        }
        this.dnssd.popDestroyOp(this.destroyOp);
        this.running = false;
        if (this.service) {
            this.service.destroy();
            this.service = undefined;
        }
    }

    private getOrCreateService(name: string, type: string, domain: string): DnsSdService {
        let service = <DnsSdService> this.services.find(s => s.fqdn == `${name}.${type}${domain}`);
        if (service) {
            return service;
        }

        service = new DnsSdService(name, type, domain);
        this.services.push(service);
        return service;
    }

    private static parseText(txt: string[]): Object {
        const result = new Object();
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

class DnsSdService extends events.EventEmitter implements bonjour.Service {
    private pending: string[] = new Array<string>();
    public addresses: string[] = new Array<string>();
    public subtypes: string[];
    public protocol: string;
    public host: string;
    public port: number;
    public fqdn: string;
    public txt: Object;
    public published: boolean;

    constructor(
        public name: string,
        public type: string,
        public domain: string) {
            super();
            this.fqdn = `${name}.${type}${domain}`;
            [this.type, this.protocol] = type.split('.');
            // remove leading '_'
            this.type = this.type.slice(1);
            this.protocol = this.protocol.slice(1);
        }

    stop(cb: () => any): void {
        throw 'Not implemented';
    }

    start(): void {
        throw 'Not implemented';
    }

    pushPending(id: string): void {
        this.pending.push(id);
    }

    // returns true if no more pending
    popPending(id: string): boolean {
        const i = this.pending.findIndex(v => v == id);
        if (i < 0) {
            throw 'id not found';
        }
        this.pending.splice(i, 1);

        return this.pending.length == 0;
    }
}
