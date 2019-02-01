# Change Log
All notable changes to the "ev3dev-browser" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## 0.9.0 - 2018-01-31
### Changed
- Extension is replaced by "ev3dev.ev3dev-browser".

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
- Mulit-root workspace support
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