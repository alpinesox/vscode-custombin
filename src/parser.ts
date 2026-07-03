import * as crypto from "crypto";
import { BinaryReader, bytesToHex } from "./binaryReader";
import { ComputedCheck, DataRange, FieldDefinition, FormatDefinition, IntegrityCheck, ParsedField, ParseDiagnostic, ParseResult } from "./model";

export interface ParseOptions { maxArrayItems: number; maxRenderedFields: number; maxRawDisplayBytes: number }

interface ParseBudget {
  nodesRemaining: number;
  rawBytesRemaining: number;
  nodeLimitReported: boolean;
  rawLimitReported: boolean;
}

interface ParseContext {
  reader: BinaryReader;
  definition: FormatDefinition;
  rootDiagnostics: ParseDiagnostic[];
  options: ParseOptions;
  budget: ParseBudget;
  values: Map<string, string | number | bigint | boolean>;
  rawValues: Map<string, Uint8Array>;
  pendingValidations: PendingValidation[];
}

interface PendingValidation {
  field: FieldDefinition;
  path: string;
  offset: number;
  value: string | number | bigint;
  raw: Uint8Array;
  diagnostics: ParseDiagnostic[];
}

export function parseBinary(bytes: Uint8Array, definition: FormatDefinition, options: ParseOptions): ParseResult {
  const diagnostics: ParseDiagnostic[] = [];
  const context: ParseContext = { reader: new BinaryReader(bytes), definition, rootDiagnostics: diagnostics, options, budget: { nodesRemaining: options.maxRenderedFields, rawBytesRemaining: options.maxRawDisplayBytes, nodeLimitReported: false, rawLimitReported: false }, values: new Map(), rawValues: new Map(), pendingValidations: [] };
  const cursor = { offset: 0 };
  const fields: ParsedField[] = [];
  for (const field of definition.fields) {
    const parsed = parseField(context, field, cursor, field.name, 0);
    if (parsed) fields.push(parsed);
  }
  for (const validation of context.pendingValidations) validateIntegrity(context, validation.field, validation.path, validation.offset, validation.value, validation.raw, validation.diagnostics);
  return { formatId: definition.id, formatName: definition.name, fields, diagnostics, bytesConsumed: cursor.offset };
}

function parseField(
  context: ParseContext,
  field: FieldDefinition,
  cursor: { offset: number },
  path: string,
  depth: number
): ParsedField | undefined {
  const offset = field.offset ?? cursor.offset;
  const diagnostics: ParseDiagnostic[] = [];
  const label = field.label ?? field.name;
  try {
    if (depth > 16) throw new Error("Maximum nested structure depth exceeded.");
    if (!dependencySatisfied(field, context, path)) return undefined;
    if (!consumeNodeBudget(context.budget, context.rootDiagnostics, path, offset)) return undefined;
    const result = isRepeated(field)
      ? parseArray(context, field, offset, path, depth)
      : field.type === "struct" || field.type === "section"
        ? parseStruct(context, field, offset, path, depth)
        : parseScalarField(context, field, offset, path, label, diagnostics);
    if (field.offset === undefined) cursor.offset = offset + result.length;
    return result;
  } catch (error) {
    const diagnostic = { severity: "error" as const, message: error instanceof Error ? error.message : String(error), path, offset };
    diagnostics.push(diagnostic);
    context.rootDiagnostics.push(diagnostic);
    return {
      path,
      name: field.name,
      label,
      description: field.description,
      type: field.type,
      offset,
      length: 0,
      rawValue: "",
      displayValue: "<parse error>",
      meta: field.meta,
      diagnostics,
    };
  }
}

function parseScalarField(context: ParseContext, field: FieldDefinition, offset: number, path: string, label: string, diagnostics: ParseDiagnostic[]): ParsedField {
  const parsed = parseScalar(context, field, offset, path);
  context.values.set(path, parsed.value);
  context.rawValues.set(path, parsed.raw);
  const rawValue = formatRawValue(parsed.raw, path, offset, context.rootDiagnostics, context.budget);
  if (field.computed || field.checksum || field.hash) context.pendingValidations.push({ field, path, offset, value: parsed.value, raw: parsed.raw, diagnostics });
  return {
    path,
    name: field.name,
    label,
    description: field.description,
    type: field.type,
    offset,
    length: parsed.length,
    rawValue,
    displayValue: field.type === "bytes" ? rawValue : formatValue(parsed.value, field, parsed.raw),
    meta: field.meta,
    diagnostics,
  };
}

