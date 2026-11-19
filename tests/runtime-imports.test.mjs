import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Vercel runtime imports the registry through its emitted JavaScript path", async () => {
  const source = await readFile(new URL("../src/engines/provision_contract.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /from\s+["']\.\/template_registry\.js["']/,
    "the deployed JavaScript bundle must not retain a .ts runtime import",
  );
  assert.doesNotMatch(source, /from\s+["']\.\/template_registry\.ts["']/);
});
