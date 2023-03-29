import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as ssh2Streams from 'ssh2-streams';
import * as temp from 'temp';

import * as vscode from 'vscode';

import { Ev3devBrowserDebugSession, LaunchRequestArguments } from './debugServer';
import { Brickd } from './brickd';
import { Device } from './device';
import {
    getSharedTempDir,
    sanitizedDateString,
    setContext,
    toastStatusBarMessage,
    verifyFileHeader,
    getPlatform,
} from './utils';

// fs.constants.S_IXUSR is undefined on win32!
const S_IXUSR = 0o0100;

let config: WorkspaceConfig;
let output: vscode.OutputChannel;
let resourceDir: string;
let ev3devBrowserProvider: Ev3devBrowserProvider;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext): void {
    config = new WorkspaceConfig(context.workspaceState);
    output = vscode.window.createOutputChannel('ev3dev');
    resourceDir = context.asAbsolutePath('resources');

    ev3devBrowserProvider = new Ev3devBrowserProvider();
    const factory = new Ev3devDebugAdapterDescriptorFactory();
    const provider = new Ev3devDebugConfigurationProvider();
    context.subscriptions.push(
        output, ev3devBrowserProvider,
        vscode.window.registerTreeDataProvider('ev3devBrowser', ev3devBrowserProvider),
        vscode.commands.registerCommand('ev3devBrowser.deviceTreeItem.openSshTerminal', d => d.openSshTerminal()),
        vscode.commands.registerCommand('ev3devBrowser.deviceTreeItem.captureScreenshot', d => d.captureScreenshot()),
        vscode.commands.registerCommand('ev3devBrowser.deviceTreeItem.showSysinfo', d => d.showSysinfo()),
        vscode.commands.registerCommand('ev3devBrowser.deviceTreeItem.reconnect', d => d.connect()),
        vscode.commands.registerCommand('ev3devBrowser.deviceTreeItem.connectNew', d => pickDevice()),
        vscode.commands.registerCommand('ev3devBrowser.deviceTreeItem.disconnect', d => d.disconnect()),
        vscode.commands.registerCommand('ev3devBrowser.deviceTreeItem.select', d => d.handleClick()),
        vscode.commands.registerCommand('ev3devBrowser.fileTreeItem.run', f => f.run()),
        vscode.commands.registerCommand('ev3devBrowser.fileTreeItem.runInTerminal', f => f.runInTerminal()),
        vscode.commands.registerCommand('ev3devBrowser.fileTreeItem.delete', f => f.delete()),
        vscode.commands.registerCommand('ev3devBrowser.fileTreeItem.showInfo', f => f.showInfo()),
        vscode.commands.registerCommand('ev3devBrowser.fileTreeItem.upload', f => f.upload()),
        vscode.commands.registerCommand('ev3devBrowser.fileTreeItem.select', f => f.handleClick()),
        vscode.commands.registerCommand('ev3devBrowser.action.pickDevice', () => pickDevice()),
        vscode.commands.registerCommand('ev3devBrowser.action.download', () => downloadAll()),
        vscode.commands.registerCommand('ev3devBrowser.action.refresh', () => refresh()),
        vscode.debug.onDidReceiveDebugSessionCustomEvent(e => handleCustomDebugEvent(e)),
        vscode.debug.registerDebugAdapterDescriptorFactory('ev3devBrowser', factory),
        vscode.debug.registerDebugConfigurationProvider('ev3devBrowser', provider),
    );
}

class Ev3devDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    private server?: net.Server;

    createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        if (!this.server) {
            // start listening on a random port
            this.server = net.createServer(socket => {
                const session = new Ev3devBrowserDebugSession();
                session.setRunAsServer(true);
                session.start(<NodeJS.ReadableStream>socket, socket);
            }).listen(0);
        }

        // make VS Code connect to debug server
        return new vscode.DebugAdapterServer((<net.AddressInfo>this.server.address()).port);
    }

    dispose() {
        this.server?.close();
    }
}

class Ev3devDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    async resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        debugConfiguration: vscode.DebugConfiguration,
        token?: vscode.CancellationToken,
    ): Promise<vscode.DebugConfiguration | undefined> {
        if (Object.keys(debugConfiguration).length === 0) {
            type DebugConfigurationQuickPickItem = vscode.QuickPickItem & { interactiveTerminal: boolean };
            const items: DebugConfigurationQuickPickItem[] = [
                {
                    label: "Download and run current file",
                    description: "in interactive terminal",
                    interactiveTerminal: true,
                },
                {
                    label: "Download and run current file",
                    description: "in output pane",
                    interactiveTerminal: false,
                },
            ];
            const selected = await vscode.window.showQuickPick(items, {
                matchOnDescription: true,
                ignoreFocusOut: true,
                placeHolder: "Debug configuration"
            }, token);
            if (selected) {
                return {
                    type: "ev3devBrowser",
                    name: `${selected.label} ${selected.description}`,
                    request: "launch",
                    program: "/home/robot/${workspaceFolderBasename}/${relativeFile}",
                    interactiveTerminal: selected.interactiveTerminal
                };
            }
        }
        return debugConfiguration;
    }
}

