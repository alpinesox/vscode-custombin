import { FormatDefinition, RegistryDiagnostic } from "./model";

const SUPPORTED_TYPES = new Set(["u8", "i8", "u16", "i16", "u32", "i32", "u64", "i64", "f32", "f64", "bytes", "string", "struct", "section"]);
const TOP_LEVEL_KEYS = new Set(["schemaVersion", "id", "name", "title", "summary", "version", "status", "provenance", "references", "meta", "description", "fileExtensions", "endianness", "confidence", "minSize", "maxSize", "magic", "fields"]);
const FIELD_KEYS = new Set(["name", "label", "description", "offset", "type", "endianness", "length", "encoding", "trimNull", "count", "repeatToEof", "stride", "itemLength", "lengthFrom", "enum", "flags", "children", "format", "required", "dependsOn", "checksum", "hash", "computed", "meta"]);
const MAGIC_KEYS = new Set(["offset", "bytes", "required", "description"]);
const ENCODINGS = new Set(["ascii", "utf8", "utf16le", "hex"]);
const FORMATS = new Set(["decimal", "hex", "binary", "timestamp-unix", "raw"]);
const CHECKSUM_ALGORITHMS = new Set(["crc32"]);
const HASH_ALGORITHMS = new Set(["sha1", "sha256", "sha384", "sha512"]);
const SEVERITIES = new Set(["error", "warning", "info"]);
const MAX_DEPTH = 16;
const MAX_FIELDS = 4096;

export function validateFormatDefinition(value: unknown, sourcePath: string): { definition?: FormatDefinition; diagnostics: RegistryDiagnostic[] } {
  const diagnostics: RegistryDiagnostic[] = [];
  if (!isRecord(value)) return { diagnostics: [diag(sourcePath, "Format definition must be a JSON object.")] };
  rejectUnknownKeys(value, TOP_LEVEL_KEYS, sourcePath, diagnostics, "definition");
  if (value.schemaVersion !== 1) diagnostics.push(diag(sourcePath, "schemaVersion must be 1."));
  if (typeof value.id !== "string" || !/^[A-Za-z0-9_.-]+$/.test(value.id)) diagnostics.push(diag(sourcePath, "id must be a stable identifier."));
  if (typeof value.name !== "string" || value.name.length === 0) diagnostics.push(diag(sourcePath, "name is required."));
  for (const key of ["title", "summary", "version", "status", "provenance", "description"]) validateOptionalString(value[key], sourcePath, diagnostics, key);
  if (!Array.isArray(value.fields) || value.fields.length === 0) diagnostics.push(diag(sourcePath, "fields must be a non-empty array."));

  const fields = Array.isArray(value.fields) ? value.fields : [];
  let fieldCount = 0;
  for (const field of fields) fieldCount += validateField(field, sourcePath, diagnostics, 0);
  if (fieldCount > MAX_FIELDS) diagnostics.push(diag(sourcePath, `Definition has ${fieldCount} fields; maximum is ${MAX_FIELDS}.`));

  validateStringArray(value.fileExtensions, sourcePath, diagnostics, "fileExtensions", /^\.[A-Za-z0-9_-]+$/);
  validateStringArray(value.references, sourcePath, diagnostics, "references", /^.{1,2048}$/);
  validateMetadata(value.meta, sourcePath, diagnostics, "meta");
  validateMagic(value.magic, sourcePath, diagnostics);
  validateOptionalInteger(value.minSize, sourcePath, diagnostics, "minSize", 0);
  validateOptionalInteger(value.maxSize, sourcePath, diagnostics, "maxSize", 0);
  if (typeof value.minSize === "number" && typeof value.maxSize === "number" && value.minSize > value.maxSize) diagnostics.push(diag(sourcePath, "minSize must not exceed maxSize."));
  validateOptionalInteger(value.confidence, sourcePath, diagnostics, "confidence", 0, 100);
  if (value.endianness !== undefined && value.endianness !== "little" && value.endianness !== "big") diagnostics.push(diag(sourcePath, "endianness must be little or big."));

  if (diagnostics.some(item => item.severity === "error")) return { diagnostics };
  return { definition: normalize(value as unknown as FormatDefinition, sourcePath), diagnostics };
}

