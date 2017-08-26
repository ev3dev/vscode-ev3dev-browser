import * as dnode from 'dnode';
import * as fs from 'fs';
import * as net from 'net';

import * as path from 'path';
import * as ssh2 from 'ssh2';
import * as ssh2Streams from 'ssh2-streams';
import * as temp from 'temp';

import * as vscode from 'vscode';

import * as dnssd from './dnssd';
import { Device } from './device';
import {
    sanitizedDateString,
    getSharedTempDir,
    verifyFileHeader,
    StatusBarProgressionMessage
} from './utils';


const S_IXUSR = parseInt('00100', 8);

let output: vscode.OutputChannel;
let resourceDir: string;
let shellPath: string;
let ev3devBrowserProvider: Ev3devBrowserProvider;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) : void {
    output = vscode.window.createOutputChannel('ev3dev');
    resourceDir = context.asAbsolutePath('resources');
    shellPath = context.asAbsolutePath(path.join('native', process.platform, 'shell'));
    if (process.platform == 'win32') {
        shellPath += '.exe'
    }

    ev3devBrowserProvider = new Ev3devBrowserProvider();
    context.subscriptions.push(
        output, ev3devBrowserProvider,
        vscode.window.registerTreeDataProvider('ev3devBrowser', ev3devBrowserProvider),
        vscode.commands.registerCommand('ev3devBrowser.deviceTreeItem.openSshTerminal', d => d.openSshTerminal()),
        vscode.commands.registerCommand('ev3devBrowser.deviceTreeItem.captureScreenshot', d => d.captureScreenshot()),
        vscode.commands.registerCommand('ev3devBrowser.deviceTreeItem.connect', d => d.connect()),
        vscode.commands.registerCommand('ev3devBrowser.deviceTreeItem.disconnect', d => d.disconnect()),
        vscode.commands.registerCommand('ev3devBrowser.deviceTreeItem.select', d => d.handleClick()),
        vscode.commands.registerCommand('ev3devBrowser.fileClicked', f => f.handleClick()),
        vscode.commands.registerCommand('ev3devBrowser.remoteRun', f => f.run()),
        vscode.commands.registerCommand('ev3devBrowser.remoteTerm', f => f.stop()),
        vscode.commands.registerCommand('ev3devBrowser.remoteDelete', f => f.delete()),
        vscode.commands.registerCommand('ev3devBrowser.pickDevice', () => pickDevice()),
        vscode.commands.registerCommand('ev3devBrowser.download', () => download()),
        vscode.debug.onDidReceiveDebugSessionCustomEvent(e => handleCustomDebugEvent(e))
    );
}

// this method is called when your extension is deactivated
export function deactivate() {
    // The "temp" module should clean up automatically, but do this just in case.
    temp.cleanupSync();
}

async function pickDevice(): Promise<void> {
    const device = await Device.pickDevice();
    if (!device) {
        // user canceled
        return;
    }
    ev3devBrowserProvider.setDevice(device);
    try {
        await device.connect();
    }
    catch (err) {
        vscode.window.showErrorMessage(`Failed to connect to ${device.name}: ${err.message}`);
    }
}

