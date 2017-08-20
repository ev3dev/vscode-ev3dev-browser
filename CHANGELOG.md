# Change Log
All notable changes to the "ev3dev-browser" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## Unreleased
### Fixed
- Fix downloading projects with subdirectories
### Added
- Command to capture a screenshot from the remote device

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