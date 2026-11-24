import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("runtime registry module exists as JavaScript for Vercel's emitted function bundle", async () => {
  const source = await readFile(new URL("../src/engines/provision_contract.ts", import.meta.url), "utf8");
  const registryModule = new URL("../src/engines/template_registry.js", import.meta.url);
  await assert.doesNotReject(readFile(registryModule));
  assert.ok(source.includes('from "./template_registry.js"'));
  assert.ok(!source.includes('from "./template_registry.ts"'));
});

import { readdir } from 'node:fs/promises';
test('all runtime TypeScript source uses emitted .js import specifiers', async () => {
  async function check(dir) {
    for (const e of await readdir(dir,{withFileTypes:true})) {
      const url=new URL(e.name+(e.isDirectory()?'/':''),dir);
      if(e.isDirectory()) await check(url);
      else if(e.name.endsWith('.ts')) {
        const source=await readFile(url,'utf8');
        assert.doesNotMatch(source,/from\s+["'][.][^"']*\.ts["']/,'TS-only runtime import in '+url.pathname);
      }
    }
  }
  await check(new URL('../src/',import.meta.url));
  await check(new URL('../api/',import.meta.url));
});
