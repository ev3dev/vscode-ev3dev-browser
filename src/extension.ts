import * as fs from 'fs';
import * as path from 'path';
import * as ssh2Streams from 'ssh2-streams';
import * as temp from 'temp';

import * as vscode from 'vscode';

import { LaunchRequestArguments } from './native-helper/debugServer';
import { Brickd } from './brickd';
import { Device } from './device';
import {
    getSharedTempDir,
    sanitizedDateString,
    setContext,
    toastStatusBarMessage,
    verifyFileHeader
} from './utils';

let output: vscode.OutputChannel;
let resourceDir: string;
let helperExePath: string;
let ev3devBrowserProvider: Ev3devBrowserProvider;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel('ev3dev');
    resourceDir = context.asAbsolutePath('resources');
    helperExePath = context.asAbsolutePath(path.join('native', process.platform, 'helper'));
    if (process.platform == 'win32') {
        helperExePath += '.exe'
    }

    ev3devBrowserProvider = new Ev3devBrowserProvider();
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
        vscode.commands.registerCommand('ev3devBrowser.fileTreeItem.delete', f => f.delete()),
        vscode.commands.registerCommand('ev3devBrowser.fileTreeItem.showInfo', f => f.showInfo()),
        vscode.commands.registerCommand('ev3devBrowser.fileTreeItem.select', f => f.handleClick()),
        vscode.commands.registerCommand('ev3devBrowser.action.pickDevice', () => pickDevice()),
        vscode.commands.registerCommand('ev3devBrowser.action.download', () => download()),
        vscode.commands.registerCommand('ev3devBrowser.action.refresh', () => refresh()),
        vscode.debug.onDidReceiveDebugSessionCustomEvent(e => handleCustomDebugEvent(e))
    );
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
            vscode.window.showErrorMessage(`Failed to connect to ${device.name}: ${err.message}`);
        }
    });
}

async function handleCustomDebugEvent(event: vscode.DebugSessionCustomEvent): Promise<void> {
    switch (event.event) {
    case 'ev3devBrowser.debugger.launch':
        const args = <LaunchRequestArguments> event.body;

        // optionally download before running
        if (args.download !== false && !await download()) {
            // download() shows error messages, so don't show additional message here.
            await event.session.customRequest('ev3devBrowser.debugger.terminate');
            break;
        }

        // run the program
        try {
            const device = ev3devBrowserProvider.getDeviceSync();
            const command = `brickrun ${args.program}`;
            output.show(true);
            output.clear();
            output.appendLine(`Starting: ${command}`);
            const channel = await device.exec(command);
            channel.on('close', () => {
                event.session.customRequest('ev3devBrowser.debugger.terminate');
            });
            channel.on('exit', (code, signal, coreDump, desc) => {
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
            });
            channel.on('data', (chunk) => {
                output.append(chunk.toString());
            });
            channel.stderr.on('data', (chunk) => {
                output.append(chunk.toString());
            });
            output.appendLine('Started.');
            output.appendLine('----------');
        }
        catch (err) {
            await event.session.customRequest('ev3devBrowser.debugger.terminate');
            vscode.window.showErrorMessage(`Failed to run file: ${err.message}`);
        }
        break;
    case 'ev3devBrowser.debugger.stop':
        const device = ev3devBrowserProvider.getDeviceSync();
        if (device && device.isConnected) {
            device.exec('conrun-kill --signal=SIGKILL');
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
        title: 'Sending'
    }, async progress => {
        try {
            const files = await vscode.workspace.findFiles(includeFiles, excludeFiles);
            let fileIndex = 1;
            const reportProgress = (message: string) => progress.report({ message: message });

            for (const f of files) {
                const baseProgressMessage = `(${fileIndex}/${files.length}) ${f.fsPath}`;
                reportProgress(baseProgressMessage);

                const basename = path.basename(f.fsPath);
                const relativeDir = path.dirname(vscode.workspace.asRelativePath(f.fsPath));
                const remoteDir = path.posix.join(remoteBaseDir, relativeDir);
                const remotePath = path.posix.resolve(remoteDir, basename);

                // File permission handling:
                // - If the file starts with a shebang, then assume it should be
                //   executable.
                // - Otherwise use the existing file permissions. On Windows
                //   all files will be executable.
                let mode: string = undefined;
                if (await verifyFileHeader(f.fsPath, new Buffer('#!/'))) {
                    mode = '755';
                }
                else {
                    const stat = fs.statSync(f.fsPath);
                    mode = stat.mode.toString(8);
                }

                // make sure the directory exists
                await device.mkdir_p(remoteDir);
                // then we can copy the file
                await device.put(f.fsPath, remotePath, mode,
                    percentage => reportProgress(`${baseProgressMessage} - ${percentage}%`));

                fileIndex++;
            }
            // make sure any new files show up in the browser
            ev3devBrowserProvider.fireDeviceChanged();
            success = true;
            vscode.window.setStatusBarMessage(`Done sending project to ${device.name}.`, 5000);
        }
        catch (err) {
            vscode.window.showErrorMessage(`Error sending file: ${err.message}`);
        }
    });

    return success;
}

function refresh(): void {
    ev3devBrowserProvider.fireDeviceChanged();
}

