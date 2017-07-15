'use strict';

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as bonjour from 'bonjour';
import * as ssh2 from 'ssh2'
import * as ssh2Streams from 'ssh2-streams'
import * as path from 'path'

const S_IXUSR = parseInt('00100', 8);


let output: vscode.OutputChannel;
let resourceDir: string;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    output = vscode.window.createOutputChannel('ev3dev');
    resourceDir = context.asAbsolutePath('resources');
    context.subscriptions.push(output);

    const ev3devBrowserProvider = new Ev3devBrowserProvider();
    context.subscriptions.push(vscode.window.registerTreeDataProvider('ev3devBrowser', ev3devBrowserProvider));
    context.subscriptions.push(vscode.commands.registerCommand('ev3devBrowser.refresh', () => ev3devBrowserProvider.refresh()));
    context.subscriptions.push(vscode.commands.registerCommand('ev3devBrowser.openSshTerminal', d => ev3devBrowserProvider.openSshTerminal(d)));
    context.subscriptions.push(vscode.commands.registerCommand('ev3devBrowser.deviceCLicked', d => d.handleClick()));
    context.subscriptions.push(vscode.commands.registerCommand('ev3devBrowser.fileClicked', f => f.handleClick()));
    context.subscriptions.push(vscode.commands.registerCommand('ev3devBrowser.remoteRun', f => f.run()));
    context.subscriptions.push(vscode.commands.registerCommand('ev3devBrowser.remoteTerm', f => f.stop()));
    
}

// this method is called when your extension is deactivated
export function deactivate() {
}

export class Ev3devBrowserProvider implements vscode.TreeDataProvider<Device | File> {
    private _onDidChangeTreeData: vscode.EventEmitter<Device | File | undefined> = new vscode.EventEmitter<Device | File | undefined>();
	readonly onDidChangeTreeData: vscode.Event<Device | File | undefined> = this._onDidChangeTreeData.event;
    private readonly devices: Array<Device> = new Array<Device>();
    private readonly browser: bonjour.Browser;

	constructor() {
        this.browser = bonjour().find({type: 'sftp-ssh'});
        this.browser.on('up', s => this.onBrowserUp(s));
        this.browser.on('down', s => this.onBrowserDown(s));
        this.browser.start();
    }

	refresh(): void {
		this.browser.update();
        this._onDidChangeTreeData.fire();
    }
    
    openSshTerminal(device: Device): void {
        device.openSshTerminal();
    }

	getTreeItem(element: Device | File): vscode.TreeItem {
		return element;
    }

    getChildren(element?: Device | File): vscode.ProviderResult<Device[] | File[]> {
        if (!element) {
            return this.devices;
        }
        if (element instanceof Device) {
            return [element.rootDirectory];
        }
        if (element instanceof File) {
            return element.getFiles();
        }
    }

    private onBrowserUp = (service: bonjour.Service): void => {
        if ('ev3dev.robot.user' in service.txt) {
            const device = new Device(this, service);
            this.devices.push(device);
            this._onDidChangeTreeData.fire();
        }
    }

    private onBrowserDown = (service: bonjour.Service): void => {
        const matchIndex = this.devices.findIndex(d => d.service == service);
        if (matchIndex >= 0) {
            this.devices.splice(matchIndex, 1);
            this._onDidChangeTreeData.fire();
        }
    }

    fireDeviceChanged(device: Device): void {
        // not sure why, but if we pass device to fire(), vscode does not call
        // back to getTreeItem(), so we are refreshing the entire tree for now
        this._onDidChangeTreeData.fire();
    }

    fireFileChanged(file: File): void {
        this._onDidChangeTreeData.fire(file);
    }
}

class Device extends vscode.TreeItem {
    private client: ssh2.Client;
    private sftp: ssh2.SFTPWrapper;
    readonly username: string;
    rootDirectory : File;

	constructor(readonly provider: Ev3devBrowserProvider, public service: bonjour.Service) {
        super(service.name);
        this.username = service.txt['ev3dev.robot.user']
        this.contextValue = 'ev3devDevice';
        this.command = { command: 'ev3devBrowser.deviceCLicked', title: '', arguments: [this]};
        this.client = new ssh2.Client();
        this.client.on('ready', () => this.handleClientReady());
        this.client.on('error', err => this.handleClientError(err));
        this.client.connect({
            host: service.host,
            username: this.username,
            password: vscode.workspace.getConfiguration('ev3devBrowser').get('password'),
        });
    }

    private handleClientReady(): void {
        this.client.sftp((err, sftp) => {
            if (err) {
                this.handleClientError(err);
                return;
            }
            this.sftp = sftp;
            const rootPath = this.service.txt['ev3dev.robot.home'] || `/home/${this.username}`;
            this.sftp.stat(rootPath, (err, stats) => {
                if (err) {
                    this.handleClientError(err);
                    return;
                }
                this.rootDirectory = new File(this, '', {
                    filename: this.service.txt['ev3dev.robot.home'] || `/home/${this.username}`,
                    longname: '',
                    attrs: stats
                });
                this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                this.provider.fireDeviceChanged(this);
            });
            
            this.iconPath.dark = path.join(resourceDir, 'icons', 'dark', 'green-circle.svg');
            this.iconPath.light = path.join(resourceDir, 'icons', 'light', 'green-circle.svg');
        });
    }

    private handleClientError(err: any): void {
        this.iconPath.dark = path.join(resourceDir, 'icons', 'dark', 'red-circle.svg');
        this.iconPath.light = path.join(resourceDir, 'icons', 'light', 'red-circle.svg');
        this.provider.fireDeviceChanged(this);
        vscode.window.showErrorMessage(`Failed to connect to ${this.label}: ${err.message}`);
    }