function validateField(value: unknown, sourcePath: string, diagnostics: RegistryDiagnostic[], depth: number): number {
  if (!isRecord(value)) { diagnostics.push(diag(sourcePath, "Field must be an object.")); return 1; }
  rejectUnknownKeys(value, FIELD_KEYS, sourcePath, diagnostics, "field");
  if (depth > MAX_DEPTH) diagnostics.push(diag(sourcePath, `Field nesting exceeds ${MAX_DEPTH}.`));
  if (typeof value.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.name)) diagnostics.push(diag(sourcePath, "Field name must be an identifier."));
  if (typeof value.type !== "string" || !SUPPORTED_TYPES.has(value.type)) diagnostics.push(diag(sourcePath, `Unsupported field type: ${String(value.type)}.`));
  validateOptionalInteger(value.offset, sourcePath, diagnostics, "field.offset", 0);
  validateOptionalInteger(value.length, sourcePath, diagnostics, "field.length", 0, 1024 * 1024);
  validateOptionalInteger(value.count, sourcePath, diagnostics, "field.count", 0, 4096);
  validateOptionalInteger(value.stride, sourcePath, diagnostics, "field.stride", 1, 1024 * 1024);
  validateOptionalInteger(value.itemLength, sourcePath, diagnostics, "field.itemLength", 1, 1024 * 1024);
  if (value.repeatToEof !== undefined && typeof value.repeatToEof !== "boolean") diagnostics.push(diag(sourcePath, "field.repeatToEof must be boolean."));
  if (value.lengthFrom !== undefined && (typeof value.lengthFrom !== "string" || !isFieldPath(value.lengthFrom))) diagnostics.push(diag(sourcePath, "field.lengthFrom must be a field path."));
  if ((value.type === "string" || value.type === "bytes") && typeof value.length !== "number" && typeof value.lengthFrom !== "string") diagnostics.push(diag(sourcePath, `${String(value.type)} field ${String(value.name)} requires length or lengthFrom.`));
  if ((value.type === "struct" || value.type === "section") && !Array.isArray(value.children)) diagnostics.push(diag(sourcePath, `${String(value.type)} field ${String(value.name)} requires children.`));
  if (value.endianness !== undefined && value.endianness !== "little" && value.endianness !== "big") diagnostics.push(diag(sourcePath, "field.endianness must be little or big."));
  if (value.encoding !== undefined && (typeof value.encoding !== "string" || !ENCODINGS.has(value.encoding))) diagnostics.push(diag(sourcePath, "field.encoding is invalid."));
  if (value.format !== undefined && (typeof value.format !== "string" || !FORMATS.has(value.format))) diagnostics.push(diag(sourcePath, "field.format is invalid."));
  if (value.trimNull !== undefined && typeof value.trimNull !== "boolean") diagnostics.push(diag(sourcePath, "field.trimNull must be boolean."));
  if (value.required !== undefined && typeof value.required !== "boolean") diagnostics.push(diag(sourcePath, "field.required must be boolean."));
  validateDependsOn(value.dependsOn, sourcePath, diagnostics);
  validateIntegrityCheck(value.checksum, sourcePath, diagnostics, "field.checksum", CHECKSUM_ALGORITHMS);
  validateIntegrityCheck(value.hash, sourcePath, diagnostics, "field.hash", HASH_ALGORITHMS);
  validateComputed(value.computed, sourcePath, diagnostics);
  validateMetadata(value.meta, sourcePath, diagnostics, "field.meta");
  validateEnum(value.enum, sourcePath, diagnostics);
  validateFlags(value.flags, sourcePath, diagnostics);
  let count = 1;
  if (Array.isArray(value.children)) for (const child of value.children) count += validateField(child, sourcePath, diagnostics, depth + 1);
  return count;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, sourcePath: string, diagnostics: RegistryDiagnostic[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) diagnostics.push(diag(sourcePath, `Unknown ${label} property: ${key}.`));
}

