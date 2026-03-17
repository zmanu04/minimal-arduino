import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// --- GLOBAL VARIABLES ---
let currentBoard = "";
let currentPort = "";
let statusBarBoard: vscode.StatusBarItem;
let statusBarBoardOptions: vscode.StatusBarItem;
let statusBarPort: vscode.StatusBarItem;

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
    
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document.fileName.endsWith('.ino')) {
        vscode.window.showWarningMessage("Please open a .ino file to configure IntelliSense for it.");
        return;
    }
    
    const sketchDir = path.dirname(editor.document.uri.fsPath);
    
    // Put .vscode in the Workspace root (the main opened folder), fallback to sketch folder
    let rootPath = sketchDir;
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    }

    const vscodeFolder = path.join(rootPath, '.vscode');
    const buildPath = path.join(vscodeFolder, 'build');

    try {
        const sketchPathArg = `"${sketchDir}"`;
        const output = await runCommandAsync(`"${cli}" compile --fqbn ${fqbn} --show-properties --build-path "${buildPath}" ${sketchPathArg}`);
        
        const props: { [key: string]: string } = {};
        output.split('\n').forEach(line => {
            const parts = line.split('=');
            if (parts.length >= 2) props[parts[0].trim()] = parts.slice(1).join('=').trim();
        });

        // Add a helper to expand Arduino variables (e.g., {compiler.sdk.path})
        const expandVars = (str: string | undefined): string => {
            if (!str) return "";
            let result = str;
            let lastResult = "";
            let depth = 0;
            while (result !== lastResult && depth < 10) {
                lastResult = result;
                result = result.replace(/\{([a-zA-Z0-9_\-\.]+)\}/g, (m, key) => props[key] !== undefined ? props[key] : m);
                depth++;
            }
            return result;
        };

        const cleanPath = (p: string) => p ? p.replace(/\\/g, '/').replace(/"/g, '') : "";
        const platformPath = cleanPath(expandVars(props["runtime.platform.path"]));
        const corePath = cleanPath(expandVars(props["build.core.path"])) || `${platformPath}/cores/${expandVars(props["build.core"])}`;
        const variantPath = cleanPath(expandVars(props["build.variant.path"])) || `${platformPath}/variants/${expandVars(props["build.variant"])}`;

        let compilerPath = cleanPath(expandVars(props["compiler.path"]));
        if (compilerPath.endsWith('/')) compilerPath = compilerPath.slice(0, -1);
        let compilerCmd = cleanPath(expandVars(props["compiler.cpp.cmd"])) || "g++";
        
        let fullCompilerPath = compilerPath ? `${compilerPath}/${compilerCmd}` : compilerCmd;
        if (process.platform === "win32" && !fullCompilerPath.toLowerCase().endsWith(".exe")) fullCompilerPath += ".exe";
        
        // DYNAMIC COMPILER FALLBACK: Resolve unexpanded variables (prevents fallback to AVR compiler)
        if (fullCompilerPath.includes('{')) {
            const match = fullCompilerPath.match(/\{runtime\.tools\.([^}]+)\.path\}/);
            if (match && platformPath) {
                const toolName = match[1];
                // Go up from .../packages/<vendor>/hardware/<arch>/<version> to .../packages/<vendor>
                const packageVendorRoot = path.join(platformPath, '..', '..', '..');
                const toolsDir = path.join(packageVendorRoot, 'tools', toolName);
                if (fs.existsSync(toolsDir)) {
                    const versions = fs.readdirSync(toolsDir).filter(v => /^\d/.test(v)); // Filter out non-version folders
                    // Get the latest version by sorting
                    const latestVersion = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).shift();
                    if (latestVersion) {
                        const resolvedToolPath = cleanPath(path.join(toolsDir, latestVersion));
                        fullCompilerPath = fullCompilerPath.replace(match[0], resolvedToolPath);
                    }
                }
            }
        }
        
        if (!fs.existsSync(fullCompilerPath)) fullCompilerPath = ""; // Prevent VS Code probe crash on invalid path

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
        const cleanSketchDir = cleanPath(sketchDir);
        
        // Start with the sketch directory
        let rawIncludePaths: string[] = [ cleanSketchDir ];

        // Recursively scan the build path for all subdirectories to find generated headers
        const scanBuildDir = (dir: string) => {
            if (!fs.existsSync(dir)) return;
            rawIncludePaths.push(cleanPath(dir));
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        scanBuildDir(path.join(dir, entry.name));
                    }
                }
            } catch (e) {}
        };
        scanBuildDir(buildPath);

        // Add core and variant paths FIRST (No wildcards to prevent crashing the extension)
        if (corePath) rawIncludePaths.push(corePath);
        if (variantPath) rawIncludePaths.push(variantPath);

        // Setup the base Preprocessor Defines
        let rawDefines: string[] = [
            "ARDUINO=10800",
            props["build.board"] ? `ARDUINO_${props["build.board"]}` : "ARDUINO_BOARD",
            "F_CPU=" + (props["build.f_cpu"] || "16000000L"),
            "USBCON"
        ];
        
        let forcedIncludes: string[] = arduinoHPath ? [arduinoHPath] : [];
        let pendingIncludes: string[] = [];
        let missingResponseFile = false;
        let esp32ResponseFileReferenced = false;

        // Helper to robustly parse defines from compiler flags
        const parseDefine = (dMatch: string): string => {
            let define = dMatch.replace(/^-D\s*/, '');
            // If it starts with a quote, it's a quoted define. It might be malformed by the CLI.
            if (define.startsWith('"')) {
                // Remove the leading quote.
                define = define.substring(1);
                // If a trailing quote exists, remove it.
                if (define.endsWith('"')) {
                    define = define.slice(0, -1);
                }
            }
            // Finally, un-escape any internal quotes that the CLI added.
            return define.replace(/\\"/g, '"');
        };

        // ESP32 FIX: The most reliable way to get all includes is to parse them from the compiler flags.
        // The compiler flag properties contain space-separated compiler flags, including -I paths.
        // ESP32 Core v3+ offloads its response files (@includes.txt) into the 'includes' property!
        const flagProperties = [ 
            props["includes"],
            props["compiler.c.flags"], 
            props["compiler.cpp.flags"], 
            props["compiler.cpreprocessor.flags"],
            props["build.extra_flags"]
        ];
        for (let prop of flagProperties) {
            if (!prop) continue;

            prop = expandVars(prop); // EXPAND VARIABLES FIRST

            // ESP32 Core v3+ FIX: Read compiler response files (@"path/to/file") which offload the actual -I flags due to Windows path limits
            const responseFileMatches = prop.match(/@"([^"]+)"|@(\S+)/g) || [];
            for (const match of responseFileMatches) {
                esp32ResponseFileReferenced = true;
                let filePath = match.startsWith('@"') ? match.slice(2, -1) : match.slice(1);
                filePath = cleanPath(filePath);
                if (fs.existsSync(filePath)) {
                    let fileContent = fs.readFileSync(filePath, 'utf8');
                    fileContent = fileContent.replace(/\0/g, ''); // Fix potential UTF-16 parsing failures
                    fileContent = expandVars(fileContent); // EXPAND VARIABLES INSIDE THE FILE TOO
                    const fileMatches = fileContent.match(/-(?:I|isystem)\s*("[^"]+"|[^\s]+)/g) || [];
                    for (const fMatch of fileMatches) {
                        let includePath = fMatch.replace(/^-(?:I|isystem)\s*/, '').replace(/^"|"$/g, '');
                        rawIncludePaths.push(cleanPath(includePath));
                    }
                    
                    // Extract Defines (-D) from compiler response files
                    const defineMatches = fileContent.match(/-D\s*("[^"]+"|[^\s]+)/g) || [];
                    for (const dMatch of defineMatches) {
                        rawDefines.push(parseDefine(dMatch));
                    }

                    // Extract Forced Includes (-include) from compiler response files
                    const includeFileMatches = fileContent.match(/-include\s*("[^"]+"|[^\s]+)/g) || [];
                    for (const iMatch of includeFileMatches) {
                        let incFile = iMatch.replace(/^-include\s*/, '').replace(/^"|"$/g, '');
                        if (fs.existsSync(cleanPath(incFile))) {
                            forcedIncludes.push(cleanPath(incFile));
                        } else {
                            pendingIncludes.push(incFile); // Save relative paths for absolute resolution later
                        }
                    }
                } else {
                    missingResponseFile = true;
                }
            }

            // This regex handles quoted and unquoted include/isystem flags
            const matches = prop.match(/-(?:I|isystem)\s*("[^"]+"|[^\s]+)/g) || [];
            for (const match of matches) {
                let includePath = match.replace(/^-(?:I|isystem)\s*/, '').replace(/^"|"$/g, '');
                rawIncludePaths.push(cleanPath(includePath));
            }

            // Extract Defines (-D) from normal compiler properties
            const propDefines = prop.match(/-D\s*("[^"]+"|[^\s]+)/g) || [];
            for (const dMatch of propDefines) {
                rawDefines.push(parseDefine(dMatch));
            }

            // Extract Forced Includes (-include) from normal compiler properties
            const propIncludes = prop.match(/-include\s*("[^"]+"|[^\s]+)/g) || [];
            for (const iMatch of propIncludes) {
                let incFile = iMatch.replace(/^-include\s*/, '').replace(/^"|"$/g, '');
                if (fs.existsSync(cleanPath(incFile))) {
                    forcedIncludes.push(cleanPath(incFile));
                } else {
                    pendingIncludes.push(incFile); // Save relative paths for absolute resolution later
                }
            }
        }

        // FAILSAFE: Explicitly parse generated includes.txt files if the property evaluation missed them
        const failsafeIncludes = [
            path.join(buildPath, 'sketch', 'includes.txt'),
            path.join(buildPath, 'core', 'includes.txt')
        ];
        for (const fsInc of failsafeIncludes) {
            if (fs.existsSync(fsInc)) {
                let fileContent = fs.readFileSync(fsInc, 'utf8').replace(/\0/g, '');
                const fileMatches = fileContent.match(/-(?:I|isystem)\s*("[^"]+"|[^\s]+)/g) || [];
                for (const fMatch of fileMatches) {
                    let includePath = fMatch.replace(/^-(?:I|isystem)\s*/, '').replace(/^"|"$/g, '');
                    rawIncludePaths.push(cleanPath(includePath));
                }
            }
        }

        // FAILSAFE: Force-include sdkconfig.h so IntelliSense knows the exact chip target
        // This solves phantom inactive block errors (like xtensa/config/core.h on a RISC-V chip)
        const possibleSdkConfigs = [
            path.join(buildPath, 'core', 'sdkconfig.h'),
            path.join(buildPath, 'config', 'sdkconfig.h'),
            path.join(buildPath, 'sketch', 'sdkconfig.h'),
            path.join(buildPath, 'sdkconfig.h')
        ];
        for (const p of possibleSdkConfigs) {
            if (fs.existsSync(p)) {
                forcedIncludes.push(cleanPath(p));
                break; // Only include it once
            }
        }

        // ESP32 Direct SDK Path Fallback
        const sdkPath = cleanPath(expandVars(props["compiler.sdk.path"]));
        if (sdkPath) {
            rawIncludePaths.push(sdkPath);
        }

        const arch = (props["build.arch"] || "").toLowerCase();
        const mcu = props["build.mcu"] ? props["build.mcu"].toUpperCase() : "";

        // HOTFIX for ESP32 Core v3+: The CLI sometimes fails to provide the paths to deeply nested FreeRTOS headers
        if (arch.includes("esp")) {
            // Find any property that gives us the path to the esp32c6-libs (or similar) tool directory
            const espToolPathKey = Object.keys(props).find(k => k.startsWith("runtime.tools.") && k.includes("-libs.path"));
            if (espToolPathKey) {
                const espToolPath = cleanPath(expandVars(props[espToolPathKey]));

                // Explicitly force include sdkconfig.h so IntelliSense knows exactly which chip we are compiling for (RISC-V vs Xtensa)
                let sdkConfigPath = "";
                const findSdkConfig = (dir: string, depth: number) => {
                    if (depth > 6 || sdkConfigPath) return;
                    try {
                        const entries = fs.readdirSync(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            if (entry.isFile() && entry.name === 'sdkconfig.h') {
                                sdkConfigPath = path.join(dir, entry.name);
                                return;
                            } else if (entry.isDirectory()) {
                                findSdkConfig(path.join(dir, entry.name), depth + 1);
                            }
                        }
                    } catch (e) {}
                };
                findSdkConfig(espToolPath, 0);
                if (sdkConfigPath) forcedIncludes.push(cleanPath(sdkConfigPath));

                const mcuStr = mcu.toLowerCase();
                const isRiscV = mcu.includes("C2") || mcu.includes("C3") || mcu.includes("C6") || mcu.includes("H2");
                const archToSkip = isRiscV ? "xtensa" : "riscv";

                // Targeted Recursive Scanner: Scans only the critical components that cause nested include errors.
                // This avoids VS Code's path limit while guaranteeing no nested headers are missed.
                rawIncludePaths.push(cleanPath(path.join(espToolPath, 'include')));
                
                const scanComponentForIncludes = (base: string, depth: number) => {
                    if (depth > 6 || !fs.existsSync(base)) return;
                    try {
                        const entries = fs.readdirSync(base, { withFileTypes: true });
                        let hasHeaders = false;
                        for (const entry of entries) {
                            if (entry.isDirectory()) {
                                const dirName = entry.name.toLowerCase();
                                if (dirName === archToSkip) continue; // Block wrong architecture completely
                                
                                const fullPath = path.join(base, entry.name);
                                if (entry.name === 'include') rawIncludePaths.push(cleanPath(fullPath));
                                scanComponentForIncludes(fullPath, depth + 1);
                            } else if (!hasHeaders && entry.isFile() && entry.name.endsWith('.h')) {
                                hasHeaders = true;
                            }
                        }
                        if (hasHeaders) rawIncludePaths.push(cleanPath(base));
                    } catch (e) {}
                };

                const componentsToScan = ['freertos', 'soc', 'hal', 'esp_hw_support', 'esp_system', 'esp_common', 'config', isRiscV ? 'riscv' : 'xtensa'];
                for (const comp of componentsToScan) {
                    scanComponentForIncludes(path.join(espToolPath, 'include', comp), 0);
                }
            }
        }


        // Resolve pending includes (like "sdkconfig.h") against discovered include paths
        for (const incFile of pendingIncludes) {
            for (const dir of rawIncludePaths) {
                const fullPath = path.join(dir, incFile);
                if (fs.existsSync(fullPath)) {
                    forcedIncludes.push(cleanPath(fullPath));
                    break;
                }
            }
        }

        // Remove duplicates and ensure paths are clean
        const uniquePaths = [...new Set(rawIncludePaths)];

        // Filter out folders that don't exist to prevent VS Code warnings
        const includePaths = uniquePaths.filter(p => {
            const baseDir = p.replace('/**', '');
            return fs.existsSync(baseDir);
        });

        // --- SMART ARCHITECTURE MAPPING ---
        if (arch) {
            rawDefines.push(`ARDUINO_ARCH_${arch.toUpperCase()}`);
            if (arch === "esp8266") rawDefines.push("ESP8266");
        }
        if (mcu) {
            rawDefines.push(mcu);
            if (arch.includes("esp")) {
                rawDefines.push(`CONFIG_IDF_TARGET_${mcu}=1`); // CRITICAL: Hardcodes chip target to stop Xtensa fallback
                if (mcu.includes("C3") || mcu.includes("C6") || mcu.includes("H2")) {
                    rawDefines.push("CONFIG_IDF_TARGET_ARCH_RISCV=1");
                } else {
                    rawDefines.push("CONFIG_IDF_TARGET_ARCH_XTENSA=1");
                }
            }
        }
        
        // Automatically adapt IntelliSense to the user's Operating System
        const osPrefix = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
        let intellisenseMode = `${osPrefix}-gcc-x64`; // Default fallback
        if (arch.includes("arm") || arch.includes("samd") || arch.includes("rp2040") || fullCompilerPath.toLowerCase().includes("arm")) {
            intellisenseMode = `${osPrefix}-gcc-arm`;
        } else if (arch.includes("avr")) {
            intellisenseMode = `${osPrefix}-gcc-x86`; // 8-bit AVRs are closer to x86 constraints
        } else if (arch.includes("esp") || arch.includes("xtensa") || arch.includes("riscv")) {
            intellisenseMode = `${osPrefix}-gcc-x86`; // Force 32-bit mode for ESP32/RISCV to prevent sizeof pointer crashes
        }

        // CRITICAL FIX: Passing `-mmcu` to Xtensa/RISC-V compilers fatally crashes the C/C++ extension's background compiler probe.
        const compilerArgs = (arch === "avr" && props["build.mcu"]) ? [`-mmcu=${props["build.mcu"]}`] : [];

        // BUILD THE PERFECT CONFIG
        const config = {
            configurations: [{
                name: "Minimal Arduino",
                compilerPath: fullCompilerPath, // Feed exact path to VS Code so the native probe can run
                compilerArgs: compilerArgs,
                intelliSenseMode: intellisenseMode,
                includePath: includePaths,
                forcedInclude: [...new Set(forcedIncludes)],
                defines: [...new Set(rawDefines)],
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
        
        if (esp32ResponseFileReferenced && missingResponseFile) {
            vscode.window.showWarningMessage("ESP32 requires a first-time build! Please click 'Verify / Compile', then select your board again to fix IntelliSense.");
        } else {
            vscode.window.showInformationMessage(`IntelliSense OK! Hardware mapped to ${arch.toUpperCase() || "Default"}.`);
        }

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
        if (this.iconName === "plug" && this.actionValue) {
            this.command = {
                command: "minimalArduino.setPort",
                title: "Select Port",
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
                if (this.type === 'ports') {
                    const portName = l.trim().split(/\s+/)[0]; // Strictly isolate the port name (e.g., COM3)
                    return new ArduinoItem(portName, p[p.length-1] || "Unknown", "plug", portName);
                }
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
    statusBarBoardOptions = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    statusBarPort = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    currentBoard = context.workspaceState.get<string>("lastBoard", "");
    currentPort = context.workspaceState.get<string>("lastPort", "");
    
    statusBarBoard.text = `$(circuit-board) ${currentBoard ? (currentBoard.split(':')[2] || currentBoard) : "Select Board"}`;
    statusBarBoard.tooltip = currentBoard;
    statusBarBoard.show();

    statusBarBoardOptions.text = `$(settings-gear)`;
    statusBarBoardOptions.tooltip = "Configure Board Options (USB CDC, Flash Size, etc.)";
    statusBarBoardOptions.command = "minimalArduino.configureBoard";
    if (currentBoard) statusBarBoardOptions.show();

    statusBarPort.text = `$(plug) ${currentPort || "Select Port"}`;
    statusBarPort.show();

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
            statusBarBoard.text = `$(circuit-board) ${fqbn.split(':')[2] || fqbn}`;
            statusBarBoard.tooltip = fqbn;
            statusBarBoardOptions.show();

            // --- AUTO-INSTALL CORE ---
            // Explicitly install the core for the selected board to ensure all headers (like FreeRTOS.h) are available.
            const cli = getCliPath();
            const coreParts = fqbn.split(':');
            if (coreParts.length >= 2) {
                const coreName = `${coreParts[0]}:${coreParts[1]}`;
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Verifying board package: ${coreName}`,
                    cancellable: false
                }, async () => {
                    try {
                        // This command is idempotent. It downloads if missing, otherwise does nothing.
                        await runCommandAsync(`"${cli}" core install ${coreName}`);
                    } catch (e: any) {
                        // Don't block if it fails (e.g., network error). The compile step later will be the final judge.
                        console.warn(`Could not pre-install core ${coreName}: ${e.message}`);
                        vscode.window.showWarningMessage(`Failed to install board package ${coreName}. IntelliSense may be inaccurate.`);
                    }
                });
            }

            await updateIntellisenseConfig(fqbn);
        }),

        vscode.commands.registerCommand("minimalArduino.configureBoard", async () => {
            if (!currentBoard) return vscode.window.showErrorMessage("Select a board first!");
            const cli = getCliPath();
            
            // Break down FQBN into its base board and its current options
            const parts = currentBoard.split(':');
            const baseFqbn = parts.slice(0, 3).join(':');
            let currentOptions = parts.length > 3 ? parts[3] : "";

            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Fetching Board Options..." }, async () => {
                try {
                    const stdout = await runCommandAsync(`"${cli}" board details -b ${baseFqbn} --format json`);
                    const details = JSON.parse(stdout);

                    if (!details.config_options || details.config_options.length === 0) {
                        return vscode.window.showInformationMessage("This board has no configurable options.");
                    }

                    // Step 1: Pick an Option (e.g., USB CDC On Boot)
                    const optionItems: (vscode.QuickPickItem & { original: any })[] = details.config_options.map((opt: any) => ({
                        label: opt.option_label || opt.option, description: opt.option, original: opt
                    }));
                    const selectedOption = await vscode.window.showQuickPick(optionItems, { placeHolder: "Select a configuration option (e.g., USB CDC On Boot)" });
                    if (!selectedOption) return;

                    // Step 2: Pick a Value (e.g., Enabled)
                    const valueItems: (vscode.QuickPickItem & { originalValue: any })[] = selectedOption.original.values.map((val: any) => ({
                        label: val.value_label || val.value, description: val.value, originalValue: val.value
                    }));
                    const selectedValue = await vscode.window.showQuickPick(valueItems, { placeHolder: `Set value for ${selectedOption.label}` });
                    if (!selectedValue) return;

                    // Step 3: Reconstruct the FQBN string
                    const configs: { [key: string]: string } = {};
                    if (currentOptions) currentOptions.split(',').forEach(pair => { const [k, v] = pair.split('='); if (k && v) configs[k] = v; });
                    
                    if (selectedOption.description) {
                        configs[selectedOption.description] = selectedValue.originalValue; // Apply new setting
                    }
                    
                    const newConfigString = Object.entries(configs).map(([k, v]) => `${k}=${v}`).join(',');
                    const newFqbn = `${baseFqbn}:${newConfigString}`;
                    
                    // Step 4: Apply and trigger rebuild
                    vscode.commands.executeCommand("minimalArduino.setBoard", newFqbn);
                } catch (e: any) { vscode.window.showErrorMessage(`Failed to fetch board details: ${e.message}`); }
            });
        }),

        vscode.commands.registerCommand("minimalArduino.setPort", async (port: string) => {
            const cleanPort = port.trim().split(/\s+/)[0];
            currentPort = cleanPort;
            await context.workspaceState.update("lastPort", cleanPort);
            statusBarPort.text = `$(plug) ${cleanPort}`;
        }),

        vscode.commands.registerCommand("minimalArduino.autoDetect", () => {
            boardProvider.refresh(); portProvider.refresh(); libProvider.refresh();
        }),
        vscode.commands.registerCommand("minimalArduino.newSketch", async () => {
            const sketchName = await vscode.window.showInputBox({ 
                prompt: "Name your new Arduino sketch (no spaces):",
                placeHolder: "MyAwesomeProject" 
            });
            
            if (!sketchName) return;

            // Find where to put it
            let rootPath = "";
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            } else {
                vscode.window.showErrorMessage("Please open a folder in VS Code first!");
                return;
            }

            const sketchDir = path.join(rootPath, sketchName);
            const sketchFile = path.join(sketchDir, `${sketchName}.ino`);

            if (fs.existsSync(sketchDir)) {
                vscode.window.showErrorMessage(`A folder named "${sketchName}" already exists!`);
                return;
            }

            // Create the folder and the .ino file
            fs.mkdirSync(sketchDir, { recursive: true });
            const templateCode = `void setup() {\n  // put your setup code here, to run once:\n\n}\n\nvoid loop() {\n  // put your main code here, to run repeatedly:\n\n}\n`;
            fs.writeFileSync(sketchFile, templateCode);

            // Open the new file in the editor automatically
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sketchFile));
            vscode.window.showTextDocument(doc);
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
                        vscode.window.showInformationMessage(`${selection.label} installed successfully! Updating IntelliSense...`);
                        libProvider.refresh();
                        
                        // MAGIC FIX: Auto-update the C++ paths if a board is currently selected
                        if (currentBoard) {
                            await updateIntellisenseConfig(currentBoard);
                        }
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
    
    let terminal = vscode.window.terminals.find(t => t.name === 'Arduino');
    if (!terminal) {
        terminal = vscode.window.createTerminal(`Arduino`);
    }
    terminal.show();
    
    // MAGIC FIX: If the user wants to upload, tell the CLI to compile AND upload
    let cliAction = action;
    if (action === "upload") {
        cliAction = "compile --upload";
    }

    const callOperator = process.platform === "win32" ? "& " : "";
    const sketchDir = path.dirname(editor.document.fileName);
    
    // Use workspace root for build path
    let rootPath = sketchDir;
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    const buildPath = path.join(rootPath, '.vscode', 'build');
    let command = `${callOperator}"${cli}" ${cliAction} --fqbn ${currentBoard} --build-path "${buildPath}" "${sketchDir}"`;
    
    // Add the port flag if we are uploading
    if (action === "upload" && currentPort) {
        const cleanPort = currentPort.trim().split(/\s+/)[0];
        command += ` -p "${cleanPort}"`;
    }
    
    terminal.sendText(command);
}

export function deactivate() {}