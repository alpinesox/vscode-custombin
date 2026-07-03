import * as path from "path";
import * as vscode from "vscode";
import { matchFormats } from "./matcher";
import { CandidateResult } from "./model";
import { FormatRegistry } from "./registry";
import { buildWebviewHtml, serializeCandidates } from "./webview";

let registry: FormatRegistry;
let activeCustomBinUri: vscode.Uri | undefined;
const settingWarningsShown = new Set<string>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registry = new FormatRegistry(context.extensionUri);
  context.subscriptions.push(registry);
  await registry.load();
  registry.watch();
  context.subscriptions.push(CustomBinEditorProvider.register(context, registry));
  context.subscriptions.push(vscode.commands.registerCommand("custombin.open", async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri ?? activeCustomBinUri;
    if (!target) { await vscode.window.showWarningMessage("No file selected."); return; }
    await vscode.commands.executeCommand("vscode.openWith", target, CustomBinEditorProvider.viewType);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("custombin.selectFormat", async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri ?? activeCustomBinUri;
    if (!target) { await vscode.window.showWarningMessage("Open a file before selecting a Custom Binary Viewer format."); return; }
    const picked = await vscode.window.showQuickPick(registry.all.map(format => ({ label: format.name, description: format.id, format })), { placeHolder: "Select Custom Binary Viewer format" });
    if (!picked) return;
    await context.workspaceState.update(overrideKey(target), picked.format.id);
    await vscode.commands.executeCommand("vscode.openWith", target, CustomBinEditorProvider.viewType);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("custombin.reloadFormats", async () => {
    await registry.load();
    registry.watch();
    await vscode.window.showInformationMessage(`Loaded ${registry.all.length} Custom Binary Viewer format definition(s).`);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("custombin.validateFormats", async () => {
    await registry.load();
    registry.watch();
    const errors = registry.issues.filter(issue => issue.severity === "error");
    await vscode.window.showInformationMessage(errors.length ? `${errors.length} format definition issue(s).` : "All format definitions are valid.");
  }));
}

export function deactivate(): void { /* noop */ }

class CustomBinEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = "custombin.viewer";

  static register(context: vscode.ExtensionContext, registry: FormatRegistry): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(CustomBinEditorProvider.viewType, new CustomBinEditorProvider(context, registry), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  constructor(private readonly context: vscode.ExtensionContext, private readonly registry: FormatRegistry) {}

  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    return { uri, dispose: (): void => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] };
    if (panel.active) activeCustomBinUri = document.uri;
    const disposables: vscode.Disposable[] = [];
    disposables.push(panel.onDidChangeViewState(event => {
      if (event.webviewPanel.active) activeCustomBinUri = document.uri;
    }));
    disposables.push(panel.onDidDispose(() => {
      if (activeCustomBinUri?.toString() === document.uri.toString()) activeCustomBinUri = undefined;
      disposables.splice(0).forEach(disposable => { disposable.dispose(); });
    }));
    let selectedId: string | undefined = this.context.workspaceState.get<string>(overrideKey(document.uri));
    const render = async (): Promise<void> => {
      try {
        const candidates = await this.candidates(document.uri);
        if (selectedId && !candidates.some(candidate => candidate.definition.id === selectedId)) selectedId = undefined;
        panel.webview.html = buildWebviewHtml(panel.webview, this.context.extensionUri, serializeCandidates(candidates, selectedId, this.registry.issues));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        panel.webview.html = buildWebviewHtml(panel.webview, this.context.extensionUri, { registryDiagnostics: [{ severity: "error", message }] });
      }
    };
    await render();
    disposables.push(panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (isSelectFormatMessage(message)) {
        const candidates = await this.candidates(document.uri);
        if (!candidates.some(candidate => candidate.definition.id === message.formatId)) return;
        selectedId = message.formatId;
        await this.context.workspaceState.update(overrideKey(document.uri), selectedId);
        await render();
      } else if (isReloadMessage(message)) {
        await this.registry.load();
        this.registry.watch();
        await render();
      }
    }));
  }

  private async candidates(uri: vscode.Uri): Promise<CandidateResult[]> {
    const config = vscode.workspace.getConfiguration("custombin");
    const maxFileBytes = getIntegerSetting(config, "maxFileBytes", 1, 2147483647, 10 * 1024 * 1024);
    const maxArrayItems = getIntegerSetting(config, "maxArrayItems", 1, 1000000, 4096);
    const maxRenderedFields = getIntegerSetting(config, "maxRenderedFields", 1, 1000000, 10000);
    const maxRawDisplayBytes = getIntegerSetting(config, "maxRawDisplayBytes", 0, 268435456, 64 * 1024);
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > maxFileBytes) throw new Error(`File is ${stat.size} bytes; custombin.maxFileBytes is ${maxFileBytes}. Increase custombin.maxFileBytes to parse this file.`);
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > maxFileBytes) throw new Error(`File is ${bytes.byteLength} bytes after read; custombin.maxFileBytes is ${maxFileBytes}. Increase custombin.maxFileBytes to parse this file.`);
    return matchFormats(bytes, path.basename(uri.fsPath), this.registry.all, { maxArrayItems, maxRenderedFields, maxRawDisplayBytes });
  }
}

function getIntegerSetting(config: vscode.WorkspaceConfiguration, key: string, min: number, max: number, fallback: number): number {
  const value = config.get<number>(key);
  if (!Number.isInteger(value)) {
    showSettingWarningOnce(`custombin.${key}:not-integer`, `custombin.${key} must be an integer; using default ${fallback}.`);
    return fallback;
  }
  if ((value as number) < min || (value as number) > max) {
    const clamped = Math.max(min, Math.min(max, value as number));
    showSettingWarningOnce(`custombin.${key}:range:${value}`, `custombin.${key}=${value} is outside ${min}-${max}; using ${clamped}.`);
    return clamped;
  }
  return value as number;
}

function showSettingWarningOnce(id: string, message: string): void {
  if (settingWarningsShown.has(id)) return;
  settingWarningsShown.add(id);
  void vscode.window.showWarningMessage(message);
}

function isSelectFormatMessage(message: unknown): message is { command: "selectFormat"; formatId: string } {
  return typeof message === "object" && message !== null && (message as { command?: unknown }).command === "selectFormat" && typeof (message as { formatId?: unknown }).formatId === "string";
}

function isReloadMessage(message: unknown): message is { command: "reload" } {
  return typeof message === "object" && message !== null && (message as { command?: unknown }).command === "reload";
}

function overrideKey(uri: vscode.Uri): string {
  return `format:${uri.toString()}`;
}
