// Type definitions for dnode 1.2.2
// Project: https://github.com/substack/dnode
// Definitions by: David Lechner <david@lechnology.com>

declare module 'dnode' {
    import * as net from 'net';

    export type ConsFunc<T> = () => T;

    export function dnode<T>(cons: ConsFunc<T> | T, opt?: {}): DNode;

    export interface DNode extends NodeJS.WritableStream {
        connect(port: number): D;
        pipe(socket: net.Socket): void;
        destroy(): void;
    }

    export class D {
        on<T>(event: 'remote', listener: (remote: T) => void): void;
        end(): void;
    }
}
