// This implements the interface from the 'bonjour' npm package using the
// avahi-browse command. Not all features are implemented.

import * as bonjour from 'bonjour';
import * as bonjour2 from '../bonjour';
import * as events from 'events';
import * as child_process from 'child_process';
import * as readline from 'readline';

export function isPresent(): boolean {
    try {
        child_process.execFileSync('avahi-browse', ['--version']);
        return true;
    }
    catch (err) {
        return false;
    }
}

export function getInstance(): bonjour2.Bonjour {
    return new Avahi();
}

class Avahi implements bonjour2.Bonjour {
    private destroyOps = new Array<()=>void>();

    // interface method implementation
    public find(options: bonjour.BrowserOptions, onUp?: (service: bonjour.Service) => void): bonjour.Browser {
        const browser = new AvahiBrowser(this, options);
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
    pushDestroyOp(op: ()=>void): ()=>void {
        this.destroyOps.push(op);
        return op;
    }

    /**
     * Removes an operation that was added with pushDestroyOp()
     * @param op the operation to remove
     */
    popDestroyOp(op: ()=>void): void {
        let i = this.destroyOps.findIndex(v => v == op);
        if (i >= 0) {
            this.destroyOps.splice(i, 1);
        }
    }
}

class AvahiBrowser extends events.EventEmitter implements bonjour.Browser {
    private avahiBrowse: child_process.ChildProcess;
    private destroyOp: ()=>void;
    readonly services: bonjour.Service[] = new Array<bonjour.Service>();

    constructor(private avahi: Avahi, private options: bonjour.BrowserOptions) {
        super();
    }

    start(): void {
        if (this.destroyOp) {
            throw 'Already started';
        }

        const args = ['--parsable', '--no-db-lookup', '--resolve'];
        if (this.options.type) {
            args.push(`_${this.options.type}._${this.options.protocol || 'tcp'}`);
        }
        else {
            args.push('--all');
        }
        this.avahiBrowse = child_process.spawn('avahi-browse', args);
        this.destroyOp = this.avahi.pushDestroyOp(() => this.stop());
        const rl = readline.createInterface({ input: this.avahiBrowse.stdout });
        rl.on('line', line => {
            if (!line) {
                return;
            }
            const [action, iface, protocol, name, type, domain, host, addr, port, txt] = line.split(';', 10);
            const service = this.getOrCreateService(name, type, domain);
            switch (action) {
            case '+':
                // we have to merge several avahi entries together to get the
                // equivalent of the nodejs bonjour implementation
                service.pushPending(`${iface}.${protocol}`);
                break;
            case '-':
                const i = this.services.findIndex(s => s.fqdn == `${name}.${type}.${domain}`);
                if (i < 0) {
                    // was already removed
                    break;
                }
                this.services.splice(i, 1);
                this.emit('down', service);
                break;
            case '=':
                service.host = host;
                service.addresses.push(addr);
                service.port = Number(port);
                service.txt = AvahiBrowser.parseText(txt);
                if (service.popPending(`${iface}.${protocol}`)) {
                    // don't emit the 'up' event until we are sure we are completely resolved
                    this.emit('up', service);
                }
                break;
            }
        });
        this.avahiBrowse.on('close', (c, s) => {
            this.avahi.popDestroyOp(this.destroyOp);
            this.destroyOp = undefined;
        });
    }

    update(): void {
        throw 'Not implemented';
    }

    stop(): void {
        if (!this.destroyOp) {
            throw 'Not started';
        }
        this.avahiBrowse.kill();
    }

    private getOrCreateService(name: string, type: string, domain: string): AvahiService {
        let service = <AvahiService> this.services.find(s => s.fqdn == `${name}.${type}.${domain}`);
        if (service) {
            return service;
        }

        service = new AvahiService(name, type, domain);
        this.services.push(service);
        return service;
    }

    private static parseText(txt?: string): Object {
        const result = new Object();
        if (!txt) {
            return result;
        }
        const matches = txt.match(/"[^"]+"/g);
        matches.forEach(m => {
            // remove quotes
            m = m.slice(1, -1);
            const [key, value] = m.split('=', 2);
            result[key] = value;
        });
        return result;
    }
}

class AvahiService extends events.EventEmitter implements bonjour.Service {
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
            this.fqdn = `${name}.${type}.${domain}`;
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
