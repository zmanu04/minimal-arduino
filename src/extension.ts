/* eslint-disable @typescript-eslint/naming-convention */
'use strict';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// --- GLOBAL VARIABLES ---
let currentBoard = '';
let currentPort = '';
let statusBarBoard: vscode.StatusBarItem;
let statusBarPort: vscode.StatusBarItem;
let statusBarBoardOptions: vscode.StatusBarItem;

// --- HELPER FUNCTIONS ---

/**
 * Safely parses JSON from CLI output, ignoring leading/trailing non-JSON text (like download progress).
 */
function parseJsonOutput(stdout: string): any {
  if (!stdout) return {};
  
  // Remove ANSI escape codes (colors, progress bars) sometimes injected by CLI in debug terminals
  let text = stdout.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

  try {
    return JSON.parse(text);
  } catch (e) {
    // Find the absolute outermost JSON object or array
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    
    let objStr = firstBrace !== -1 && lastBrace > firstBrace ? text.substring(firstBrace, lastBrace + 1) : '';
    let arrStr = firstBracket !== -1 && lastBracket > firstBracket ? text.substring(firstBracket, lastBracket + 1) : '';
    
    if (arrStr.length > objStr.length) {
        try { return JSON.parse(arrStr); } catch (err) {}
        try { return JSON.parse(objStr); } catch (err) {}
    } else {
        try { return JSON.parse(objStr); } catch (err) {}
        try { return JSON.parse(arrStr); } catch (err) {}
    }
    return {};
  }
}

/**
 * Retrieves the base command for arduino-cli, including the executable path and any global flags from settings.
 * @returns The base command string for arduino-cli.
 */
function getCliBaseCommand(): string {
  const config = vscode.workspace.getConfiguration('minimalArduino');
  
  const cliPath = config.get<string>('cliPath', '').trim();
  let command = cliPath || 'arduino-cli';
  if (cliPath && cliPath.includes(' ') && !cliPath.startsWith('"')) {
    command = `"${cliPath}"`;
  }

  return command;
}

/**
 * Executes a shell command asynchronously.
 * @param command The command to execute.
 * @returns A promise that resolves with the command's stdout.
 */
function runCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use { shell: true } to let the system shell handle command parsing.
    // This is more robust than manual parsing and makes the extension's
    // behavior identical to running the command in a terminal.
    const child = cp.spawn(command, [], { shell: true });

    let stdoutData = '';
    let stderrData = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      stdoutData += data;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => {
      stderrData += data;
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdoutData);
      } else {
        const errorMsg =
          stderrData.trim() ||
          `Command failed with exit code ${code}: ${command}`;
        reject(new Error(errorMsg));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Finds the workspace root, preferring the folder containing the active .ino file.
 * @returns The workspace root path or undefined.
 */
function getWorkspaceRoot(): string | undefined {
  if (!vscode.workspace.workspaceFolders) {
    return undefined;
  }

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.fsPath.endsWith('.ino')) {
    const sketchPath = path.dirname(editor.document.uri.fsPath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      editor.document.uri
    );
    if (workspaceFolder) {
      return workspaceFolder.uri.fsPath;
    }
    return sketchPath; // Fallback to sketch folder if not in a workspace
  }

  return vscode.workspace.workspaceFolders[0].uri.fsPath;
}
/**
 * Recursively finds all files with a given extension in a directory.
 * @param dir The directory to search.
 * @param ext The extension to look for (e.g., '.h').
 * @returns An array of file paths.
 */
function findFilesByExt(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  let results: string[] = [];
  const dirents = fs.readdirSync(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const res = path.resolve(dir, dirent.name);
    if (dirent.isDirectory()) {
      results = results.concat(findFilesByExt(res, ext));
    } else if (dirent.isFile() && dirent.name.endsWith(ext)) {
      results.push(res);
    }
  }
  return results;
}

// --- INTELLISENSE ---

/**
 * Generates the c_cpp_properties.json file for IntelliSense.
 * @param fqbn The fully qualified board name.
 */
