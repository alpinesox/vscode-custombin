import * as path from "path";
import * as vscode from "vscode";
import { FormatDefinition, RegistryDiagnostic } from "./model";
import { validateFormatDefinition } from "./validator";

const MAX_FORMAT_FILES = 256;
const MAX_FORMAT_FILE_BYTES = 1024 * 1024;

export class FormatRegistry implements vscode.Disposable {
  private definitions: FormatDefinition[] = [];
  private diagnostics: RegistryDiagnostic[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  get all(): FormatDefinition[] { return [...this.definitions]; }
  get issues(): RegistryDiagnostic[] { return [...this.diagnostics]; }

  async load(): Promise<void> {
    const loaded: FormatDefinition[] = [];
    const diagnostics: RegistryDiagnostic[] = [];
    const uris = await this.definitionUris();
    if (uris.length > MAX_FORMAT_FILES) diagnostics.push({ severity: "warning", message: `Loaded first ${MAX_FORMAT_FILES} format definition files; ${uris.length - MAX_FORMAT_FILES} skipped.` });
    for (const uri of uris.slice(0, MAX_FORMAT_FILES)) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > MAX_FORMAT_FILE_BYTES) {
          diagnostics.push({ severity: "error", message: `Format definition file exceeds ${MAX_FORMAT_FILE_BYTES} bytes and was skipped.`, sourcePath: uri.fsPath });
          continue;
        }
        const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
        const result = validateFormatDefinition(parsed, uri.fsPath);
        diagnostics.push(...result.diagnostics);
        if (result.definition) loaded.push(result.definition);
      } catch (error) {
        diagnostics.push({ severity: "error", message: error instanceof Error ? error.message : String(error), sourcePath: uri.fsPath });
      }
    }
    const seen = new Set<string>();
    this.definitions = loaded.filter(definition => {
      if (seen.has(definition.id)) { diagnostics.push({ severity: "error", message: `Duplicate format id ${definition.id}; later definition skipped.`, sourcePath: definition.sourcePath }); return false; }
      seen.add(definition.id);
      return true;
    });
    this.diagnostics = diagnostics;
    this.onDidChangeEmitter.fire();
  }

  watch(): void {
    this.watcher?.dispose();
    const folders = configuredFolders().join(",");
    this.watcher = vscode.workspace.createFileSystemWatcher(`**/{${folders}}/*.json`);
    this.watcher.onDidCreate(() => { void this.load(); });
    this.watcher.onDidChange(() => { void this.load(); });
    this.watcher.onDidDelete(() => { void this.load(); });
  }

  dispose(): void {
    this.watcher?.dispose();
    this.onDidChangeEmitter.dispose();
  }

  private async definitionUris(): Promise<vscode.Uri[]> {
    const uris: vscode.Uri[] = [];
    for (const folder of configuredFolders()) {
      uris.push(...await vscode.workspace.findFiles(`${folder}/*.json`, "**/node_modules/**"));
    }
    const builtin = vscode.Uri.joinPath(this.extensionUri, "extensions");
    try {
      for (const [name, type] of await vscode.workspace.fs.readDirectory(builtin)) {
        if (type === vscode.FileType.File && name.endsWith(".json")) uris.push(vscode.Uri.joinPath(builtin, name));
      }
    } catch { /* no built-in formats in development */ }
    return uris.sort((a, b) => path.basename(a.fsPath).localeCompare(path.basename(b.fsPath)));
  }
}

function configuredFolders(): string[] {
  const raw = vscode.workspace.getConfiguration("custombin").get<string[]>("formatFolders", ["extensions", "formats"]);
  const safe = raw.filter(folder => /^[A-Za-z0-9_.-]+$/.test(folder));
  return safe.length ? Array.from(new Set(safe)) : ["extensions", "formats"];
}
