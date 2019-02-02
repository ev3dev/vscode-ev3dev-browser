// Type definitions for dnode 1.2.2
// Project: https://github.com/substack/dnode
// Definitions by: David Lechner <david@lechnology.com>

/// <reference types="node" />

declare function dnode<T>(cons: dnode.ConsFunc<T> | T, opt?: {}): dnode.DNode;
export = dnode;
declare namespace dnode {

    type ConsFunc<T> = () => T;

    interface DNode extends NodeJS.WritableStream {
        connect(port: number): D;
        pipe(socket: NodeJS.Socket): void;
        destroy(): void;
    }

    class D {
        on<T>(event: 'remote', listener: (remote: T) => void): void;
        end(): void;
    }
}