// this method is called when your extension is deactivated
export function deactivate(): void {
    // The "temp" module should clean up automatically, but do this just in case.
    temp.cleanupSync();
}

async function pickDevice(): Promise<void> {
    const device = await Device.pickDevice();
    if (!device) {
        // user canceled
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: "Connecting..."
    }, async progress => {
        ev3devBrowserProvider.setDevice(device);
        try {
            await device.connect();
            toastStatusBarMessage(`Connected`);
        }
        catch (err) {
            const troubleshoot = 'Troubleshoot';
            vscode.window.showErrorMessage(`Failed to connect to ${device.name}: ${err.message}`, troubleshoot)
                .then((value) => {
                    if (value === troubleshoot) {
                        const wiki = vscode.Uri.parse('https://github.com/ev3dev/vscode-ev3dev-browser/wiki/Troubleshooting')
                        vscode.commands.executeCommand('vscode.open', wiki);
                    }
                });
        }
    });
}

const activeDebugSessions = new Set<string>();
let debugTerminal: vscode.Terminal;
let debugRestarting: boolean;

async function handleCustomDebugEvent(event: vscode.DebugSessionCustomEvent): Promise<void> {
    let device: Device | undefined;
    switch (event.event) {
        case 'ev3devBrowser.debugger.launch':
            const args = <LaunchRequestArguments>event.body;
            device = await ev3devBrowserProvider.getDevice();
            if (device && !device.isConnected) {
                const item = ev3devBrowserProvider.getDeviceTreeItem();
                if (item) {
                    await item.connect();
                }
            }
            if (!device || !device.isConnected) {
                await event.session.customRequest('ev3devBrowser.debugger.terminate');
                break;
            }

            // optionally download before running - workspaceFolder can be undefined
            // if the request did not come from a specific project, in which case we
            // download all projects
            const folder = event.session.workspaceFolder;
            if (args.download !== false && !(folder ? await download(folder, device) : await downloadAll())) {
                // download() shows error messages, so don't show additional message here.
                await event.session.customRequest('ev3devBrowser.debugger.terminate');
                break;
            }

            // run the program
            try {
                // normalize the path to unix path separators since this path will be used on the EV3
                const programPath = vscode.Uri.file(args.program).path;

                const dirname = path.posix.dirname(programPath);
                if (args.interactiveTerminal) {
                    const command = `brickrun -r --directory="${dirname}" "${programPath}"`;
                    const config = vscode.workspace.getConfiguration(`terminal.integrated.env.${getPlatform()}`);
                    const termEnv = config.get<string>('TERM');
                    const env = {
                        ...vscode.workspace.getConfiguration('ev3devBrowser').get<object>('env'),
                        ...vscode.workspace.getConfiguration('ev3devBrowser').get<object>('interactiveTerminal.env'),
                    };
                    const ch = await device.exec(command, env, { term: termEnv || process.env['TERM'] || 'xterm-256color' });
                    const writeEmitter = new vscode.EventEmitter<string>();
                    ch.stdout.on('data', (data: string | Buffer) => writeEmitter.fire(String(data)));
                    ch.stderr.on('data', (data: string | Buffer) => writeEmitter.fire(String(data)));
                    if (debugTerminal) {
                        debugTerminal.dispose();
                    }
                    debugTerminal = vscode.window.createTerminal({
                        name: `${path.posix.basename(programPath)} on ${device.name}`,
                        pty: {
                            onDidWrite: writeEmitter.event,
                            open: (dim: vscode.TerminalDimensions | undefined) => {
                                if (dim !== undefined) {
                                    ch.setWindow(dim.rows, dim.columns, 0, 0);
                                }
                                writeEmitter.fire(`Starting: ${command}\r\n`);
                                writeEmitter.fire('----------\r\n');
                            },
                            close: () => {
                                ch.close();
                                activeDebugSessions.delete(event.session.id);
                            },
                            handleInput: (data: string) => {
                                ch.stdin.write(data);
                            },
                            setDimensions: (dim: vscode.TerminalDimensions) => {
                                ch.setWindow(dim.rows, dim.columns, 0, 0);
                            },
                        },
                    });
                    ch.on('close', () => {
                        if (debugRestarting) {
                            activeDebugSessions.add(event.session.id);
                            event.session.customRequest('ev3devBrowser.debugger.thread', 'started');
                            debugRestarting = false;
                        } else {
                            event.session.customRequest('ev3devBrowser.debugger.terminate');
                        }
                        ch.destroy();
                    });
                    ch.on('exit', (code, signal, coreDump, desc) => {
                        writeEmitter.fire('----------\r\n');
                        if (code === 0) {
                            writeEmitter.fire('Completed successfully.\r\n');
                        }
                        else if (code) {
                            writeEmitter.fire(`Exited with error code ${code}.\r\n`);
                        }
                        else {
                            writeEmitter.fire(`Exited with signal ${signal}.\r\n`);
                        }
                        activeDebugSessions.delete(event.session.id);
                    });
                    ch.on('error', (err: any) => {
                        vscode.window.showErrorMessage(`Connection error: ${err || err.message}`);
                        debugTerminal.dispose();
                        ch.destroy();
                    });
                    debugTerminal.show();
                    event.session.customRequest('ev3devBrowser.debugger.thread', 'started');
                }
                else {
                    const command = `brickrun --directory="${dirname}" "${programPath}"`;
                    output.show(true);
                    output.clear();
                    output.appendLine(`Starting: ${command}`);
                    const env = vscode.workspace.getConfiguration('ev3devBrowser').get('env');
                    const channel = await device.exec(command, env);
                    channel.on('close', () => {
                        if (debugRestarting) {
                            activeDebugSessions.add(event.session.id);
                            output.clear();
                            output.appendLine(`Restarting: ${command}`);
                            output.appendLine('----------');
                            event.session.customRequest('ev3devBrowser.debugger.thread', 'started');
                            debugRestarting = false;
                        } else {
                            event.session.customRequest('ev3devBrowser.debugger.terminate');
                        }
                    });
                    channel.on('exit', (code, signal, coreDump, desc) => {
                        if (!debugRestarting) {
                            output.appendLine('----------');
                            if (code === 0) {
                                output.appendLine('Completed successfully.');
                            }
                            else if (code) {
                                output.appendLine(`Exited with error code ${code}.`);
                            }
                            else {
                                output.appendLine(`Exited with signal ${signal}.`);
                            }
                            activeDebugSessions.delete(event.session.id);
                        }
                    });
                    channel.on('data', (chunk: string | Buffer) => {
                        output.append(chunk.toString());
                    });
                    channel.stderr.on('data', (chunk) => {
                        output.append(chunk.toString());
                    });
                    output.appendLine('----------');
                    event.session.customRequest('ev3devBrowser.debugger.thread', 'started');
                }
                activeDebugSessions.add(event.session.id);
            }
            catch (err) {
                await event.session.customRequest('ev3devBrowser.debugger.terminate');
                vscode.window.showErrorMessage(`Failed to run file: ${err.message}`);
            }
            break;
        case 'ev3devBrowser.debugger.stop':
            debugRestarting = event.body.restart;
            device = ev3devBrowserProvider.getDeviceSync();
            if (activeDebugSessions.has(event.session.id) && device && device.isConnected) {
                device.exec('conrun-kill --signal=SIGKILL --group');
            }
            // update remote file browser in case program created new files
            refresh();
            break;
        case 'ev3devBrowser.debugger.interrupt':
            device = ev3devBrowserProvider.getDeviceSync();
            if (activeDebugSessions.has(event.session.id) && device && device.isConnected) {
                device.exec('conrun-kill --signal=SIGINT');
            }
            // update remote file browser in case program created new files
            refresh();
            break;
    }
}

