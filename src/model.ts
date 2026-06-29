export type Endianness = "little" | "big";

export type FieldType =
  | "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "u64" | "i64"
  | "f32" | "f64" | "bytes" | "string" | "struct";

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
  enum?: Record<string, string>;
  flags?: FlagDefinition[];
  children?: FieldDefinition[];
  format?: "decimal" | "hex" | "binary" | "timestamp-unix" | "raw";
  required?: boolean;
}

export interface FormatDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
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
