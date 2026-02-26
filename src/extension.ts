import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// --- GLOBAL VARIABLES ---
let currentBoard = "";
let currentPort = "";
let statusBarBoard: vscode.StatusBarItem;

// --- 1. DYNAMIC PATH CONFIGURATION ---
function getCliPath(): string {
    const config = vscode.workspace.getConfiguration("minimalArduino");
    let rawPath = config.get<string>("cliPath", "").trim();
    return rawPath.replace(/^["']|["']$/g, "") || "arduino-cli";
}

function runCommandAsync(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.exec(command, { encoding: "utf8", maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout || "");
        });
    });
}

// --- 2. INTELLISENSE (BULLETPROOF GENERATION) ---
async function updateIntellisenseConfig(fqbn: string) {
    const cli = getCliPath();
    
    // Detect Workspace
    let rootPath = "";
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    } else if (vscode.window.activeTextEditor) {
        rootPath = path.dirname(vscode.window.activeTextEditor.document.uri.fsPath);
    }
    if (!rootPath) return;

    const vscodeFolder = path.join(rootPath, '.vscode');

    try {
        let sketchPath = vscode.window.activeTextEditor ? `"${path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)}"` : "";
        const output = await runCommandAsync(`"${cli}" compile --fqbn ${fqbn} --show-properties ${sketchPath}`);
        
        const props: { [key: string]: string } = {};
        output.split('\n').forEach(line => {
            const parts = line.split('=');
            if (parts.length >= 2) props[parts[0].trim()] = parts.slice(1).join('=').trim();
        });

        const cleanPath = (p: string) => p ? p.replace(/\\/g, '/').replace(/"/g, '') : "";
        const platformPath = cleanPath(props["runtime.platform.path"]);
        const corePath = cleanPath(props["build.core.path"]) || `${platformPath}/cores/${props["build.core"]}`;
        const variantPath = cleanPath(props["build.variant.path"]) || `${platformPath}/variants/${props["build.variant"]}`;

        let compilerPath = cleanPath(props["compiler.path"]);
        if (compilerPath.endsWith('/')) compilerPath = compilerPath.slice(0, -1);
        let compilerCmd = cleanPath(props["compiler.cpp.cmd"]) || "g++";
        
        let fullCompilerPath = compilerPath ? `${compilerPath}/${compilerCmd}` : compilerCmd;
        if (process.platform === "win32" && !fullCompilerPath.toLowerCase().endsWith(".exe")) fullCompilerPath += ".exe";

        const compilerBaseDir = path.dirname(path.dirname(fullCompilerPath)); 

        let arduinoHPath = "";
        const searchPaths = [corePath, `${corePath}/api`, `${platformPath}/api/core`];
        for (const p of searchPaths) {
            if (fs.existsSync(`${p}/Arduino.h`)) {
                arduinoHPath = `${p}/Arduino.h`;
                break;
            }
        }

        // --- BULLETPROOF PATH RESOLUTION ---
        const homeDir = cleanPath(os.homedir());
        const rawIncludePaths = [
            `${rootPath}/**`,
            `${corePath}/**`,
            `${variantPath}/**`,
            `${platformPath}/libraries/**`,
            `${homeDir}/Documents/Arduino/libraries/**`,
            `${homeDir}/OneDrive/Documents/Arduino/libraries/**`
        ];

        // DYNAMIC TOOLCHAIN SCANNER (Finds the hidden compiler folders regardless of architecture)
        if (fs.existsSync(compilerBaseDir)) {
            const subdirs = fs.readdirSync(compilerBaseDir);
            for (const dir of subdirs) {
                const includeTarget = path.join(compilerBaseDir, dir, 'include');
                if (fs.existsSync(includeTarget)) {
                    rawIncludePaths.push(`${cleanPath(includeTarget)}/**`);
                }
            }
            const gccLibPath = path.join(compilerBaseDir, 'lib', 'gcc');
            if (fs.existsSync(gccLibPath)) rawIncludePaths.push(`${cleanPath(gccLibPath)}/**`);
        }

        // Filter out folders that don't exist to prevent VS Code warnings
        const includePaths = rawIncludePaths.filter(p => {
            const baseDir = p.replace('/**', '');
            return fs.existsSync(baseDir);
        });

        // --- SMART ARCHITECTURE MAPPING ---
        const arch = (props["build.arch"] || "").toLowerCase();
        let intellisenseMode = "windows-gcc-x64"; // Default fallback
        if (arch.includes("arm") || arch.includes("samd") || arch.includes("rp2040") || fullCompilerPath.toLowerCase().includes("arm")) {
            intellisenseMode = "windows-gcc-arm";
        } else if (arch.includes("avr")) {
            intellisenseMode = "windows-gcc-x86"; // 8-bit AVRs are closer to x86 constraints
        }

        const mcu = props["build.mcu"];
        const compilerArgs = mcu ? [`-mmcu=${mcu}`] : [];

        // BUILD THE PERFECT CONFIG
        const config = {
            configurations: [{
                name: "Minimal Arduino",
                compilerPath: fs.existsSync(fullCompilerPath) ? fullCompilerPath : "",
                compilerArgs: compilerArgs,
                intelliSenseMode: intellisenseMode,
                includePath: includePaths,
                forcedInclude: arduinoHPath ? [arduinoHPath] : [],
                defines: [
                    "ARDUINO=10800",
                    props["build.board"] || "ARDUINO_BOARD",
                    "F_CPU=" + (props["build.f_cpu"] || "16000000L"),
                    "USBCON"
                ],
                cStandard: "c11",
                cppStandard: "c++17"
            }],
            version: 4
        };

        if (!fs.existsSync(vscodeFolder)) fs.mkdirSync(vscodeFolder, { recursive: true });
        fs.writeFileSync(path.join(vscodeFolder, 'c_cpp_properties.json'), JSON.stringify(config, null, 4));

        const settingsPath = path.join(vscodeFolder, 'settings.json');
        let settings: any = {};
        if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        
        if (!settings["files.associations"]) settings["files.associations"] = {};
        settings["files.associations"]["*.ino"] = "cpp";
        if (settings["C_Cpp.default.customConfigurationProvider"]) delete settings["C_Cpp.default.customConfigurationProvider"];

        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
        vscode.window.showInformationMessage(`IntelliSense OK! Hardware mapped to ${arch.toUpperCase() || "Default"}.`);

    } catch (e: any) {
        vscode.window.showErrorMessage(`IntelliSense Error: ${e.message}`);
    }
}

