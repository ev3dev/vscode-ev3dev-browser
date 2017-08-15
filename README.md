# ev3dev browser for Visual Studio Code

This extension allows you to browse ev3dev devices from Visual Studio Code, send
files to these devices and remotely run programs.

Learn more about ev3dev at <http://www.ev3dev.org>.


## Requirements

This extension is only compatible with **ev3dev-stretch** [snapshot images] starting
with `2017-08-11`. It will not work with other versions of ev3dev.

Additional information can be found on the [wiki].

[snapshot images]: https://oss.jfrog.org/list/oss-snapshot-local/org/ev3dev/brickstrap/
[wiki]: https://github.com/ev3dev/vscode-ev3dev-browser/wiki


## Features

*   **Discover devices**: Any connected ev3dev device should be automatically discovered.
    No configuration necessary.

    ![Device connect button screenshot](.README/device-connect-button.png)

    ![Device quick-pick screenshot](.README/device-quick-pick.png)

*   **Remotely browse files**: Files for each device are listed just as they are in
    Brickman.

    ![File listing screenshot](.README/file-listing.png)

*   **Download files to the device**: The current VS Code project can be sent to an
    ev3dev device with a single click.

    ![Download button screenshot](.README/download-button.png)

*   **Remotely run programs**: Click any executable file to run it.

    ![Run quick-pick screenshot](.README/run-quick-pick.png)

    Right-clicking works too.

    ![Run context menu screenshot](.README/run-context-menu.png)

    Error messages will be displayed in the output pane.

    ![Output pane screenshot](.README/output-pane.png)

*   **Start a remote SSH session**: You can start an SSH session in the terminal pane
    by right-clicking on a device.

    ![Device context menu screenshot](.README/device-context-menu.png)


## Extension Settings

This extension contributes the following settings:

*   `ev3devBrowser.password`: If you changed the password on your ev3dev device,
     you will need to set the password here.
*   `ev3devBrowser.env`: If you need to set environment variables for running
    remote programs, you can set them here.
*   `ev3devBrowser.download.include`: Use this to specify which files to
    included when downloading files to the remote device. Can use glob patterns.
*   `ev3devBrowser.download.exclude`: Use this to specify which files to
    exclude when downloading files to the remote device. Can use glob patterns.
*   `ev3devBrowser.download.directory`: By default files are downloaded to
    a folder with the same name as the VS Code project. Use this setting to
    save the project files somewhere else. Paths are relative to the `/home/robot`
    directory.


## Known Issues

*   Currently, all downloaded files have the executable bit set.
*   Stopping a program only sends `SIGTERM`. If that doesn't actually stop the
    program then it can't be stopped remotely. There is not a way to send
    `SIGKILL` to forcefully stop it.
