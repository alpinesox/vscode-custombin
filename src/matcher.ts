import * as path from "path";
import { bytesToHex } from "./binaryReader";
import { CandidateResult, FormatDefinition } from "./model";
import { parseBinary, ParseOptions } from "./parser";

export function matchFormats(bytes: Uint8Array, filename: string, definitions: FormatDefinition[], options: ParseOptions): CandidateResult[] {
  const ext = path.extname(filename).toLowerCase();
  const candidates: CandidateResult[] = [];
  for (const definition of definitions) {
    const reasons: string[] = [];
    let score = definition.confidence ?? 0;
    if (definition.minSize !== undefined && bytes.length < definition.minSize) continue;
    if (definition.maxSize !== undefined && bytes.length > definition.maxSize) continue;
    let matchedSignal = false;
    if (definition.fileExtensions?.map(item => item.toLowerCase()).includes(ext)) { score += 20; reasons.push(`extension ${ext} matched`); matchedSignal = true; }
    const magic = scoreMagic(bytes, definition, reasons);
    if (magic.requiredFailed) continue;
    if (magic.score > 0) matchedSignal = true;
    score += magic.score;
    const result = parseBinary(bytes, definition, options);
    const errors = result.diagnostics.filter(item => item.severity === "error").length;
    const warnings = result.diagnostics.filter(item => item.severity === "warning").length;
    score += Math.max(0, definition.fields.length - errors) * 3;
    score -= errors * 25;
    score -= warnings * 5;
    if (errors === 0) reasons.push("parsed without errors");
    if (!matchedSignal && errors > 0) continue;
    if (score < 1) continue;
    candidates.push({ definition, score, reasons, result });
  }
  return candidates.sort((a, b) => b.score - a.score || a.definition.name.localeCompare(b.definition.name));
}

function scoreMagic(bytes: Uint8Array, definition: FormatDefinition, reasons: string[]): { score: number; requiredFailed: boolean } {
  let score = 0;
  for (const rule of definition.magic ?? []) {
    const expected = rule.bytes.toUpperCase();
    if (rule.offset + expected.length / 2 > bytes.length) {
      if (rule.required ?? true) return { score, requiredFailed: true };
      continue;
    }
    const actual = bytesToHex(bytes.subarray(rule.offset, rule.offset + expected.length / 2));
    if (actual === expected) { score += 50; reasons.push(rule.description ?? `magic matched at ${rule.offset}`); }
    else if (rule.required ?? true) return { score, requiredFailed: true };
  }
  return { score, requiredFailed: false };
}
