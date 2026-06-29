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
- Offset, length, field name, type, decoded value, raw bytes, and tooltip descriptions.
- CSP-protected webview with a cryptographically random nonce and delegated event handling.
- Safe parsing with bounds checks and structured diagnostics.

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

## VS Code registration limits

VS Code custom editor selectors are contributed statically from `package.json`. Runtime JSON definitions cannot dynamically add new custom editor selectors. This extension therefore contributes a broad optional custom editor and works best through **Open With...** or the `Custom Binary Viewer: Open` command. You can use VS Code `workbench.editorAssociations` manually if you want specific extensions to open with this viewer by default.

## Security and robustness notes

- Format definitions are local JSON files and are treated as untrusted input.
- Every binary read is bounds checked.
- Arrays and nesting are capped.
- Invalid schemas are skipped and reported as diagnostics.
- Webview content is escaped and protected by a restrictive Content Security Policy.
- This viewer does not execute scripts from format definitions.

This artifact was produced with AI assistance and should be reviewed by a qualified professional before use as compliance evidence, legal submission, or external distribution.