function parseScalar(context: ParseContext, field: FieldDefinition, offset: number, path: string): { value: string | number | bigint; length: number; raw: Uint8Array } {
  if (field.type === "string") {
    const length = resolveLength(context, field, offset, path) ?? 0;
    const raw = context.reader.slice(offset, length);
    return { value: decodeString(raw, field.encoding ?? "utf8", field.trimNull ?? true), length, raw };
  }
  if (field.type === "bytes") {
    const length = resolveLength(context, field, offset, path) ?? 0;
    const raw = context.reader.slice(offset, length);
    return { value: bytesToHex(raw, " "), length, raw };
  }
  return context.reader.read(offset, field.type, field.endianness ?? context.definition.endianness ?? "little");
}

function parseStruct(
  context: ParseContext,
  field: FieldDefinition,
  offset: number,
  path: string,
  depth: number
): ParsedField {
  const childCursor = { offset };
  const children: ParsedField[] = [];
  for (const child of field.children ?? []) {
    const parsed = parseField(context, child, childCursor, `${path}.${child.name}`, depth + 1);
    if (parsed) children.push(parsed);
    if (context.budget.nodesRemaining <= 0) { reportNodeBudget(context.budget, context.rootDiagnostics, `${path}.${child.name}`, childCursor.offset); break; }
  }
  const length = field.itemLength ?? field.length ?? Math.max(0, childCursor.offset - offset);
  return { path, name: field.name, label: field.label ?? field.name, description: field.description, type: field.type, offset, length, rawValue: "", displayValue: `${children.length} fields`, meta: field.meta, children, diagnostics: [] };
}

function parseArray(
  context: ParseContext,
  field: FieldDefinition,
  offset: number,
  path: string,
  depth: number
): ParsedField {
  const requestedCount = resolveArrayCount(context, field, offset, path);
  const count = Math.min(requestedCount, context.options.maxArrayItems);
  const item: FieldDefinition = { ...field, count: undefined, repeatToEof: undefined, lengthFrom: undefined, offset: undefined, name: "item", label: "Item" };
  const itemCursor = { offset };
  const children: ParsedField[] = [];
  for (let i = 0; i < count; i++) {
    if (field.repeatToEof && itemCursor.offset >= context.reader.length) break;
    const before = itemCursor.offset;
    const parsed = parseField(context, item, itemCursor, `${path}[${i}]`, depth + 1);
    if (parsed) children.push({ ...parsed, label: `${field.label ?? field.name} [${i}]` });
    itemCursor.offset = before + itemSpan(field, parsed?.length ?? Math.max(0, itemCursor.offset - before));
    if (context.budget.nodesRemaining <= 0) { reportNodeBudget(context.budget, context.rootDiagnostics, `${path}[${i}]`, itemCursor.offset); break; }
  }
  if (requestedCount > context.options.maxArrayItems) context.rootDiagnostics.push({ severity: "warning", message: `Array ${path} truncated at ${context.options.maxArrayItems} items.`, path, offset });
  return { path, name: field.name, label: field.label ?? field.name, description: field.description, type: field.type, offset, length: Math.max(0, itemCursor.offset - offset), rawValue: "", displayValue: `${children.length} item(s)`, meta: field.meta, children, diagnostics: [] };
}

function isRepeated(field: FieldDefinition): boolean {
  return field.count !== undefined || (field.repeatToEof === true && field.type !== "string" && field.type !== "bytes") || (field.lengthFrom !== undefined && field.type !== "string" && field.type !== "bytes");
}

function resolveLength(context: ParseContext, field: FieldDefinition, offset: number, path: string): number | undefined {
  if (field.repeatToEof) return Math.max(0, context.reader.length - offset);
  return field.lengthFrom ? numericValue(context, field.lengthFrom, path) : field.length;
}

function resolveArrayCount(context: ParseContext, field: FieldDefinition, offset: number, path: string): number {
  if (field.count !== undefined) return field.count;
  if (field.lengthFrom) return numericValue(context, field.lengthFrom, path) ?? 0;
  if (field.repeatToEof) {
    const span = itemSpan(field, field.itemLength ?? field.stride ?? scalarWidth(field));
    return span > 0 ? Math.floor((context.reader.length - offset) / span) : context.options.maxArrayItems;
  }
  return 0;
}

function itemSpan(field: FieldDefinition, parsedLength: number): number {
  return field.stride ?? field.itemLength ?? parsedLength;
}