function validateEnum(value: unknown, sourcePath: string, diagnostics: RegistryDiagnostic[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) { diagnostics.push(diag(sourcePath, "field.enum must be an object.")); return; }
  for (const [key, label] of Object.entries(value)) {
    if (!/^-?\d+$/.test(key)) diagnostics.push(diag(sourcePath, `field.enum key must be an integer string: ${key}.`));
    if (typeof label !== "string") diagnostics.push(diag(sourcePath, `field.enum value for ${key} must be a string.`));
  }
}

function validateFlags(value: unknown, sourcePath: string, diagnostics: RegistryDiagnostic[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) { diagnostics.push(diag(sourcePath, "field.flags must be an array.")); return; }
  for (const flag of value) {
    if (!isRecord(flag)) { diagnostics.push(diag(sourcePath, "field.flags entries must be objects.")); continue; }
    rejectUnknownKeys(flag, new Set(["mask", "label", "description"]), sourcePath, diagnostics, "flag");
    validateOptionalInteger(flag.mask, sourcePath, diagnostics, "flag.mask", 0);
    if (typeof flag.label !== "string" || flag.label.length === 0) diagnostics.push(diag(sourcePath, "flag.label is required."));
    if (flag.description !== undefined && typeof flag.description !== "string") diagnostics.push(diag(sourcePath, "flag.description must be a string."));
  }
}

function validateDependsOn(value: unknown, sourcePath: string, diagnostics: RegistryDiagnostic[]): void {
  if (value === undefined) return;
  const dependencies = Array.isArray(value) ? value : [value];
  for (const dependency of dependencies) {
    if (!isRecord(dependency)) { diagnostics.push(diag(sourcePath, "field.dependsOn entries must be objects.")); continue; }
    rejectUnknownKeys(dependency, new Set(["path", "present", "equals", "notEquals", "mask"]), sourcePath, diagnostics, "dependsOn");
    if (typeof dependency.path !== "string" || !isFieldPath(dependency.path)) diagnostics.push(diag(sourcePath, "dependsOn.path must be a field path."));
    if (dependency.present !== undefined && typeof dependency.present !== "boolean") diagnostics.push(diag(sourcePath, "dependsOn.present must be boolean."));
    if (dependency.mask !== undefined) validateOptionalInteger(dependency.mask, sourcePath, diagnostics, "dependsOn.mask", 0);
    if (dependency.equals !== undefined && !isScalarComparable(dependency.equals)) diagnostics.push(diag(sourcePath, "dependsOn.equals must be a string, number, or boolean."));
    if (dependency.notEquals !== undefined && !isScalarComparable(dependency.notEquals)) diagnostics.push(diag(sourcePath, "dependsOn.notEquals must be a string, number, or boolean."));
  }
}

function validateIntegrityCheck(value: unknown, sourcePath: string, diagnostics: RegistryDiagnostic[], label: string, algorithms: Set<string>): void {
  if (value === undefined) return;
  if (!isRecord(value)) { diagnostics.push(diag(sourcePath, `${label} must be an object.`)); return; }
  rejectUnknownKeys(value, new Set(["algorithm", "range", "severity"]), sourcePath, diagnostics, label);
  if (typeof value.algorithm !== "string" || !algorithms.has(value.algorithm)) diagnostics.push(diag(sourcePath, `${label}.algorithm is invalid.`));
  validateRange(value.range, sourcePath, diagnostics, `${label}.range`);
  if (value.severity !== undefined && (typeof value.severity !== "string" || !SEVERITIES.has(value.severity))) diagnostics.push(diag(sourcePath, `${label}.severity is invalid.`));
}