async function updateIntellisenseConfig(fqbn: string) {
  const cli = getCliBaseCommand();
  const rootPath = getWorkspaceRoot();
  if (!rootPath) {
    vscode.window.showErrorMessage('No workspace folder found.');
    return;
  }

  const vscodeFolder = path.join(rootPath, '.vscode');
  const buildPath = path.join(vscodeFolder, 'build');
  const cppPropertiesPath = path.join(vscodeFolder, 'c_cpp_properties.json');

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Updating IntelliSense...',
      cancellable: false,
    },
    async (progress) => {
      try {
        progress.report({ message: 'Getting build properties...' });
        let propsOutput = '';
        const sketchDir = vscode.window.activeTextEditor ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath) : rootPath;
        try {
            // Natively ask arduino-cli to fully resolve all absolute tool paths and core variables
            // 'compile' is preferred because it resolves tool dependencies (like esp32-arduino-libs)
            propsOutput = await runCommand(`${cli} compile -b ${fqbn} --show-properties "${sketchDir}"`);
        } catch (err) {
            // Fallback to board details if compile fails
            propsOutput = await runCommand(`${cli} board details -b ${fqbn} --show-properties`);
        }
        
        const buildProps: { [key: string]: string } = {};
        propsOutput.split('\n').forEach(line => {
            const eqIdx = line.indexOf('=');
            if (eqIdx !== -1) {
                const key = line.substring(0, eqIdx).trim();
                const value = line.substring(eqIdx + 1).trim();
                buildProps[key] = value;
            }
        });

        // Recursively resolve all variables like {compiler.sdk.path} (Crucial for ESP32)
        const resolveVars = () => {
            let madeChanges = true;
            let resolveAttempts = 0;
            const sortedKeys = Object.keys(buildProps).sort((a, b) => b.length - a.length);
            while (madeChanges && resolveAttempts < 10) {
                madeChanges = false;
                for (const key of sortedKeys) {
                    let val = buildProps[key];
                    if (val && typeof val === 'string' && val.includes('{')) {
                        const prev = val;
                        for (const subKey of sortedKeys) {
                            if (val.includes(`{${subKey}}`)) {
                                val = val.split(`{${subKey}}`).join(buildProps[subKey]);
                            }
                        }
                        if (val !== prev) {
                            buildProps[key] = val;
                            madeChanges = true;
                        }
                    }
                }
                resolveAttempts++;
            }
        };
        resolveVars();

        // Fallback for unresolved {runtime.tools.X.path} (happens if 'compile' fails and 'board details' is used)
        const runtimePlatformPath = buildProps['runtime.platform.path'];
        if (runtimePlatformPath) {
            const vendorDir = path.resolve(runtimePlatformPath, '../../..');
            let needsReResolve = false;
            for (const key of Object.keys(buildProps)) {
                let val = buildProps[key];
                if (typeof val === 'string' && val.includes('{runtime.tools.')) {
                    const matches = [...val.matchAll(/{runtime\.tools\.([^}]+)\.path}/g)];
                    for (const match of matches) {
                        const toolName = match[1];
                        const tryToolPaths = [ toolName, toolName.replace(/-\d+\.\d+\.\d+$/, '') ];
                        
                        for (const tName of tryToolPaths) {
                            const toolBaseDir = path.join(vendorDir, 'tools', tName);
                            if (fs.existsSync(toolBaseDir)) {
                                try {
                                    const versions = fs.readdirSync(toolBaseDir).filter(f => fs.statSync(path.join(toolBaseDir, f)).isDirectory());
                                    if (versions.length > 0) {
                                        const latestVersion = versions.sort().pop() || versions[0];
                                        val = val.split(match[0]).join(path.join(toolBaseDir, latestVersion));
                                        needsReResolve = true;
                                        break;
                                    }
                                } catch (e) {}
                            }
                        }
                    }
                    buildProps[key] = val;
                }
            }
            if (needsReResolve) {
                resolveVars(); // Run once more to cascade the newly found paths
            }
        }

        let compilerPathStr = '';
        const compilerDir = buildProps['compiler.path'];
        const compilerCmd = buildProps['compiler.cpp.cmd'] || buildProps['compiler.c.cmd'];
        if (compilerDir && compilerCmd) {
            compilerPathStr = path.join(compilerDir, compilerCmd);
        }

        // Windows requires the .exe extension for the C/C++ extension to successfully execute the compiler and extract stdio.h
        if (process.platform === 'win32' && compilerPathStr && !compilerPathStr.toLowerCase().endsWith('.exe')) {
          compilerPathStr += '.exe';
        }
        if (compilerPathStr) {
            compilerPathStr = path.normalize(compilerPathStr);
        }
        // If the path still doesn't exist, clear it to force cpptools to use a safe system fallback
        if (compilerPathStr && !fs.existsSync(compilerPathStr)) {
          compilerPathStr = '';
        }

        // Strip response files (@) from compilerArgs so cpptools doesn't incorrectly parse them without -iprefix
        const compilerArgs = (buildProps['compiler.cpp.flags'] || '').split(' ').filter(f => f && !f.startsWith('-D') && !f.startsWith('-I') && !f.startsWith('@'));
        const defines = [
            `F_CPU=${buildProps['build.f_cpu'] || '16000000L'}`,
            `ARDUINO=10800`,
            buildProps['build.board'] ? `ARDUINO_${buildProps['build.board']}` : '',
            buildProps['build.arch'] ? `ARDUINO_ARCH_${buildProps['build.arch']}` : ''
        ].filter(Boolean);

        let flagsToParse = [
            buildProps['compiler.cpreprocessor.flags'],
            buildProps['compiler.c.flags'],
            buildProps['compiler.cpp.flags'],
            buildProps['compiler.c.extra_flags'],
            buildProps['compiler.cpp.extra_flags'],
            buildProps['build.extra_flags'],
            buildProps['includes']
        ].filter(Boolean).join(' ');

        // Expand response files (@/path/to/file or @"/path/to/file") which contain includes and defines (e.g. ESP32)
        const responseFileRegex = /@("([^"]+)"|'([^']+)'|([^\s"']+))/g;
        flagsToParse = flagsToParse.replace(responseFileRegex, (match, _p1, p2, p3, p4) => {
            // Remove any literal escaped quotes or backslashes that might break fs.existsSync
            const rfPath = (p2 || p3 || p4).replace(/^["'\\]+|["'\\]+$/g, '');
            if (rfPath && fs.existsSync(rfPath)) {
                try {
                    let content = fs.readFileSync(rfPath, 'utf8');
                    // Expand any {vars} inside the response file just in case they were hidden
                    content = content.replace(/{([a-zA-Z0-9_.-]+)}/g, (m, varName) => {
                        return buildProps[varName] || m;
                    });
                    return content;
                } catch (err) {
                    return match;
                }
            }
            return match;
        });

        // Un-wrap flags quoted entirely to protect spaces, e.g., "-iprefixC:\path" -> -iprefix "C:\path"
        flagsToParse = flagsToParse.replace(/(?:^|\s)"(-[A-Za-z]+)([^"]*)"/g, ' $1 "$2"');
        flagsToParse = flagsToParse.replace(/(?:^|\s)'(-[A-Za-z]+)([^']*)'/g, " $1 '$2'");

        const defineRegex = /-D\s*"([^"]+)"|-D\s*'([^']+)'|-D\s*([^\s]+)/g;
        let match;
        while ((match = defineRegex.exec(flagsToParse)) !== null) {
            const defineStr = match[1] || match[2] || match[3];
            if (defineStr && !defines.includes(defineStr)) {
                defines.push(defineStr);
            }
        }

        let corePath = buildProps['build.core.path'];
        let variantPath = buildProps['build.variant.path'];

        // Fallback for core and variant paths if arduino-cli omits them from the root object
        if (!corePath && runtimePlatformPath && buildProps['build.core']) {
            corePath = path.join(runtimePlatformPath, 'cores', buildProps['build.core']);
        }
        if (!variantPath && runtimePlatformPath && buildProps['build.variant']) {
            variantPath = path.join(runtimePlatformPath, 'variants', buildProps['build.variant']);
        }

        let includePaths = [
          corePath,
          variantPath,
          // The platform path is the root of the hardware package (e.g. .../esp32/3.3.7/)
          // and contains toolchains, libraries, and other necessary headers not always
          // specified in other properties. Including it is crucial for complex platforms.
          runtimePlatformPath,
          buildProps['compiler.sdk.path'],
          buildProps['runtime.tools.esp32-arduino-libs.path'],
          buildProps['runtime.tools.esp32-libs.path']
        ].filter((p): p is string => Boolean(p));

        let currentPrefix = '';
        const includeRegex = /(-I|-isystem|-iprefix|-iwithprefixbefore|-idirafter)\s*"([^"]+)"|(-I|-isystem|-iprefix|-iwithprefixbefore|-idirafter)\s*'([^']+)'|(-I|-isystem|-iprefix|-iwithprefixbefore|-idirafter)\s*([^\s]+)/g;
        while ((match = includeRegex.exec(flagsToParse)) !== null) {
            const flag = match[1] || match[3] || match[5];
            const val = match[2] || match[4] || match[6];
            
            if (flag === '-iprefix') {
                currentPrefix = val;
            } else if (flag === '-iwithprefixbefore') {
                const safeVal = val.trim().replace(/^[\\\/]+/, ''); // Prevent absolute path override on Windows
                const fullPath = currentPrefix ? path.join(currentPrefix, safeVal) : val;
                if (fullPath && !includePaths.includes(fullPath)) {
                    includePaths.push(fullPath);
                }
            } else {
                    if (val) {
                        let absoluteVal = val;
                        if (!path.isAbsolute(val) && buildProps['compiler.sdk.path']) {
                            absoluteVal = path.join(buildProps['compiler.sdk.path'], val);
                        }
                        if (!includePaths.includes(absoluteVal)) {
                            includePaths.push(absoluteVal);
                        }
                }
            }
        }

        // Find all library paths
        const libResponse = await runCommand(`${cli} lib list --format json`);
        const parsedLibs = parseJsonOutput(libResponse);
        let installedLibs: any[] = [];
        if (Array.isArray(parsedLibs)) { installedLibs = parsedLibs; }
        else if (parsedLibs.libraries && Array.isArray(parsedLibs.libraries)) { installedLibs = parsedLibs.libraries; }
        else if (parsedLibs.installed_libraries && Array.isArray(parsedLibs.installed_libraries)) { installedLibs = parsedLibs.installed_libraries; }
        else {
            for (const key of Object.keys(parsedLibs)) {
                if (Array.isArray(parsedLibs[key])) { installedLibs = parsedLibs[key]; break; }
            }
        }
        
        for (const l of installedLibs) {
          const libObj = l.library || l;
          const libPath = libObj.install_dir || libObj.path || libObj.Path;
          if (libPath) {
            includePaths.push(libPath);

            // Also add src and utility folders if they exist
            const srcPath = path.join(libPath, 'src');
            if (fs.existsSync(srcPath)) {
              includePaths.push(srcPath);
            }
            const utilPath = path.join(libPath, 'utility');
            if (fs.existsSync(utilPath)) {
              includePaths.push(utilPath);
            }
          }
        }
        // Add sketch directory to include paths
        if (vscode.window.activeTextEditor) {
          const sketchDir = path.dirname(
            vscode.window.activeTextEditor.document.uri.fsPath
          );
          includePaths.push(sketchDir);
        }

        // Add recursive include paths for all libraries
        const recursiveIncludes = includePaths
          .filter((p) => fs.existsSync(p))
          .map((p) => `${p}/**`);

        const forcedIncludes: string[] = [];

        // Find Arduino.h and force-include it
        if (corePath) {
          const arduinoHeader = findFilesByExt(corePath, 'Arduino.h')[0];
          if (arduinoHeader) {
            forcedIncludes.push(arduinoHeader);
          }
        }

        // Find sdkconfig.h for ESP32 and force-include it
        if (fqbn.includes('esp32')) {
          const sdkConfigFile = findFilesByExt(buildPath, 'sdkconfig.h')[0];
          if (sdkConfigFile) {
            forcedIncludes.push(sdkConfigFile);
          }

          // Force-resolve deeply nested FreeRTOS headers that get skipped by IntelliSense depth limits
          const sdkPath = buildProps['compiler.sdk.path'] || buildProps['runtime.tools.esp32-libs.path'] || buildProps['runtime.tools.esp32-arduino-libs.path'];
          if (sdkPath) {
              const freertosInclude = path.join(sdkPath, 'include', 'freertos');
              if (fs.existsSync(freertosInclude)) {
                  const portmacroFiles = findFilesByExt(freertosInclude, 'portmacro.h');
                  portmacroFiles.forEach(file => {
                      const pmDir = path.dirname(file);
                      if (!includePaths.includes(pmDir)) includePaths.push(pmDir);
                  });
              }
          }
        }

        const config = {
          configurations: [
            {
              name: 'Minimal Arduino',
              compilerPath: compilerPathStr,
              compilerArgs,
              intelliSenseMode:
                'windows-gcc-x64',
              includePath: [...new Set([...includePaths.filter(p => fs.existsSync(p)), ...recursiveIncludes])],
              forcedInclude: [...new Set(forcedIncludes)],
              defines,
              cStandard: 'c11',
              cppStandard: 'c++17',
            },
          ],
          version: 4,
        };

        if (!fs.existsSync(vscodeFolder)) {
          fs.mkdirSync(vscodeFolder, { recursive: true });
        }
        fs.writeFileSync(cppPropertiesPath, JSON.stringify(config, null, 2));

        vscode.window.showInformationMessage('IntelliSense updated successfully.');
      } catch (error: any) {
        vscode.window.showErrorMessage(
          `Failed to update IntelliSense: ${error.message}`
        );
      }
    }
  );
}