/**
 * Download all workspace folders to the device.
 *
 * @return Promise of true on success, otherwise false.
 */
async function downloadAll(): Promise<boolean> {
    let device = await ev3devBrowserProvider.getDevice();
    if (!device) {
        // get device will have shown an error message, so we don't need another here
        return false;
    }
    if (!device.isConnected) {
        vscode.window.showErrorMessage('Device is not connected.');
        return false;
    }

    if (!vscode.workspace.workspaceFolders) {
        vscode.window.showErrorMessage('Must have a folder open to send files to device.');
        return false;
    }
    await vscode.workspace.saveAll();

    for (const localFolder of vscode.workspace.workspaceFolders) {
        if (!await download(localFolder, device)) {
            return false;
        }
    }

    return true;
}

/**
 * Download workspace folder to the device.
 *
 * @param folder The folder.
 * @param device The device.
 * @return Promise of true on success, otherwise false.
 */
async function download(folder: vscode.WorkspaceFolder, device: Device): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('ev3devBrowser.download', folder.uri);

    const includeFiles = new vscode.RelativePattern(folder, config.get<string>('include', ''));
    const excludeFiles = new vscode.RelativePattern(folder, config.get<string>('exclude', ''));
    const projectDir = config.get<string>('directory') || path.basename(folder.uri.fsPath);
    const remoteBaseDir = path.posix.join(device.homeDirectoryPath, projectDir);
    const deviceName = device.name;

    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Sending',
        cancellable: true,
    }, async (progress, token) => {
        try {
            const files = await vscode.workspace.findFiles(includeFiles, excludeFiles);

            // If there are no files matching the given include and exclude patterns,
            // let the user know about it.
            if (!files.length) {
                const msg = 'No files selected for download. Please check the ev3devBrowser.download.include and ev3devBrowser.download.exclude settings.';
                // try to make it easy for the user to fix the problem by offering to
                // open the settings editor
                const openSettings = 'Open Settings';
                vscode.window.showErrorMessage(msg, openSettings).then(result => {
                    if (result === openSettings) {
                        vscode.commands.executeCommand('workbench.action.openSettings2');
                    }
                });

                // "cancel" the download
                return false;
            }

            const increment = 100 / files.length;
            let fileIndex = 1;
            const reportProgress = (message: string) => progress.report({ message: message });

            for (const f of files) {
                if (token.isCancellationRequested) {
                    ev3devBrowserProvider.fireDeviceChanged();
                    return false;
                }

                const relativePath = vscode.workspace.asRelativePath(f, false);
                const baseProgressMessage = `(${fileIndex}/${files.length}) ${relativePath}`;
                reportProgress(baseProgressMessage);

                const basename = path.basename(f.fsPath);
                let relativeDir = path.dirname(relativePath);
                if (path === path.win32) {
                    relativeDir = relativeDir.replace(path.win32.sep, path.posix.sep);
                }
                const remoteDir = path.posix.join(remoteBaseDir, relativeDir);
                const remotePath = path.posix.resolve(remoteDir, basename);

                // File permission handling:
                // - If the file starts with a shebang, then assume it should be
                //   executable.
                // - Otherwise use the existing file permissions. On Windows
                //   we also check for ELF file format to know if a file
                //   should be executable since Windows doesn't know about
                //   POSIX file permissions.
                let mode: string;
                if (await verifyFileHeader(f.fsPath, new Buffer('#!/'))) {
                    mode = '755';
                }
                else {
                    const stat = fs.statSync(f.fsPath);
                    if (process.platform === 'win32') {
                        // fs.stat() on win32 return something like '100666'
                        // See https://github.com/joyent/libuv/blob/master/src/win/fs.c
                        // and search for `st_mode`

                        // So, we check to see the file uses ELF format, if
                        // so, make it executable.
                        if (await verifyFileHeader(f.fsPath, new Buffer('\x7fELF'))) {
                            stat.mode |= S_IXUSR;
                        }
                    }
                    mode = stat.mode.toString(8);
                }

                // make sure the directory exists
                if (!device) {
                    throw new Error("Lost connection");
                }
                await device.mkdir_p(remoteDir);
                // then we can copy the file
                await device.put(f.fsPath, remotePath, mode,
                    percentage => reportProgress(`${baseProgressMessage} - ${percentage}%`));

                fileIndex++;
                progress.report({ increment: increment });
            }
            // make sure any new files show up in the browser
            ev3devBrowserProvider.fireDeviceChanged();

            vscode.window.showInformationMessage(`Download to ${deviceName} complete`);
        }
        catch (err) {
            vscode.window.showErrorMessage(`Error sending file: ${err.message}`);
            return false;
        }

        return true;
    });
}

