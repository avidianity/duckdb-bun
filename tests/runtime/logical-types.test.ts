// Logical type functions of the new bindings: index checks before the C calls
// that would crash, Uint32Value coercion of indexes, argument errors, and
// handle kinds.

import { expect, test } from "bun:test";
import { create_config } from "../../src/bindings/api/database.ts";
import * as lt from "../../src/bindings/api/logical-types.ts";
import { Type } from "../../src/bindings/generated/contract.ts";

test("a negative index arrives as a large unsigned one and is range-checked", () => {
  const enumType = lt.create_enum_type(["a", "b"]);
  expect(() => lt.enum_dictionary_value(enumType, -1)).toThrow(
    new RangeError("enum value index 4294967295 is out of range (count: 2)"),
  );
  // A fraction truncates, as ToUint32 does.
  expect(lt.enum_dictionary_value(enumType, 1.9)).toBe("b");
  const structType = lt.create_struct_type([lt.create_logical_type(Type.INTEGER)], ["a"]);
  expect(() => lt.struct_type_child_type(structType, 1)).toThrow(RangeError);
  expect(() => lt.union_type_member_name(structType, 0)).toThrow(
    new RangeError("union member index 0 is out of range (count: 0)"),
  );
});

test("struct and union types take the shorter of the two arrays", () => {
  const int = lt.create_logical_type(Type.INTEGER);
  const structType = lt.create_struct_type([int, int], ["only"]);
  expect(lt.struct_type_child_count(structType)).toBe(1);
  expect(lt.struct_type_child_name(structType, 0)).toBe("only");
  const unionType = lt.create_union_type([int], ["x", "y"]);
  expect(lt.union_type_member_count(unionType)).toBe(1);
  expect(lt.get_type_id(lt.union_type_member_type(unionType, 0))).toBe(Type.INTEGER);
});

test("names are passed as UTF-8, and arguments of the wrong type fail with N-API's text", () => {
  expect(lt.enum_dictionary_value(lt.create_enum_type(["", "ünïcødé 🦆"]), 1)).toBe("ünïcødé 🦆");
  expect(() => lt.create_enum_type("a" as never)).toThrow(new Error("An array was expected"));
  expect(() => lt.create_enum_type([1] as never)).toThrow(new Error("A string was expected"));
  expect(() => lt.create_struct_type([1] as never, ["a"])).toThrow(new Error("Invalid logical type argument"));
  expect(() => lt.get_type_id(create_config() as never)).toThrow(new Error("Invalid logical type argument"));
  expect(() => lt.create_array_type(lt.create_logical_type(Type.INTEGER), "3" as never)).toThrow(
    new Error("A number was expected"),
  );
});

test("create_logical_type refuses VARIANT after Uint32Value coercion", () => {
  expect(() => lt.create_logical_type((Type.VARIANT + 0.5) as Type)).toThrow(
    "Cannot create a VARIANT logical type; see https://github.com/duckdb/duckdb/issues/24680",
  );
  expect(lt.get_type_id(lt.create_logical_type(Type.DECIMAL))).toBe(Type.INVALID);
});

test("create_decimal_type narrows width and scale to uint8", () => {
  const decimal = lt.create_decimal_type(256 + 18, 6);
  expect(lt.decimal_width(decimal)).toBe(18);
  expect(lt.decimal_scale(decimal)).toBe(6);
  expect(lt.decimal_internal_type(decimal)).toBe(Type.BIGINT);
});

test("alias round-trips and reads null when unset", () => {
  const type = lt.create_list_type(lt.create_logical_type(Type.VARCHAR));
  expect(lt.logical_type_get_alias(type)).toBeNull();
  lt.logical_type_set_alias(type, "names");
  expect(lt.logical_type_get_alias(type)).toBe("names");
  expect(() => lt.logical_type_set_alias(type, 1 as never)).toThrow(new Error("A string was expected"));
  expect(lt.get_type_id(lt.list_type_child_type(type))).toBe(Type.VARCHAR);
});

test("array types report their size as a number", () => {
  const array = lt.create_array_type(lt.create_logical_type(Type.DOUBLE), 3);
  expect(lt.array_type_array_size(array)).toBe(3);
  expect(lt.get_type_id(lt.array_type_child_type(array))).toBe(Type.DOUBLE);
});
