# Change Log
All notable changes to the "ev3dev-browser" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## Unreleased
### Added
- Mulit-root workspace support

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