function refresh(): void {
    ev3devBrowserProvider.fireDeviceChanged();
}

class Ev3devBrowserProvider extends vscode.Disposable implements vscode.TreeDataProvider<DeviceTreeItem | File | CommandTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<DeviceTreeItem | File | CommandTreeItem> =
        new vscode.EventEmitter<DeviceTreeItem | File | CommandTreeItem>();
    readonly onDidChangeTreeData: vscode.Event<DeviceTreeItem | File | CommandTreeItem> = this._onDidChangeTreeData.event;
    private device: DeviceTreeItem | undefined;
    private readonly noDeviceTreeItem = new CommandTreeItem('Click here to connect to a device', 'ev3devBrowser.action.pickDevice');

    constructor() {
        super(() => {
            this.setDevice(undefined);
        });
    }

    public setDevice(device: Device | undefined): void {
        if ((this.device && this.device.device) === device) {
            return;
        }
        if (this.device) {
            this.device.device.disconnect();
            this.device = undefined;
        }
        if (device) {
            this.device = new DeviceTreeItem(device);
        }
        this.fireDeviceChanged();
    }

    /**
     * Gets the current device.
     *
     * Will prompt the user to select a device if there is not one already connected
     */
    public async getDevice(): Promise<Device | undefined> {
        if (!this.device) {
            const connectNow = 'Connect Now';
            const result = await vscode.window.showErrorMessage('No ev3dev device is connected.', connectNow);
            if (result === connectNow) {
                await pickDevice();
            }
        }
        return this.device && this.device.device;
    }

    /**
     * Gets the current device or undefined if no device is connected.
     */
    public getDeviceSync(): Device | undefined {
        return this.device && this.device.device;
    }

    public getDeviceTreeItem(): DeviceTreeItem | undefined {
        return this.device;
    }

    public getTreeItem(element: DeviceTreeItem | File | CommandTreeItem): vscode.TreeItem {
        return element;
    }

    public getChildren(element?: DeviceTreeItem | File | CommandTreeItem): vscode.ProviderResult<(DeviceTreeItem | File | CommandTreeItem)[]> {
        if (!element) {
            return [this.device || this.noDeviceTreeItem];
        }
        if (element instanceof DeviceTreeItem) {
            // should always have element.rootDirectory - included in if statement just for type checking
            if (element.device.isConnected && element.rootDirectory) {
                return [element.statusItem, element.rootDirectory];
            }
            return [];
        }
        if (element instanceof DeviceStatusTreeItem) {
            return element.children;
        }
        if (element instanceof File) {
            return element.getFiles();
        }
        return [];
    }

    public fireDeviceChanged(): void {
        // not sure why, but if we pass device to fire(), vscode does not call
        // back to getTreeItem(), so we are refreshing the entire tree for now
        this._onDidChangeTreeData.fire();
    }

    public fireFileChanged(file: File | undefined): void {
        this._onDidChangeTreeData.fire(file);
    }

    public fireStatusChanged(status: DeviceStatusTreeItem) {
        this._onDidChangeTreeData.fire(status);
    }
}

