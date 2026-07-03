# Custom Binary Viewer

Custom Binary Viewer is a read-only VS Code extension for inspecting arbitrary binary file formats from local JSON format definitions.

It is intentionally generic. It does not contain certificate, key, ASN.1, or other domain-specific parsers. Instead, it loads definitions from workspace `extensions` or `formats` folders and optional configured format paths, then interprets those definitions against binary files.

## Features

- Read-only custom editor for binary files.
- Local JSON format definitions with schema validation.
- Extension, magic/header, size, and structural matching.
- Parser override dropdown when more than one candidate matches.
- Endian-aware primitive parsing.
- Fixed strings, bytes, arrays, structs, sections, enums, and bit flags.
- Repeated fixed-size entries with `count`, `repeatToEof`, `itemLength`, and `stride`.
- Length indirection with `lengthFrom` for strings, bytes, and arrays.
- Conditional fields with `dependsOn`.
- Checksum and hash validation aids for corruption sanity checks.
- Computed validation expressions for truncated or transformed checksum/hash comparisons.
- Top-level and field-level metadata rendered in the viewer.
- Required field markers are validated today and reserved for stricter matching policies in a future schema revision.
- UTF-8, ASCII, UTF-16LE, and hex string decoding.
- Offset, length, field name, type, decoded value, raw bytes, and tooltip descriptions.
- CSP-protected webview with a cryptographically random nonce and delegated event handling.
- Safe parsing with bounds checks, aggregate render budgets, truncation, and structured diagnostics.

## Format definition example

The repository includes a sample definition that describes this layout. The sample is not loaded as a built-in runtime parser; copy it into a workspace `extensions` or `formats` folder, or reference it with `custombin.formatPaths`, to use it.

```text
uint16, uint16, str(64), uint32, uint8
```