// --- SIDEBAR DATA PROVIDER ---
class ArduinoItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly iconName: string,
    public readonly fqbn?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = `${this.label} (${this.description})`;
    this.iconPath = new vscode.ThemeIcon(iconName);
    this.contextValue = iconName;

    if (this.iconName === 'circuit-board' && this.fqbn) {
      this.command = {
        command: 'minimalArduino.setBoard',
        title: 'Set Board',
        arguments: [this.fqbn],
      };
    }
    if (this.iconName === 'plug' && this.fqbn) {
      this.command = {
        command: 'minimalArduino.setPort',
        title: 'Set Port',
        arguments: [this.fqbn],
      };
    }
  }
}

class ArduinoProvider implements vscode.TreeDataProvider<ArduinoItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    ArduinoItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private type: 'boards' | 'ports' | 'libs', private context?: vscode.ExtensionContext) {}
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element: ArduinoItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ArduinoItem[]> {
    const cli = getCliBaseCommand();
    try {
      if (this.type === 'boards') {
        const stdout = await runCommand(`${cli} board listall --format json`);
        const result = parseJsonOutput(stdout);

        if (result.error) {
          return [new ArduinoItem('Error', result.error.message || result.error, 'error')];
        }

        const boards = result.boards || [];
        if (boards.length === 0) {
          return [
            new ArduinoItem(
              'No boards found',
              'Run `>Arduino: Core Update` from Command Palette',
              'info'
            ),
          ];
        }

        const recentBoards = this.context?.workspaceState.get<string[]>('recentBoards') || [];
        boards.sort((a: any, b: any) => {
            const indexA = recentBoards.indexOf(a.fqbn);
            const indexB = recentBoards.indexOf(b.fqbn);
            
            if (indexA !== -1 && indexB !== -1) return indexA - indexB;
            if (indexA !== -1) return -1;
            if (indexB !== -1) return 1;
            
            return a.name.localeCompare(b.name);
        });

        return boards.map(
          (b: any) =>
            new ArduinoItem(b.name, b.fqbn, 'circuit-board', b.fqbn)
        );
      } else if (this.type === 'ports') {
        const stdout = await runCommand(`${cli} board list --format json`);
        const result = parseJsonOutput(stdout);
        if (result.error) {
          return [new ArduinoItem('Error', result.error.message || result.error, 'error')];
        }

        let ports: any[] = [];
        if (Array.isArray(result)) {
          ports = result;
        } else if (result.ports) {
          ports = result.ports;
        } else if (result.detected_ports) {
          ports = result.detected_ports;
        }

        if (ports.length === 0) {
          const item = new ArduinoItem('No connected ports', 'Click for troubleshooting tips', 'info');
          item.command = {
            command: 'vscode.open',
            title: 'Troubleshoot',
            arguments: [vscode.Uri.parse('https://support.arduino.cc/hc/en-us/sections/360003759059-Board-not-working-or-not-detected')]
          };
          return [item];
        }
        return ports.map(
          (p: any) => {
            const portName = p.port?.address || p.address || (typeof p.port === 'string' ? p.port : 'Unknown');
            let boardName = 'Unknown';
            if (p.matching_boards && p.matching_boards.length > 0) {
              boardName = p.matching_boards[0].name;
            } else if (p.board && p.board.name) {
              boardName = p.board.name;
            } else if (p.board_name) {
              boardName = p.board_name;
            }
            return new ArduinoItem(portName, boardName, 'plug', portName);
          }
        );
      } else if (this.type === 'libs') {
        const stdout = await runCommand(`${cli} lib list --format json`);
        const result = parseJsonOutput(stdout);
        if (result.error) {
            return [new ArduinoItem('Error', result.error.message || result.error, 'error')];
        }
        
        let libs: any[] = [];
        if (Array.isArray(result)) { libs = result; }
        else if (result.libraries && Array.isArray(result.libraries)) { libs = result.libraries; }
        else if (result.installed_libraries && Array.isArray(result.installed_libraries)) { libs = result.installed_libraries; }
        else {
            for (const key of Object.keys(result)) {
                if (Array.isArray(result[key])) { libs = result[key]; break; }
            }
        }
        
        if (libs.length === 0) {
          const emptyItem = new ArduinoItem('No libraries installed', 'Use search to install', 'info');
          emptyItem.command = { command: 'minimalArduino.searchLibrary', title: 'Search Libraries' };
          return [emptyItem];
        }
        
        return libs.map((l: any) => {
          const libObj = l.library || l;
          return new ArduinoItem(libObj.name || libObj.Name || 'Unknown', libObj.version || libObj.Version || '', 'library');
        });
      }
      return [];
    } catch (e: any) {
      try {
        const errorJson = JSON.parse(e.message);
        if (errorJson.error) {
          return [new ArduinoItem('Error', errorJson.error.message || errorJson.error, 'error')];
        }
      } catch (parseError) {
        // Not a JSON error
      }
      return [new ArduinoItem('Error', e.message, 'error')];
    }
  }
}

