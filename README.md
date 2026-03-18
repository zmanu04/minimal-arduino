# Minimal Arduino for VS Code

Minimal Arduino is a lightweight extension that integrates `arduino-cli` into VS Code. It provides a fast, native development environment for Arduino projects without the overhead of the official IDE.

## Features

* **Auto-Configured IntelliSense:** Automatically resolves complex C/C++ include paths (like ESP32 and FreeRTOS) to eliminate false `#include` errors.
* **Project Memory:** Saves your target board and COM port settings per workspace folder.
* **Smart Uploads:** Auto-selects the COM port if only one board is connected, or prompts you if multiple are found.
* **Library Manager:** Search, install, and manage libraries directly from the VS Code sidebar.
* **Native UI:** Integrates cleanly with VS Code, providing quick actions in the editor menu and status bar.

## Prerequisites

1. **Arduino CLI:** Must be downloaded manually. Provide the path to `arduino-cli.exe` in the extension settings.
2. **C/C++ Extension:** Required for code navigation and IntelliSense (`ms-vscode.cpptools`).
3. **Serial Monitor Extension (Optional):** Recommended for reading serial output (`ms-vscode.vscode-serial-monitor`).

## Getting Started

1. **Configure CLI:** Open VS Code Settings (`Ctrl + ,`), search for `Minimal Arduino: Cli Path`, and enter the absolute path to `arduino-cli.exe`.
2. **Create a Sketch:** Open an empty folder and run the **New Sketch** command to generate the `.ino` file.
3. **Select Board & Port:** Use the status bar at the bottom left to choose your target board and COM port.
4. **Compile & Upload:** Use the editor menu buttons (top right) to Verify or Upload your code.

## Interface Guide

* **Status Bar (Bottom):** Select your board, COM port, and board-specific options.
* **Sidebar (Activity Bar):** View installed boards, connected ports, and manage libraries.
* **Editor Menu (Top Right):** Quick access to Verify, Upload, Serial Monitor, and New Sketch commands.