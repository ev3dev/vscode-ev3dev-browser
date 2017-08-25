import { DebugSession, Event, TerminatedEvent } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';

/**
 * This interface should always match the schema found in the mock-debug extension manifest.
 */
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the program to debug. */
	program: string;
}


class Ev3devBrowserDebugSession extends DebugSession {
    protected initializeRequest(response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments): void
    {
        response.body.supportTerminateDebuggee = true;
        this.sendResponse(response);
    }

    protected launchRequest(response: DebugProtocol.LaunchResponse, args:LaunchRequestArguments): void {
        this.sendEvent(new Event('ev3devBrowser.downloadAndRun', {
            program: args.program
        }));
        // terminating for now since we are using existing quick-pick to stop program
        this.sendEvent(new TerminatedEvent());
    }

    protected customRequest(command: string, response: DebugProtocol.Response, args: any): void {
        switch (command) {
        case 'ev3devBrowser.terminate':
            this.sendEvent(new TerminatedEvent());
            this.sendResponse(response);
            break;
        }
    }
    
    protected disconnectRequest(response: DebugProtocol.DisconnectResponse,
        args: DebugProtocol.DisconnectArguments): void
    {
        this.sendEvent(new Event('ev3devBrowser.stop'));
        this.sendResponse(response);
    }
}

DebugSession.run(Ev3devBrowserDebugSession);