function scalarWidth(field: FieldDefinition): number {
  switch (field.type) {
    case "u8": case "i8": return 1;
    case "u16": case "i16": return 2;
    case "u32": case "i32": case "f32": return 4;
    case "u64": case "i64": case "f64": return 8;
    default: return field.itemLength ?? field.length ?? 0;
  }
}

function decodeString(bytes: Uint8Array, encoding: string, trimNull: boolean): string {
  if (encoding === "hex") return bytesToHex(bytes, " ");
  const decoder = new TextDecoder(textDecoderEncoding(encoding), { fatal: false });
  const text = decoder.decode(bytes);
  return trimNull ? text.replace(/\0+$/g, "") : text;
}

function textDecoderEncoding(encoding: string): string {
  if (encoding === "ascii") return "latin1";
  if (encoding === "utf16le") return "utf-16le";
  return encoding;
}

function consumeNodeBudget(budget: ParseBudget, diagnostics: ParseDiagnostic[], path: string, offset: number): boolean {
  if (budget.nodesRemaining > 0) { budget.nodesRemaining--; return true; }
  reportNodeBudget(budget, diagnostics, path, offset);
  return false;
}

function reportNodeBudget(budget: ParseBudget, diagnostics: ParseDiagnostic[], path: string, offset: number): void {
  if (budget.nodeLimitReported) return;
  diagnostics.push({ severity: "warning", message: "Parse output truncated because the rendered field limit was reached.", path, offset });
  budget.nodeLimitReported = true;
}

function formatRawValue(raw: Uint8Array, path: string, offset: number, diagnostics: ParseDiagnostic[], budget: ParseBudget): string {
  const allowed = Math.max(0, Math.min(raw.byteLength, budget.rawBytesRemaining));
  budget.rawBytesRemaining -= allowed;
  const formatted = allowed > 0 ? bytesToHex(raw.subarray(0, allowed), " ") : "";
  if (allowed < raw.byteLength) {
    if (!budget.rawLimitReported) {
      diagnostics.push({ severity: "warning", message: "Raw byte display truncated because the raw display budget was reached.", path, offset });
      budget.rawLimitReported = true;
    }
    return formatted ? `${formatted} ... <truncated>` : "<truncated>";
  }
  return formatted;
}

function dependencySatisfied(field: FieldDefinition, context: ParseContext, currentPath: string): boolean {
  if (!field.dependsOn) return true;
  const dependencies = Array.isArray(field.dependsOn) ? field.dependsOn : [field.dependsOn];
  return dependencies.every(dependency => {
    const actual = fieldValue(context, dependency.path, currentPath);
    const present = actual !== undefined;
    if (dependency.present !== undefined && dependency.present !== present) return false;
    if (dependency.present === false && !present && dependency.equals === undefined && dependency.notEquals === undefined && dependency.mask === undefined) return true;
    if (!present) return false;
    const comparable = dependency.mask !== undefined ? applyMask(actual, dependency.mask) : actual;
    if (dependency.equals !== undefined && String(comparable) !== String(dependency.equals)) return false;
    if (dependency.notEquals !== undefined && String(comparable) === String(dependency.notEquals)) return false;
    if (dependency.mask !== undefined && dependency.equals === undefined && dependency.notEquals === undefined) return Number(comparable) !== 0;
    return true;
  });
}

function applyMask(value: string | number | bigint | boolean, mask: number): number | bigint {
  if (typeof value === "bigint") return value & BigInt(mask);
  if (typeof value === "number") return value & mask;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric & mask : 0;
}

