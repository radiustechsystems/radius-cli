#!/usr/bin/env npx tsx
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

type Severity = 'error' | 'warning' | 'info';
type Category = 'deterministic' | 'accessibility';

interface Finding {
  file: string;
  line?: number;
  severity: Severity;
  category: Category;
  rule: string;
  message: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, '..', 'docs', 'pages');

const isNonBlocking = process.argv.includes('--non-blocking');

const findings: Finding[] = [];

function addFinding(finding: Finding) {
  findings.push(finding);
}

function collectDocsFiles(dir: string, baseDir: string = dir): Array<{ fullPath: string; relativePath: string }> {
  const out: Array<{ fullPath: string; relativePath: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectDocsFiles(fullPath, baseDir));
      continue;
    }
    if (!entry.name.endsWith('.md') && !entry.name.endsWith('.mdx')) continue;
    out.push({ fullPath, relativePath: relative(baseDir, fullPath) });
  }
  return out;
}

function buildRouteMap(dir: string, baseDir: string = dir): Set<string> {
  const routes = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const route of buildRouteMap(fullPath, baseDir)) routes.add(route);
      continue;
    }
    if (!entry.name.endsWith('.md') && !entry.name.endsWith('.mdx')) continue;
    const rel = relative(baseDir, fullPath).replace(/\.(md|mdx)$/, '');
    if (rel === 'index') {
      routes.add('/');
      continue;
    }
    if (rel.endsWith('/index')) {
      const route = `/${rel.replace(/\/index$/, '')}`;
      routes.add(route);
      routes.add(`${route}/`);
      continue;
    }
    routes.add(`/${rel}`);
  }
  return routes;
}

function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

function validateDeterministic(filePath: string, content: string, routes: Set<string>) {
  const lines = content.split('\n');
  const frontmatter = extractFrontmatter(content);

  if (!frontmatter) {
    addFinding({
      file: filePath,
      severity: 'error',
      category: 'deterministic',
      rule: 'missing-frontmatter',
      message: 'Missing frontmatter block.',
    });
  } else {
    if (!/^title:\s*.+/m.test(frontmatter)) {
      addFinding({
        file: filePath,
        severity: 'error',
        category: 'deterministic',
        rule: 'missing-title',
        message: 'Frontmatter is missing a title.',
      });
    }
    if (!/^description:\s*.+/m.test(frontmatter)) {
      addFinding({
        file: filePath,
        severity: 'error',
        category: 'deterministic',
        rule: 'missing-description',
        message: 'Frontmatter is missing a description.',
      });
    }
  }

  const h1Lines = lines.map((line, index) => ({ line, lineNo: index + 1 })).filter((x) => /^#\s+/.test(x.line.trim()));

  if (h1Lines.length === 0) {
    addFinding({
      file: filePath,
      severity: 'error',
      category: 'deterministic',
      rule: 'missing-h1',
      message: 'Page must include exactly one H1.',
    });
  }
  if (h1Lines.length > 1) {
    addFinding({
      file: filePath,
      severity: 'error',
      category: 'deterministic',
      rule: 'multiple-h1',
      message: `Page contains ${h1Lines.length} H1 headings; keep exactly one.`,
    });
  }

  if (filePath.endsWith('.mdx')) {
    const h1 = h1Lines[0];
    if (h1 && !/\[[^\]]+\]/.test(h1.line.trim())) {
      addFinding({
        file: filePath,
        line: h1.lineNo,
        severity: 'warning',
        category: 'deterministic',
        rule: 'missing-h1-subtitle',
        message: 'H1 should include bracket subtitle text (for example: `# Title [Subtitle]`).',
      });
    }
  }

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (/!\[\]\(/.test(line)) {
      addFinding({
        file: filePath,
        line: lineNo,
        severity: 'warning',
        category: 'accessibility',
        rule: 'image-alt-text',
        message: 'Image is missing alt text.',
      });
    }

    const linkRegex = /\[[^\]]+\]\((\/[^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(line)) !== null) {
      const target = match[1].split('#')[0].split('?')[0];
      if (!target) continue;
      const noTrail = target.endsWith('/') ? target.slice(0, -1) : target;
      const withTrail = `${noTrail}/`;
      if (!routes.has(target) && !routes.has(noTrail) && !routes.has(withTrail)) {
        addFinding({
          file: filePath,
          line: lineNo,
          severity: 'error',
          category: 'deterministic',
          rule: 'broken-internal-link',
          message: `Broken internal link: ${match[1]}`,
        });
      }
    }
  });

  // ```json blocks are copied as-is, so they must parse. Use ```jsonc for partial or annotated examples.
  const jsonBlock = /^```json[ \t]*\n([\s\S]*?)^```/gm;
  let block: RegExpExecArray | null;
  while ((block = jsonBlock.exec(content)) !== null) {
    try {
      JSON.parse(block[1]);
    } catch (error) {
      addFinding({
        file: filePath,
        line: content.slice(0, block.index).split('\n').length,
        severity: 'error',
        category: 'deterministic',
        rule: 'invalid-json-block',
        message: `JSON code block does not parse: ${(error as Error).message}`,
      });
    }
  }
}

async function main() {
  console.log('Running docs validator v2...');
  if (!existsSync(DOCS_DIR)) throw new Error(`Missing docs/pages directory: ${DOCS_DIR}`);

  const files = collectDocsFiles(DOCS_DIR);
  const routes = buildRouteMap(DOCS_DIR);
  console.log(`Discovered ${files.length} docs pages and ${routes.size} routes.`);

  for (const file of files) {
    validateDeterministic(file.relativePath, readFileSync(file.fullPath, 'utf-8'), routes);
  }

  for (const f of findings) {
    console.log(`${f.severity.toUpperCase()} · ${f.file}${f.line ? `:${f.line}` : ''} · ${f.rule} · ${f.message}`);
  }
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  console.log(`Done. Errors: ${errors} · Warnings: ${warnings}`);

  if (!isNonBlocking && errors > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
