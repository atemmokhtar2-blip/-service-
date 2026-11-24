// Test emitted JavaScript rather than relying on Node to resolve TS-only paths.
import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';
const output = await mkdtemp(join(tmpdir(), 'factory-runtime-'));
async function compile(dir, target) {
  await mkdir(target, {recursive:true});
  for (const entry of await readdir(dir,{withFileTypes:true})) {
    const src=join(dir,entry.name),dest=join(target,entry.name.replace(/\.ts$/,'.js'));
    if(entry.isDirectory()) await compile(src,dest);
    else if(/\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      const text=await readFile(src,'utf8');
      await writeFile(dest,entry.name.endsWith('.ts') ? ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText:text);
    }
  }
}
await writeFile(join(output,'package.json'),'{"type":"module"}');
await compile(fileURLToPath(new URL('../src/',import.meta.url)),output);
export function compiled(name) { return pathToFileURL(join(output,name)).href; }