/**
 * Possible states for a Device.
 *
 * These are used for the tree view context value.
 */
enum DeviceState {
    Disconnected = 'ev3devBrowser.device.disconnected',
    Connecting = 'ev3devBrowser.device.connecting',
    Connected = 'ev3devBrowser.device.connected'
}

class DeviceTreeItem extends vscode.TreeItem {
    public rootDirectory: File | undefined;
    public statusItem: DeviceStatusTreeItem;

    constructor(public readonly device: Device) {
        super(device.name);
        this.command = { command: 'ev3devBrowser.deviceTreeItem.select', title: '', arguments: [this] };
        device.onWillConnect(() => this.handleConnectionState(DeviceState.Connecting));
        device.onDidConnect(() => this.handleConnectionState(DeviceState.Connected));
        device.onDidDisconnect(() => this.handleConnectionState(DeviceState.Disconnected));
        if (device.isConnecting) {
            this.handleConnectionState(DeviceState.Connecting);
        }
        else if (device.isConnected) {
            this.handleConnectionState(DeviceState.Connected);
        }
        else {
            this.handleConnectionState(DeviceState.Disconnected);
        }
        this.statusItem = new DeviceStatusTreeItem(device);
    }

    private handleConnectionState(state: DeviceState): void {
        this.contextValue = state;
        setContext('ev3devBrowser.context.connected', false);
        this.collapsibleState = vscode.TreeItemCollapsibleState.None;
        this.rootDirectory = undefined;
        let icon: string | undefined;

        switch (state) {
            case DeviceState.Connecting:
                icon = 'yellow-circle.svg';
                break;
            case DeviceState.Connected:
                setContext('ev3devBrowser.context.connected', true);
                this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                this.rootDirectory = new File(this.device, undefined, '', {
                    filename: this.device.homeDirectoryPath,
                    longname: '',
                    attrs: this.device.homeDirectoryAttr
                });
                this.rootDirectory.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                icon = 'green-circle.svg';
                this.statusItem.connectBrickd();
                break;
            case DeviceState.Disconnected:
                icon = 'red-circle.svg';
                break;
        }

        if (icon) {
            this.iconPath = {
                dark: path.join(resourceDir, 'icons', 'dark', icon),
                light: path.join(resourceDir, 'icons', 'light', icon),
            };
        }
        else {
            this.iconPath = undefined;
        }

        ev3devBrowserProvider.fireDeviceChanged();
    }

