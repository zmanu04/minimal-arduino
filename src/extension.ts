import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getSerialMonitorApi, Version, StopBits, Parity, LineEnding } from '@microsoft/vscode-serial-monitor-api';

interface LibraryQuickPickItem extends vscode.QuickPickItem {
    libData: any;
}

// Global State Variables (Now initialized inside activate so they can read memory)
let cliPath = "";
let currentBoard = "";
let currentPort = "";
let statusBarBoard: vscode.StatusBarItem;
let statusBarPort: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    console.log('minimalArduino is active!');

   // 1. Locate the Arduino CLI from VS Code Settings
    const config = vscode.workspace.getConfiguration('minimalArduino');
    let rawPath = config.get<string>('cliPath', '').trim();
    
    // BULLETPROOFING: Strip any accidental quotes the user pasted in the settings box
    cliPath = rawPath.replace(/^["']|["']$/g, '');

    // If the path is empty or invalid, throw a smart error with a shortcut button!
    if (!cliPath || !fs.existsSync(cliPath)) {
        vscode.window.showErrorMessage(
            "Minimal Arduino: Please configure the path to your arduino-cli.exe to continue.", 
            "Open Settings"
        ).then(choice => {
            if (choice === "Open Settings") {
                // Opens the settings menu directly to your specific text box
                vscode.commands.executeCommand('workbench.action.openSettings', 'minimalArduino.cliPath');
            }
        });
    }

    // --- MEMORY UPGRADE ---
    // Read the last used hardware from this specific project's memory
    currentBoard = context.workspaceState.get<string>('lastBoard', '');
    currentPort = context.workspaceState.get<string>('lastPort', '');

    // 2. Setup Status Bar (Injecting our remembered data!)
    statusBarBoard = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarBoard.text = `$(circuit-board) ${currentBoard}`;
    statusBarBoard.show();

    statusBarPort = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    statusBarPort.text = currentPort ? `$(plug) ${currentPort}` : `$(plug) No Port`;
    statusBarPort.show();

    // 3. Register Tree Data Providers
    const portProvider = new PortTreeProvider();
    vscode.window.registerTreeDataProvider('minimalArduino.portsView', portProvider);

    const boardProvider = new BoardTreeProvider();
    vscode.window.registerTreeDataProvider('minimalArduino.boardsView', boardProvider);

    const libProvider = new LibTreeProvider();
    vscode.window.registerTreeDataProvider('minimalArduino.libsView', libProvider);

    // 4. Register Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('minimalArduino.autoDetect', () => {
            portProvider.refresh();
            boardProvider.refresh();
            libProvider.refresh();
            vscode.window.showInformationMessage("minimalArduino: Hardware & Libraries refreshed.");
        }),

        // Updating Port (and saving to memory)
        vscode.commands.registerCommand('minimalArduino.setPort', (portName: string) => {
            currentPort = portName;
            context.workspaceState.update('lastPort', currentPort); // <--- SAVE TO MEMORY
            statusBarPort.text = `$(plug) ${currentPort}`;
            vscode.window.showInformationMessage(`Port selected: ${currentPort}`);
        }),

        // Updating Board from Sidebar (and saving to memory)
        vscode.commands.registerCommand('minimalArduino.setBoard', (boardFqbn: string) => {
            currentBoard = boardFqbn;
            context.workspaceState.update('lastBoard', currentBoard); // <--- SAVE TO MEMORY
            statusBarBoard.text = `$(circuit-board) ${currentBoard}`;
            vscode.window.showInformationMessage(`Board selected: ${currentBoard}`);
        }),

        // Interactive Board Search (and saving to memory)
        vscode.commands.registerCommand('minimalArduino.selectBoard', async () => {
            const fetchBoardsPromise = runCommandAsync(`"${cliPath}" board listall`).then(stdout => {
                const lines = stdout.split('\n').slice(1);
                const items: vscode.QuickPickItem[] = [];
                
                lines.forEach(line => {
                    const parts = line.trim().split(/\s{2,}/);
                    if (parts.length >= 2) {
                        items.push({
                            label: parts[0],
                            description: parts[1]
                        });
                    }
                });
                return items;
            });

            const selection = await vscode.window.showQuickPick(fetchBoardsPromise, { 
                placeHolder: 'Search for a board (e.g., Uno, Nano, ESP32)',
                matchOnDescription: true 
            });

            if (selection) {
                currentBoard = selection.description!;
                context.workspaceState.update('lastBoard', currentBoard); // <--- SAVE TO MEMORY
                statusBarBoard.text = `$(circuit-board) ${currentBoard}`;
                vscode.window.showInformationMessage(`Board set to: ${selection.label}`);
            }
        }),

        // Core Actions (Now passing context for memory access)
        vscode.commands.registerCommand('minimalArduino.compile', () => runCliTask('compile', "Arduino Build", context)),
        vscode.commands.registerCommand('minimalArduino.upload', () => runCliTask('upload', "Arduino Upload", context)),

        // Auto-Create New Sketch Boilerplate
        vscode.commands.registerCommand('minimalArduino.newSketch', async () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showErrorMessage("Please open a project folder first!");
                return;
            }

            const rootPath = workspaceFolders[0].uri.fsPath;
            const defaultName = path.basename(rootPath);

            // 1. Ask the user for the sketch name (defaults to current folder name)
            const sketchName = await vscode.window.showInputBox({
                prompt: "Name your new sketch (Creates the required Arduino folder & .ino file)",
                value: defaultName
            });

            if (!sketchName) return; // User cancelled

            // 2. Arduino Rule: Sketch file must match its parent folder.
            let targetDir = rootPath;
            if (sketchName !== defaultName) {
                targetDir = path.join(rootPath, sketchName);
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir);
                }
            }

            const sketchFile = path.join(targetDir, `${sketchName}.ino`);

            // 3. Prevent overwriting an existing sketch
            if (fs.existsSync(sketchFile)) {
                vscode.window.showErrorMessage(`A sketch named ${sketchName}.ino already exists here!`);
                const doc = await vscode.workspace.openTextDocument(sketchFile);
                vscode.window.showTextDocument(doc);
                return;
            }

            // 4. Generate the Boilerplate
            const boilerplate = `void setup() {\n  // put your setup code here, to run once:\n\n}\n\nvoid loop() {\n  // put your main code here, to run repeatedly:\n\n}\n`;
            
            try {
                fs.writeFileSync(sketchFile, boilerplate);
                
                // 5. Open it immediately in the editor
                const document = await vscode.workspace.openTextDocument(sketchFile);
                await vscode.window.showTextDocument(document);
                
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to create sketch: ${e.message}`);
            }
        }),
        
        // Library Manager
        vscode.commands.registerCommand('minimalArduino.installLib', async () => {
            const query = await vscode.window.showInputBox({ 
                prompt: "Search Arduino Library Manager (e.g., 'Servo', 'Adafruit')",
                placeHolder: "Enter library name..."
            });
            if (!query) return;

            await vscode.window.withProgress({ 
                location: vscode.ProgressLocation.Notification, 
                title: `Searching for '${query}'...` 
            }, async () => {
                try {
                    const output = await runCommandAsync(`"${cliPath}" lib search "${query}" --format json`);
                    
                    const firstBrace = output.indexOf('{');
                    const lastBrace = output.lastIndexOf('}');
                    if (firstBrace === -1 || lastBrace === -1) {
                        vscode.window.showInformationMessage(`No libraries found for '${query}'.`);
                        return;
                    }
                    
                    const data = JSON.parse(output.substring(firstBrace, lastBrace + 1));
                    
                    if (!data.libraries || data.libraries.length === 0) {
                        vscode.window.showInformationMessage(`No libraries found for '${query}'.`);
                        return;
                    }

                    const items: LibraryQuickPickItem[] = data.libraries.map((lib: any) => ({
                        label: lib.name,
                        description: `v${lib.latest_version || lib.version || ''}`,
                        detail: lib.sentence || "",
                        libData: lib
                    }));
                    
                    const selection = await vscode.window.showQuickPick(items, { 
                        placeHolder: 'Select a library to install',
                        matchOnDescription: true,
                        matchOnDetail: true
                    });
                    
                    if (!selection) return;

                    const lib = selection.libData;
                    let versions: string[] = [];

                    if (lib.releases && typeof lib.releases === 'object') {
                        versions = Array.isArray(lib.releases) 
                            ? lib.releases.map((r: any) => r.version) 
                            : Object.keys(lib.releases);
                    } else if (lib.available_versions) {
                        versions = lib.available_versions;
                    } else if (lib.latest_version || lib.version) {
                        versions = [lib.latest_version || lib.version];
                    }

                    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

                    const versionItems: vscode.QuickPickItem[] = versions.map(v => ({
                        label: v,
                        description: v === (lib.latest_version || lib.version) ? "(Latest)" : ""
                    }));

                    const versionSelection = await vscode.window.showQuickPick(versionItems, {
                        placeHolder: `Select a version to install for ${selection.label}`
                    });

                    if (!versionSelection) return;

                    const term = vscode.window.createTerminal("Arduino Lib Manager");
                    term.show();
                    term.sendText(`& "${cliPath}" lib install "${selection.label}@${versionSelection.label}"`);
                    setTimeout(() => libProvider.refresh(), 5000);
                    
                } catch(e: any) { 
                    console.error(e);
                    vscode.window.showErrorMessage(`Search Failed: ${e.message || "Invalid JSON from CLI"}`); 
                }
            });
        }),

        // Serial Monitor (Also upgraded to use Workspace Memory!)
        vscode.commands.registerCommand('minimalArduino.serialMonitor', async () => {
            if (!currentPort || currentPort === "None") {
                vscode.window.showErrorMessage("Please select a Port from the Activity Bar first!");
                return;
            }

            // Read last Baud Rate from Workspace Memory
            let lastBaud = context.workspaceState.get<string>('lastBaudRate', '9600');
            const standardRates = ['9600', '19200', '38400', '57600', '74880', '115200'];
            const filteredRates = standardRates.filter(b => b !== lastBaud);
            
            const baudItems: vscode.QuickPickItem[] = [
                { label: lastBaud, description: "(Last Used)" },
                ...filteredRates.map(b => ({ label: b }))
            ];

            const selection = await vscode.window.showQuickPick(baudItems, { 
                placeHolder: `Select Baud Rate` 
            });

            if (!selection) return;

            const selectedBaud = selection.label;
            context.workspaceState.update('lastBaudRate', selectedBaud); // <--- SAVE TO MEMORY

            const serialApi = await getSerialMonitorApi(Version.latest, context);
            
            if (!serialApi) {
                const response = await vscode.window.showErrorMessage(
                    "The official Microsoft Serial Monitor is required.", 
                    "Install Now"
                );
                if (response === "Install Now") {
                    vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-vscode.vscode-serial-monitor');
                }
                return;
            }

            await serialApi.startMonitoringPort({
                port: currentPort,
                baudRate: parseInt(selectedBaud),
                lineEnding: LineEnding.None,
                dataBits: 8,
                stopBits: StopBits.One,
                parity: Parity.None
            });
        })
    );

    vscode.commands.executeCommand('minimalArduino.autoDetect');
}

// --- HELPER FUNCTIONS ---

async function runCliTask(action: string, terminalName: string, context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showErrorMessage("Open an .ino file first!"); return; }

    // --- SMART BOARD FALLBACK ---
    if (!currentBoard || currentBoard === "None" || currentBoard === "") {
        const fetchBoardsPromise = runCommandAsync(`"${cliPath}" board listall`).then(stdout => {
            const lines = stdout.split('\n').slice(1);
            const items: vscode.QuickPickItem[] = [];
            
            lines.forEach(line => {
                const parts = line.trim().split(/\s{2,}/);
                if (parts.length >= 2) {
                    items.push({ label: parts[0], description: parts[1] });
                }
            });
            return items;
        });

        const selection = await vscode.window.showQuickPick(fetchBoardsPromise, { 
            placeHolder: 'No target board selected! Search and select one now:',
            matchOnDescription: true 
        });

        if (!selection) return; // User pressed escape and cancelled

        // Save the newly selected board to memory and update the UI
        currentBoard = selection.description!;
        context.workspaceState.update('lastBoard', currentBoard);
        statusBarBoard.text = `$(circuit-board) ${currentBoard}`;
    }

    // --- SMART PORT FALLBACK ---
    if (action === 'upload' && (!currentPort || currentPort === "None" || currentPort === "")) {
        const psCommand = 'powershell "Get-WMIObject Win32_PnPEntity | Where-Object { $_.Name -match \'(COM\\d+)\' } | Select-Object Name | ConvertTo-Json"';
        
        try {
            const stdout = await runCommandAsync(psCommand);
            if (!stdout) throw new Error("No ports");

            let data = JSON.parse(stdout);
            let ports = Array.isArray(data) ? data : [data];
            
            // Extract just the "COMX" strings
            let comPorts = ports.map(p => {
                const match = p.Name.match(/(COM\d+)/);
                return match ? match[1] : null;
            }).filter(p => p !== null) as string[];

            if (comPorts.length === 1) {
                // Exactly one port? Grab it automatically!
                currentPort = comPorts[0];
                vscode.window.showInformationMessage(`Auto-selected port: ${currentPort}`);
            } else if (comPorts.length > 1) {
                // Multiple ports? Ask them right now!
                const selection = await vscode.window.showQuickPick(comPorts, { 
                    placeHolder: "Select a port to upload to:" 
                });
                if (!selection) return; // User cancelled
                currentPort = selection;
            } else {
                vscode.window.showErrorMessage("No COM ports found. Is your board plugged in?");
                return;
            }

            // Save this new port to memory and update the Status Bar UI
            context.workspaceState.update('lastPort', currentPort);
            statusBarPort.text = `$(plug) ${currentPort}`;

        } catch (e) {
            vscode.window.showErrorMessage("No ports detected. Please plug in your board!");
            return;
        }
    }

    // --- EXECUTE CLI COMMAND ---
    const sketchPath = path.dirname(editor.document.fileName);
    const term = vscode.window.createTerminal(terminalName);
    term.show();
    
    let command = `& "${cliPath}" ${action} --fqbn ${currentBoard} "${sketchPath}"`;
    if (action === 'upload') {
        command += ` -p ${currentPort}`;
    }
    term.sendText(command);
}

function runCommandAsync(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.exec(command, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr || err.message));
            } else {
                resolve(stdout || "");
            }
        });
    });
}

// --- TREE DATA PROVIDERS ---

class PortTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined> = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> = this._onDidChangeTreeData.event;

    refresh(): void { this._onDidChangeTreeData.fire(undefined); }
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<vscode.TreeItem[]> {
        const psCommand = 'powershell "Get-WMIObject Win32_PnPEntity | Where-Object { $_.Name -match \'(COM\\d+)\' } | Select-Object Name, PNPDeviceID | ConvertTo-Json"';
        
        let items: vscode.TreeItem[] = [];
        try {
            const stdout = await runCommandAsync(psCommand);
            if (stdout) {
                let data = JSON.parse(stdout);
                let ports = Array.isArray(data) ? data : [data];
                
                ports.forEach(p => {
                    const match = p.Name.match(/COM(\d+)/);
                    if (match) {
                        const portName = match[0];
                        const item = new vscode.TreeItem(portName, vscode.TreeItemCollapsibleState.None);
                        item.description = p.Name.replace(`(${portName})`, '').trim();
                        item.iconPath = new vscode.ThemeIcon('plug');
                        item.command = { command: 'minimalArduino.setPort', title: "Select Port", arguments: [portName] };
                        items.push(item);
                    }
                });
            }
        } catch (e) { 
            console.error("No ports found", e); 
        }
        
        if (items.length === 0) {
            items.push(new vscode.TreeItem("No ports detected", vscode.TreeItemCollapsibleState.None));
        }
        return items;
    }
}

class BoardTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined> = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> = this._onDidChangeTreeData.event;

    refresh(): void { this._onDidChangeTreeData.fire(undefined); }
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<vscode.TreeItem[]> {
        let items: vscode.TreeItem[] = [];

        const searchItem = new vscode.TreeItem("Search All Boards...", vscode.TreeItemCollapsibleState.None);
        searchItem.iconPath = new vscode.ThemeIcon('search');
        searchItem.command = { command: 'minimalArduino.selectBoard', title: "Search Boards" };
        items.push(searchItem);

        try {
            const stdout = await runCommandAsync(`"${cliPath}" board listall`);
            const lines = stdout.split('\n').slice(1);
            
            lines.forEach(line => {
                const parts = line.trim().split(/\s{2,}/);
                if (parts.length >= 2) {
                    const item = new vscode.TreeItem(parts[0], vscode.TreeItemCollapsibleState.None);
                    item.description = parts[1];
                    item.iconPath = new vscode.ThemeIcon('circuit-board');
                    item.command = { command: 'minimalArduino.setBoard', title: "Select Board", arguments: [parts[1]] };
                    items.push(item);
                }
            });
        } catch (e) {
            console.error("Failed to fetch boards", e);
        }
        return items;
    }
}

class LibTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined> = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> = this._onDidChangeTreeData.event;

    refresh(): void { this._onDidChangeTreeData.fire(undefined); }
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<vscode.TreeItem[]> {
        let items: vscode.TreeItem[] = [];

        const searchItem = new vscode.TreeItem("Search & Install New...", vscode.TreeItemCollapsibleState.None);
        searchItem.iconPath = new vscode.ThemeIcon('search');
        searchItem.command = { command: 'minimalArduino.installLib', title: "Install Lib" };
        items.push(searchItem);

        try {
            const stdout = await runCommandAsync(`"${cliPath}" lib list`);
            const lines = stdout.split('\n').slice(1);
            
            lines.forEach(line => {
                const parts = line.trim().split(/\s{2,}/); 
                if (parts.length >= 2) {
                    const libName = parts[0];
                    const libVersion = parts[1];
                    
                    const item = new vscode.TreeItem(libName, vscode.TreeItemCollapsibleState.None);
                    item.description = `v${libVersion}`;
                    item.iconPath = new vscode.ThemeIcon('library');
                    item.tooltip = parts.join(' | ');
                    items.push(item);
                }
            });
        } catch (err) {
            console.error("Failed to list libraries", err);
        }

        if (items.length === 1) {
            const emptyItem = new vscode.TreeItem("No downloaded libraries found.", vscode.TreeItemCollapsibleState.None);
            items.push(emptyItem);
        }

        return items;
    }
}

export function deactivate() {}