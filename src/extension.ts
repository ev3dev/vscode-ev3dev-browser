import * as dnode from 'dnode';
import * as fs from 'fs';
import * as net from 'net';

import * as path from 'path';
import * as ssh2 from 'ssh2';
import * as ssh2Streams from 'ssh2-streams';
import * as temp from 'temp';

import * as vscode from 'vscode';

import * as dnssd from './dnssd';
import {
    sanitizedDateString,
    getSharedTempDir,
    verifyFileHeader,
    StatusBarProgressionMessage
} from './utils';

const S_IXUSR = parseInt('00100', 8);

let dnssdClient: dnssd.Client;
let output: vscode.OutputChannel;
let resourceDir: string;
let shellPath: string;
let ev3devBrowserProvider: Ev3devBrowserProvider;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) : Promise<void> {
    dnssdClient = await dnssd.getInstance();

    output = vscode.window.createOutputChannel('ev3dev');
    context.subscriptions.push(output);
    resourceDir = context.asAbsolutePath('resources');
    shellPath = context.asAbsolutePath(path.join('native', process.platform, 'shell'));
    if (process.platform == 'win32') {
        shellPath += '.exe'
    }

    ev3devBrowserProvider = new Ev3devBrowserProvider();
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('ev3devBrowser', ev3devBrowserProvider),
        vscode.commands.registerCommand('ev3devBrowser.openSshTerminal', d => ev3devBrowserProvider.openSshTerminal(d)),
        vscode.commands.registerCommand('ev3devBrowser.captureScreenshot', d => ev3devBrowserProvider.captureScreenshot(d)),
        vscode.commands.registerCommand('ev3devBrowser.deviceClicked', d => d.handleClick()),
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
    const device = ev3devBrowserProvider.getDeviceSync();
    if (device) {
        device.destroy();
    }
    dnssdClient.destroy();

    // The "temp" module should clean up automatically, but do this just in case.
    temp.cleanupSync();
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
 * Use a quick-pick to browse discovered devices and select one.
 */
async function pickDevice(): Promise<void> {
    try {
        const selectedItem = await new Promise<ServiceItem>(async (resolve, reject) => {
                // start browsing for devices
                const browser = await dnssdClient.browse({ service: 'sftp-ssh' });
                const items = new Array<ServiceItem>();
                let cancelSource: vscode.CancellationTokenSource;
                let done = false;

                // if a device is added or removed, cancel the quick-pick
                // and then show a new one with the update list
                browser.on('added', (service) => {
                    if (service.txt['ev3dev.robot.home']) {
                        // this looks like an ev3dev device
                        const item = new ServiceItem(service);
                        items.push(item);
                        cancelSource.cancel();
                    }
                });
                browser.on('removed', (service) => {
                    const index = items.findIndex(si => si.service == service);
                    if (index > -1) {
                        items.splice(index, 1);
                        cancelSource.cancel();
                    }
                });

                // if there is a browser error, cancel the quick-pick and show
                // an error message
                browser.on('error', err => {
                    cancelSource.cancel();
                    browser.destroy();
                    done = true;
                    reject(err);
                });

                while (!done) {
                    cancelSource = new vscode.CancellationTokenSource();
                    // using this promise in the quick-pick will cause a progress
                    // bar to show if there are no items.
                    const list = new Promise<ServiceItem[]>((resolve, reject) => {
                        if (items) {
                            resolve(items);
                        }
                        else {
                            reject();
                        }
                    })
                    const selected = await vscode.window.showQuickPick(list, {
                        ignoreFocusOut: true,
                        placeHolder: "Searching for devices..."
                    }, cancelSource.token);
                    if (cancelSource.token.isCancellationRequested) {
                        continue;
                    }
                    browser.destroy();
                    done = true;
                    resolve(selected);
                }
            });
        if (!selectedItem) {
            // cancelled
            return;
        }

        ev3devBrowserProvider.setDevice(selectedItem.service);
    }
    catch (err) {
        vscode.window.showErrorMessage(`Something bad happened: ${err.message}`);
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
    const connected = await device.checkConnection();
    if (!connected) {
        vscode.window.showErrorMessage('Device is not connected.');
        return false;
    }

    const config = vscode.workspace.getConfiguration('ev3devBrowser.download');
    const includeFiles = config.get<string>('include');
    const excludeFiles = config.get<string>('exclude');
    const projectDir = config.get<string>('directory') || path.basename(localDir);
    const remoteBaseDir = device.rootDirectory.path + `/${projectDir}/`;
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
            device.provider.fireDeviceChanged(device);
            success = true;
        }
        catch (err) {
            vscode.window.showErrorMessage(`Error sending file: ${err.message}`);
        }
    });

    return success;
}