function validateRange(value: unknown, sourcePath: string, diagnostics: RegistryDiagnostic[], label: string): void {
  if (!isRecord(value)) { diagnostics.push(diag(sourcePath, `${label} must be an object.`)); return; }
  rejectUnknownKeys(value, new Set(["offset", "offsetFrom", "length", "lengthFrom"]), sourcePath, diagnostics, label);
  validateOptionalInteger(value.offset, sourcePath, diagnostics, `${label}.offset`, 0);
  validateOptionalInteger(value.length, sourcePath, diagnostics, `${label}.length`, 0, 1024 * 1024 * 100);
  if (value.offsetFrom !== undefined && (typeof value.offsetFrom !== "string" || !isFieldPath(value.offsetFrom))) diagnostics.push(diag(sourcePath, `${label}.offsetFrom must be a field path.`));
  if (value.lengthFrom !== undefined && (typeof value.lengthFrom !== "string" || !isFieldPath(value.lengthFrom))) diagnostics.push(diag(sourcePath, `${label}.lengthFrom must be a field path.`));
  if (value.offset === undefined && value.offsetFrom === undefined) diagnostics.push(diag(sourcePath, `${label} requires offset or offsetFrom.`));
  if (value.length === undefined && value.lengthFrom === undefined) diagnostics.push(diag(sourcePath, `${label} requires length or lengthFrom.`));
  if (value.offset !== undefined && value.offsetFrom !== undefined) diagnostics.push(diag(sourcePath, `${label} must not define both offset and offsetFrom.`));
  if (value.length !== undefined && value.lengthFrom !== undefined) diagnostics.push(diag(sourcePath, `${label} must not define both length and lengthFrom.`));
}

function validateComputed(value: unknown, sourcePath: string, diagnostics: RegistryDiagnostic[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) { diagnostics.push(diag(sourcePath, "field.computed must be an object.")); return; }
  rejectUnknownKeys(value, new Set(["expression", "derive", "compare", "severity"]), sourcePath, diagnostics, "computed");
  if (typeof value.expression !== "string" || value.expression.length < 1 || value.expression.length > 512) diagnostics.push(diag(sourcePath, "field.computed.expression must be a non-empty string up to 512 characters."));
  if (typeof value.expression === "string" && !/^[A-Za-z0-9_().,:[\]\s+-]+$/.test(value.expression)) diagnostics.push(diag(sourcePath, "field.computed.expression contains unsupported characters."));
  validateDerive(value.derive, sourcePath, diagnostics);
  validateCompare(value.compare, sourcePath, diagnostics);
  if (value.severity !== undefined && (typeof value.severity !== "string" || !SEVERITIES.has(value.severity))) diagnostics.push(diag(sourcePath, "field.computed.severity is invalid."));
}

function validateDerive(value: unknown, sourcePath: string, diagnostics: RegistryDiagnostic[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) { diagnostics.push(diag(sourcePath, "field.computed.derive must be an array.")); return; }
  if (value.length > 8) diagnostics.push(diag(sourcePath, "field.computed.derive must have at most 8 steps."));
  for (const step of value) {
    if (!isRecord(step)) { diagnostics.push(diag(sourcePath, "computed derive steps must be objects.")); continue; }
    rejectUnknownKeys(step, new Set(["op", "start", "end"]), sourcePath, diagnostics, "derive");
    if (!["slice", "u32le", "le32", "u32be", "be32"].includes(String(step.op))) diagnostics.push(diag(sourcePath, "derive.op is invalid."));
    if (step.op === "slice") {
      validateOptionalInteger(step.start, sourcePath, diagnostics, "derive.start", 0);
      validateOptionalInteger(step.end, sourcePath, diagnostics, "derive.end", 0);
      if (typeof step.start === "number" && typeof step.end === "number" && step.end < step.start) diagnostics.push(diag(sourcePath, "derive.end must not be less than derive.start."));
    }
  }
}

