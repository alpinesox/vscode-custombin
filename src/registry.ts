import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { FormatDefinition, RegistryDiagnostic } from "./model";
import { validateFormatDefinition } from "./validator";

const MAX_FORMAT_FILES = 256;
const MAX_FORMAT_FILE_BYTES = 1024 * 1024;
const MAX_FORMAT_PATHS = 32;
const MAX_FORMAT_PATH_DEPTH = 8;

export class FormatRegistry implements vscode.Disposable {
  private definitions: FormatDefinition[] = [];
  private diagnostics: RegistryDiagnostic[] = [];
  private watchers: vscode.Disposable[] = [];
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
    this.watchers.splice(0).forEach(watcher => { watcher.dispose(); });
    const folders = configuredFolders().join(",");
    const watcher = vscode.workspace.createFileSystemWatcher(`**/{${folders}}/*.json`);
    this.watchers.push(watcher);
    watcher.onDidCreate(() => { void this.load(); });
    watcher.onDidChange(() => { void this.load(); });
    watcher.onDidDelete(() => { void this.load(); });
    for (const entry of configuredFormatPaths().slice(0, MAX_FORMAT_PATHS)) {
      for (const root of formatPathRoots(entry)) this.watchers.push(watchExternalPath(root, () => { void this.load(); }));
    }
  }

  dispose(): void {
    this.watchers.splice(0).forEach(watcher => { watcher.dispose(); });
    this.onDidChangeEmitter.dispose();
  }

  private async definitionUris(): Promise<vscode.Uri[]> {
    const uris: vscode.Uri[] = [];
    for (const folder of configuredFolders()) {
      uris.push(...await vscode.workspace.findFiles(`${folder}/*.json`, "**/node_modules/**"));
    }
    for (const entry of configuredFormatPaths().slice(0, MAX_FORMAT_PATHS)) {
      uris.push(...await formatPathUris(entry));
    }
    return uris.sort((a, b) => path.basename(a.fsPath).localeCompare(path.basename(b.fsPath)));
  }
}

function configuredFolders(): string[] {
  const raw = vscode.workspace.getConfiguration("custombin").get<string[]>("formatFolders", ["extensions", "formats"]);
  const safe = raw.filter(folder => /^[A-Za-z0-9_.-]+$/.test(folder));
  return safe.length ? Array.from(new Set(safe)) : ["extensions", "formats"];
}

function configuredFormatPaths(): string[] {
  const raw = vscode.workspace.getConfiguration("custombin").get<string[]>("formatPaths", []);
  return Array.from(new Set(raw.filter(item => typeof item === "string" && item.trim().length > 0).map(item => item.trim())));
}

async function formatPathUris(entry: string): Promise<vscode.Uri[]> {
  const roots = formatPathRoots(entry);
  const uris: vscode.Uri[] = [];
  for (const root of roots) {
    const parsed = parseFormatPath(root);
    uris.push(...await collectFormatFiles(vscode.Uri.file(parsed.root), parsed.matcher, 0));
  }
  return uris;
}

function formatPathRoots(entry: string): string[] {
  const expanded = expandHome(entry);
  if (!safeConfiguredPath(expanded)) return [];
  return path.isAbsolute(expanded) ? [expanded] : workspaceRootPaths().map(root => `${root}${path.sep}${expanded}`);
}

function watchExternalPath(root: string, onChange: () => void): vscode.Disposable {
  const parsed = parseFormatPath(root);
  let timer: NodeJS.Timeout | undefined;
  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 250);
  };
  try {
    const watcher = fs.watch(parsed.root, { recursive: true }, trigger);
    return { dispose: (): void => { if (timer) clearTimeout(timer); watcher.close(); } };
  } catch {
    return { dispose: (): void => { if (timer) clearTimeout(timer); } };
  }
}

function workspaceRootPaths(): string[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.map(folder => folder.uri.fsPath);
}

function expandHome(value: string): string {
  if (value === "~") return homeDirectory();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/") || value.startsWith("~\\")) return `${homeDirectory()}${path.sep}${value.slice(2)}`;
  return value;
}

function safeConfiguredPath(value: string): boolean {
  if (value.includes("\0")) return false;
  if (path.isAbsolute(value)) return true;
  return !value.split(/[\\/]+/).some(segment => segment === "..");
}

function homeDirectory(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? "";
}

function parseFormatPath(value: string): { root: string; matcher: (relativePath: string, isDirectory: boolean) => boolean } {
  const normalized = path.normalize(value);
  const segments = normalized.split(/[\\/]+/);
  const globIndex = segments.findIndex(segment => segment.includes("*"));
  if (globIndex === -1) return { root: normalized, matcher: (_relativePath, isDirectory) => !isDirectory && _relativePath.toLowerCase().endsWith(".json") };
  const root = segments.slice(0, globIndex).join(path.sep) || path.parse(normalized).root;
  const pattern = segments.slice(globIndex).join("/");
  return { root, matcher: (relativePath, isDirectory) => !isDirectory && globMatches(pattern, relativePath.replace(/\\/g, "/")) };
}

async function collectFormatFiles(root: vscode.Uri, matcher: (relativePath: string, isDirectory: boolean) => boolean, depth: number, relativePath = ""): Promise<vscode.Uri[]> {
  if (depth > MAX_FORMAT_PATH_DEPTH) return [];
  const uris: vscode.Uri[] = [];
  let entries: [string, vscode.FileType][];
  try { entries = await vscode.workspace.fs.readDirectory(root); } catch { return []; }
  for (const [name, type] of entries) {
    const childRelative = relativePath ? `${relativePath}/${name}` : name;
    const child = vscode.Uri.joinPath(root, name);
    if (type === vscode.FileType.Directory) {
      if (matcher(childRelative, true)) uris.push(child);
      uris.push(...await collectFormatFiles(child, matcher, depth + 1, childRelative));
    } else if (type === vscode.FileType.File && matcher(childRelative, false)) {
      uris.push(child);
    }
  }
  return uris;
}

function globMatches(pattern: string, relativePath: string): boolean {
  return globSegmentsMatch(pattern.toLowerCase().split("/"), relativePath.toLowerCase().split("/"), 0, 0);
}

function globSegmentsMatch(pattern: string[], candidate: string[], patternIndex: number, candidateIndex: number): boolean {
  if (patternIndex === pattern.length) return candidateIndex === candidate.length;
  const segment = pattern[patternIndex];
  if (segment === "**") {
    for (let index = candidateIndex; index <= candidate.length; index++) if (globSegmentsMatch(pattern, candidate, patternIndex + 1, index)) return true;
    return false;
  }
  if (candidateIndex >= candidate.length) return false;
  return segmentMatches(segment ?? "", candidate[candidateIndex] ?? "") && globSegmentsMatch(pattern, candidate, patternIndex + 1, candidateIndex + 1);
}

function segmentMatches(pattern: string, candidate: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === candidate;
  let offset = 0;
  if ((parts[0] ?? "") && !candidate.startsWith(parts[0] ?? "")) return false;
  for (const part of parts) {
    if (!part) continue;
    const index = candidate.indexOf(part, offset);
    if (index < 0) return false;
    offset = index + part.length;
  }
  const last = parts[parts.length - 1] ?? "";
  return !last || candidate.endsWith(last);
}
