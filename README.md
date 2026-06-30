# Custom Binary Viewer

Custom Binary Viewer is a read-only VS Code extension for inspecting arbitrary binary file formats from local JSON format definitions.

It is intentionally generic. It does not contain certificate, key, ASN.1, or other domain-specific parsers. Instead, it loads definitions from workspace `extensions/` or `formats/` folders and interprets those definitions against binary files.

## Features

- Read-only custom editor for binary files.
- Local JSON format definitions with schema validation.
- Extension, magic/header, size, and structural matching.
- Parser override dropdown when more than one candidate matches.
- Endian-aware primitive parsing.
- Fixed strings, bytes, arrays, structs, enums, and bit flags.
- Required field markers are validated today and reserved for stricter matching policies in a future schema revision.
- UTF-8, ASCII, UTF-16LE, and hex string decoding.
- Offset, length, field name, type, decoded value, raw bytes, and tooltip descriptions.
- CSP-protected webview with a cryptographically random nonce and delegated event handling.
- Safe parsing with bounds checks, aggregate render budgets, truncation, and structured diagnostics.

## Format definition example

The bundled sample describes this layout:

```text
uint16, uint16, str(64), uint32, uint8
```

```json
{
  "schemaVersion": 1,
  "id": "sample.toy-record",
  "name": "Toy Record",
  "fileExtensions": [".toybin", ".bin"],
  "endianness": "little",
  "minSize": 73,
  "fields": [
    { "name": "version", "type": "u16", "description": "Record format version." },
    { "name": "flags", "type": "u16", "format": "hex" },
    { "name": "name", "type": "string", "length": 64, "encoding": "utf8" },
    { "name": "payloadLength", "type": "u32" },
    { "name": "status", "type": "u8", "enum": { "1": "Ready" } }
  ]
}
```

## Matching behavior

Candidates are scored by:

- explicit definition confidence
- file extension match
- magic/header match
- parse success
- parse warnings and errors

Magic/header matches carry more weight than extension-only matches. If more than one definition matches, use the parser dropdown in the top right of the viewer to override the selection for the current file.

Magic rules are required by default. A required magic rule that does not match excludes the candidate. Set `"required": false` when a magic value should add confidence if present but should not exclude the format when absent or different.

## Format definition reference

Definitions use schema version `1` and are validated against `schemas/custombin-format.schema.json` plus equivalent runtime checks.

Supported primitive field types are `u8`, `i8`, `u16`, `i16`, `u32`, `i32`, `u64`, `i64`, `f32`, and `f64`. Compound field types are `bytes`, `string`, and `struct`. A field can include `count` to render a fixed-size array.

The default endianness is `little`. Set top-level `endianness` to change the default for the definition, or set field-level `endianness` to override one numeric field.

String fields require `length` and support these encodings:

- `utf8`
- `ascii`
- `utf16le`
- `hex`

Bytes fields also require `length`. Both string and bytes reads are bounds checked.

Display `format` can be:

- `decimal`
- `hex`
- `binary`
- `timestamp-unix`
- `raw`

`hex` and `binary` display the raw bytes read for the field, so signed negative values are shown as their fixed-width byte representation rather than JavaScript's signed string form.

Fields can include `enum` mappings from integer strings to labels, and `flags` arrays with integer masks and labels. Set `description` on definitions, magic rules, fields, and flags to provide tooltips or diagnostics context.

## Safety limits

The viewer applies multiple budgets because workspace format definitions and binary files are treated as untrusted local input:

- `custombin.maxFileBytes`: maximum binary file size to parse. Default: `10485760` bytes.
- `custombin.maxArrayItems`: maximum items rendered from one array field. Default: `4096`.
- `custombin.maxRenderedFields`: maximum expanded field rows in one parse result. Default: `10000`.
- `custombin.maxRawDisplayBytes`: maximum aggregate raw bytes converted to display text in one parse result. Default: `65536`.

The extension also caps loaded format definition files and skips definition JSON files larger than 1 MiB. When a budget is reached, parsing continues only where safe and reports a warning diagnostic such as truncated field output or truncated raw-byte display.

## VS Code registration limits

VS Code custom editor selectors are contributed statically from `package.json`. Runtime JSON definitions cannot dynamically add new custom editor selectors. This extension therefore contributes a broad optional custom editor and works best through **Open With...** or the `Custom Binary Viewer: Open` command. You can use VS Code `workbench.editorAssociations` manually if you want specific extensions to open with this viewer by default.

## Security and robustness notes

- Format definitions are local JSON files and are treated as untrusted input.
- Every binary read is bounds checked.
- Arrays, nesting, expanded rows, raw-byte display, format file count, and format file size are capped.
- Invalid schemas are skipped and reported as diagnostics.
- Webview content is escaped and protected by a restrictive Content Security Policy.
- This viewer does not execute scripts from format definitions.

This artifact was produced with AI assistance and should be reviewed by a qualified professional before use as compliance evidence, legal submission, or external distribution.
