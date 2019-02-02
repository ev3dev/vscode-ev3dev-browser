// Type definitions for dbus-native 0.2.2
// Project: https://github.com/sidorares/dbus-native
// Definitions by: David Lechner <david@lechnology.com>

declare module 'dbus-native' {
    export interface Bus {
        connection: Connection;
    }

    export class Connection {
        on(event: 'connect', listener: () => void): this;
        on(event: 'message', listener: (msg: any) => void): this;
        on(event: 'error', listener: (err: any) => void): this;
    }

    export function systemBus(): Bus;
}