// --- 3. SIDEBAR DATA PROVIDER ---
class ArduinoItem extends vscode.TreeItem {
    constructor(
        public readonly label: string, 
        public readonly description: string, 
        public readonly iconName: string,
        public readonly actionValue?: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${this.label} (${this.description})`;
        this.iconPath = new vscode.ThemeIcon(iconName);
        this.contextValue = iconName; 
        
        if (this.iconName === "circuit-board" && this.actionValue) {
            this.command = {
                command: "minimalArduino.setBoard",
                title: "Select Board",
                arguments: [this.actionValue]
            };
        }
    }
}

class ArduinoProvider implements vscode.TreeDataProvider<ArduinoItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ArduinoItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private type: 'boards' | 'ports' | 'libs') {}
    refresh(): void { this._onDidChangeTreeData.fire(); }
    getTreeItem(element: ArduinoItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<ArduinoItem[]> {
        const cli = getCliPath();
        try {
            let cmd = this.type === 'boards' ? `"${cli}" board listall` : this.type === 'ports' ? `"${cli}" board list` : `"${cli}" lib list`;
            const stdout = await runCommandAsync(cmd);
            return stdout.split('\n').filter(l => l.trim().length > 0).slice(1).map(l => {
                const p = l.trim().split(/\s{2,}/);
                if (this.type === 'boards') return new ArduinoItem(p[0], p[1], "circuit-board", p[1]);
                if (this.type === 'ports') return new ArduinoItem(p[0], p[p.length-1] || "Unknown", "plug", p[0]);
                return new ArduinoItem(p[0], p[1] || "v?", "library");
            });
        } catch (e) {
            return [new ArduinoItem("Error", "Check CLI Path", "error")];
        }
    }
}

// --- 4. ACTIVATION & COMMANDS ---
export function activate(context: vscode.ExtensionContext) {
    statusBarBoard = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    currentBoard = context.workspaceState.get<string>("lastBoard", "");
    currentPort = context.workspaceState.get<string>("lastPort", "");
    
    statusBarBoard.text = `$(circuit-board) ${currentBoard || "Select Board"}`;
    statusBarBoard.show();

    const boardProvider = new ArduinoProvider('boards');
    const portProvider = new ArduinoProvider('ports');
    const libProvider = new ArduinoProvider('libs');

    vscode.window.registerTreeDataProvider('minimalArduino.boardsView', boardProvider);
    vscode.window.registerTreeDataProvider('minimalArduino.portsView', portProvider);
    vscode.window.registerTreeDataProvider('minimalArduino.libsView', libProvider);

    context.subscriptions.push(
        vscode.commands.registerCommand("minimalArduino.selectBoard", async () => {
            const cli = getCliPath();
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Loading boards..." }, async () => {
                try {
                    const stdout = await runCommandAsync(`"${cli}" board listall`);
                    const items = stdout.split('\n').slice(1).filter(l => l.trim().length > 0).map(l => {
                        const p = l.trim().split(/\s{2,}/);
                        return { label: p[0], description: p[1] };
                    });

                    const sel = await vscode.window.showQuickPick(items, { placeHolder: "Search Arduino boards..." });
                    if (sel) vscode.commands.executeCommand("minimalArduino.setBoard", sel.description);
                } catch (e) {
                    vscode.window.showErrorMessage("Failed to search boards. Is arduino-cli installed?");
                }
            });
        }),

        vscode.commands.registerCommand("minimalArduino.setBoard", async (fqbn: string) => {
            currentBoard = fqbn;
            await context.workspaceState.update("lastBoard", fqbn);
            statusBarBoard.text = `$(circuit-board) ${fqbn}`;
            await updateIntellisenseConfig(fqbn);
        }),

        vscode.commands.registerCommand("minimalArduino.autoDetect", () => {
            boardProvider.refresh(); portProvider.refresh(); libProvider.refresh();
        }),

        vscode.commands.registerCommand("minimalArduino.compile", () => runCliTask("compile")),
        vscode.commands.registerCommand("minimalArduino.upload", () => runCliTask("upload")),
        
        vscode.commands.registerCommand("minimalArduino.searchLibrary", async () => {
            const cli = getCliPath();
            const query = await vscode.window.showInputBox({ prompt: "Search for an Arduino Library" });
            if (!query) return;

            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Searching for "${query}"...`, cancellable: false }, async () => {
                try {
                    const stdout = await runCommandAsync(`"${cli}" lib search "${query}" --format json`);
                    const result = JSON.parse(stdout);
                    const libs = result.libraries || [];

                    if (libs.length === 0) {
                        vscode.window.showInformationMessage(`No library found for "${query}".`);
                        return;
                    }

                    const items: vscode.QuickPickItem[] = libs.map((lib: any) => ({
                        label: lib.name || "Unknown",
                        description: lib.author || "",
                        detail: lib.sentence || ""
                    }));

                    const selection = await vscode.window.showQuickPick(items, { placeHolder: "Select a library to install", matchOnDetail: true });

                    if (selection) {
                        vscode.window.showInformationMessage(`Installing ${selection.label}...`);
                        await runCommandAsync(`"${cli}" lib install "${selection.label}"`);
                        vscode.window.showInformationMessage(`${selection.label} installed successfully!`);
                        libProvider.refresh();
                    }
                } catch (e) {
                    vscode.window.showErrorMessage("Library search failed.");
                }
            });
        })
    );
}

async function runCliTask(action: string) {
    const cli = getCliPath();
    const editor = vscode.window.activeTextEditor;
    if (!editor || !currentBoard) {
        vscode.window.showErrorMessage("Please open a .ino file and select a board.");
        return;
    }
    const terminal = vscode.window.createTerminal(`Arduino ${action}`);
    terminal.show();
    let command = `& "${cli}" ${action} --fqbn ${currentBoard} "${path.dirname(editor.document.fileName)}"`;
    if (action === "upload" && currentPort) command += ` -p ${currentPort}`;
    terminal.sendText(command);
}

export function deactivate() {}