    public handleClick(): void {
        // Attempt to keep he collapsible state correct. If we don't do this,
        // strange things happen on a refresh.
        switch (this.collapsibleState) {
            case vscode.TreeItemCollapsibleState.Collapsed:
                this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                break;
            case vscode.TreeItemCollapsibleState.Expanded:
                this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                break;
        }
    }

    public openSshTerminal(): void {
        const config = vscode.workspace.getConfiguration(`terminal.integrated.env.${getPlatform()}`);
        const termEnv = config.get<string>('TERM');
        this.device.shell({ term: termEnv || process.env['TERM'] || 'xterm-256color' }).then(ch => {
            const writeEmitter = new vscode.EventEmitter<string>();
            ch.stdout.on('data', (data: string | Buffer) => writeEmitter.fire(String(data)));
            ch.stderr.on('data', (data: string | Buffer) => writeEmitter.fire(String(data)));
            const term = vscode.window.createTerminal({
                name: `SSH: ${this.label}`,
                pty: {
                    onDidWrite: writeEmitter.event,
                    open: (dim: vscode.TerminalDimensions | undefined) => {
                        if (dim !== undefined) {
                            ch.setWindow(dim.rows, dim.columns, 0, 0);
                        }
                    },
                    close: () => {
                        ch.close();
                    },
                    handleInput: (data: string) => {
                        ch.stdin.write(data);
                    },
                    setDimensions: (dim: vscode.TerminalDimensions) => {
                        ch.setWindow(dim.rows, dim.columns, 0, 0);
                    },
                },
            });
            ch.on('close', () => {
                term.dispose();
                ch.destroy();
            });
            ch.on('error', (err: any) => {
                vscode.window.showErrorMessage(`SSH connection error: ${err || err.message}`);
                term.dispose();
                ch.destroy();
            });
            term.show();
        }).catch(err => {
            vscode.window.showErrorMessage(`Failed to create SSH terminal: ${err || err.message}`);
        });
    }

    public async captureScreenshot(): Promise<void> {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: "Capturing screenshot..."
        }, progress => {
            return new Promise(async (resolve, reject) => {
                const handleCaptureError = (e: any) => {
                    vscode.window.showErrorMessage("Error capturing screenshot: " + (e.message || e));
                    reject();
                };

                try {
                    const screenshotDirectory = await getSharedTempDir('ev3dev-screenshots');
                    const screenshotBaseName = `ev3dev-${sanitizedDateString()}.png`;
                    const screenshotFile = `${screenshotDirectory}/${screenshotBaseName}`;

                    const conn = await this.device.exec('fbgrab -');
                    const writeStream = fs.createWriteStream(screenshotFile);

                    conn.on('error', (e: Error) => {
                        writeStream.removeAllListeners('finish');
                        handleCaptureError(e);
                    });

                    writeStream.on('open', () => {
                        conn.stdout.pipe(writeStream);
                    });

                    writeStream.on('error', (e: Error) => {
                        vscode.window.showErrorMessage("Error saving screenshot: " + e.message);
                        reject();
                    });

                    writeStream.on('finish', async () => {
                        const pngHeader = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
                        if (await verifyFileHeader(screenshotFile, pngHeader)) {
                            toastStatusBarMessage("Screenshot captured");
                            resolve();
                            vscode.commands.executeCommand('vscode.open', vscode.Uri.file(screenshotFile), vscode.ViewColumn.Two);
                        }
                        else {
                            handleCaptureError("The screenshot was not in the correct format. You may need to upgrade to fbcat 0.5.0.");
                        }
                    });
                }
                catch (e) {
                    handleCaptureError(e);
                }
            });
        });
    }

    public async showSysinfo() {
        try {
            output.clear();
            output.show();
            output.appendLine('========== ev3dev-sysinfo ==========');
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: 'Grabbing ev3dev system info...'
            }, async progress => {
                const [stdout, stderr] = await this.device.createExecObservable('ev3dev-sysinfo');
                await Promise.all([
                    stdout.forEach(v => output.appendLine(v)),
                    stderr.forEach(v => output.appendLine(v))
                ]);
            });

            toastStatusBarMessage('System info retrieved');
        }
        catch (err) {
            vscode.window.showErrorMessage('An error occurred while getting system info: ' + (err.message || err));
        }
    }

    public async connect(): Promise<void> {
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: `Connecting to ${this.label}`
            }, async progress => {
                await this.device.connect();
            });
            toastStatusBarMessage(`Connected to ${this.label}`);
        }
        catch (err) {
            const troubleshoot = 'Troubleshoot';
            vscode.window.showErrorMessage(`Failed to connect to ${this.label}: ${err.message}`, troubleshoot)
                .then((value) => {
                    if (value === troubleshoot) {
                        const wiki = vscode.Uri.parse('https://github.com/ev3dev/vscode-ev3dev-browser/wiki/Troubleshooting')
                        vscode.commands.executeCommand('vscode.open', wiki);
                    }
                });
        }
    }

    public disconnect(): void {
        this.device.disconnect();
    }
}

