// Data chunks, vectors and validity masks of the new bindings
// (src/bindings/api/data-chunk.ts and vector.ts): official error text, views
// over native memory that keep their owner alive, and the places this binding
// is deliberately stricter than the official one.

import { ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import duckdb, { Type } from "../../src/bindings/index.ts";
import { duckdb as capi } from "../../src/bindings/runtime/native.ts";

const INTEGER = () => duckdb.create_logical_type(Type.INTEGER);
const VARCHAR = () => duckdb.create_logical_type(Type.VARCHAR);

test("data_chunk_get_vector reports an out-of-range column as the official RangeError", () => {
  const chunk = duckdb.create_data_chunk([INTEGER(), VARCHAR()]);
  expect(duckdb.data_chunk_get_column_count(chunk)).toBe(2);
  expect(() => duckdb.data_chunk_get_vector(chunk, 2)).toThrow(
    new RangeError("column index 2 is out of range (count: 2)"),
  );
  // Uint32Value: a negative index wraps to a large unsigned one.
  expect(() => duckdb.data_chunk_get_vector(chunk, -1)).toThrow(
    new RangeError("column index 4294967295 is out of range (count: 2)"),
  );
  expect(() => duckdb.data_chunk_get_vector(chunk, "0" as never)).toThrow(new Error("A number was expected"));
  expect(() => duckdb.create_data_chunk(INTEGER() as never)).toThrow(new Error("An array was expected"));
  expect(() => duckdb.data_chunk_get_size(INTEGER() as never)).toThrow(new Error("Invalid data chunk argument"));
});

test("vector_get_data is a Buffer over the vector's memory that keeps the chunk alive", () => {
  const makeView = () => {
    const chunk = duckdb.create_data_chunk([INTEGER()]);
    duckdb.data_chunk_set_size(chunk, 2);
    const vector = duckdb.data_chunk_get_vector(chunk, 0);
    duckdb.copy_data_to_vector(vector, 0, new Int32Array([7, -9]).buffer, 0, 8);
    return duckdb.vector_get_data(vector, 8);
  };
  const view = makeView();
  for (let i = 0; i < 5; i++) Bun.gc(true);
  expect(view).toBeInstanceOf(Buffer);
  expect(view.byteOffset).toBe(0);
  expect(new Int32Array(view.buffer, 0, 2)).toEqual(new Int32Array([7, -9]));
  // Writes go straight to DuckDB's memory.
  view[0] = 8;
  expect(new Int32Array(view.buffer, 0, 1)[0]).toBe(8);
  expect(duckdb.vector_get_data(duckdb.data_chunk_get_vector(duckdb.create_data_chunk([INTEGER()]), 0), 0)).toEqual(
    Buffer.alloc(0),
  );
});

test("vector_get_validity is null until the mask is made writable", () => {
  const chunk = duckdb.create_data_chunk([INTEGER()]);
  const vector = duckdb.data_chunk_get_vector(chunk, 0);
  expect(duckdb.vector_get_validity(vector, 8)).toBeNull();
  expect(() => duckdb.copy_data_to_vector_validity(vector, 0, new ArrayBuffer(8), 0, 8)).toThrow(
    new Error("Vector has no validity mask"),
  );
  duckdb.vector_ensure_validity_writable(vector);
  const mask = duckdb.vector_get_validity(vector, 8);
  expect(mask[0]).toBe(0xff);
  duckdb.validity_set_row_invalid(mask, 3);
  expect(duckdb.validity_row_is_valid(duckdb.vector_get_validity(vector, 8), 3)).toBe(true);
  duckdb.copy_data_to_vector_validity(vector, 0, mask.buffer as ArrayBuffer, 0, 8);
  expect(duckdb.validity_row_is_valid(duckdb.vector_get_validity(vector, 8), 3)).toBe(false);
});

test("validity functions agree bit for bit with DuckDB's duckdb_validity_* functions", () => {
  const mask = new Uint8Array(16);
  crypto.getRandomValues(mask);
  for (let row = 0; row < 128; row++) {
    expect(duckdb.validity_row_is_valid(mask, row)).toBe(capi.duckdb_validity_row_is_valid(ptr(mask), row));
  }
  const ours = mask.slice();
  const theirs = mask.slice();
  for (const [row, valid] of [
    [0, false],
    [63, true],
    [64, false],
    [127, false],
    [5, true],
  ] as const) {
    duckdb.validity_set_row_validity(ours, row, valid);
    capi.duckdb_validity_set_row_validity(ptr(theirs), row, valid);
  }
  expect(ours).toEqual(theirs);
  expect(() => duckdb.validity_set_row_valid(ours, 128)).toThrow(
    new RangeError("row index 128 is out of range for a validity mask of 16 bytes (128 rows)"),
  );
});

test("vector_get_data returns a copy, as the official binding does", () => {
  const chunk = duckdb.create_data_chunk([INTEGER()]);
  duckdb.data_chunk_set_size(chunk, 1);
  const vector = duckdb.data_chunk_get_vector(chunk, 0);
  const data = duckdb.vector_get_data(vector, 4);
  new DataView(data.buffer).setInt32(0, 42, true);
  expect(new DataView(duckdb.vector_get_data(vector, 4).buffer).getInt32(0, true)).not.toBe(42);
  duckdb.copy_data_to_vector(vector, 0, data.buffer as ArrayBuffer, 0, 4);
  expect(new DataView(duckdb.vector_get_data(vector, 4).buffer).getInt32(0, true)).toBe(42);
});

test("get_data_from_pointer reads a long string's bytes and shares the vector's lifetime", () => {
  const chunk = duckdb.create_data_chunk([VARCHAR()]);
  duckdb.data_chunk_set_size(chunk, 2);
  const vector = duckdb.data_chunk_get_vector(chunk, 0);
  const long = "a string longer than twelve bytes";
  duckdb.vector_assign_string_element(vector, 0, long);
  duckdb.vector_assign_string_element(vector, 1, "nul\0inside");
  const data = duckdb.vector_get_data(vector, 32);
  const view = new DataView(data.buffer);
  expect(view.getUint32(0, true)).toBe(long.length);
  const bytes = duckdb.get_data_from_pointer(data.buffer as ArrayBuffer, 8, long.length);
  expect(new TextDecoder().decode(bytes)).toBe(long);
  expect(new TextDecoder().decode(data.subarray(20, 20 + view.getUint32(16, true)))).toBe("nul\0inside");
  expect(() => duckdb.get_data_from_pointer(new Uint8Array(8) as never, 0, 1)).toThrow(new Error("Invalid argument"));
});

test("list, struct and array children are borrowed from their parent", () => {
  const listChunk = duckdb.create_data_chunk([duckdb.create_list_type(INTEGER())]);
  const list = duckdb.data_chunk_get_vector(listChunk, 0);
  duckdb.list_vector_reserve(list, 4000);
  duckdb.list_vector_set_size(list, 3000);
  expect(duckdb.list_vector_get_size(list)).toBe(3000);
  const child = duckdb.list_vector_get_child(list);
  expect(duckdb.get_type_id(duckdb.vector_get_column_type(child))).toBe(Type.INTEGER);

  const structType = duckdb.create_struct_type([INTEGER(), VARCHAR()], ["a", "b"]);
  const struct = duckdb.data_chunk_get_vector(duckdb.create_data_chunk([structType]), 0);
  expect(duckdb.get_type_id(duckdb.vector_get_column_type(duckdb.struct_vector_get_child(struct, 1)))).toBe(
    Type.VARCHAR,
  );
});

test("struct_vector_get_child is bounds-checked, since DuckDB's C++ exception would abort the process", () => {
  const structType = duckdb.create_struct_type([INTEGER()], ["a"]);
  const vector = duckdb.data_chunk_get_vector(duckdb.create_data_chunk([structType]), 0);
  expect(() => duckdb.struct_vector_get_child(vector, 1)).toThrow(
    new RangeError("struct entry index 1 is out of range (count: 1)"),
  );
  const notStruct = duckdb.data_chunk_get_vector(duckdb.create_data_chunk([INTEGER()]), 0);
  expect(() => duckdb.struct_vector_get_child(notStruct, 0)).toThrow(
    new RangeError("struct entry index 0 is out of range (count: 0)"),
  );
});

test("create_vector owns its memory and can reference a value", () => {
  const vector = duckdb.create_vector(INTEGER(), 1);
  duckdb.vector_reference_value(vector, duckdb.create_int32(42));
  const data = duckdb.vector_get_data(vector, 4);
  expect(new DataView(data.buffer).getInt32(0, true)).toBe(42);
  expect(duckdb.vector_size()).toBe(2048);
});