function numericValue(context: ParseContext, path: string, currentPath?: string): number | undefined {
  const value = fieldValue(context, path, currentPath);
  if (value === undefined) return undefined;
  const numeric = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function fieldValue(context: ParseContext, path: string, currentPath?: string): string | number | bigint | boolean | undefined {
  return context.values.get(resolveFieldPath(context.values, path, currentPath));
}

function resolveFieldPath(values: Map<string, unknown>, path: string, currentPath?: string): string {
  if (values.has(path) || !currentPath || path.includes(".")) return path;
  const parent = currentPath.includes(".") ? currentPath.slice(0, currentPath.lastIndexOf(".")) : "";
  const sibling = parent ? `${parent}.${path}` : path;
  return values.has(sibling) ? sibling : path;
}

function validateIntegrity(context: ParseContext, field: FieldDefinition, path: string, offset: number, value: string | number | bigint, raw: Uint8Array, fieldDiagnostics: ParseDiagnostic[]): void {
  if (field.computed) validateComputed(context, field.computed, path, offset, value, raw, fieldDiagnostics);
  const check = field.checksum ?? field.hash;
  if (!check) return;
  const range = resolveRange(context, check.range);
  if (!range) {
    pushIntegrityDiagnostic(context, fieldDiagnostics, check, `Unable to validate ${path}; checksum/hash range could not be resolved.`, path, offset);
    return;
  }
  const bytes = context.reader.slice(range.offset, range.length);
  const actual = computeIntegrity(check, bytes);
  const matches = isChecksumAlgorithm(check.algorithm) ? integrityNumberMatches(value, raw, actual) : bytesEqual(raw, actual);
  if (!matches) {
    pushIntegrityDiagnostic(context, fieldDiagnostics, check, `${path} ${check.algorithm} mismatch: expected ${expectedDisplay(value, raw)}, computed ${bytesToHex(actual)}.`, path, offset);
  }
}

type ComputedValue = Uint8Array | number;

function validateComputed(context: ParseContext, check: ComputedCheck, path: string, offset: number, value: string | number | bigint, raw: Uint8Array, fieldDiagnostics: ParseDiagnostic[]): void {
  try {
    const computed = applyDerive(evaluateComputed(context, check.expression, 0), check.derive);
    const targetPath = check.compare?.targetPath;
    const targetValue = targetPath ? context.values.get(targetPath) : value;
    const targetRaw = targetPath ? context.rawValues.get(targetPath) : raw;
    if (targetValue === undefined || targetRaw === undefined) throw new Error(`compare target ${targetPath ?? path} is unavailable`);
    const matches = computedMatches(computed, targetValue, targetRaw, check.compare?.mode ?? "auto");
    if (!matches) pushComputedDiagnostic(context, fieldDiagnostics, check, `${path} computed mismatch against ${targetPath ?? path}: expected ${expectedDisplay(targetValue, targetRaw)}, computed ${computedDisplay(computed)}.`, path, offset);
  } catch (error) {
    pushComputedDiagnostic(context, fieldDiagnostics, check, `Unable to validate ${path}; computed expression failed: ${error instanceof Error ? error.message : String(error)}.`, path, offset);
  }
}

function applyDerive(value: ComputedValue, derive: ComputedCheck["derive"]): ComputedValue {
  let current = value;
  for (const step of derive ?? []) {
    switch (step.op) {
      case "slice": current = byteSlice(asBytes(current), step.start, step.end); break;
      case "u32le": case "le32": current = readU32(asBytes(current), true); break;
      case "u32be": case "be32": current = readU32(asBytes(current), false); break;
    }
  }
  return current;
}

function computedMatches(computed: ComputedValue, targetValue: string | number | bigint | boolean, targetRaw: Uint8Array, mode: "auto" | "numeric" | "raw-bytes"): boolean {
  if (mode === "numeric") return typeof computed === "number" && computedNumberMatches(targetValue, targetRaw, computed);
  if (mode === "raw-bytes") return bytesEqual(asBytes(computed), targetRaw);
  return typeof computed === "number" ? computedNumberMatches(targetValue, targetRaw, computed) : bytesEqual(targetRaw, computed);
}

function evaluateComputed(context: ParseContext, expression: string, depth: number): ComputedValue {
  if (depth > 16) throw new Error("maximum computed expression depth exceeded");
  const trimmed = expression.trim();
  const slice = parseSliceSuffix(trimmed);
  if (slice) return byteSlice(asBytes(evaluateComputed(context, slice.target, depth + 1)), slice.start, slice.end);
  if (/^0x[0-9A-Fa-f]+$/.test(trimmed)) return Number.parseInt(trimmed.slice(2), 16);
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const call = parseFunctionCall(trimmed);
  if (call) return evaluateFunction(context, call.name, call.args, depth + 1);
  const value = numericValue(context, trimmed);
  if (value !== undefined) return value;
  throw new Error(`unsupported token ${trimmed}`);
}

function evaluateFunction(context: ParseContext, name: string, args: string[], depth: number): ComputedValue {
  switch (name.toLowerCase()) {
    case "slice": {
      if (args.length !== 2) throw new Error("slice requires offset and length");
      const offset = asNumber(evaluateComputed(context, args[0] ?? "", depth));
      const length = asNumber(evaluateComputed(context, args[1] ?? "", depth));
      if (length > 100 * 1024 * 1024) throw new Error("slice length exceeds limit");
      return context.reader.slice(offset, length);
    }
    case "sha1": case "sha256": case "sha384": case "sha512": case "sha3_256": case "sha3_384": case "sha3_512": {
      if (args.length !== 1) throw new Error(`${name} requires one byte input`);
      return crypto.createHash(hashAlgorithmName(name)).update(asBytes(evaluateComputed(context, args[0] ?? "", depth))).digest();
    }
    case "crc32": {
      if (args.length !== 1) throw new Error("crc32 requires one byte input");
      return crc32ReflectedBytes(asBytes(evaluateComputed(context, args[0] ?? "", depth)));
    }
    case "crc32_reflected": case "crc32_ieee": {
      if (args.length !== 1) throw new Error(`${name} requires one byte input`);
      return crc32ReflectedBytes(asBytes(evaluateComputed(context, args[0] ?? "", depth)));
    }
    case "crc32_non_reflected": case "crc32_msb": case "crc32_mpeg2": {
      if (args.length !== 1) throw new Error(`${name} requires one byte input`);
      return crc32NonReflectedBytes(asBytes(evaluateComputed(context, args[0] ?? "", depth)));
    }
    case "concat": {
      if (args.length < 1 || args.length > 16) throw new Error("concat requires 1 to 16 byte inputs");
      return concatBytes(args.map(arg => asBytes(evaluateComputed(context, arg, depth))));
    }
    case "hex": {
      if (args.length !== 1) throw new Error("hex requires one hex literal argument");
      return hexLiteralToBytes(args[0] ?? "");
    }
    case "u32le": case "le32": {
      if (args.length !== 1) throw new Error(`${name} requires one byte input`);
      return readU32(asBytes(evaluateComputed(context, args[0] ?? "", depth)), true);
    }
    case "u32be": case "be32": {
      if (args.length !== 1) throw new Error(`${name} requires one byte input`);
      return readU32(asBytes(evaluateComputed(context, args[0] ?? "", depth)), false);
    }
    default: throw new Error(`unsupported function ${name}`);
  }
}

function parseFunctionCall(expression: string): { name: string; args: string[] } | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/.exec(expression);
  if (!match) return undefined;
  return { name: match[1] ?? "", args: splitArgs(match[2] ?? "") };
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let bracketDepth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "[") bracketDepth++;
    else if (char === "]") bracketDepth--;
    else if (char === "," && depth === 0 && bracketDepth === 0) { args.push(input.slice(start, i).trim()); start = i + 1; }
  }
  const last = input.slice(start).trim();
  if (last) args.push(last);
  return args;
}

