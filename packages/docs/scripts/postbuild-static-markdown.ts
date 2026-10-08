#!/usr/bin/env tsx
/**
 * postbuild-static-markdown.ts
 *
 * Vocs 2 generates a Markdown twin for every page and writes it to
 * `dist/public/assets/md/<path>.md`. The pretty `/<path>.md` URL (and
 * `Accept: text/markdown` negotiation) is handled by Vocs's server middleware,
 * which does not exist in a `renderStrategy: 'full-static'` build served from
 * Cloudflare Pages / GitHub Pages.
 *
 * This script keeps the documented URLs working on static hosts:
 *
 *   1. Mirrors `dist/public/assets/md/**` to `dist/public/<path>.md`
 *      (`/index.md` for the home page; index pages also get `<dir>/index.md`).
 *   2. Points page links inside the mirrored twins at their `.md` twins
 *      (`/fees` → `/fees.md`) so an agent reading Markdown stays on Markdown.
 *      Vocs leaves these links extensionless because its server serves Markdown
 *      at the page URL to agents; a static host cannot.
 *   3. Rewrites the relative page links in `llms.txt` / `llms-full.txt` to
 *      absolute `.md` URLs so agents can fetch Markdown directly.
 *   4. Drops the 404 page from the agent-facing output.
 *
 * Runs automatically via the `postbuild` script.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const PROJECT_ROOT = join(import.meta.dirname ?? dirname(new URL(import.meta.url).pathname), '..');
const OUT_DIR = process.env.VOCS_OUT_DIR ?? join(PROJECT_ROOT, 'dist', 'public');
const TWINS_DIR = join(OUT_DIR, 'assets', 'md');
const PAGES_DIR = join(PROJECT_ROOT, 'docs', 'pages');

/** Base URL for absolute links in llms.txt (mirrors scripts/generate-sitemap.ts). */
/** Routes that exist for browsers only and should not be offered to agents. */
const EXCLUDED_ROUTES = new Set(['/404']);

const DOCS_BASE_URL = (process.env.DOCS_BASE_URL ?? process.env.SITE_BASE_URL ?? 'https://docs.radiustech.xyz').replace(
  /\/$/,
  '',
);

function collectFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, files);
    else if (entry.endsWith('.md')) files.push(full);
  }
  return files;
}

/** Pages authored as `<dir>/index.mdx` also historically published `<dir>/index.md`. */
function isIndexPage(pagePath: string): boolean {
  return ['.mdx', '.md'].some((ext) => existsSync(join(PAGES_DIR, pagePath, `index${ext}`)));
}

function mirrorTwins(): number {
  if (!existsSync(TWINS_DIR)) {
    console.warn(`⚠  No Markdown twins found at ${relative(PROJECT_ROOT, TWINS_DIR)} — skipping mirror.`);
    return 0;
  }

  let count = 0;
  for (const source of collectFiles(TWINS_DIR)) {
    const rel = relative(TWINS_DIR, source); // e.g. reference/fees.md
    const pagePath = rel.replace(/\.md$/, '');
    if (EXCLUDED_ROUTES.has(`/${pagePath}`)) {
      rmSync(source);
      continue;
    }

    const targets = [join(OUT_DIR, rel)];
    if (pagePath !== 'index' && isIndexPage(pagePath)) targets.push(join(OUT_DIR, pagePath, 'index.md'));

    const content = linkTwins(readFileSync(source, 'utf-8'));
    for (const target of targets) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf-8');
      count++;
    }
  }
  return count;
}

/** Page path (`/fees`, `/build/`, `/`) → its twin's URL path, or null if it has no twin. */
function twinPath(path: string): string | null {
  const clean = path === '/' ? '/index' : path.replace(/\/$/, '');
  if (EXCLUDED_ROUTES.has(clean)) return null;
  return existsSync(join(TWINS_DIR, `${clean}.md`)) ? `${clean}.md` : null;
}

/** `[text](/fees#turnstile)` → `[text](/fees.md#turnstile)`, for pages that have a twin. */
function linkTwins(content: string): string {
  return content.replace(/\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g, (match, path: string, hash = '') => {
    if (/\.\w+$/.test(path)) return match; // static file (image, .mjs, skills .md)
    const twin = twinPath(path);
    return twin ? `](${twin}${hash})` : match;
  });
}

/** `- [Title](/path): desc` → `- [Title](https://docs.radiustech.xyz/path.md): desc` */
function absolutizeLinks(content: string): string {
  const withoutExcluded = content
    .split('\n')
    .filter((line) => ![...EXCLUDED_ROUTES].some((route) => line.startsWith(`- [`) && line.includes(`](${route})`)))
    .join('\n');
  return withoutExcluded.replace(/\]\((\/[^)\s]*)\)/g, (_match, path: string) => {
    if (/\.\w+$/.test(path)) return `](${DOCS_BASE_URL}${path})`;
    const clean = path === '/' || path === '/index' ? '/index' : path.replace(/\/$/, '');
    return `](${DOCS_BASE_URL}${clean}.md)`;
  });
}

function rewriteLlmsFiles(): void {
  for (const name of ['llms.txt', 'llms-full.txt']) {
    const file = join(OUT_DIR, name);
    if (!existsSync(file)) {
      console.warn(`⚠  ${name} not found in build output — skipping.`);
      continue;
    }
    writeFileSync(file, absolutizeLinks(readFileSync(file, 'utf-8')), 'utf-8');
    console.log(`  ✓  ${name} links rewritten to ${DOCS_BASE_URL}/*.md`);
  }
}

function main(): void {
  if (!existsSync(OUT_DIR)) {
    console.error(`✗  Build output not found at ${OUT_DIR}. Run \`pnpm build\` first.`);
    process.exit(1);
  }

  const mirrored = mirrorTwins();
  console.log(`  ✓  ${mirrored} Markdown twin(s) mirrored to pretty .md URLs`);
  rewriteLlmsFiles();
}

main();