class Ev3devBrowserProvider implements vscode.TreeDataProvider<Device | File> {
    private _onDidChangeTreeData: vscode.EventEmitter<Device | File> = new vscode.EventEmitter<Device | File>();
	readonly onDidChangeTreeData: vscode.Event<Device | File> = this._onDidChangeTreeData.event;
    private device: Device = null;

    setDevice(service: dnssd.Service) {
        if (this.device) {
            this.device.destroy();
            this.device = null;
        }
        if (service) {
            this.device = new Device(this, service);
        }
        this.fireDeviceChanged(this.device);
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
        return this.device;
    }

    /**
     * Gets the current device or null if no device is connected.
     */
    getDeviceSync(): Device {
        return this.device;
    }

    openSshTerminal(device: Device): void {
        device.openSshTerminal();
    }
    
    captureScreenshot(device: Device): void {
        device.captureScreenshot();
    }

	getTreeItem(element: Device | File): vscode.TreeItem {
		return element;
    }

    getChildren(element?: Device | File): vscode.ProviderResult<Device[] | File[]> {
        if (!element) {
            if (!this.device) {
                return [];
            }
            return [this.device];
        }
        if (element instanceof Device) {
            return [element.rootDirectory];
        }
        if (element instanceof File) {
            return element.getFiles();
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

class Device extends vscode.TreeItem {
    private client: ssh2.Client;
    private sftp: ssh2.SFTPWrapper;
    readonly username: string;
    shellPort: number;
    rootDirectory : File;

	constructor(readonly provider: Ev3devBrowserProvider, public service: dnssd.Service) {
        super(service.name);
        this.username = service.txt['ev3dev.robot.user']
        this.contextValue = DeviceState.Connecting;
        this.command = { command: 'ev3devBrowser.deviceClicked', title: '', arguments: [this]};
        this.client = new ssh2.Client();
        this.client.on('ready', () => this.handleClientReady());
        this.client.on('error', err => this.handleClientError(err));
        this.client.on('end', () => {
            // this has the effect of calling this.destroy()
            this.provider.setDevice(null);
        });
        this.client.on('close', () => {
            // this has the effect of calling this.destroy()
            this.provider.setDevice(null);
        });
        this.client.on('keyboard-interactive', async (name, instructions, lang, prompts, finish) => {
            const answers = new Array<string>();
            // work around type bug
            for (const p of prompts) {
                const choice = await vscode.window.showInputBox({
                    ignoreFocusOut: true,
                    password: !p.echo,
                    prompt:  p.prompt
                });
                answers.push(choice);
            }
            // another type binding workaround
            finish(answers);
        });
        this.client.connect({
            host: service.address,
            username: this.username,
            password: vscode.workspace.getConfiguration('ev3devBrowser').get('password'),
            tryKeyboard: true
        });
        const server = net.createServer(c => {
            const d = dnode({
                shell: (ttySettings, dataOut, dataErr, ready, exit) => {
                    this.shell(ttySettings).then(ch => {
                        ch.stdout.on('data', data => {
                            dataOut(data.toString('base64'));
                        });
                        ch.stderr.on('data', data => {
                            dataErr((<Buffer> data).toString('base64'));
                        });
                        ch.on('error', err => {
                            vscode.window.showErrorMessage(`SSH connection error: ${err.message}`);
                            exit();
                            ch.destroy();
                            d.destroy();
                        });
                        ch.on('close', () => {
                            exit();
                            ch.destroy();
                            d.destroy();
                        });
                        ready((rows, cols) => {
                            // resize callback
                            ch.setWindow(rows, cols, 0, 0);
                        }, data => {
                            // dataIn callback
                            ch.stdin.write(new Buffer(data, 'base64'));
                        });
                    });
                }
            }, {
                weak: false
            });
            c.on('error', err => {
                // TODO: not sure what to do here.
                // The default dnode implementation only ignores EPIPE.
                // On Windows, we can also get ECONNRESET when a client disconnects.
            });
            c.pipe(d).pipe(c);
        });
        server.listen(0, '127.0.0.1');
        server.on('listening', () => {
            this.shellPort = server.address().port;
        });
    }

    destroy(): void {
        this.client.destroy();
    }

    /**
     * Checks if the device is connected. If the device is currently connecting,
     * the promise will not resolve until the connection is complete or has
     * failed, otherwise the function returns immediately.
     * @return Promise of true if the device is connected, otherwise false.
     */
    async checkConnection(): Promise<boolean> {
        switch (this.contextValue) {
        case DeviceState.Connecting:
            return await new Promise<boolean>((resolve, reject) => {
                // recursively call checkConnection() until it is no longer connecting
                // FIXME: this is not pretty. we need to separate the Device
                // object from the TreeItem view so that the Device can be
                // an event emitter.
                setTimeout(() => this.checkConnection().then(r => resolve(r), err => reject(err)), 100);
            });
        case DeviceState.Connected:
            return true;
        case DeviceState.Disconnected:
            return false;
        }
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
                this.rootDirectory = new File(this, undefined, '', {
                    filename: this.service.txt['ev3dev.robot.home'] || `/home/${this.username}`,
                    longname: '',
                    attrs: stats
                });
                this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                this.rootDirectory.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                this.provider.fireDeviceChanged(this);
            });
            
            this.contextValue = DeviceState.Connected;
            this.iconPath.dark = path.join(resourceDir, 'icons', 'dark', 'green-circle.svg');
            this.iconPath.light = path.join(resourceDir, 'icons', 'light', 'green-circle.svg');
        });
    }

    private handleClientError(err: any): void {
        this.contextValue = DeviceState.Disconnected;
        this.iconPath.dark = path.join(resourceDir, 'icons', 'dark', 'red-circle.svg');
        this.iconPath.light = path.join(resourceDir, 'icons', 'light', 'red-circle.svg');
        this.rootDirectory = undefined;
        this.collapsibleState = vscode.TreeItemCollapsibleState.None;
        this.provider.fireDeviceChanged(this);
        // only show error message if we never connected
        if (!this.sftp) {
            vscode.window.showErrorMessage(`Failed to connect to ${this.label}: ${err.message}`);
        }
    }

    chmod(path: string, mode: string | number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.sftp.chmod(path, mode, err => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
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

    shell(window: ssh2.PseudoTtyOptions): Promise<ssh2.ClientChannel> {
        return new Promise((resolve, reject) => {
            const options = <ssh2.ShellOptions> {
                env: vscode.workspace.getConfiguration('ev3devBrowser').get('env')
            };
            this.client.shell(window, options, (err, stream) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(stream);
                }
            });
        })
    }

    mkdir(path: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.sftp.mkdir(path, err => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
    }

    /**
     * Recursively create a directory (equivalent of mkdir -p).
     * @param path the path
     */
    async mkdir_p(path: string): Promise<void> {
        const names = path.split('/');
        let part = '';
        while (names.length) {
            part += names.shift() + '/';
            // have to make sure the directory exists on the remote device first
            try {
                await this.stat(part);
            }
            catch (err) {
                if (err.code != 2 /* file does not exist */) {
                    throw err;
                }
                await this.mkdir(part);
            }
        }
    }

    put(local: string, remote: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.sftp.fastPut(local, remote, (err) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
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

    stat(path: string): Promise<ssh2Streams.Stats> {
        return new Promise((resolve, reject) => {
            this.sftp.stat(path, (err, stats) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(stats);
                }
            });
        });
    }

    unlink(path: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.sftp.unlink(path, err => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            })
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
        const term = vscode.window.createTerminal(`SSH: ${this.label}`,
            shellPath,
            [this.shellPort.toString()]);
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

            const conn = await this.exec('fbgrab -');
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
		dark: path.join(resourceDir, 'icons', 'dark', 'yellow-circle.svg'),
		light: path.join(resourceDir, 'icons', 'light', 'yellow-circle.svg')
	};
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
        this.device.unlink(this.path).then(() => {
            this.device.provider.fireFileChanged(this.parent);
        }, err => {
            vscode.window.showErrorMessage(`Error deleting '${this.path}': ${err.message}`);
        });
    }
}
