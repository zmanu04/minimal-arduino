# Minimal Arduino - Lightweight Arduino IDE for VS Code

Minimal Arduino is a custom, lightning-fast VS Code extension that replaces the heavy official Arduino IDE. By wrapping the official `arduino-cli`, it provides a seamless, native VS Code experience without the clutter.

## Features

* **Smart Project Memory:** Remembers your exact Target Board, COM Port, and Baud Rate on a per-folder basis. Switch between an ESP32 project and an Uno project, and your settings update automatically.
* **Smart Uploads & Fallbacks:** Forgot to select a port? If only one Arduino is plugged in, it auto-selects it and uploads. If multiple are plugged in, it instantly drops down a Quick Pick menu. 
* **Interactive Library Manager:** A dedicated sidebar to view installed libraries. Search the entire 13,000+ Arduino registry, pick specific release versions, and install them directly inside VS Code.
* **Aggressive Port Detection:** Uses native Windows PowerShell commands to perfectly identify real connected COM ports, ignoring dead or disconnected Bluetooth ports.
* **Native Serial Monitor:** Fully integrated with Microsoft's official Serial Monitor API for a polished, dedicated data-streaming UI.
* **One-Click Sketch Generation:** Click the "New Sketch" button to automatically generate the strict Folder + `.ino` file structure Arduino requires, fully populated with `setup()` and `loop()` boilerplate.

## UI Layout

Minimal Arduino cleans up the interface to keep you focused on your code.

**Top Editor Menu (When a `.ino` is open):**
1. **New Sketch:** Generates a new project folder/file.
2. **Refresh:** Re-scans your USB ports and local library folders.
3. **Verify:** Compiles your code.
4. **Upload:** Flashes your code to the board.
5. **Serial Monitor:** Opens the live data stream.

**Activity Bar (The Minimal Arduino Sidebar):**
* **Target Board:** Search and select from hundreds of Arduino/ESP boards.
* **Connected Ports:** View and select currently attached USB hardware.
* **Library Manager:** View downloaded libraries, versions, and search for new ones.

## Prerequisites & Requirements

1. **Arduino CLI (Required):** This extension requires the official `arduino-cli`. You must download it to your computer and point the extension to its location via VS Code Settings.
2. **Windows OS:** The aggressive COM port detection currently relies on native Windows PowerShell commands.
3. **Microsoft Serial Monitor:** The extension will automatically prompt you to install Microsoft's official `ms-vscode.vscode-serial-monitor` if you don't already have it installed.

## Getting Started

1. **Link the CLI:** Open your VS Code Settings (`Ctrl + ,`), search for `Minimal Arduino: Cli Path`, and paste the absolute path to your `arduino-cli.exe` (e.g., `C:\Program Files\arduino-cli\arduino-cli.exe`). Do not include quotes.
2. **Start a Project:** Open any empty folder in VS Code.
3. **Create a Sketch:** Click the **New Sketch** button at the top right to generate your `.ino` file and boilerplate code.
4. **Compile:** Click **Verify/Compile**. If you haven't picked a board yet, the extension will smartly ask you to search for one.
5. **Upload:** Plug in your Arduino and click **Upload**.