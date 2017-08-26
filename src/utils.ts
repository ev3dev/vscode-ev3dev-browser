import * as vscode from 'vscode';
import * as temp from 'temp';
import * as fs from 'fs';
import { isArray } from 'util';

export function sanitizedDateString(date?: Date) {
    const d = date || new Date();
    const pad = (num: number) => ("00" + num).slice(-2);

    return `${d.getFullYear()}-${pad(d.getMonth())}-${pad(d.getDay())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
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

export class StatusBarProgressionMessage {
    private statusBarItem: vscode.StatusBarItem;

    constructor(initialMessage?: string) {
        this.statusBarItem = vscode.window.createStatusBarItem();
        if (initialMessage) {
            this.statusBarItem.text = initialMessage;
            this.statusBarItem.show();
        }
    }

    /**
     * Updates the displayed message.
     * @param newMessage The new message to display
     */
    public update(newMessage: string) {
        if (!this.statusBarItem) {
            return;
        }

        this.statusBarItem.text = newMessage;
        this.statusBarItem.show();
    }

    /**
     * Marks the progression as being finished. If a message is specified, it is
     * shown temporarily before the item disappears.
     * 
     * Note that a message should always be provided if an external message
     * indicating a failure won't be presented to the user.
     * @param finalMessage The last message to show for a short period
     * @param delay The amount of time the final message should be shown
     */
    public finish(finalMessage?: string, delay: number = 5000) {
        if (!this.statusBarItem) {
            return;
        }

        if (finalMessage) {
            this.update(finalMessage);
            setTimeout(() => this.dispose(), delay);
        }
        else {
            this.dispose();
        }
    }

    private dispose() {
        this.statusBarItem.dispose();
        this.statusBarItem = null;
    }
}