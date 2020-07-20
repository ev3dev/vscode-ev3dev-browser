# Change Log
All notable changes to the "ev3dev-browser" extension will be documented in this file.

<!-- Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file. -->

## v1.2.0 - 2020-07-20
### Changed
- Initial debug configuration has new example to run current file
### Fixed
- Stop button does not kill all child processes
- Activate extension on command palette command
- Fix multiple network interfaces not updated on Windows when scanning for devices
- Fix race condition when browsing for connected devices
### Added
- ev3dev remote debugger is now a default debugger for Python files

## 1.1.0 - 2020-03-07
### Added
- New "pause" button on debugger that sends SIGINT to remote process
- New "interactiveTerminal" debugger option to run remote programs in
  interactive terminal instead of output pane
- New setting for device connection timeout
### Fixed
- Fix debugger restart button not working
- Fix numbers not allowed in `ev3devBrowser.env` variable names
### Changed
- SSH shell no longer requires native executable on Windows
- Device connection timeout increased to 30 seconds

## 1.0.4 - 2019-04-26
### Fixed
- Fix "Timed out while waiting for handshake" error
- Fix not working on Linux without Avahi installed

## 1.0.3 - 2019-03-25
### Changed
- `ev3devBrowser` debugger type no longer uses native executable.
- SSH shell no longer uses native executable on Linux and Mac.
### Fixed
- Fix debugger hanging when ev3dev Device Browser view is collapsed

## 1.0.2 - 2019-03-11
### Fixed
- Files are not downloaded when using global launch configuration
- No indication when zero files are downloaded

## 1.0.1 - 2019-02-02
### Fixed
- Duplicate listed devices in quick-pick on Windows
- SSH terminal not working

## 1.0.0 - 2019-01-31
### Fixed
- When using "Download and run", only current project is downloaded instead of
  entire workspace
### Changed
- Download progress is shown in notification instead of status bar
- Minimum VS Code version updated to 1.30
- Publisher changed to "ev3dev"

## 0.8.1 - 2018-07-14
### Fixed
- Error when trying to use file paths containing spaces (@WasabiFan)

## 0.8.0 - 2017-11-09
### Fixed
- Current working directory is not the same as when running programs with Brickman
- Context menu shown on root folder in remote file browser
### Changed
- Upload command remembers selected directory for each workspace

## 0.7.0 - 2017-10-24
### Added
- Multi-root workspace support
- Upload command
### Fixed
- Backslashes in directory names when downloading (Windows only)
- Cannot run remote files (Windows only)

## 0.6.0 - 2017-10-18
### Added
- Context menu item to connect to a different device
- Context menu item to show file info
### Changed
- Remote directories can be deleted
- Downloads can be canceled
### Fixed
- Connection timeout issues with Bluetooth and Wi-Fi

## 0.5.0 - 2017-09-14
### Added
- Battery voltage monitoring
- Refresh command/button
### Removed
- ev3devBrowser.visible configuration setting (@WasabiFan)
## Changed
- DNS-SD device discovery uses IPv6 instead of IPv4

## 0.4.0 - 2017-09-04
### Added
- Command to get system info from remote device (@WasabiFan)
- Configuration option and UI for adding devices that are not automatically
  discovered
### Fixed
- Incorrect date stamp in screenshots (@WasabiFan)
- Device still shows connected when the device is unplugged or the network is
  disconnected
- Tree view commands listed in command palette

## 0.3.1 - 2017-08-26
### Fixed
- Extra development files published with extension, resulting in large download

## 0.3.0 - 2017-08-26
### Added
- Debugger contribution point to allow download and run by pressing F5
- Device (re)connect/disconnect commands
- Command to capture a screenshot from the remote device (@WasabiFan)
### Changed
- Connect button is now an item in the tree view
### Fixed
- Download button shown when no device is connected
- Extra commands listed in command palette
- Device context menu shown when device not connected
- Fix downloading projects with subdirectories

## 0.2.0 - 2017-08-15
### Added
- Optional interactive password prompt
- Delete context menu item to delete remote files
- Connect button to initiate connection to a device
### Changed
- SSH sessions use internal shared connection instead of depending on
  external `ssh` and `plink.exe` programs
- File names are now sorted
- Device discovery improvements
- Improved handling of device disconnection
- Only connect to one device at a time
- Device browser can now be hidden via settings

## 0.1.0 - 2017-07-26
- Initial release
