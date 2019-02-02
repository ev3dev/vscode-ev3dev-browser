// Type definitions for avahi-dbus 0.1.0
// Project: https://github.com/machinekoder/node-avahi-dbus
// Definitions by: David Lechner <david@lechnology.com>

declare module 'avahi-dbus' {
    import * as dbus from 'dbus-native';

    export const PROTO_INET: number;
    export const PROTO_INET6: number;
    export const PROTO_UNSPEC: number;
    export const IF_UNSPEC: number;

    export class Daemon {
        constructor(bus: dbus.Bus);
        GetVersionString(callback: (err: any, version: string) => void): void;
        GetAPIVersion(callback: (err: any, version: number) => void): void;
        GetHostName(callback: (err: any, name: string) => void): void;
        SetHostName(name: string, callback: (err: any) => void): void;
        GetHostNameFqdn(callback: (err: any, name: string) => void): void;
        GetDomainName(callback: (err: any, name: string) => void): void;
        IsNSSSupportAvailable(callback: (err: any, yes: boolean) => void): void;
        GetState(callback: (err: any, state: number) => void): void;
        on(signal: 'StateChanged', callback: (state: number, error: string) => void): void;
        GetLocalServiceCookie(callback: (err: any, cookie: number) => void): void;
        GetAlternativeHostName(name: string, callback: (err: any, name: string) => void): void;
        GetAlternativeServiceName(name: string, callback: (err: any, name: string) => void): void;
        GetNetworkInterfaceNameByIndex(index: number, callback: (err: any, name: string) => void): void;
        GetNetworkInterfaceIndexByName(name: string, callback: (err: any, index: number) => void): void;
        ResolveHostName(interface: number, protocol: number, name: string, aprotocol: number, flags: number, callback: (err: any, interface: number, protocol: number, name: string, aprotocol: number, flags: number) => void): void;
        ResolveAddress(interface: number, protocol: number, address: string, flags: number, callback: (err: any, interface: number, protocol: number, aprotocol: number, address: string, name: string, flags: number) => void): void;
        ResolveService(interface: number, protocol: number, name: string, type: string, domain: string, aprotocol: number, flags: number, callback: (err: any, interface: number, protocol: number, name: string, type: string, domain: string, host: string, aprotocol: number, address: string, port: number, txt: Uint8Array[], flags: number) => void): void;
        EntryGroupNew(callback: (err: any, group: EntryGroup) => void): void;
        DomainBrowserNew(interface: number, protocol: number, domain: string, btype: number, flags: number, callback: (err: any, browser: DomainBrowser) => void): void;
        ServiceTypeBrowserNew(interface: number, protocol: number, domain: string, flags: number, callback: (err: any, browser: ServiceTypeBrowser) => void): void;
        ServiceBrowserNew(interface: number, protocol: number, type: string, domain: string, flags: number, callback: (err: any, browser: ServiceBrowser) => void): void;
        ServiceResolverNew(interface: number, protocol: number, name: string, type: string, domain: string, aprotocol: number, flags: number, callback: (err: any, browser: ServiceResolver) => void): void;
        HostNameResolverNew(interface: number, protocol: number, name: string, aprotocol: number, flags: number, callback: (err: any, resolver: HostNameResolver) => void): void;
        AddressResolverNew(interface: number, protocol: number, address: string, flags: number, callback: (err: any, resolver: AddressResolver) => void): void;
        RecordBrowserNew(interface: number, protocol: number, name: string, clazz: number, type: number, flags: number, callback: (err: any, resolver: RecordBrowser) => void): void;
    }

    export class EntryGroup {
        Free(callback: (err: any) => void): void;
        Commit(callback: (err: any) => void): void;
        Reset(callback: (err: any) => void): void;
        GetState(callback: (err: any, state: number) => void): void;
        on(signal: 'StateChanged', callback: (state: number, error: string) => void): void;
        IsEmpty(callback: (err: any, empty: boolean) => void): void;
        AddService(interface: number, protocol: number, flags: number, name: string, type: string, domain: string, host: string, port: number, txt: Uint8Array[], callback: (err: any) => void): void;
        AddServiceSubtype(interface: number, protocol: number, flags: number, name: string, type: string, domain: string, subtype: string, callback: (err: any) => void): void;
        UpdateServiceTxt(interface: number, protocol: number, flags: number, name: string, type: string, domain: string, txt: Uint8Array[], callback: (err: any) => void): void;
        AddAddress(interface: number, protocol: number, flags: number, name: string, address: string, callback: (err: any) => void): void;
        AddRecord(interface: number, protocol: number, flags: number, name: string, clazz: number, type: number, ttl: number, rdata: Uint8Array, callback: (err: any) => void): void;
    }

    export class DomainBrowser {
        Free(callback: (err: any) => void): void;
        on(event: 'ItemNew', callback: (interface: number, protocol: number, domain: string, flags: number) => void): void;
        on(event: 'ItemRemove', callback: (interface: number, protocol: number, domain: string, flags: number) => void): void;
        on(event: 'Failure', callback: (error: string) => void): void;
        on(event: 'AllForNow', callback: () => void): void;
        on(event: 'CacheExhausted', callback: () => void): void;
    }

    export class ServiceTypeBrowser {
        Free(callback: (err: any) => void): void;
        on(event: 'ItemNew', callback: (interface: number, protocol: number, type: string, domain: string, flags: number) => void): void;
        on(event: 'ItemRemove', callback: (interface: number, protocol: number, type: string, domain: string, flags: number) => void): void;
        on(event: 'Failure', callback: (error: string) => void): void;
        on(event: 'AllForNow', callback: () => void): void;
        on(event: 'CacheExhausted', callback: () => void): void;
    }

    export class ServiceBrowser {
        Free(callback: (err: any) => void): void;
        on(event: 'ItemNew', callback: (interface: number, protocol: number, name: string, type: string, domain: string, flags: number) => void): void;
        on(event: 'ItemRemove', callback: (interface: number, protocol: number, name: string, type: string, domain: string, flags: number) => void): void;
        on(event: 'Failure', callback: (error: string) => void): void;
        on(event: 'AllForNow', callback: () => void): void;
        on(event: 'CacheExhausted', callback: () => void): void;
    }

    export class ServiceResolver {
        Free(callback: (err: any) => void): void;
        on(event: 'Found', callback: (interface: number, protocol: number, name: string, type: string, domain: string, aprotocol: number, address: string, port: number, txt: Uint8Array[], flags: number) => void): void;
        on(event: 'Failure', callback: (error: string) => void): void;
    }

    export class HostNameResolver {
        Free(callback: (err: any) => void): void;
        on(event: 'Found', callback: (interface: number, protocol: number, name: string, aprotocol: number, address: string, flags: number) => void): void;
        on(event: 'Failure', callback: (error: string) => void): void;
    }

    export class AddressResolver {
        Free(callback: (err: any) => void): void;
        on(event: 'Found', callback: (interface: number, protocol: number, aprotocol: number, address: string, name: string, flags: number) => void): void;
        on(event: 'Failure', callback: (error: string) => void): void;
    }

    export class RecordBrowser {
        Free(callback: (err: any) => void): void;
        on(event: 'ItemNew', callback: (interface: number, protocol: number, clazz: number, type: number, rdata: Uint8Array, flags: number) => void): void;
        on(event: 'ItemRemove', callback: (interface: number, protocol: number, clazz: number, type: number, rdata: Uint8Array, flags: number) => void): void;
        on(event: 'Failure', callback: (error: string) => void): void;
        on(event: 'AllForNow', callback: () => void): void;
        on(event: 'CacheExhausted', callback: () => void): void;
    }
}