function parseSliceSuffix(expression: string): { target: string; start: number; end: number } | undefined {
  const match = /^(.*)\[(\d+):(\d+)\]$/.exec(expression);
  if (!match) return undefined;
  return { target: (match[1] ?? "").trim(), start: Number.parseInt(match[2] ?? "0", 10), end: Number.parseInt(match[3] ?? "0", 10) };
}

function byteSlice(bytes: Uint8Array, start: number, end: number): Uint8Array {
  if (start < 0 || end < start || end > bytes.byteLength) throw new Error("computed byte slice is out of range");
  return bytes.subarray(start, end);
}

function asBytes(value: ComputedValue): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concatBytes(values: Uint8Array[]): Uint8Array {
  const total = values.reduce((sum, value) => sum + value.byteLength, 0);
  if (total > 100 * 1024 * 1024) throw new Error("concat result exceeds limit");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.byteLength; }
  return result;
}

function hexLiteralToBytes(value: string): Uint8Array {
  const normalized = value.trim().replace(/^0x/i, "");
  if (!/^([0-9A-Fa-f]{2})*$/.test(normalized)) throw new Error("hex literal must contain an even number of hex digits");
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  return bytes;
}

function asNumber(value: ComputedValue): number {
  if (typeof value === "number") return value;
  if (value.byteLength > 6) throw new Error("byte value is too large for numeric conversion");
  return Array.from(value).reduce((total, byte) => (total * 256) + byte, 0);
}

function hashAlgorithmName(name: string): string {
  return name.replace(/_/g, "-");
}