```json
{
  "schemaVersion": 1,
  "id": "sample.toy-record",
  "name": "Toy Record",
  "title": "Toy Record Layout",
  "summary": "Example fixed-width toy record.",
  "version": "1.0",
  "status": "example",
  "provenance": "Bundled sample definition.",
  "references": ["README example"],
  "meta": { "owner": "sample", "confidenceNote": "Illustrative only" },
  "fileExtensions": [".toybin", ".bin"],
  "endianness": "little",
  "minSize": 73,
  "fields": [
    { "name": "version", "type": "u16", "description": "Record format version." },
    { "name": "flags", "type": "u16", "format": "hex" },
    { "name": "name", "type": "string", "length": 64, "encoding": "utf8", "meta": { "source": "record header" } },
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

Supported primitive field types are `u8`, `i8`, `u16`, `i16`, `u32`, `i32`, `u64`, `i64`, `f32`, and `f64`. Compound field types are `bytes`, `string`, `struct`, and `section`. A `section` groups child fields without adding bytes of its own, which is useful for labels such as root header, key block, or signature block.

The default endianness is `little`. Set top-level `endianness` to change the default for the definition, or set field-level `endianness` to override one numeric field.

String and bytes fields require `length`, `lengthFrom`, or `repeatToEof`. `length` is an explicit byte count. `lengthFrom` can reference a sibling field inside the same struct item, which supports TLV records such as `{ tag, len, payload[len] }` repeated to EOF. `repeatToEof` consumes the remaining bytes for a bare string or bytes field.

String fields support these encodings:

- `utf8`
- `ascii`
- `utf16le`
- `hex`

Both string and bytes reads are bounds checked.

Arrays can use one of these controls:

- `count`: parse a fixed number of items.
- `lengthFrom`: parse a number of items from a field path.
- `repeatToEof`: repeat until the end of the file.

Use `itemLength` for fixed-size records and `stride` when each item begins at a predictable distance from the previous item. For example, an appended table with 256-byte records can use `repeatToEof: true` and `itemLength: 256`.

For TLV-style records, define a repeated struct and use sibling `lengthFrom` on the payload:

```json
{
  "name": "records",
  "type": "struct",
  "repeatToEof": true,
  "children": [
    { "name": "tag", "type": "u16" },
    { "name": "len", "type": "u32" },
    { "name": "payload", "type": "bytes", "lengthFrom": "len" }
  ]
}
```

Fields can include explicit `offset` values even when sequential parsing would work. Prefer explicit `offset` and `length` values when they make the format definition clearer or align with an external specification.

Display `format` can be:

- `decimal`
- `hex`
- `binary`
- `timestamp-unix`
- `raw`

`hex` and `binary` display the raw bytes read for the field, so signed negative values are shown as their fixed-width byte representation rather than JavaScript's signed string form.

Fields can include `enum` mappings from integer strings to labels, and `flags` arrays with integer masks and labels. Use `dependsOn` to parse a field only when another field path is present, equal to a value, not equal to a value, or has a bit mask set.

Set `description` on definitions, magic rules, fields, and flags to provide tooltips or diagnostics context.

Top-level definitions can include `title`, `summary`, `version`, `status`, `provenance`, `references`, and `meta`. Each field can also include `meta`. The viewer renders top-level metadata in a metadata section and field metadata in row tooltips. `meta` accepts string, number, boolean, null, or string-array values so definitions can carry source-specific metadata without changing the schema.

## Integrity validation aids

Fields can include `checksum` or `hash` validation metadata. These checks are viewer sanity aids only: they do not execute code, do not change format matching, and do not stop parsing the rest of the file. A mismatch is reported as a top-level diagnostic and on the field row.

CRC-32 checks compare the computed checksum against the parsed numeric field value or raw field bytes:

```json
{
  "name": "headerCrc",
  "type": "u32",
  "endianness": "little",
  "checksum": {
    "algorithm": "crc32",
    "range": { "offset": 0, "length": 128 }
  }
}
```

Hashes compare the computed digest against the parsed raw field bytes:

```json
{
  "name": "payloadSha256",
  "type": "bytes",
  "length": 32,
  "hash": {
    "algorithm": "sha256",
    "range": { "offsetFrom": "payloadOffset", "lengthFrom": "payloadLength" }
  }
}
```

Supported checksum algorithms: `crc32`, `crc32-reflected`, and `crc32-non-reflected`. `crc32` is an alias for reflected IEEE CRC-32.

Supported hash algorithms: `sha1`, `sha256`, `sha384`, `sha512`, `sha3-256`, `sha3-384`, and `sha3-512`.

Ranges support either `offset` or `offsetFrom`, plus either `length` or `lengthFrom`. Validation runs after parsing, so `offsetFrom`, `lengthFrom`, and computed comparison targets can reference any parsed field path. The default mismatch severity is `error`; set `severity` to `warning` or `info` when a check should be informational.

For truncated or transformed comparisons, use `computed`. Computed expressions are a bounded declarative validation DSL, not user code. They can call a fixed function set, have a maximum expression length, and are evaluated with parser depth and range limits.

```json
{
  "name": "keyBlockCheck",
  "type": "u32",
  "endianness": "little",
  "computed": {
    "expression": "le32(sha384(slice(0x20, key_block_len))[0:4])"
  }
}
```

You can also separate the base expression, derivation steps, and comparison target. This supports cases such as “SHA-384 over a range, first four digest bytes interpreted as a little-endian `u32`, equals another field path”:

```json
{
  "name": "keyHashValidation",
  "type": "bytes",
  "length": 0,
  "computed": {
    "expression": "sha384(slice(0x20, key_block_len))",
    "derive": [
      { "op": "slice", "start": 0, "end": 4 },
      { "op": "u32le" }
    ],
    "compare": { "targetPath": "keyhash_word0", "mode": "numeric" }
  }
}
```

Supported computed functions:

- `slice(offset, length)`: byte slice from the file. Arguments can be numeric literals, hex literals, or previous field paths.
- `sha1(bytes)`, `sha256(bytes)`, `sha384(bytes)`, `sha512(bytes)`.
- `sha3_256(bytes)`, `sha3_384(bytes)`, `sha3_512(bytes)`.
- `crc32(bytes)`, `crc32_reflected(bytes)`, `crc32_ieee(bytes)`, `crc32_non_reflected(bytes)`, `crc32_msb(bytes)`, `crc32_mpeg2(bytes)`.
- `concat(bytes, ...)` to build non-contiguous preimages.
- `hex(evenLengthHex)` for literal bytes.
- `u32le(bytes)`, `le32(bytes)`, `u32be(bytes)`, `be32(bytes)`.

Computed byte results compare to field raw bytes. Computed numeric results compare to numeric field values. Byte results can use `[start:end]` suffix slicing, such as `sha384(slice(0x20, key_block_len))[0:4]`.

`derive` currently supports `slice`, `u32le`, `le32`, `u32be`, and `be32`. `compare.targetPath` points to a parsed field. `compare.mode` can be `auto`, `numeric`, or `raw-bytes`.

## Safety limits

The viewer applies multiple budgets because workspace format definitions and binary files are treated as untrusted local input:

- `custombin.maxFileBytes`: maximum binary file size to parse. Default: `10485760` bytes.
- `custombin.maxArrayItems`: maximum items rendered from one array field. Default: `4096`.
- `custombin.maxRenderedFields`: maximum expanded field rows in one parse result. Default: `10000`.
- `custombin.maxRawDisplayBytes`: maximum aggregate raw bytes converted to display text in one parse result. Default: `65536`.

The extension also caps loaded format definition files and skips definition JSON files larger than 1 MiB. When a budget is reached, parsing continues only where safe and reports a warning diagnostic such as truncated field output or truncated raw-byte display.

These limits are configurable up to larger hard ceilings intended to protect the extension host from accidental unbounded work. If a configured value is outside the supported range or is not an integer, the viewer reports a warning and shows the effective value. Oversized-file diagnostics name `custombin.maxFileBytes` so users know which setting to raise.

## VS Code registration limits

VS Code custom editor selectors are contributed statically from `package.json`. Runtime JSON definitions cannot dynamically add new custom editor selectors. This extension therefore contributes a broad optional custom editor and works best through **Open With...** or the `Custom Binary Viewer: Open` command. You can use VS Code `workbench.editorAssociations` manually if you want specific extensions to open with this viewer by default.

The extension does not claim files by default. This avoids hijacking normal text or extension-specific editors for files that only happen to match `*`.

## Format discovery

The viewer loads workspace format definitions from `custombin.formatFolders`, which defaults to `extensions` and `formats`. These folders are workspace-relative and are discovered with VS Code workspace search.

Use `custombin.formatPaths` for stable, opt-in format locations outside the workspace. Entries can be absolute paths, workspace-relative paths, or `~`-expanded paths. Entries can point to directories or glob-style patterns. Absolute and `~` paths are discovered with bounded recursive `fs.readdir` traversal rather than VS Code workspace search.

Example:

```json
{
  "custombin.formatPaths": [
    "~/.config/custombin/**/*.custombin.json"
  ]
}
```

Directory entries load recursive `.json` files up to the traversal depth limit. Glob entries only load files matching the pattern. The extension caps the number of configured paths, traversal depth, loaded definition files, and definition file size. Use `Custom Binary Viewer: Reload Format Definitions` after changing discovery settings; edits under watched workspace folders or configured external roots hot-reload automatically.

## Security and robustness notes

- Format definitions are local JSON files and are treated as untrusted input.
- Every binary read is bounds checked.
- Arrays, nesting, expanded rows, raw-byte display, format file count, and format file size are capped.
- Non-workspace `custombin.formatPaths` discovery is opt-in and bounded by configured path count and traversal depth.
- Invalid schemas are skipped and reported as diagnostics.
- Webview content is escaped and protected by a restrictive Content Security Policy.
- This viewer does not execute scripts from format definitions.

This artifact was produced with AI assistance and should be reviewed by a qualified professional before use as compliance evidence, legal submission, or external distribution.
