import { test } from "node:test";
import assert from "node:assert/strict";
import { requireStrings } from "../src/http.js";

test("requireStrings returns the fields when all are present", () => {
  assert.deepEqual(requireStrings({ a: "1", b: "2" }, ["a", "b"]), { a: "1", b: "2" });
});

test("requireStrings rejects a missing field", () => {
  assert.equal(requireStrings({ a: "1" }, ["a", "b"]), null);
});

test("requireStrings rejects empty or whitespace-only values", () => {
  assert.equal(requireStrings({ a: "" }, ["a"]), null);
  assert.equal(requireStrings({ a: "   " }, ["a"]), null);
});

test("requireStrings rejects a non-object body", () => {
  assert.equal(requireStrings(null, ["a"]), null);
  assert.equal(requireStrings("nope", ["a"]), null);
});

test("requireStrings keeps the original value (no trimming of content)", () => {
  assert.deepEqual(requireStrings({ a: "  x  " }, ["a"]), { a: "  x  " });
});
