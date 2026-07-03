import * as assert from "assert";
import * as crypto from "crypto";
import { matchFormats } from "../matcher";
import { FormatDefinition } from "../model";
import { parseBinary } from "../parser";
import { validateFormatDefinition } from "../validator";

const parseOptions = { maxArrayItems: 128, maxRenderedFields: 10000, maxRawDisplayBytes: 65536 };

function toyBytes(): Uint8Array {
  const bytes = new Uint8Array(73);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, 3, true);
  new TextEncoder().encode("hello").forEach((byte, index) => { bytes[4 + index] = byte; });
  view.setUint32(68, 42, true);
  view.setUint8(72, 1);
  return bytes;
}

const toyDefinition: FormatDefinition = {
  schemaVersion: 1,
  id: "test.toy",
  name: "Toy",
  fileExtensions: [".toybin"],
  endianness: "little",
  fields: [
    { name: "version", type: "u16" },
    { name: "flags", type: "u16", format: "hex", flags: [{ mask: 1, label: "Enabled" }, { mask: 2, label: "Archived" }] },
    { name: "name", type: "string", length: 64, encoding: "utf8", trimNull: true },
    { name: "payloadLength", type: "u32" },
    { name: "status", type: "u8", enum: { "1": "Ready" } },
  ],
};

function testParser(): void {
  const result = parseBinary(toyBytes(), toyDefinition, parseOptions);
  assert.strictEqual(result.diagnostics.length, 0);
  assert.strictEqual(result.fields[0]?.displayValue, "1");
  assert.strictEqual(result.fields[1]?.displayValue, "0x0300 [Enabled, Archived]");
  assert.strictEqual(result.fields[2]?.displayValue, "hello");
  assert.strictEqual(result.fields[3]?.displayValue, "42");
  assert.strictEqual(result.fields[4]?.displayValue, "1 (Ready)");
}

function testBounds(): void {
  const truncated = toyBytes().subarray(0, 3);
  const result = parseBinary(truncated, toyDefinition, parseOptions);
  assert.ok(result.diagnostics.some(item => item.severity === "error"));
}

function testStructAndArrayCursor(): void {
  const bytes = new Uint8Array([1, 0, 2, 0, 3, 4, 9]);
  const definition: FormatDefinition = {
    schemaVersion: 1,
    id: "test.struct-array",
    name: "Struct Array",
    endianness: "little",
    fields: [
      { name: "pair", type: "struct", children: [{ name: "a", type: "u16" }, { name: "b", type: "u16" }] },
      { name: "items", type: "u8", count: 2 },
      { name: "tail", type: "u8" },
    ],
  };
  const result = parseBinary(bytes, definition, parseOptions);
  assert.strictEqual(result.diagnostics.length, 0);
  assert.strictEqual(result.fields[0]?.offset, 0);
  assert.strictEqual(result.fields[0]?.length, 4);
  assert.strictEqual(result.fields[1]?.offset, 4);
  assert.strictEqual(result.fields[1]?.length, 2);
  assert.strictEqual(result.fields[2]?.offset, 6);
  assert.strictEqual(result.fields[2]?.displayValue, "9");
}

function testExplicitOffsetArray(): void {
  const definition: FormatDefinition = { schemaVersion: 1, id: "test.offset-array", name: "Offset Array", endianness: "little", fields: [{ name: "items", type: "u8", offset: 1, count: 3 }] };
  const result = parseBinary(new Uint8Array([9, 1, 2, 3]), definition, parseOptions);
  assert.strictEqual(result.diagnostics.length, 0);
  assert.deepStrictEqual(result.fields[0]?.children?.map(item => item.displayValue), ["1", "2", "3"]);
  assert.strictEqual(result.fields[0]?.length, 3);
}