function readU32(bytes: Uint8Array, littleEndian: boolean): number {
  if (bytes.byteLength < 4) throw new Error("u32 conversion requires at least four bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, littleEndian);
}

function computedNumberMatches(value: string | number | bigint | boolean, raw: Uint8Array, computed: number): boolean {
  if (typeof value === "number") return value >>> 0 === computed >>> 0;
  if (typeof value === "bigint") return value === BigInt(computed >>> 0);
  return integrityNumberMatches(value, raw, u32beBytes(computed));
}

function u32beBytes(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function computedDisplay(value: ComputedValue): string {
  return typeof value === "number" ? String(value) : bytesToHex(value);
}

function pushComputedDiagnostic(context: ParseContext, fieldDiagnostics: ParseDiagnostic[], check: ComputedCheck, message: string, path: string, offset: number): void {
  const diagnostic = { severity: check.severity ?? "error", message, path, offset };
  fieldDiagnostics.push(diagnostic);
  context.rootDiagnostics.push(diagnostic);
}

function resolveRange(context: ParseContext, range: DataRange): { offset: number; length: number } | undefined {
  const offset = range.offsetFrom ? numericValue(context, range.offsetFrom) : range.offset;
  const length = range.lengthFrom ? numericValue(context, range.lengthFrom) : range.length;
  if (offset === undefined || length === undefined) return undefined;
  return { offset, length };
}

function computeIntegrity(check: IntegrityCheck, bytes: Uint8Array): Uint8Array {
  if (check.algorithm === "crc32" || check.algorithm === "crc32-reflected") return crc32ReflectedBytes(bytes);
  if (check.algorithm === "crc32-non-reflected") return crc32NonReflectedBytes(bytes);
  return crypto.createHash(hashAlgorithmName(check.algorithm)).update(bytes).digest();
}

function isChecksumAlgorithm(algorithm: IntegrityCheck["algorithm"]): boolean {
  return algorithm === "crc32" || algorithm === "crc32-reflected" || algorithm === "crc32-non-reflected";
}

function crc32ReflectedBytes(bytes: Uint8Array): Uint8Array {
  const value = crc32Reflected(bytes);
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function crc32NonReflectedBytes(bytes: Uint8Array): Uint8Array {
  const value = crc32NonReflected(bytes);
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function crc32Reflected(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function crc32NonReflected(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) : (crc << 1);
  }
  return crc >>> 0;
}

const CRC32_TABLE = new Uint32Array(Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
}));

function integrityNumberMatches(value: string | number | bigint | boolean, raw: Uint8Array, computed: Uint8Array): boolean {
  const computedNumber = ((computed[0] ?? 0) * 0x1000000) + ((computed[1] ?? 0) << 16) + ((computed[2] ?? 0) << 8) + (computed[3] ?? 0);
  if (typeof value === "number") return value >>> 0 === computedNumber >>> 0;
  if (typeof value === "bigint") return value === BigInt(computedNumber >>> 0);
  return bytesEqual(raw, computed);
}

function expectedDisplay(value: string | number | bigint | boolean, raw: Uint8Array): string {
  return typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" ? String(value) : bytesToHex(raw);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) return false;
  return true;
}

function pushIntegrityDiagnostic(context: ParseContext, fieldDiagnostics: ParseDiagnostic[], check: IntegrityCheck, message: string, path: string, offset: number): void {
  const diagnostic = { severity: check.severity ?? "error", message, path, offset };
  fieldDiagnostics.push(diagnostic);
  context.rootDiagnostics.push(diagnostic);
}

function formatValue(value: string | number | bigint, field: FieldDefinition, raw: Uint8Array): string {
  const key = String(value);
  const enumValue = field.enum?.[key];
  const suffix = enumValue ? ` (${enumValue})` : "";
  if (field.flags && (typeof value === "number" || typeof value === "bigint")) {
    const active = field.flags.filter(flag => flagActive(value, flag.mask)).map(flag => flag.label);
    return `${formatPrimitive(value, field, raw)}${active.length ? ` [${active.join(", ")}]` : ""}`;
  }
  return `${formatPrimitive(value, field, raw)}${suffix}`;
}

function flagActive(value: number | bigint, mask: number): boolean {
  return typeof value === "bigint" ? (value & BigInt(mask)) === BigInt(mask) : (value & mask) === mask;
}

function formatPrimitive(value: string | number | bigint, field: FieldDefinition, raw: Uint8Array): string {
  if (field.format === "hex") return `0x${bytesToHex(raw)}`;
  if (field.format === "binary" && (typeof value === "number" || typeof value === "bigint")) return `0b${bytesToBinary(raw)}`;
  if (field.format === "timestamp-unix" && (typeof value === "number" || typeof value === "bigint")) return new Date(Number(value) * 1000).toISOString();
  return String(value);
}

function bytesToBinary(bytes: Uint8Array): string {
  return Array.from(bytes).map(byte => byte.toString(2).padStart(8, "0")).join("");
}
