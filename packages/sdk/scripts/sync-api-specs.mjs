// Copies the OpenAPI documents out of a checkout of radiustechsystems/api-monorepo into specs/.
//
//   node scripts/sync-api-specs.mjs <path-to-api-monorepo>
//
// Used by .github/workflows/regenerate-api-clients.yml after checking the monorepo out at the
// commit that changed a spec; handy locally too. Follow with `pnpm generate:api`.
import { copyFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const monorepo = process.argv[2];
if (!monorepo) {
  console.error('usage: node scripts/sync-api-specs.mjs <path-to-api-monorepo>');
  process.exit(1);
}
const SOURCES = {
  faucet: 'apps/faucet-api/openapi/openapi.json',
  swap: 'apps/swap-api/openapi/openapi.json',
};
await mkdir(path.join(root, 'specs'), { recursive: true });
for (const [name, rel] of Object.entries(SOURCES)) {
  const from = path.resolve(monorepo, rel);
  await access(from).catch(() => {
    console.error(`missing ${from}; run \`pnpm generate:openapi\` in the monorepo first`);
    process.exit(1);
  });
  const to = path.join(root, 'specs', `${name}.openapi.json`);
  await copyFile(from, to);
  console.log(`${rel} -> ${path.relative(root, to)}`);
}
