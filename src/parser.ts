import { BinaryReader, bytesToHex } from "./binaryReader";
import { FieldDefinition, FormatDefinition, ParsedField, ParseDiagnostic, ParseResult } from "./model";

export interface ParseOptions { maxArrayItems: number }

export function parseBinary(bytes: Uint8Array, definition: FormatDefinition, options: ParseOptions): ParseResult {
  const reader = new BinaryReader(bytes);
  const diagnostics: ParseDiagnostic[] = [];
  const cursor = { offset: 0 };
  const fields: ParsedField[] = [];
  for (const field of definition.fields) {
    const parsed = parseField(reader, definition, field, cursor, field.name, diagnostics, options, 0);
    if (parsed) fields.push(parsed);
  }
  return { formatId: definition.id, formatName: definition.name, fields, diagnostics, bytesConsumed: cursor.offset };
}

function parseField(
  reader: BinaryReader,
  definition: FormatDefinition,
  field: FieldDefinition,
  cursor: { offset: number },
  path: string,
  rootDiagnostics: ParseDiagnostic[],
  options: ParseOptions,
  depth: number
): ParsedField | undefined {
  const offset = field.offset ?? cursor.offset;
  const diagnostics: ParseDiagnostic[] = [];
  const label = field.label ?? field.name;
  try {
    if (depth > 16) throw new Error("Maximum nested structure depth exceeded.");
    const result = field.count !== undefined
      ? parseArray(reader, definition, field, offset, path, rootDiagnostics, options, depth)
      : field.type === "struct"
        ? parseStruct(reader, definition, field, offset, path, rootDiagnostics, options, depth)
        : parseScalarField(reader, definition, field, offset, path, label, diagnostics);
    if (field.offset === undefined) cursor.offset = offset + result.length;
    return result;
  } catch (error) {
    const diagnostic = { severity: "error" as const, message: error instanceof Error ? error.message : String(error), path, offset };
    diagnostics.push(diagnostic);
    rootDiagnostics.push(diagnostic);
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
      diagnostics,
    };
  }
}

function parseScalarField(reader: BinaryReader, definition: FormatDefinition, field: FieldDefinition, offset: number, path: string, label: string, diagnostics: ParseDiagnostic[]): ParsedField {
  const parsed = parseScalar(reader, definition, field, offset);
  return {
    path,
    name: field.name,
    label,
    description: field.description,
    type: field.type,
    offset,
    length: parsed.length,
    rawValue: bytesToHex(parsed.raw, " "),
    displayValue: formatValue(parsed.value, field, parsed.raw),
    diagnostics,
  };
}

function parseScalar(reader: BinaryReader, definition: FormatDefinition, field: FieldDefinition, offset: number): { value: string | number | bigint; length: number; raw: Uint8Array } {
  if (field.type === "string") {
    const length = field.length ?? 0;
    const raw = reader.slice(offset, length);
    return { value: decodeString(raw, field.encoding ?? "utf8", field.trimNull ?? true), length, raw };
  }
  if (field.type === "bytes") {
    const length = field.length ?? 0;
    const raw = reader.slice(offset, length);
    return { value: bytesToHex(raw, " "), length, raw };
  }
  return reader.read(offset, field.type, field.endianness ?? definition.endianness ?? "little");
}

function parseStruct(
  reader: BinaryReader,
  definition: FormatDefinition,
  field: FieldDefinition,
  offset: number,
  path: string,
  rootDiagnostics: ParseDiagnostic[],
  options: ParseOptions,
  depth: number
): ParsedField {
  const childCursor = { offset };
  const children: ParsedField[] = [];
  for (const child of field.children ?? []) {
    const parsed = parseField(reader, definition, child, childCursor, `${path}.${child.name}`, rootDiagnostics, options, depth + 1);
    if (parsed) children.push(parsed);
  }
  const length = Math.max(0, childCursor.offset - offset);
  return { path, name: field.name, label: field.label ?? field.name, description: field.description, type: field.type, offset, length, rawValue: "", displayValue: `${children.length} fields`, children, diagnostics: [] };
}

function parseArray(
  reader: BinaryReader,
  definition: FormatDefinition,
  field: FieldDefinition,
  offset: number,
  path: string,
  rootDiagnostics: ParseDiagnostic[],
  options: ParseOptions,
  depth: number
): ParsedField {
  const count = Math.min(field.count ?? 0, options.maxArrayItems);
  const item: FieldDefinition = { ...field, count: undefined, offset: undefined, name: "item", label: "Item" };
  const itemCursor = { offset };
  const children: ParsedField[] = [];
  for (let i = 0; i < count; i++) {
    const parsed = parseField(reader, definition, item, itemCursor, `${path}[${i}]`, rootDiagnostics, options, depth + 1);
    if (parsed) children.push({ ...parsed, label: `${field.label ?? field.name} [${i}]` });
  }
  if ((field.count ?? 0) > options.maxArrayItems) rootDiagnostics.push({ severity: "warning", message: `Array ${path} truncated at ${options.maxArrayItems} items.`, path, offset });
  return { path, name: field.name, label: field.label ?? field.name, description: field.description, type: field.type, offset, length: Math.max(0, itemCursor.offset - offset), rawValue: "", displayValue: `${children.length} item(s)`, children, diagnostics: [] };
}

function decodeString(bytes: Uint8Array, encoding: string, trimNull: boolean): string {
  if (encoding === "hex") return bytesToHex(bytes, " ");
  const decoder = new TextDecoder(encoding === "ascii" ? "latin1" : encoding, { fatal: false });
  const text = decoder.decode(bytes);
  return trimNull ? text.replace(/\0+$/g, "") : text;
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
  if (field.format === "binary" && typeof value === "number") return `0b${value.toString(2)}`;
  if (field.format === "timestamp-unix" && (typeof value === "number" || typeof value === "bigint")) return new Date(Number(value) * 1000).toISOString();
  return String(value);
}
