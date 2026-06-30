import * as assert from "assert";
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
    fields: [{ name: "outer", type: "struct", count: 16, children: [{ name: "inner", type: "string", length: 0, count: 16 }] }],
  };
  const result = parseBinary(new Uint8Array(1), nested, { maxArrayItems: 16, maxRenderedFields: 10, maxRawDisplayBytes: 16 });
  assert.ok(result.diagnostics.some(item => item.message.includes("rendered field limit")));
  assert.ok((result.fields[0]?.children?.length ?? 0) < 16);

  const raw: FormatDefinition = { schemaVersion: 1, id: "test.raw-budget", name: "Raw Budget", fields: [{ name: "a", type: "bytes", length: 4 }, { name: "b", type: "bytes", offset: 0, length: 4 }] };
  const rawResult = parseBinary(new Uint8Array([1, 2, 3, 4]), raw, { maxArrayItems: 16, maxRenderedFields: 10, maxRawDisplayBytes: 3 });
  assert.strictEqual(rawResult.fields[0]?.rawValue, "01 02 03 ... <truncated>");
  assert.strictEqual(rawResult.fields[1]?.rawValue, "<truncated>");
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
  testValidation();
  console.log("All tests passed");
}

run();
