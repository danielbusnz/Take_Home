import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectDocument, validateDocuments } from "../src/documents.js";
import type { Document } from "../src/types.js";

const pdf: Document = { name: "dec.pdf", contentType: "application/pdf", bytes: "abc" };

test("clean PDF passes", () => {
  assert.equal(inspectDocument(pdf), null);
});

test("non-PDF is flagged", () => {
  const html: Document = { ...pdf, contentType: "text/html" };
  assert.match(inspectDocument(html)?.reason ?? "", /unexpected contentType/);
});

test("empty body is flagged", () => {
  const empty: Document = { ...pdf, bytes: "" };
  assert.match(inspectDocument(empty)?.reason ?? "", /empty body/);
});

test("validateDocuments returns docs unchanged", () => {
  const docs = [pdf];
  assert.deepEqual(validateDocuments("mock", docs), docs);
});

test("validateDocuments throws when there are no documents", () => {
  assert.throws(() => validateDocuments("mock", []), /no documents/);
});
