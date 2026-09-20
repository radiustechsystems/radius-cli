// Regenerates src/generated/*.ts from the OpenAPI documents in specs/.
//
//   pnpm generate:api          write src/generated/{faucet,swap}.ts
//   pnpm generate:api --check  exit 1 when the committed files differ from a fresh generation
//
// The specs are copied from radiustechsystems/api-monorepo (apps/<app>-api/openapi/openapi.json)
// by scripts/sync-api-specs.mjs, normally via .github/workflows/regenerate-api-clients.yml.
// Only the wire-level types are generated; src/faucet.ts and src/swap.ts are hand-written on top
// and compile against them, so a spec change that breaks the SDK fails `tsc`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = { faucet: 'specs/faucet.openapi.json', swap: 'specs/swap.openapi.json' };
const check = process.argv.includes('--check');

let drift = false;
for (const [name, spec] of Object.entries(SPECS)) {
  const specPath = path.join(root, spec);
  const outPath = path.join(root, 'src/generated', `${name}.ts`);
  const document = JSON.parse(await readFile(specPath, 'utf8'));
  const ast = await openapiTS(document, { exportType: true, rootTypes: false });
  const header = [
    `// Generated from ${spec} by scripts/generate-api.mjs (openapi-typescript). Do not edit.`,
    `// ${document.info?.title ?? name} ${document.info?.version ?? ''}`.trimEnd(),
    '',
  ].join('\n');
  const next = header + astToString(ast);
  const current = await readFile(outPath, 'utf8').catch(() => undefined);
  if (check) {
    if (current !== next) {
      drift = true;
      console.error(`${path.relative(root, outPath)} is out of date; run \`pnpm generate:api\``);
    }
    continue;
  }
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, next, 'utf8');
  console.log(`${current === next ? 'unchanged' : 'wrote'} ${path.relative(root, outPath)}`);
}
if (drift) process.exit(1);
