import * as vscode from 'vscode';
import * as temp from 'temp';
import * as fs from 'fs';
import { isArray } from 'util';

const toastDuration = 5000;

export function sanitizedDateString(date?: Date): string {
    const d = date || new Date();
    const pad = (num: number) => ("00" + num).slice(-2);

    // Months are zero-indexed
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

const tempDirs: { [sharedKey: string]: string } = {};
export function getSharedTempDir(sharedKey: string): Promise<string> {
    if (tempDirs[sharedKey]) {
        return Promise.resolve(tempDirs[sharedKey]);
    }

    return new Promise((resolve, reject) => {
        temp.track();
        temp.mkdir(sharedKey, (err, dirPath) => {
            if (err) {
                reject(err);
            }
            else {
                tempDirs[sharedKey] = dirPath;
                resolve(dirPath);
            }
        })
    });
}

export function openAndRead(path: string, offset: number, length: number, position: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        fs.open(path, 'r', (err, fd) => {
            if (err) {
                reject(err);
                return;
            }

            const buffer = new Buffer(length);
            fs.read(fd, buffer, offset, length, position, (err, bytesRead, buffer) => {
                fs.close(fd);
                if (err) {
                    reject(err);
                    return;
                }
                resolve(buffer);
            });
        });
    })
}

export async function verifyFileHeader(filePath: string, expectedHeader: Buffer | number[], offset?: number): Promise<boolean> {
    const bufferExpectedHeader = isArray(expectedHeader) ? new Buffer(<number[]>expectedHeader) : <Buffer>expectedHeader;
    const header = await openAndRead(filePath, 0, bufferExpectedHeader.length, offset);
    return header.compare(bufferExpectedHeader) == 0;
}

export function toastStatusBarMessage(message: string): void {
    vscode.window.setStatusBarMessage(message, toastDuration);
}

/**
 * Sets a context that can be use for when clauses in package.json
 *
 * This may become official vscode API some day.
 * https://github.com/Microsoft/vscode/issues/10471
 * @param context The context name
 */
export function setContext(context: string, state: boolean): void {
    vscode.commands.executeCommand('setContext', context, state);
}