async function handleCustomDebugEvent(event: vscode.DebugSessionCustomEvent): Promise<void> {
    switch (event.event) {
    case 'ev3devBrowser.downloadAndRun':
        if (!await download()) {
            // download() shows error messages, so don't show additional message here.
            await event.session.customRequest('ev3devBrowser.terminate');
            return;
        }
        try {
            const device = ev3devBrowserProvider.getDeviceSync();
            const stat = await device.stat(event.body.program);
            const parts = event.body.program.split('/');
            const filename = parts.pop();
            parts.push(''); // so we get trailing '/'
            const dirname = parts.join('/');
            const file = new File(device, null, dirname, {
                filename: filename,
                longname: '',
                attrs: stat
            });
            file.run();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Failed to run file: ${err.message}`);
        }
        break;
    case 'ev3devBrowser.stop':
        const device = ev3devBrowserProvider.getDeviceSync();
        if (device) {
            device.exec('conrun-kill');
        }
        break;
    }
}

/**
 * Download the current project directory to the device.
 * 
 * @return Promise of true on success, otherwise false.
 */
async function download(): Promise<boolean> {
    await vscode.workspace.saveAll();
    const localDir = vscode.workspace.rootPath;
    if (!localDir) {
        vscode.window.showErrorMessage('Must have a folder open to send files to device.');
        return false;
    }

    let device = await ev3devBrowserProvider.getDevice();
    if (!device) {
        // get device will have shown an error message, so we don't need another here
        return false;
    }
    if (!device.isConnected) {
        vscode.window.showErrorMessage('Device is not connected.');
        return false;
    }

    const config = vscode.workspace.getConfiguration('ev3devBrowser.download');
    const includeFiles = config.get<string>('include');
    const excludeFiles = config.get<string>('exclude');
    const projectDir = config.get<string>('directory') || path.basename(localDir);
    const remoteBaseDir = device.homeDirectoryPath + `/${projectDir}/`;
    let success = false;
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: 'Downloading'
    }, async progress => {
        try {
            const files = await vscode.workspace.findFiles(includeFiles, excludeFiles);
            for (const f of files) {
                progress.report({
                    message: `Copying ${f.fsPath}`
                });
                const basename = path.basename(f.fsPath);
                const relativeDir = path.dirname(vscode.workspace.asRelativePath(f.fsPath)) + '/';
                const remoteDir = remoteBaseDir + relativeDir;
                const remotePath = remoteDir + basename;
                
                // make sure the directory exists
                await device.mkdir_p(remoteDir);
                // then we can copy the file
                await device.put(f.fsPath, remotePath);
                // TODO: selectively make files executable
                await device.chmod(remotePath, '755');
            }
            // make sure any new files show up in the browser
            ev3devBrowserProvider.fireDeviceChanged();
            success = true;
        }
        catch (err) {
            vscode.window.showErrorMessage(`Error sending file: ${err.message}`);
        }
    });

    return success;
}

class Ev3devBrowserProvider extends vscode.Disposable implements vscode.TreeDataProvider<DeviceTreeItem | File> {
    private _onDidChangeTreeData: vscode.EventEmitter<DeviceTreeItem | File> = new vscode.EventEmitter<DeviceTreeItem | File>();
    readonly onDidChangeTreeData: vscode.Event<DeviceTreeItem | File> = this._onDidChangeTreeData.event;
    private device: DeviceTreeItem;

    constructor() {
        super(() => {
            this.setDevice(null);
        });
    }

    setDevice(device: Device) {
        if (this.device) {
            this.device.device.disconnect();
            this.device = null;
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
    async getDevice(): Promise<Device> {
        if (!this.device) {
            const connectNow = 'Connect Now';
            const result = await vscode.window.showErrorMessage('No ev3dev device is connected.', connectNow);
            if (result == connectNow) {
                await pickDevice();
            }
        }
        return this.device.device;
    }

    /**
     * Gets the current device or null if no device is connected.
     */
    getDeviceSync(): Device {
        return this.device && this.device.device;
    }

    getTreeItem(element: DeviceTreeItem | File): vscode.TreeItem {
        return element;
    }

    getChildren(element?: DeviceTreeItem | File): vscode.ProviderResult<DeviceTreeItem[] | File[]> {
        if (!element) {
            if (!this.device) {
                return [];
            }
            return [this.device];
        }
        if (element instanceof DeviceTreeItem) {
            return [element.rootDirectory];
        }
        if (element instanceof File) {
            return element.getFiles();
        }
    }

    fireDeviceChanged(): void {
        // not sure why, but if we pass device to fire(), vscode does not call
        // back to getTreeItem(), so we are refreshing the entire tree for now
        this._onDidChangeTreeData.fire();
    }

    fireFileChanged(file: File): void {
        this._onDidChangeTreeData.fire(file);
    }
}

class ServiceItem implements vscode.QuickPickItem {
    readonly label: string;
    readonly description: string;
    
    constructor (public service: dnssd.Service) {
        this.label = service.name;
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
    rootDirectory : File;

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
            this.handleConnectionState(DeviceState.Disconnected)
        }
    }

    private handleConnectionState(state: DeviceState) {
        this.contextValue = state;
        this.collapsibleState = vscode.TreeItemCollapsibleState.None;
        this.rootDirectory = null;
        let icon: string;
        switch(state) {
        case DeviceState.Connecting:
            icon = 'yellow-circle.svg';
            break;
        case DeviceState.Connected:
            this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
            this.rootDirectory = new File(this.device, null, '', {
                filename: this.device.homeDirectoryPath,
                longname: '',
                attrs: this.device.homeDirectoryAttr
            });
            this.rootDirectory.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
            icon = 'green-circle.svg';
            break;
        case DeviceState.Disconnected:
            icon = 'red-circle.svg';
            break;
        }
        this.iconPath.dark = path.join(resourceDir, 'icons', 'dark', icon);
        this.iconPath.light = path.join(resourceDir, 'icons', 'light', icon);
        ev3devBrowserProvider.fireDeviceChanged();
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
        const term = vscode.window.createTerminal(`SSH: ${this.label}`,
            shellPath,
            [this.device.shellPort.toString()]);
        term.show();
    }
    
    async captureScreenshot() {
        const statusBarMessage = new StatusBarProgressionMessage("Attempting to capture screenshot...");

        const handleCaptureError = e => {
            vscode.window.showErrorMessage("Error capturing screenshot: " + (e.message || e)); 
            statusBarMessage.finish();
        }

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
                statusBarMessage.finish();
            });

            writeStream.on('finish', async () => {
                const pngHeader = [ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A ];
                if (await verifyFileHeader(screenshotFile, pngHeader)) {
                    statusBarMessage.finish(`Screenshot "${screenshotBaseName}" successfully captured`);
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(screenshotFile));
                }
                else {
                    handleCaptureError("The screenshot was not in the correct format. You may need to upgrade to fbcat 0.5.0.");
                }
            });
        }
        catch (e) {
            handleCaptureError(e);
        }
    }

    iconPath = {
        dark: null,
        light: null
    };

    async connect(): Promise<void> {
        try {
            await this.device.connect();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Failed to connect to ${this.label}: ${err.message}`);
        }
    }

    disconnect(): void {
        this.device.disconnect();
    }
}

