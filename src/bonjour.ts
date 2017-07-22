
import * as avahi from './bonjour/avahi';
import * as dnssd from './bonjour/dnssd';
import * as bonjour from 'bonjour';

// This is a subset for bonjour.Bonjour. We are not using the full interface,
// so this is the stuff we are actually using.
export interface Bonjour {
    find(options: bonjour.BrowserOptions, onUp?: (service: bonjour.Service) => void): bonjour.Browser;
    destroy(): void;
}

/**
 * Gets in instance of the Bonjour interface.
 *
 * It will try to use a platform-specific implementation. Or if one is not
 * present, it falls back to a pure js implementation.
 */
export function getInstance(): Bonjour {
    if (avahi.isPresent()) {
        return avahi.getInstance();
    }

    if (dnssd.isPresent()) {
        return dnssd.getInstance();
    }

    // fall back to pure-javascript implementation
    return bonjour();
}
