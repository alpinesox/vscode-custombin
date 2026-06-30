import * as crypto from "crypto";
import * as vscode from "vscode";
import { CandidateResult, RegistryDiagnostic } from "./model";

export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, payload: unknown): string {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.js"));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Custom Binary Viewer</title>
  <style nonce="${nonce}">
    *{box-sizing:border-box}body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);background:var(--vscode-editor-background);color:var(--vscode-foreground);margin:0;padding:14px}
    header{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:12px;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:10px}
    h1{font-size:1.1rem;margin:0}.meta{color:var(--vscode-descriptionForeground);font-size:.9em}.controls{display:flex;gap:8px;align-items:center}select,button{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);padding:4px 8px;border-radius:3px}
    .banner{padding:8px 10px;border-radius:5px;margin:8px 0}.warn{background:rgba(255,180,0,.14)}.err{background:rgba(220,50,50,.14)}.info{background:rgba(90,150,255,.14)}
    table{border-collapse:collapse;width:100%;margin-top:10px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--vscode-panel-border);padding:5px 8px}th{color:var(--vscode-descriptionForeground);font-weight:600}.mono{font-family:var(--vscode-editor-font-family,monospace)}.value{word-break:break-all}.tree-pad{display:inline-block}
    .help{display:inline-flex;align-items:center;justify-content:center;margin-left:5px;width:14px;height:14px;border:1px solid var(--vscode-descriptionForeground);border-radius:50%;font-size:10px;color:var(--vscode-descriptionForeground);position:relative}.help:hover::after,.help:focus::after{content:attr(data-help);position:absolute;z-index:5;left:18px;top:-4px;width:300px;background:var(--vscode-editorHoverWidget-background);color:var(--vscode-editorHoverWidget-foreground);border:1px solid var(--vscode-panel-border);border-radius:5px;padding:8px;box-shadow:0 2px 8px rgba(0,0,0,.35)}
    .depth-0{width:0}.depth-1{width:18px}.depth-2{width:36px}.depth-3{width:54px}.depth-4{width:72px}.depth-5{width:90px}.depth-6{width:108px}.depth-7{width:126px}.depth-8{width:144px}.depth-9{width:162px}.depth-10{width:180px}.depth-11{width:198px}.depth-12{width:216px}.depth-13{width:234px}.depth-14{width:252px}.depth-15{width:270px}.depth-16{width:288px}
  </style>
</head>
<body>
  <div id="payload" data-json="${escapeAttr(JSON.stringify(payload))}" hidden></div>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function serializeCandidates(candidates: CandidateResult[], selectedId: string | undefined, registryDiagnostics: RegistryDiagnostic[]): unknown {
  const selected = candidates.find(candidate => candidate.definition.id === selectedId) ?? candidates[0];
  const metadata = selected ? {
    title: selected.definition.title,
    summary: selected.definition.summary ?? selected.definition.description,
    version: selected.definition.version,
    status: selected.definition.status,
    provenance: selected.definition.provenance,
    confidence: selected.definition.confidence,
    references: selected.definition.references,
    meta: selected.definition.meta,
  } : undefined;
  return {
    candidates: candidates.map(candidate => ({ id: candidate.definition.id, name: candidate.definition.name, score: candidate.score, reasons: candidate.reasons })),
    selectedId: selected?.definition.id,
    selected: selected ? { id: selected.definition.id, name: selected.definition.name, score: selected.score, reasons: selected.reasons, metadata, result: selected.result } : undefined,
    registryDiagnostics,
  };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
