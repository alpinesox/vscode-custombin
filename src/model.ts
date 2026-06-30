export type Endianness = "little" | "big";

export type FieldType =
  | "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "u64" | "i64"
  | "f32" | "f64" | "bytes" | "string" | "struct" | "section";

export type Metadata = Record<string, string | number | boolean | null | string[]>;

export interface FieldDependency {
  path: string;
  present?: boolean;
  equals?: string | number | boolean;
  notEquals?: string | number | boolean;
  mask?: number;
}

export interface DataRange {
  offset?: number;
  offsetFrom?: string;
  length?: number;
  lengthFrom?: string;
}

export interface IntegrityCheck {
  algorithm: "crc32" | "sha1" | "sha256" | "sha384" | "sha512";
  range: DataRange;
  severity?: DiagnosticSeverity;
}

export interface ComputedCheck {
  expression: string;
  severity?: DiagnosticSeverity;
}

export interface MagicRule {
  offset: number;
  bytes: string;
  required?: boolean;
  description?: string;
}

export interface FlagDefinition {
  mask: number;
  label: string;
  description?: string;
}

export interface FieldDefinition {
  name: string;
  label?: string;
  description?: string;
  offset?: number;
  type: FieldType;
  endianness?: Endianness;
  length?: number;
  encoding?: "ascii" | "utf8" | "utf16le" | "hex";
  trimNull?: boolean;
  count?: number;
  repeatToEof?: boolean;
  stride?: number;
  itemLength?: number;
  lengthFrom?: string;
  enum?: Record<string, string>;
  flags?: FlagDefinition[];
  children?: FieldDefinition[];
  format?: "decimal" | "hex" | "binary" | "timestamp-unix" | "raw";
  required?: boolean;
  dependsOn?: FieldDependency | FieldDependency[];
  checksum?: IntegrityCheck;
  hash?: IntegrityCheck;
  computed?: ComputedCheck;
  meta?: Metadata;
}

export interface FormatDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  title?: string;
  summary?: string;
  version?: string;
  status?: string;
  provenance?: string;
  references?: string[];
  meta?: Metadata;
  description?: string;
  fileExtensions?: string[];
  endianness?: Endianness;
  confidence?: number;
  minSize?: number;
  maxSize?: number;
  magic?: MagicRule[];
  fields: FieldDefinition[];
  sourcePath?: string;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface ParseDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
  path?: string;
  offset?: number;
}

export interface ParsedField {
  path: string;
  name: string;
  label: string;
  description?: string;
  type: FieldType;
  offset: number;
  length: number;
  rawValue: string;
  displayValue: string;
  meta?: Metadata;
  children?: ParsedField[];
  diagnostics: ParseDiagnostic[];
}

export interface ParseResult {
  formatId: string;
  formatName: string;
  fields: ParsedField[];
  diagnostics: ParseDiagnostic[];
  bytesConsumed: number;
}

export interface CandidateResult {
  definition: FormatDefinition;
  score: number;
  reasons: string[];
  result: ParseResult;
}

export interface RegistryDiagnostic extends ParseDiagnostic {
  sourcePath?: string;
}