function testEndianOffsetsAndLargeIntegers(): void {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint16(1, 0x1234, false);
  view.setBigUint64(3, 0x0102030405060708n, false);
  view.setBigInt64(11, -2n, true);
  view.setUint8(19, 0x0f);
  const definition: FormatDefinition = {
    schemaVersion: 1,
    id: "test.endian-offsets",
    name: "Endian Offsets",
    endianness: "big",
    fields: [
      { name: "padding", type: "u8" },
      { name: "big", type: "u16", format: "hex" },
      { name: "large", type: "u64" },
      { name: "negative", type: "i64", endianness: "little" },
      { name: "bits", type: "u8", format: "binary" },
    ],
  };
  const result = parseBinary(bytes, definition, parseOptions);
  assert.strictEqual(result.diagnostics.length, 0);
  assert.strictEqual(result.fields[1]?.displayValue, "0x1234");
  assert.strictEqual(result.fields[2]?.displayValue, "72623859790382856");
  assert.strictEqual(result.fields[3]?.displayValue, "-2");
  assert.strictEqual(result.fields[4]?.displayValue, "0b00001111");
}

function testNegativeBinaryUsesRawBits(): void {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, -2n, false);
  const definition: FormatDefinition = { schemaVersion: 1, id: "test.negative-binary", name: "Negative Binary", endianness: "big", fields: [{ name: "negative", type: "i64", format: "binary" }] };
  const result = parseBinary(bytes, definition, parseOptions);
  assert.strictEqual(result.diagnostics.length, 0);
  assert.strictEqual(result.fields[0]?.displayValue, "0b1111111111111111111111111111111111111111111111111111111111111110");
}

function testUtf16String(): void {
  const bytes = new Uint8Array([0x48, 0x00, 0x69, 0x00, 0x00, 0x00]);
  const definition: FormatDefinition = { schemaVersion: 1, id: "test.utf16", name: "UTF-16", fields: [{ name: "text", type: "string", length: 6, encoding: "utf16le" }] };
  const result = parseBinary(bytes, definition, parseOptions);
  assert.strictEqual(result.diagnostics.length, 0);
  assert.strictEqual(result.fields[0]?.displayValue, "Hi");
}

function testOptionalMagicDoesNotExclude(): void {
  const definition: FormatDefinition = { ...toyDefinition, id: "test.optional-magic", name: "Optional Magic", magic: [{ offset: 0, bytes: "FFFF", required: false }] };
  const candidates = matchFormats(toyBytes(), "sample.toybin", [definition], parseOptions);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0]?.definition.id, "test.optional-magic");
}

function testParseBudgets(): void {
  const nested: FormatDefinition = {
    schemaVersion: 1,
    id: "test.budget",
    name: "Budget",
    fields: [{ name: "outer", type: "struct", count: 16, children: [{ name: "inner", type: "u8", count: 16 }] }],
  };
  const result = parseBinary(new Uint8Array(512), nested, { maxArrayItems: 16, maxRenderedFields: 10, maxRawDisplayBytes: 16 });
  assert.ok(result.diagnostics.some(item => item.message.includes("rendered field limit")));
  assert.ok((result.fields[0]?.children?.length ?? 0) < 16);

  const raw: FormatDefinition = { schemaVersion: 1, id: "test.raw-budget", name: "Raw Budget", fields: [{ name: "a", type: "bytes", length: 4 }, { name: "b", type: "bytes", offset: 0, length: 4 }] };
  const rawResult = parseBinary(new Uint8Array([1, 2, 3, 4]), raw, { maxArrayItems: 16, maxRenderedFields: 10, maxRawDisplayBytes: 3 });
  assert.strictEqual(rawResult.fields[0]?.rawValue, "01 02 03 ... <truncated>");
  assert.strictEqual(rawResult.fields[1]?.rawValue, "<truncated>");

  const largeScalar: FormatDefinition = { schemaVersion: 1, id: "test.large-scalar", name: "Large Scalar", fields: [{ name: "tail", type: "bytes", repeatToEof: true }, { name: "text", type: "string", offset: 0, repeatToEof: true }] };
  const largeResult = parseBinary(new Uint8Array([65, 66, 67, 68, 69, 70]), largeScalar, { maxArrayItems: 16, maxRenderedFields: 10, maxRawDisplayBytes: 3 });
  assert.strictEqual(largeResult.fields[0]?.rawValue, "41 42 43 ... <truncated>");
  assert.strictEqual(largeResult.fields[0]?.displayValue, "41 42 43 ... <truncated>");
  assert.ok(largeResult.fields[1]?.displayValue.includes("<truncated>"));
}