const defaultCores = ['arduino:avr', 'esp32:esp32', 'arduino:renesas_uno'];

async function checkAndInstallDefaultCores(boardProvider: ArduinoProvider) {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Checking for default Arduino cores...',
        cancellable: false
    }, async (progress) => {
        try {
            const cli = getCliBaseCommand();
            progress.report({ message: 'Getting installed cores...' });
            
            const installedListJson = await runCommand(`${cli} core list --format json`);
            const parsedOutput = parseJsonOutput(installedListJson);
            
            let coreArray: any[] = [];
            if (Array.isArray(parsedOutput)) { coreArray = parsedOutput; }
            else if (parsedOutput.cores && Array.isArray(parsedOutput.cores)) { coreArray = parsedOutput.cores; }
            else {
                for (const key of Object.keys(parsedOutput)) {
                    if (Array.isArray(parsedOutput[key])) { coreArray = parsedOutput[key]; break; }
                }
            }
            
            const installedCores = coreArray.map((c: any) => c.ID || c.id);

            for (const coreId of defaultCores) {
                if (!installedCores.includes(coreId)) {
                    progress.report({ message: `Installing ${coreId}...` });
                    try {
                        await runCommand(`${cli} core install ${coreId}`);
                        vscode.window.showInformationMessage(`Default core '${coreId}' was missing and has been installed.`);
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to install default core '${coreId}': ${e.message}`);
                    }
                }
            }
            
            progress.report({ message: 'Core check complete. Refreshing...' });
            boardProvider.refresh();

        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to check/install default cores: ${e.message}`);
        }
    });
}

