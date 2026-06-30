import * as path from "path";
import * as vscode from "vscode";
import { matchFormats } from "./matcher";
import { CandidateResult } from "./model";
import { FormatRegistry } from "./registry";
import { buildWebviewHtml, serializeCandidates } from "./webview";

let registry: FormatRegistry;
let activeCustomBinUri: vscode.Uri | undefined;

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
    await vscode.window.showInformationMessage(`Loaded ${registry.all.length} Custom Binary Viewer format definition(s).`);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("custombin.validateFormats", async () => {
    await registry.load();
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
        await render();
      }
    }));
  }

  private async candidates(uri: vscode.Uri): Promise<CandidateResult[]> {
    const config = vscode.workspace.getConfiguration("custombin");
    const maxFileBytes = clampInteger(config.get<number>("maxFileBytes"), 1, 100 * 1024 * 1024, 10 * 1024 * 1024);
    const maxArrayItems = clampInteger(config.get<number>("maxArrayItems"), 1, 4096, 4096);
    const maxRenderedFields = clampInteger(config.get<number>("maxRenderedFields"), 1, 20000, 10000);
    const maxRawDisplayBytes = clampInteger(config.get<number>("maxRawDisplayBytes"), 0, 1024 * 1024, 64 * 1024);
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > maxFileBytes) throw new Error(`File is ${stat.size} bytes; limit is ${maxFileBytes}.`);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return matchFormats(bytes, path.basename(uri.fsPath), this.registry.all, { maxArrayItems, maxRenderedFields, maxRawDisplayBytes });
  }
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value as number));
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
