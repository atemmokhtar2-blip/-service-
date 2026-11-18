import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticCode } from "../src/diagnostics.ts";

test("keeps safe machine-readable diagnostic codes", () => {
  assert.equal(diagnosticCode("invalid_signature"), "invalid_signature");
  assert.equal(diagnosticCode("SOURCE_NOT_READY"), "SOURCE_NOT_READY");
});

test("does not expose arbitrary upstream text or credential-like values", () => {
  assert.equal(diagnosticCode("secret token=abc123"), "UNCLASSIFIED");
  assert.equal(diagnosticCode({ error: "database password leaked" }), "UNCLASSIFIED");
  assert.equal(diagnosticCode(null), "UNCLASSIFIED");
});