// --- ACTIVATION & COMMANDS ---
export function activate(context: vscode.ExtensionContext) {
  statusBarBoard = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarPort = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99
  );
  statusBarBoardOptions = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    98
  );

  currentBoard = context.workspaceState.get<string>('lastBoard', '');
  currentPort = context.workspaceState.get<string>('lastPort', '');

  statusBarBoard.text = `$(circuit-board) ${
    currentBoard ? currentBoard.split(':')[2] || currentBoard : 'Select Board'
  }`;
  statusBarBoard.tooltip = currentBoard;
  statusBarBoard.command = 'minimalArduino.selectBoard';
  statusBarBoard.show();

  statusBarPort.text = `$(plug) ${currentPort || 'Select Port'}`;
  statusBarPort.command = 'minimalArduino.selectPort';
  statusBarPort.show();

  statusBarBoardOptions.text = `$(settings-gear)`;
  statusBarBoardOptions.tooltip = 'Configure Board Options';
  statusBarBoardOptions.command = 'minimalArduino.configureBoard';
  if (currentBoard) {
    statusBarBoardOptions.show();
    updateIntellisenseConfig(currentBoard);
  }

  const boardProvider = new ArduinoProvider('boards', context);
  const portProvider = new ArduinoProvider('ports', context);
  const libProvider = new ArduinoProvider('libs', context);

  vscode.window.registerTreeDataProvider(
    'minimalArduino.boardsView',
    boardProvider
  );
  vscode.window.registerTreeDataProvider(
    'minimalArduino.portsView',
    portProvider
  );
  vscode.window.registerTreeDataProvider('minimalArduino.libsView', libProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand('minimalArduino.autoDetect', () => {
      boardProvider.refresh();
      portProvider.refresh();
      libProvider.refresh();
    }),
    vscode.commands.registerCommand('minimalArduino.coreUpdate', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Updating board index...',
          cancellable: false,
        },
        async (progress) => {
          try {
            const cli = getCliBaseCommand();
            progress.report({ message: 'Running `core update-index`...' });
            await runCommand(`${cli} core update-index`);
            progress.report({
              message: 'Index updated. Checking for boards...',
            });

            const stdout = await runCommand(`${cli} board listall --format json`);
            const result = parseJsonOutput(stdout);
            const boards = result.boards || [];

            if (boards.length > 0) {
              vscode.window.showInformationMessage(
                `Arduino core index updated successfully. Found ${boards.length} boards.`
              );
            } else {
              vscode.window.showWarningMessage(
                'Core index updated, but no boards were found. You may need to install a core, e.g., `arduino-cli core install arduino:avr`'
              );
            }

            // Refresh the boards view
            boardProvider.refresh();
          } catch (e: any) {
            vscode.window.showErrorMessage(
              `Failed to update core index: ${e.message}`
            );
          }
        }
      );
    }),
    vscode.commands.registerCommand('minimalArduino.installCore', async () => {
      await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Searching for cores...`
      }, async (progress) => {
          try {
              const cli = getCliBaseCommand();
              const stdout = await runCommand(`${cli} core search --format json`);
              const result = parseJsonOutput(stdout);
              const cores = result.cores || [];

              if (cores.length === 0) {
                  vscode.window.showErrorMessage(`No cores found. Please run 'Arduino: Core Update' first and check for errors.`);
                  return;
              }

              const items: vscode.QuickPickItem[] = cores.map((c: any) => ({
                  label: c.name,
                  description: `ID: ${c.id}`,
                  detail: `Latest: ${c.latest}${c.installed ? ' (installed: ' + c.installed + ')' : ''}`
              }));

              const selections = await vscode.window.showQuickPick(items, {
                  placeHolder: 'Select one or more cores to install',
                  canPickMany: true
              });

              if (selections && selections.length > 0) {
                  for (const sel of selections) {
                      const coreId = sel.description?.replace('ID: ', '');
                      if (coreId) {
                          await vscode.window.withProgress({
                              location: vscode.ProgressLocation.Notification,
                              title: `Installing ${coreId}...`,
                              cancellable: false
                          }, async (installProgress) => {
                              try {
                                  await runCommand(`${cli} core install ${coreId}`);
                                  installProgress.report({ message: 'Core installed.' });
                                  vscode.window.showInformationMessage(`Core '${coreId}' installed successfully.`);
                              } catch (e: any) {
                                  vscode.window.showErrorMessage(`Failed to install core: ${e.message}`);
                              }
                          });
                      }
                  }
                  boardProvider.refresh(); // Refresh once after all installations
              }

          } catch (e: any) {
              vscode.window.showErrorMessage(`Failed to search for cores: ${e.message}`);
          }
      });
    }),
    vscode.commands.registerCommand('minimalArduino.searchLibrary', async () => {
      const query = await vscode.window.showInputBox({
          prompt: 'Search for a library',
          placeHolder: 'Enter library name or topic'
      });
  
      if (!query) {
          return;
      }
  
      await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Searching for library '${query}'...`,
          cancellable: false
      }, async (progress) => {
          try {
              const cli = getCliBaseCommand();
              progress.report({ message: 'Running `lib search`...' });
              const stdout = await runCommand(`${cli} lib search "${query}" --format json`);
              const result = parseJsonOutput(stdout);
              let libraries: any[] = [];
              if (Array.isArray(result)) { libraries = result; }
              else if (result.libraries && Array.isArray(result.libraries)) { libraries = result.libraries; }
              else { for (const key of Object.keys(result)) { if (Array.isArray(result[key])) { libraries = result[key]; break; } } }
  
              if (libraries.length === 0) {
                  vscode.window.showInformationMessage(`No libraries found for '${query}'.`);
                  return;
              }
  
              const items: vscode.QuickPickItem[] = libraries.map((l: any) => {
                  const libObj = l.library || l;
                  return {
                      label: libObj.name || libObj.Name || 'Unknown',
                      description: `Latest: ${libObj.latest || libObj.Latest || 'Unknown'}`,
                      detail: (libObj.author || libObj.Author) ? `By ${libObj.author || libObj.Author}` : ''
                  };
              });
  
              const selections = await vscode.window.showQuickPick(items, {
                  placeHolder: 'Select one or more libraries to install',
                  canPickMany: true
              });
  
              if (selections && selections.length > 0) {
                await vscode.commands.executeCommand('minimalArduino.installLibrary', selections);
              }
  
          } catch (e: any) {
              vscode.window.showErrorMessage(`Failed to search for libraries: ${e.message}`);
          }
      });
    }),
    vscode.commands.registerCommand('minimalArduino.installLibrary', async (selections: readonly vscode.QuickPickItem[]) => {
      const cli = getCliBaseCommand();
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Installing libraries...',
        cancellable: false
      }, async (progress) => {
        for (const sel of selections) {
            const libName = sel.label.trim();
            progress.report({ message: `Installing ${libName}...` });
            try {
                await runCommand(`${cli} lib install "${libName.replace(/"/g, '\\"')}"`);
                vscode.window.showInformationMessage(`Library '${libName}' installed successfully.`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to install library '${libName}': ${e.message}`);
            }
        }
      });
    
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Updating library index...',
        cancellable: false
      }, async (progress) => {
        try {
            await runCommand(`${cli} lib update-index`);
        } catch (e: any) {
            vscode.window.showWarningMessage(`Failed to update library index: ${e.message}`);
        }
      });
    
      libProvider.refresh();
      if (currentBoard) {
        await updateIntellisenseConfig(currentBoard);
      }
    }),
    vscode.commands.registerCommand('minimalArduino.addLibrary', async () => {
      const libName = await vscode.window.showInputBox({
          prompt: 'Enter the exact name of the library to install',
          placeHolder: 'e.g., Adafruit GFX Library'
      });
  
      if (!libName) {
          return;
      }
  
      const item: vscode.QuickPickItem = { label: libName.trim() };
      await vscode.commands.executeCommand('minimalArduino.installLibrary', [item]);
    }),
    vscode.commands.registerCommand('minimalArduino.selectBoard', async () => {
      const cli = getCliBaseCommand();
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Loading boards...',
        },
        async () => {
          try {
            const stdout = await runCommand(
              `${cli} board listall --format json`
            );
            const boards = parseJsonOutput(stdout).boards || [];
            
            const recentBoards = context.workspaceState.get<string[]>('recentBoards') || [];
            
            // Sort boards alphabetically, but bubble the recently used boards to the top
            boards.sort((a: any, b: any) => {
              const indexA = recentBoards.indexOf(a.fqbn);
              const indexB = recentBoards.indexOf(b.fqbn);
              if (indexA !== -1 && indexB !== -1) return indexA - indexB;
              if (indexA !== -1) return -1;
              if (indexB !== -1) return 1;
              
              return a.name.localeCompare(b.name);
            });
            
            const items: vscode.QuickPickItem[] = boards.map((b: any) => ({
              label: b.name,
              description: b.fqbn,
            }));
            const sel = await vscode.window.showQuickPick(items, {
              placeHolder: 'Search Arduino boards...',
            });
            if (sel && sel.description) {
              await vscode.commands.executeCommand(
                'minimalArduino.setBoard',
                sel.description
              );
            }
          } catch (e: any) {
            vscode.window.showErrorMessage(
              `Failed to search boards: ${e.message}`
            );
          }
        }
      );
    }),

    vscode.commands.registerCommand(
      'minimalArduino.setBoard',
      async (fqbn: string) => {
        currentBoard = fqbn;
        await context.workspaceState.update('lastBoard', fqbn);
            
            let recentBoards = context.workspaceState.get<string[]>('recentBoards') || [];
            recentBoards = recentBoards.filter(b => b !== fqbn);
            recentBoards.unshift(fqbn);
            if (recentBoards.length > 15) recentBoards.pop();
            await context.workspaceState.update('recentBoards', recentBoards);
            boardProvider.refresh();

        statusBarBoard.text = `$(circuit-board) ${
          fqbn.split(':')[2] || fqbn
        }`;
        statusBarBoard.tooltip = fqbn;
        statusBarBoardOptions.show();

        const core = fqbn.split(':').slice(0, 2).join(':');
        let coreInstalled = false;
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Installing core ${core}...`,
          },
          async () => {
            try {
              await runCommand(`${getCliBaseCommand()} core install ${core}`);
              coreInstalled = true;
            } catch (error: any) {
              coreInstalled = false;
              vscode.window.showErrorMessage(
                `Failed to install core: ${error.message}`
              );
            }
          }
        );

        if (coreInstalled) {
          await updateIntellisenseConfig(fqbn);
        } else {
            vscode.window.showErrorMessage(`IntelliSense update failed because core '${core}' could not be installed.`);
        }
      }
    ),

    vscode.commands.registerCommand('minimalArduino.selectPort', async () => {
      const cli = getCliBaseCommand();
      try {
        const stdout = await runCommand(`${cli} board list --format json`);
        const result = parseJsonOutput(stdout);
        if (result.error) {
          vscode.window.showErrorMessage(`Failed to get ports: ${result.error.message || result.error}`);
          return;
        }

        let ports: any[] = [];
        if (Array.isArray(result)) {
          ports = result;
        } else if (result.ports) {
          ports = result.ports;
        } else if (result.detected_ports) {
          ports = result.detected_ports;
        }

        const items: vscode.QuickPickItem[] = ports.map((p: any) => {
          const portName = p.port?.address || p.address || (typeof p.port === 'string' ? p.port : 'Unknown');
          let boardName = 'Unknown';
          if (p.matching_boards && p.matching_boards.length > 0) {
            boardName = p.matching_boards[0].name;
          } else if (p.board && p.board.name) {
            boardName = p.board.name;
          } else if (p.board_name) {
            boardName = p.board_name;
          }
          return {
            label: portName,
            description: boardName,
          };
        });
        const sel = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a port...',
        });
        if (sel) {
          await vscode.commands.executeCommand(
            'minimalArduino.setPort',
            sel.label
          );
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to get ports: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand(
      'minimalArduino.setPort',
      async (port: string) => {
        currentPort = port;
        await context.workspaceState.update('lastPort', port);
        statusBarPort.text = `$(plug) ${port}`;
      }
    ),

    vscode.commands.registerCommand('minimalArduino.compile', () =>
      runCliTask('compile')
    ),
    vscode.commands.registerCommand('minimalArduino.upload', () =>
      runCliTask('upload')
    ),

    vscode.commands.registerCommand('minimalArduino.configureBoard', async () => {
      if (!currentBoard) {
          vscode.window.showErrorMessage('Please select a board first.');
          return;
      }
  
      const cli = getCliBaseCommand();
      try {
          const boardDetailsJson = await runCommand(`${cli} board details -b ${currentBoard} --format json`);
          const boardDetails = parseJsonOutput(boardDetailsJson);
          const options = boardDetails.configuration_options || [];
  
          if (options.length === 0) {
              vscode.window.showInformationMessage('No configuration options available for this board.');
              return;
          }
  
          const items: vscode.QuickPickItem[] = options.map((o: any) => ({
              label: o.option_label,
              description: o.option_name,
              detail: `Selected: ${o.selected_value_label} (${o.selected_value})`
          }));
  
          const selectedOption = await vscode.window.showQuickPick(items, {
              placeHolder: 'Select an option to configure'
          });
  
          if (selectedOption) {
              const optionName = selectedOption.description;
              const selectedOpt = options.find((o:any) => o.option_name === optionName);
              const valueItems: vscode.QuickPickItem[] = selectedOpt.values.map((v:any) => ({
                  label: v.value_label,
                  description: v.value
              }));
  
              const selectedValue = await vscode.window.showQuickPick(valueItems, {
                  placeHolder: `Select a value for ${selectedOption.label}`
              });
  
              if (selectedValue) {
                  // The arduino-cli does not support setting individual board options directly.
                  // This is a known limitation.
                  // For now, we can only show the options.
                  vscode.window.showInformationMessage(`Board options are not yet supported by the extension. Selected value: ${selectedValue.label}`);
              }
          }
  
      } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to get board options: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('minimalArduino.newSketch', async () => {
      const sketchName = await vscode.window.showInputBox({
        prompt: 'Enter sketch name',
        value: 'sketch',
      });
      if (!sketchName) {
        return;
      }
      const rootPath = getWorkspaceRoot();
      if (!rootPath) {
        return;
      }

      const sketchFolder = path.join(rootPath, sketchName);
      fs.mkdirSync(sketchFolder, { recursive: true });
      const sketchPath = path.join(sketchFolder, `${sketchName}.ino`);
      fs.writeFileSync(
        sketchPath,
        `void setup() {

}

void loop() {

}`
      );

      const doc = await vscode.workspace.openTextDocument(sketchPath);
      await vscode.window.showTextDocument(doc);
    })
  );

  // Check and install default cores on startup
  checkAndInstallDefaultCores(boardProvider);
}

async function runCliTask(action: 'compile' | 'upload') {
  const cli = getCliBaseCommand();
  const editor = vscode.window.activeTextEditor;
  if (!editor || !currentBoard) {
    vscode.window.showErrorMessage('Please open a .ino file and select a board.');
    return;
  }

  const terminal =
    vscode.window.terminals.find((t) => t.name === 'Arduino') ||
    vscode.window.createTerminal(`Arduino`);
  terminal.show();

  const sketchPath = editor.document.uri.fsPath;
  let command = '';
  
  if (action === 'upload') {
    const portFlag = currentPort ? `-p ${currentPort}` : '';
    // Compile and upload in one go (Arduino IDE behavior)
    command = `${cli} compile --upload --fqbn ${currentBoard} ${portFlag} "${sketchPath}"`;
  } else {
    command = `${cli} compile --fqbn ${currentBoard} "${sketchPath}"`;
  }

  // Cleanup multiple spaces
  command = command.replace(/\s+/g, ' ');

  if (process.platform === 'win32' && cli.startsWith('"')) {
    command = `& ${command}`;
  }
  terminal.sendText(command);
}

export function deactivate() {}