function testLengthFromRepeatAndStride(): void {
  const bytes = new Uint8Array([3, 65, 66, 67, 1, 9, 0, 0, 2, 8, 0, 0]);
  const definition: FormatDefinition = {
    schemaVersion: 1,
    id: "test.indirection",
    name: "Indirection",
    fields: [
      { name: "nameLength", type: "u8" },
      { name: "name", type: "string", lengthFrom: "nameLength", encoding: "ascii" },
      { name: "entries", type: "struct", repeatToEof: true, itemLength: 4, children: [{ name: "kind", type: "u8" }, { name: "value", type: "u8" }] },
    ],
  };
  const result = parseBinary(bytes, definition, parseOptions);
  assert.strictEqual(result.diagnostics.length, 0);
  assert.strictEqual(result.fields[1]?.displayValue, "ABC");
  assert.strictEqual(result.fields[2]?.children?.length, 2);
  assert.strictEqual(result.fields[2]?.children?.[1]?.offset, 8);
  assert.strictEqual(result.bytesConsumed, 12);
}

function testSectionsDependsOnAndMetadata(): void {
  const definition: FormatDefinition = {
    schemaVersion: 1,
    id: "test.sections",
    name: "Sections",
    title: "Section Test",
    summary: "Exercises sections and metadata.",
    version: "1.0",
    status: "draft",
    provenance: "unit-test",
    references: ["local"],
    meta: { owner: "tests", tags: ["section", "metadata"] },
    fields: [
      { name: "flags", type: "u8" },
      { name: "header", type: "section", label: "Header", meta: { source: "spec" }, children: [{ name: "enabled", type: "u8", dependsOn: { path: "flags", mask: 1 } }, { name: "skipped", type: "u8", dependsOn: { path: "flags", equals: 0 } }] },
    ],
  };
  const validated = validateFormatDefinition(definition, "sections.json");
  assert.strictEqual(validated.diagnostics.length, 0);
  assert.strictEqual(validateFormatDefinition({ schemaVersion: 1, id: "test.empty-section", name: "Empty Section", fields: [{ name: "note", type: "section", label: "Note" }] }, "empty.json").diagnostics.length, 0);
  const result = parseBinary(new Uint8Array([1, 7, 9]), definition, parseOptions);
  assert.strictEqual(result.fields[1]?.type, "section");
  assert.strictEqual(result.fields[1]?.children?.length, 1);
  assert.strictEqual(result.fields[1]?.children?.[0]?.displayValue, "7");
  assert.deepStrictEqual(result.fields[1]?.meta, { source: "spec" });

  const repeatedEmptySection: FormatDefinition = { schemaVersion: 1, id: "test.empty-section-repeat", name: "Empty Section Repeat", fields: [{ name: "empty", type: "section", repeatToEof: true }] };
  const repeatedResult = parseBinary(new Uint8Array([1, 2, 3]), repeatedEmptySection, parseOptions);
  assert.ok(repeatedResult.diagnostics.some(item => item.message.includes("did not consume bytes")));
}

function testConsumeRemainingAndSiblingLength(): void {
  const remainingDefinition: FormatDefinition = { schemaVersion: 1, id: "test.remaining", name: "Remaining", fields: [{ name: "prefix", type: "u8" }, { name: "tail", type: "bytes", repeatToEof: true }] };
  const remaining = parseBinary(new Uint8Array([1, 2, 3, 4]), remainingDefinition, parseOptions);
  assert.strictEqual(remaining.fields[1]?.length, 3);
  assert.strictEqual(remaining.fields[1]?.rawValue, "02 03 04");

  const tlvDefinition: FormatDefinition = {
    schemaVersion: 1,
    id: "test.tlv",
    name: "TLV",
    fields: [{ name: "records", type: "struct", repeatToEof: true, children: [{ name: "tag", type: "u16" }, { name: "len", type: "u32" }, { name: "payload", type: "bytes", lengthFrom: "len" }] }],
  };
  const tlv = new Uint8Array([1, 0, 3, 0, 0, 0, 9, 8, 7, 2, 0, 1, 0, 0, 0, 6]);
  const result = parseBinary(tlv, tlvDefinition, parseOptions);
  assert.strictEqual(result.diagnostics.length, 0);
  assert.strictEqual(result.fields[0]?.children?.length, 2);
  assert.strictEqual(result.fields[0]?.children?.[0]?.children?.[2]?.rawValue, "09 08 07");
  assert.strictEqual(result.fields[0]?.children?.[1]?.children?.[2]?.rawValue, "06");
}