/**
 * File states are used for the context value of a File.
 */
enum FileState {
    None = 'ev3devBrowser.file',
    Folder = 'ev3devBrowser.file.folder',
    RootFolder = 'ev3devBrowser.file.folder.root',
    Executable = 'ev3devBrowser.file.executable'
}

class File extends vscode.TreeItem {
    private fileCache: File[] = new Array<File>();
    readonly path: string;
    readonly isExecutable: boolean;
    readonly isDirectory: boolean;

    constructor(public device: Device, public parent: File | undefined, directory: string,
        private fileInfo: ssh2Streams.FileEntry) {
        super(fileInfo.filename);
        // work around bad typescript bindings
        const stats = (<ssh2Streams.Stats>fileInfo.attrs);
        this.path = directory + fileInfo.filename;
        this.isExecutable = stats.isFile() && !!(stats.mode & S_IXUSR);
        this.isDirectory = stats.isDirectory();
        if (this.isDirectory) {
            this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            if (this.parent) {
                this.contextValue = FileState.Folder;
            }
            else {
                this.contextValue = FileState.RootFolder;
            }
        }
        else if (this.isExecutable) {
            this.contextValue = FileState.Executable;
        }
        else {
            this.contextValue = FileState.None;
        }
        this.command = { command: 'ev3devBrowser.fileTreeItem.select', title: '', arguments: [this] };
    }

    private createOrUpdate(device: Device, directory: string, fileInfo: any): File {
        const path = directory + fileInfo.filename;
        const match = this.fileCache.find(f => f.path === path);
        if (match) {
            match.fileInfo = fileInfo;
            return match;
        }
        const file = new File(device, this, directory, fileInfo);
        this.fileCache.push(file);
        return file;
    }

    private static compare(a: File, b: File): number {
        // directories go first
        if (a.isDirectory && !b.isDirectory) {
            return -1;
        }
        if (!a.isDirectory && b.isDirectory) {
            return 1;
        }

        // then sort in ASCII order
        return a.path < b.path ? -1 : +(a.path > b.path);
    }

    getFiles(): vscode.ProviderResult<File[]> {
        return new Promise((resolve, reject) => {
            this.device.ls(this.path).then(list => {
                const files = new Array<File>();
                if (list) {
                    list.forEach(element => {
                        // skip hidden files
                        if (element.filename[0] !== '.') {
                            const file = this.createOrUpdate(this.device, this.path + "/", element);
                            files.push(file);
                        }
                    }, this);
                }
                // sort directories first, then by ASCII
                files.sort(File.compare);
                resolve(files);
                this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
            }, err => {
                reject(err);
            });
        });
    }

    public handleClick(): void {
        // keep track of state so that it is preserved during refresh
        if (this.collapsibleState === vscode.TreeItemCollapsibleState.Expanded) {
            this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            // This causes us to refresh the files each time the directory is collapsed
            this.fileCache.length = 0;
            ev3devBrowserProvider.fireFileChanged(this);
        }

        // Show a quick-pick to allow users to run an executable program.
        if (this.isExecutable) {
            const runItem = <vscode.QuickPickItem>{
                label: 'Run',
                description: this.path
            };
            const runInTerminalItem = <vscode.QuickPickItem>{
                label: 'Run in interactive terminal',
                description: this.path
            };
            vscode.window.showQuickPick([runItem, runInTerminalItem]).then(value => {
                switch (value) {
                    case runItem:
                        this.run();
                        break;
                    case runInTerminalItem:
                        this.runInTerminal();
                        break;
                }
            });
        }
    }

    public run(): void {
        vscode.debug.startDebugging(undefined, <vscode.DebugConfiguration>{
            type: 'ev3devBrowser',
            name: 'Run',
            request: 'launch',
            program: this.path,
            download: false,
            interactiveTerminal: false,
        });
    }

    public runInTerminal(): void {
        vscode.debug.startDebugging(undefined, <vscode.DebugConfiguration>{
            type: 'ev3devBrowser',
            name: 'Run in interactive terminal',
            request: 'launch',
            program: this.path,
            download: false,
            interactiveTerminal: true,
        });
    }

