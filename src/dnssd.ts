
import * as avahi from './dnssd/avahi';
import * as dnssd from './dnssd/dnssd';
import * as bonjour from './dnssd/bonjour';

/**
 * Common interface used by dnssd implementations.
 */
export interface Client {
    /**
     * Start browsing
     */
    browse(options: BrowseOptions): Promise<Browser>;

    /**
     * Frees resources used by client and destroys any associated browsers, etc.
     */
    destroy(): void;
}

/**
 * Options for Dnssd.browse()
 */
export interface BrowseOptions {
    /**
     * The service type to browse for, e.g. 'http'.
     */
    service: string;

    /**
     * The protocol transport to search for. Must be 'tcp' or 'udp'.
     * Default is 'tcp' if omitted.
     */
    transport?: 'tcp' | 'udp';

    /**
     * The IP protocol to search for. Must be 'IPv4' or 'IPv6'.
     * Default is 'IPv4' if omitted.
     */
    ipv?: 'IPv4' | 'IPv6';
}

export interface Browser {
    on(event: 'added' | 'removed', listener: (service: Service) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    destroy(): void;
}

/**
 * Data type for txt record key/value pairs.
 */
export type TxtRecords = { [key: string]: string };

export interface Service {
    /**
     * The name of the service. Suitible for displaying to the user.
     */
    readonly name: string;

    /**
     * The service type.
     */
    readonly service: string;

    /**
     * The transport protocol.
     */
    readonly transport: 'tcp' | 'udp';

    /**
     * The host name.
     */
    readonly host: string;

    /**
     * The domain.
     */
    readonly domain: string;

    /**
     * The network interface index
     */
    readonly iface: number;

    /**
     * The IP protocol version.
     */
    readonly ipv: 'IPv4' | 'IPv6';

    /**
     * The IP address.
     */
    readonly address: string;

    /**
     * This IP port.
     */
    readonly port: number;

    /**
     * The txt records as key/value pairs.
     */
    readonly txt: TxtRecords;
}

/**
 * Gets in instance of the Bonjour interface.
 *
 * It will try to use a platform-specific implementation. Or if one is not
 * present, it falls back to a pure js implementation.
 */
export async function getInstance(): Promise<Client> {
    try {
        return await avahi.getInstance();
    }
    catch (err) {
        try {
            return dnssd.getInstance();
        }
        catch (err) {
            // fall back to pure-javascript implementation
            return bonjour.getInstance();
        }
    }
}
