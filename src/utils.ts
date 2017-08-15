import * as temp from 'temp'
import * as fs from 'fs'
import { isArray } from 'util'

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