function validateCompare(value: unknown, sourcePath: string, diagnostics: RegistryDiagnostic[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) { diagnostics.push(diag(sourcePath, "field.computed.compare must be an object.")); return; }
  rejectUnknownKeys(value, new Set(["targetPath", "mode"]), sourcePath, diagnostics, "compare");
  if (value.targetPath !== undefined && (typeof value.targetPath !== "string" || !isFieldPath(value.targetPath))) diagnostics.push(diag(sourcePath, "compare.targetPath must be a field path."));
  if (value.mode !== undefined && !["auto", "numeric", "raw-bytes"].includes(String(value.mode))) diagnostics.push(diag(sourcePath, "compare.mode is invalid."));
}

function validateMetadata(value: unknown, sourcePath: string, diagnostics: RegistryDiagnostic[], label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) { diagnostics.push(diag(sourcePath, `${label} must be an object.`)); return; }
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) diagnostics.push(diag(sourcePath, `${label} key is invalid: ${key}.`));
    if (!isMetadataValue(item)) diagnostics.push(diag(sourcePath, `${label}.${key} must be a scalar or string array.`));
  }
}

function isMetadataValue(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || (Array.isArray(value) && value.every(item => typeof item === "string"));
}

function isScalarComparable(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isFieldPath(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])?)*$/.test(value);
}

function validateMagic(value: unknown, sourcePath: string, diagnostics: RegistryDiagnostic[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) { diagnostics.push(diag(sourcePath, "magic must be an array.")); return; }
  for (const rule of value) {
    if (!isRecord(rule)) { diagnostics.push(diag(sourcePath, "Magic rule must be an object.")); continue; }
    rejectUnknownKeys(rule, MAGIC_KEYS, sourcePath, diagnostics, "magic");
    validateOptionalInteger(rule.offset, sourcePath, diagnostics, "magic.offset", 0);
    if (typeof rule.bytes !== "string" || !/^([0-9A-Fa-f]{2})+$/.test(rule.bytes)) diagnostics.push(diag(sourcePath, "magic.bytes must be even-length hex."));
    if (rule.required !== undefined && typeof rule.required !== "boolean") diagnostics.push(diag(sourcePath, "magic.required must be boolean."));
    if (rule.description !== undefined && typeof rule.description !== "string") diagnostics.push(diag(sourcePath, "magic.description must be a string."));
  }
}

function validateStringArray(value: unknown, sourcePath: string, diagnostics: RegistryDiagnostic[], label: string, pattern: RegExp): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) { diagnostics.push(diag(sourcePath, `${label} must be an array.`)); return; }
  for (const item of value) if (typeof item !== "string" || !pattern.test(item)) diagnostics.push(diag(sourcePath, `${label} contains invalid value: ${String(item)}.`));
}

function validateOptionalInteger(value: unknown, sourcePath: string, diagnostics: RegistryDiagnostic[], label: string, min: number, max = Number.MAX_SAFE_INTEGER): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) diagnostics.push(diag(sourcePath, `${label} must be an integer between ${min} and ${max}.`));
}

function validateOptionalString(value: unknown, sourcePath: string, diagnostics: RegistryDiagnostic[], label: string): void {
  if (value !== undefined && typeof value !== "string") diagnostics.push(diag(sourcePath, `${label} must be a string.`));
}

function normalize(definition: FormatDefinition, sourcePath: string): FormatDefinition {
  return {
    ...definition,
    sourcePath,
    endianness: definition.endianness ?? "little",
    fileExtensions: definition.fileExtensions ?? [],
    magic: definition.magic ?? [],
    confidence: definition.confidence ?? 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diag(sourcePath: string, message: string): RegistryDiagnostic {
  return { severity: "error", message, sourcePath };
}
