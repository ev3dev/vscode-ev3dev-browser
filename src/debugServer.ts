import { DebugSession, Event, TerminatedEvent, Thread, ThreadEvent, StoppedEvent, ContinuedEvent, InitializedEvent } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';

/**
 * This interface should always match the schema found in the extension manifest.
 */
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** An absolute path to the program to debug. */
    program: string;
    /** Download files before running. Default is true. */
    download?: boolean;
    /** Run in terminal instead of output pane. */
    interactiveTerminal: boolean;
}

const THREAD_ID = 0;

export class Ev3devBrowserDebugSession extends DebugSession {
    protected initializeRequest(response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments): void {
        if (response.body) {
            response.body.supportTerminateDebuggee = true;
        }
        this.sendResponse(response);
    }

    protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
        this.sendEvent(new Event('ev3devBrowser.debugger.launch', args));
        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    protected customRequest(command: string, response: DebugProtocol.Response, args: any): void {
        switch (command) {
            case 'ev3devBrowser.debugger.thread':
                this.sendEvent(new ThreadEvent(args, THREAD_ID));
                this.sendResponse(response);
                break;
            case 'ev3devBrowser.debugger.terminate':
                this.sendEvent(new TerminatedEvent());
                this.sendResponse(response);
                break;
        }
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse,
        args: DebugProtocol.DisconnectArguments): void {
        this.sendEvent(new Event('ev3devBrowser.debugger.stop', args));
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = {
            threads: [
                new Thread(THREAD_ID, 'thread')
            ]
        };
        this.sendResponse(response);
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
        this.sendEvent(new Event('ev3devBrowser.debugger.interrupt', args));
        this.sendResponse(response);
    }
}

if (require.main === module) {
    DebugSession.run(Ev3devBrowserDebugSession);
}
