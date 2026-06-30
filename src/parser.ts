import { BinaryReader, bytesToHex } from "./binaryReader";
import { FieldDefinition, FormatDefinition, ParsedField, ParseDiagnostic, ParseResult } from "./model";

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
}

export function parseBinary(bytes: Uint8Array, definition: FormatDefinition, options: ParseOptions): ParseResult {
  const diagnostics: ParseDiagnostic[] = [];
  const context: ParseContext = { reader: new BinaryReader(bytes), definition, rootDiagnostics: diagnostics, options, budget: { nodesRemaining: options.maxRenderedFields, rawBytesRemaining: options.maxRawDisplayBytes, nodeLimitReported: false, rawLimitReported: false }, values: new Map() };
  const cursor = { offset: 0 };
  const fields: ParsedField[] = [];
  for (const field of definition.fields) {
    const parsed = parseField(context, field, cursor, field.name, 0);
    if (parsed) fields.push(parsed);
  }
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
    if (!dependencySatisfied(field, context)) return undefined;
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
  const parsed = parseScalar(context, field, offset);
  context.values.set(path, parsed.value);
  const rawValue = formatRawValue(parsed.raw, path, offset, context.rootDiagnostics, context.budget);
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

function parseScalar(context: ParseContext, field: FieldDefinition, offset: number): { value: string | number | bigint; length: number; raw: Uint8Array } {
  if (field.type === "string") {
    const length = resolveLength(context, field) ?? 0;
    const raw = context.reader.slice(offset, length);
    return { value: decodeString(raw, field.encoding ?? "utf8", field.trimNull ?? true), length, raw };
  }
  if (field.type === "bytes") {
    const length = resolveLength(context, field) ?? 0;
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
  const requestedCount = resolveArrayCount(context, field, offset);
  const count = Math.min(requestedCount, context.options.maxArrayItems);
  const item: FieldDefinition = { ...field, count: undefined, repeatToEof: undefined, lengthFrom: undefined, offset: undefined, name: "item", label: "Item" };
  const itemCursor = { offset };
  const children: ParsedField[] = [];
  for (let i = 0; i < count; i++) {
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
  return field.count !== undefined || field.repeatToEof === true || (field.lengthFrom !== undefined && field.type !== "string" && field.type !== "bytes");
}

function resolveLength(context: ParseContext, field: FieldDefinition): number | undefined {
  return field.lengthFrom ? numericValue(context, field.lengthFrom) : field.length;
}

function resolveArrayCount(context: ParseContext, field: FieldDefinition, offset: number): number {
  if (field.count !== undefined) return field.count;
  if (field.lengthFrom) return numericValue(context, field.lengthFrom) ?? 0;
  if (field.repeatToEof) {
    const span = itemSpan(field, field.itemLength ?? field.stride ?? scalarWidth(field));
    return span > 0 ? Math.floor((context.reader.length - offset) / span) : 0;
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

function dependencySatisfied(field: FieldDefinition, context: ParseContext): boolean {
  if (!field.dependsOn) return true;
  const dependencies = Array.isArray(field.dependsOn) ? field.dependsOn : [field.dependsOn];
  return dependencies.every(dependency => {
    const actual = context.values.get(dependency.path);
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

function numericValue(context: ParseContext, path: string): number | undefined {
  const value = context.values.get(path);
  if (value === undefined) return undefined;
  const numeric = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
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