/**
 * File states are used for the context value of a File.
 */
enum FileState {
    None = 'ev3devBrowser.file',
    Folder = 'ev3devBrowser.file.folder',
    Executable = 'ev3devBrowser.file.executable'
}

class File extends vscode.TreeItem {
    private fileCache: File[] = new Array<File>();
    readonly path: string;
    readonly isExecutable: boolean;
    readonly isDirectory: boolean;

    constructor(public device: Device, public parent: File, directory: string,
                private fileInfo: ssh2Streams.FileEntry) {
        super(fileInfo.filename);
        // work around bad typescript bindings
        const stats = (<ssh2Streams.Stats> fileInfo.attrs);
        this.path = directory + fileInfo.filename;
        this.isExecutable = stats.isFile() && !!(stats.mode & S_IXUSR);
        this.isDirectory = stats.isDirectory();
        if (this.isDirectory) {
            this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            this.contextValue = FileState.Folder;
        }
        else if (this.isExecutable) {
            this.contextValue = FileState.Executable;
        }
        else {
            this.contextValue = FileState.None;
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
                        if (element.filename[0] != '.') {
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

    handleClick(): void {
        // keep track of state so that it is preserved during refresh
        if (this.collapsibleState == vscode.TreeItemCollapsibleState.Expanded) {
            this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            // This causes us to refresh the files each time the directory is collapsed
            this.fileCache.length = 0;
            ev3devBrowserProvider.fireFileChanged(this);
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

    run(): void {
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
        this.device.exec('conrun-kill');
    }

    delete(): void {
        this.device.rm(this.path).then(() => {
            ev3devBrowserProvider.fireFileChanged(this.parent);
        }, err => {
            vscode.window.showErrorMessage(`Error deleting '${this.path}': ${err.message}`);
        });
    }
}