function testChecksumAndHashDiagnostics(): void {
  const crcBytes = new Uint8Array([...new TextEncoder().encode("123456789"), 0x26, 0x39, 0xf4, 0xcb, 0x03, 0x76, 0xe6, 0xe7, 0x00, 0x00, 0x00, 0x00]);
  const crcDefinition: FormatDefinition = {
    schemaVersion: 1,
    id: "test.checksum",
    name: "Checksum",
    fields: [
      { name: "data", type: "bytes", length: 9 },
      { name: "crc", type: "u32", endianness: "little", checksum: { algorithm: "crc32", range: { offset: 0, length: 9 } } },
      { name: "crcNonReflected", type: "u32", endianness: "big", checksum: { algorithm: "crc32-non-reflected", range: { offset: 0, length: 9 } } },
      { name: "badCrc", type: "u32", endianness: "little", checksum: { algorithm: "crc32", range: { offset: 0, length: 9 } } },
    ],
  };
  const crcResult = parseBinary(crcBytes, crcDefinition, parseOptions);
  assert.ok(!crcResult.diagnostics.some(item => item.path === "crc"));
  assert.ok(!crcResult.diagnostics.some(item => item.path === "crcNonReflected"));
  assert.ok(crcResult.diagnostics.some(item => item.path === "badCrc" && item.severity === "error" && item.message.includes("crc32 mismatch")));

  const payload = new Uint8Array([1, 2, 3]);
  const digest = crypto.createHash("sha256").update(payload).digest();
  const hashBytes = new Uint8Array([payload.length, ...payload, ...digest]);
  const hashDefinition: FormatDefinition = {
    schemaVersion: 1,
    id: "test.hash",
    name: "Hash",
    fields: [
      { name: "payloadLength", type: "u8", offset: 0 },
      { name: "payload", type: "bytes", offset: 1, lengthFrom: "payloadLength" },
      { name: "digest", type: "bytes", offset: 4, length: 32, hash: { algorithm: "sha256", range: { offset: 1, lengthFrom: "payloadLength" } } },
    ],
  };
  const hashResult = parseBinary(hashBytes, hashDefinition, parseOptions);
  assert.strictEqual(hashResult.diagnostics.length, 0);
}

function testComputedDiagnostics(): void {
  const bytes = new Uint8Array(0x80);
  const payload = new Uint8Array([10, 20, 30, 40, 50]);
  bytes[0] = payload.length;
  payload.forEach((byte, index) => { bytes[0x20 + index] = byte; });
  const digest = crypto.createHash("sha384").update(payload).digest();
  const nestedDigest = crypto.createHash("sha384").update(new Uint8Array([0xaa, 0xbb, 0xaa, 0xbb, ...digest])).digest();
  const expected = new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(0, true);
  new DataView(bytes.buffer).setUint32(1, expected, true);
  new DataView(bytes.buffer).setUint32(5, 0, true);
  nestedDigest.forEach((byte, index) => { bytes[0x40 + index] = byte; });
  const definition: FormatDefinition = {
    schemaVersion: 1,
    id: "test.computed",
    name: "Computed",
    fields: [
      { name: "key_block_len", type: "u8", offset: 0 },
      { name: "computedWord", type: "u32", offset: 1, endianness: "little", computed: { expression: "le32(sha384(slice(0x20, key_block_len))[0:4])" } },
      { name: "badComputedWord", type: "u32", offset: 5, endianness: "little", computed: { expression: "u32le(sha384(slice(0x20, key_block_len))[0:4])" } },
      { name: "compareWord", type: "bytes", offset: 9, length: 0, computed: { expression: "sha384(slice(0x20, key_block_len))", derive: [{ op: "slice", start: 0, end: 4 }, { op: "u32le" }], compare: { targetPath: "computedWord", mode: "numeric" } } },
      { name: "nestedValidation", type: "bytes", offset: 13, length: 0, computed: { expression: "sha384(concat(hex(AABB), hex(AABB), sha384(slice(0x20, key_block_len))))", compare: { targetPath: "nestedDigest", mode: "raw-bytes" } } },
      { name: "nestedDigest", type: "bytes", offset: 0x40, length: 48 },
    ],
  };
  const validated = validateFormatDefinition(definition, "computed.json");
  assert.strictEqual(validated.diagnostics.length, 0);
  const result = parseBinary(bytes, definition, parseOptions);
  assert.ok(!result.diagnostics.some(item => item.path === "computedWord"));
  assert.ok(!result.diagnostics.some(item => item.path === "compareWord"));
  assert.ok(!result.diagnostics.some(item => item.path === "nestedValidation"));
  assert.ok(result.diagnostics.some(item => item.path === "badComputedWord" && item.message.includes("computed mismatch")));
}