    readdir(path: string): Promise<ssh2Streams.FileEntry[]> {
        return new Promise((resolve, reject) => {
            this.sftp.readdir(path, (err, list) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(list);
                }
            })
        });
    }

    exec(command: string): Promise<ssh2.Channel> {
        return new Promise((resolve, reject) => {
            const options = {
                env: vscode.workspace.getConfiguration('ev3devBrowser').get('env')
            };
            this.client.exec(command, options, (err, channel) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(channel);
            });
        });
    }

    handleClick(): void {
        // Attempt to keep he collapsible state correct. If we don't do this,
        // strange things happen on a refresh.
        switch(this.collapsibleState) {
        case vscode.TreeItemCollapsibleState.Collapsed:
            this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
            break;
        case vscode.TreeItemCollapsibleState.Expanded:
            this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            break;
        }
    }

    openSshTerminal(): void {
        const term = vscode.window.createTerminal(this.label);
        let command = 'ssh ';
        if (this.service.txt['ev3dev.robot.user']) {
            command += this.username + '@';
        }
        command += this.service.host;
        command += '; exit';
        term.sendText(command, true);
        term.show();
    }

	iconPath = {
		dark: path.join(resourceDir, 'icons', 'dark', 'yellow-circle.svg'),
		light: path.join(resourceDir, 'icons', 'light', 'yellow-circle.svg')
	};
}

class File extends vscode.TreeItem {
    private fileCache: File[] = new Array<File>();
    readonly path: string;
    readonly isExecutable: boolean;

    constructor(public device: Device, directory: string, private fileInfo: ssh2Streams.FileEntry) {
        super(fileInfo.filename);
        // work around bad typescript bindings
        const stats = (<ssh2Streams.Stats> fileInfo.attrs);
        this.path = directory + fileInfo.filename;
        this.isExecutable = stats.isFile() && !!(stats.mode & S_IXUSR);
        if (stats.isDirectory()) {
            this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            this.contextValue = 'folder';
        }
        if (this.isExecutable) {
            this.contextValue = 'executableFile';
        }
        this.command = { command: 'ev3devBrowser.fileClicked', title: '', arguments: [this]};
    }

    private createOrUpdate(device: Device, directory: string, fileInfo: any): File {
        const path = directory + fileInfo.filename;
        const match = this.fileCache.find(f => f.path == path);
        if (match) {
            match.fileInfo = fileInfo;
            return match;
        }
        const file = new File(device, directory, fileInfo);
        this.fileCache.push(file);
        return file;
    }

    getFiles(): vscode.ProviderResult<File[]> {
        return new Promise((resolve, reject) => {
            this.device.readdir(this.path).then(list => {
                const files = new Array<File>();
                if (list) {
                    list.forEach(element => {
                        // skip hidden files
                        if (element.filename[0] != '.') {
                            const file = this.createOrUpdate(this.device, this.path + "/", element);
                            files.push(file);
                        }
                    }, this);
                }
                resolve(files);
                this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
            }, err => {
                reject(err);
            });
        });
    }

    handleClick(): void {
        // keep track of state so that it is preserved during refresh
        if (this.collapsibleState == vscode.TreeItemCollapsibleState.Expanded) {
            this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            // This causes us to refresh the files each time the directory is collapsed
            this.fileCache.length = 0;
            this.device.provider.fireFileChanged(this);
        }

        // Show a quick-pick to allow users to run an executable program.
        if (this.isExecutable) {
            const runItem = <vscode.QuickPickItem> {
                label: 'Run',
                description: this.path
            };
            vscode.window.showQuickPick([runItem]).then(value => {
                if (value == runItem) {
                    this.run();
                }
            });
        }
    }

    run() :void {
        const command = `conrun -e ${this.path}`;
        output.show(true);
        output.clear();
        output.appendLine(`Starting: ${command}`);
        this.device.exec(command).then(channel => {
            const cancelSource = new vscode.CancellationTokenSource();
            channel.on('close', () => {
                cancelSource.dispose();
            });
            channel.on('exit', (code, signal, coreDump, desc) => {
                if (code === 0) {
                    output.appendLine('Completed successfully.');
                }
                else if (code) {
                    output.appendLine(`Exited with error code ${code}.`);
                }
                else {
                    output.appendLine(`Exited with signal ${signal}.`);
                }
            });
            channel.on('data', (chunk) => {
                output.append(chunk.toString());
            });
            channel.stderr.on('data', (chunk) => {
                output.append(chunk.toString());
            });
            output.appendLine('Started.');
            output.appendLine('');

            // Use quick-pick to allow the user to stop a running program. This
            // seems to be the best available UI at the moment. By using
            // ignoreFocusOut: true, we can prevent the user from accidentally
            // closing the quick-pick (unless they press ESC). Using the
            // cancellation token will close it automatically when the program
            // exits.
            const stopItem = <vscode.QuickPickItem> {
                label: 'Stop',
                description: this.path
            };
            vscode.window.showQuickPick([stopItem], { ignoreFocusOut: true }, cancelSource.token).then(value => {
                if (value == stopItem) {
                    this.stop();
                }
            });
        }, err => {
            output.appendLine(`Failed: ${err.message}`);
        });
    }

    stop(): void {
        // if (this.channel) {
        //     // cast to any because of missing typescript binding
        //     (<any> this.channel).signal('TERM');
        // }

        // signal() does not seem to work anyway
        this.device.exec('killall conrun');
    }
}