class Ev3devBrowserProvider extends vscode.Disposable implements vscode.TreeDataProvider<DeviceTreeItem | File | CommandTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<DeviceTreeItem | File | CommandTreeItem> =
        new vscode.EventEmitter<DeviceTreeItem | File | CommandTreeItem>();
    readonly onDidChangeTreeData: vscode.Event<DeviceTreeItem | File | CommandTreeItem> = this._onDidChangeTreeData.event;
    private device: DeviceTreeItem;
    private readonly noDeviceTreeItem = new CommandTreeItem('Click here to connect to a device', 'ev3devBrowser.action.pickDevice');

    constructor() {
        super(() => {
            this.setDevice(null);
        });
    }

    public setDevice(device: Device): void {
        if ((this.device && this.device.device) == device) {
            return;
        }
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
    public async getDevice(): Promise<Device> {
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
    public getDeviceSync(): Device {
        return this.device && this.device.device;
    }

    public getTreeItem(element: DeviceTreeItem | File | CommandTreeItem): vscode.TreeItem {
        return element;
    }

    public getChildren(element?: DeviceTreeItem | File | CommandTreeItem): vscode.ProviderResult<DeviceTreeItem[] | File[] | CommandTreeItem[]> {
        if (!element) {
            return [this.device || this.noDeviceTreeItem];
        }
        if (element instanceof DeviceTreeItem) {
            if (element.device.isConnected) {
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

    public fireFileChanged(file: File): void {
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
    public rootDirectory : File;
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
            this.handleConnectionState(DeviceState.Disconnected)
        }
        this.statusItem = new DeviceStatusTreeItem(device);
    }

    private handleConnectionState(state: DeviceState): void {
        this.contextValue = state;
        setContext('ev3devBrowser.context.connected', false);
        this.collapsibleState = vscode.TreeItemCollapsibleState.None;
        this.rootDirectory = null;
        let icon: string;
        switch(state) {
        case DeviceState.Connecting:
            icon = 'yellow-circle.svg';
            break;
        case DeviceState.Connected:
            setContext('ev3devBrowser.context.connected', true);
            this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
            this.rootDirectory = new File(this.device, null, '', {
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
        this.iconPath.dark = path.join(resourceDir, 'icons', 'dark', icon);
        this.iconPath.light = path.join(resourceDir, 'icons', 'light', icon);
        ev3devBrowserProvider.fireDeviceChanged();
    }

    public handleClick(): void {
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

    public openSshTerminal(): void {
        const term = vscode.window.createTerminal(`SSH: ${this.label}`,
            helperExePath,
            ['shell', this.device.shellPort.toString()]);
        term.show();
    }
    
    public async captureScreenshot(): Promise<void> {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: "Capturing screenshot..."
        }, progress => {
            return new Promise(async (resolve, reject) => {
                const handleCaptureError = e => {
                    vscode.window.showErrorMessage("Error capturing screenshot: " + (e.message || e));
                    reject();
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
                        reject();
                    });
        
                    writeStream.on('finish', async () => {
                        const pngHeader = [ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A ];
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
            const sysinfo = await vscode.window.withProgress({
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
        catch(err) {
            vscode.window.showErrorMessage('An error occurred while getting system info: ' + (err.message || err));
        }
    }

    iconPath = {
        dark: null,
        light: null
    };

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
            vscode.window.showErrorMessage(`Failed to connect to ${this.label}: ${err.message}`);
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
        this.isExecutable = stats.isFile() && !!(stats.mode & fs.constants.S_IXUSR);
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
        this.command = { command: 'ev3devBrowser.fileTreeItem.select', title: '', arguments: [this] };
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

    public handleClick(): void {
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

    public run(): void {
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(vscode.workspace.rootPath));
        vscode.debug.startDebugging(folder, <vscode.DebugConfiguration> {
            type: 'ev3devBrowser',
            request: 'launch',
            program: this.path,
            download: false
        });
    }

    public delete(): void {
        this.device.rm_rf(this.path).then(() => {
            ev3devBrowserProvider.fireFileChanged(this.parent);
        }, err => {
            vscode.window.showErrorMessage(`Error deleting '${this.path}': ${err.message}`);
        });
    }

    public async showInfo(): Promise<void> {
        output.clear();
        output.show();
        output.appendLine('Getting file info...');
        output.appendLine('');
        try {
            let [stdout, stderr] = await this.device.createExecObservable(`/bin/ls -lh ${this.path}`);
            await Promise.all([
                stdout.forEach(line => output.appendLine(line)),
                stderr.forEach(line => output.appendLine(line))
            ]);
            output.appendLine('');
            [stdout, stderr] = await this.device.createExecObservable(`/usr/bin/file ${this.path}`);
            await Promise.all([
                stdout.forEach(line => output.appendLine(line)),
                stderr.forEach(line => output.appendLine(line))
            ]);
        }
        catch (err) {
            output.appendLine(`Error: ${err.message}`);
        }
    }
}

/**
 * A tree view item that runs a command when clicked.
 */
class CommandTreeItem extends vscode.TreeItem {
    constructor(label: string, command: string) {
        super(label);
        this.command = {
            command: command,
            title: ''
        };
    }
}

class DeviceStatusTreeItem extends CommandTreeItem {
    private readonly defaultBatteryLabel = "Battery: N/A";
    public children = new Array<CommandTreeItem>();
    private batteryItem = new CommandTreeItem(this.defaultBatteryLabel, undefined);
    private brickd: Brickd;

    public constructor(private device: Device) {
        super("Status", undefined);
        this.children.push(this.batteryItem);
        this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    }

    public async connectBrickd() {
        if (this.brickd) {
            this.brickd.removeAllListeners();
            this.brickd = null;
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
        }
        catch (err)  {
            vscode.window.showWarningMessage('Failed to get brickd connection. No status will be available.');
            return;
        };
    }
}