    public delete(): void {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: `Deleting '${this.path}'`
        }, async progress => {
            try {
                const config = vscode.workspace.getConfiguration('ev3devBrowser');
                const confirm = config.get<boolean>('confirmDelete');
                if (confirm) {
                    const deleteItem = "Delete";
                    const dontShowAgainItem = "Don't show this again";
                    const result = await vscode.window.showInformationMessage(
                        `Are you sure you want to delete '${this.path}'? This cannot be undone.`,
                        deleteItem, dontShowAgainItem);
                    if (!result) {
                        return;
                    }
                    else if (result === dontShowAgainItem) {
                        config.update('confirmDelete', false, vscode.ConfigurationTarget.Global);
                    }
                }
                await this.device.rm_rf(this.path);
                ev3devBrowserProvider.fireFileChanged(this.parent);
                toastStatusBarMessage(`Deleted '${this.path}'`);
            }
            catch (err) {
                vscode.window.showErrorMessage(`Error deleting '${this.path}': ${err.message}`);
            }
        });
    }

    public async showInfo(): Promise<void> {
        output.clear();
        output.show();
        output.appendLine('Getting file info...');
        output.appendLine('');
        try {
            let [stdout, stderr] = await this.device.createExecObservable(`/bin/ls -lh "${this.path}"`);
            await Promise.all([
                stdout.forEach(line => output.appendLine(line)),
                stderr.forEach(line => output.appendLine(line))
            ]);
            output.appendLine('');
            [stdout, stderr] = await this.device.createExecObservable(`/usr/bin/file "${this.path}"`);
            await Promise.all([
                stdout.forEach(line => output.appendLine(line)),
                stderr.forEach(line => output.appendLine(line))
            ]);
        }
        catch (err) {
            output.appendLine(`Error: ${err.message}`);
        }
    }

    public async upload(): Promise<void> {
        const basename = path.posix.basename(this.path);
        const result = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(config.uploadDir, basename))
        });

        if (!result) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: 'Uploading'
        }, async progress => {
            await this.device.get(this.path, result.fsPath, percentage => {
                progress.report({ message: `${this.path} - ${percentage}%` });
            });
        });
        config.uploadDir = path.dirname(result.fsPath);
    }
}

/**
 * A tree view item that runs a command when clicked.
 */
class CommandTreeItem extends vscode.TreeItem {
    constructor(label: string, command: string | undefined) {
        super(label);
        if (command) {
            this.command = {
                command: command,
                title: ''
            };
        }
    }
}

class DeviceStatusTreeItem extends CommandTreeItem {
    private readonly defaultBatteryLabel = "Battery: N/A";
    public children = new Array<CommandTreeItem>();
    private batteryItem = new CommandTreeItem(this.defaultBatteryLabel, undefined);
    private brickd: Brickd | undefined;

    public constructor(private device: Device) {
        super("Status", undefined);
        this.children.push(this.batteryItem);
        this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    }

    public async connectBrickd() {
        if (this.brickd) {
            this.brickd.removeAllListeners();
            this.brickd = undefined;
            this.batteryItem.label = this.defaultBatteryLabel;
        }
        try {
            this.brickd = await this.device.brickd();
            this.brickd.on('message', message => {
                const [m1, ...m2] = message.split(' ');
                switch (m1) {
                    case 'WARN':
                    case 'CRITICAL':
                        vscode.window.showWarningMessage(`${this.device.name}: ${m2.join(' ')}`);
                        break;
                    case 'PROPERTY':
                        switch (m2[0]) {
                            case "system.battery.voltage":
                                const voltage = Number(m2[1]) / 1000;
                                this.batteryItem.label = `Battery: ${voltage.toFixed(2)}V`;
                                ev3devBrowserProvider.fireStatusChanged(this);
                        }
                        break;
                }
            });
            this.brickd.on('error', err => {
                vscode.window.showErrorMessage(`${this.device.name}: ${err.message}`);
            });
            this.brickd.on('ready', () => {
                if (!this.brickd) {
                    return;
                }
                // serialNumber is used elsewhere, so tack it on to the device object
                (<any>this.device)['serialNumber'] = this.brickd.serialNumber;
            });
        }
        catch (err) {
            vscode.window.showWarningMessage('Failed to get brickd connection. No status will be available.');
            return;
        }
    }
}

/**
 * Wrapper around vscode.ExtensionContext.workspaceState
 */
class WorkspaceConfig {
    constructor(private state: vscode.Memento) {
    }

    /**
     * Gets or sets the upload directory for the current workspace.
     */
    get uploadDir(): string {
        return this.state.get('uploadDir', os.homedir());
    }

    set uploadDir(value: string) {
        this.state.update('uploadDir', value);
    }
}