function testMatching(): void {
  const magicDef: FormatDefinition = { ...toyDefinition, id: "test.magic", name: "Magic", magic: [{ offset: 0, bytes: "0100" }] };
  const candidates = matchFormats(toyBytes(), "sample.toybin", [toyDefinition, magicDef], parseOptions);
  assert.strictEqual(candidates[0]?.definition.id, "test.magic");
  assert.ok((candidates[0]?.score ?? 0) > (candidates[1]?.score ?? 0));
}

function testValidation(): void {
  const valid = validateFormatDefinition(toyDefinition, "toy.json");
  assert.ok(valid.definition);
  const invalid = validateFormatDefinition({ schemaVersion: 1, id: "bad", name: "Bad", fields: [{ name: "s", type: "string" }] }, "bad.json");
  assert.ok(invalid.diagnostics.some(item => item.message.includes("requires length")));
  const extra = validateFormatDefinition({ schemaVersion: 1, id: "bad.extra", name: "Bad", fields: [{ name: "x", type: "u8", surprise: true }] }, "extra.json");
  assert.ok(extra.diagnostics.some(item => item.message.includes("Unknown field property")));
  const badFlag = validateFormatDefinition({ schemaVersion: 1, id: "bad.flag", name: "Bad", fields: [{ name: "x", type: "u8", flags: [{ mask: "1", label: 2 }] }] }, "flag.json");
  assert.ok(badFlag.diagnostics.length >= 2);
  const badMagic = validateFormatDefinition({ schemaVersion: 1, id: "bad.magic", name: "Bad", magic: [{ offset: 0, bytes: "00", extra: true }], fields: [{ name: "x", type: "u8" }] }, "magic.json");
  assert.ok(badMagic.diagnostics.some(item => item.message.includes("Unknown magic property")));
  const standardMetadata = validateFormatDefinition({ $schema: "./custombin-format.schema.json", $comment: "ok", schemaVersion: 1, id: "test.schema-meta", name: "Schema Metadata", fields: [{ name: "x", type: "u8", $comment: "ok" }] }, "meta.json");
  assert.ok(standardMetadata.definition);
  const partial = validateFormatDefinition({ schemaVersion: 1, id: "test.partial", name: "Partial", fields: [{ name: "x", type: "bad" }, { name: "y", type: "u8" }] }, "partial.json");
  assert.ok(partial.definition);
  assert.ok(partial.diagnostics.some(item => item.message.includes("Unsupported field type")));

  const malformedValidation = validateFormatDefinition({ schemaVersion: 1, id: "test.malformed-validation", name: "Malformed Validation", fields: [{ name: "x", type: "u8", checksum: {} }] }, "malformed.json");
  assert.ok(malformedValidation.definition);
  const malformedResult = parseBinary(new Uint8Array([1]), malformedValidation.definition!, parseOptions);
  assert.ok(malformedResult.diagnostics.some(item => item.message.includes("metadata is invalid")));
}

function run(): void {
  testParser();
  testBounds();
  testStructAndArrayCursor();
  testExplicitOffsetArray();
  testEndianOffsetsAndLargeIntegers();
  testNegativeBinaryUsesRawBits();
  testUtf16String();
  testMatching();
  testOptionalMagicDoesNotExclude();
  testParseBudgets();
  testLengthFromRepeatAndStride();
  testSectionsDependsOnAndMetadata();
  testConsumeRemainingAndSiblingLength();
  testChecksumAndHashDiagnostics();
  testComputedDiagnostics();
  testValidation();
  console.log("All tests passed");
}

run();
