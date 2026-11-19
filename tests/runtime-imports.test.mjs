import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("runtime registry module exists as JavaScript for Vercel's emitted function bundle", async () => {
  const source = await readFile(new URL("../src/engines/provision_contract.ts", import.meta.url), "utf8");
  const registryModule = new URL("../src/engines/template_registry.js", import.meta.url);
  await assert.doesNotReject(readFile(registryModule));
  assert.match(source, /from\\s+["']\\.\\/template_registry\\.js["']/);
  assert.doesNotMatch(source, /from\\s+["']\\.\\/template_registry\\.ts["']/);
});
