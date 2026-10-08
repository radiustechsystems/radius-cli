#!/usr/bin/env tsx
/**
 * generate-sitemap.ts
 *
 * Generates sitemap.xml and sitemap.txt from all .md/.mdx pages in docs/pages/.
 * Output files land in public/ so Vite serves them as static assets
 * in dev and copies them to dist/public/ at build time.
 *
 * Features:
 *   - Respects sitemap.exclude frontmatter flag
 *   - Extracts lastmod from git history (fallback to build time)
 *   - Configurable priority and changefreq per page section
 *   - Generates both XML (for search engines) and TXT (for humans/LLMs)
 *
 * Usage:
 *   pnpm generate-sitemap
 *   or as part of prebuild: pnpm build
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = join(import.meta.dirname ?? __dirname, '..');
const DOCS_ROOT = join(PROJECT_ROOT, 'docs');
const PAGES_DIR = join(DOCS_ROOT, 'pages');
const PUBLIC_DIR = join(PROJECT_ROOT, 'public');

/** Base URL for absolute URLs in sitemap */
const SITE_BASE_URL = process.env.SITE_BASE_URL ?? 'https://docs.radiustech.xyz';

/** Priority and changefreq configuration by URL pattern */
const URL_CONFIG: Record<string, { priority: number; changefreq: string }> = {
  '/': { priority: 1.0, changefreq: 'weekly' },
  '/build': { priority: 0.9, changefreq: 'weekly' },
  '/reference': { priority: 0.9, changefreq: 'weekly' },
  '/architecture': { priority: 0.8, changefreq: 'monthly' },
  '/build/examples': { priority: 0.8, changefreq: 'monthly' },
};

const DEFAULT_PRIORITY = 0.7;
const DEFAULT_CHANGEFREQ = 'monthly';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SitemapEntry {
  /** URL path relative to site root, e.g. "/build/quick-start" */
  urlPath: string;
  /** ISO 8601 date string (YYYY-MM-DD) */
  lastmod: string;
  /** Priority 0.0-1.0 */
  priority: number;
  /** Changefreq: always|hourly|daily|weekly|monthly|yearly|never */
  changefreq: string;
  /** Optional: page title for TXT output */
  title?: string;
}

interface Frontmatter {
  title?: string;
  sitemap?: {
    exclude?: boolean;
    priority?: number;
    changefreq?: string;
  };
}

// ---------------------------------------------------------------------------
// Frontmatter Parsing
// ---------------------------------------------------------------------------

/**
 * Extract frontmatter from MDX file.
 * Returns { title, sitemap: { exclude?, priority?, changefreq? } }
 */
function parseFrontmatter(source: string): Frontmatter {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const title = extractYamlValue(yaml, 'title');

  // Check for sitemap configuration
  const sitemapExclude = extractYamlValue(yaml, 'sitemap.exclude') === 'true';
  const sitemapPriority = parseFloat(extractYamlValue(yaml, 'sitemap.priority') || '');
  const sitemapChangefreq = extractYamlValue(yaml, 'sitemap.changefreq');

  return {
    title: title || undefined,
    sitemap: {
      exclude: sitemapExclude || undefined,
      priority: isNaN(sitemapPriority) ? undefined : sitemapPriority,
      changefreq: sitemapChangefreq || undefined,
    },
  };
}

/**
 * Extract a YAML key value from frontmatter text.
 * Supports both simple keys and nested keys (e.g. "sitemap.exclude")
 */
function extractYamlValue(yaml: string, key: string): string {
  if (key.includes('.')) {
    const [parent, child] = key.split('.');
    const parentMatch = yaml.match(new RegExp(`^${parent}:\\s*$`, 'm'));
    if (!parentMatch) return '';

    const afterParent = yaml.slice(parentMatch.index! + parentMatch[0].length);
    const childMatch = afterParent.match(new RegExp(`^\\s+${child}:\\s*(.+)$`, 'm'));
    return childMatch?.[1]?.trim() || '';
  }

  const match = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() || '';
}

// ---------------------------------------------------------------------------
// Git Utilities
// ---------------------------------------------------------------------------

/**
 * Get the last modification date of a file from git history.
 * Returns ISO 8601 date string (YYYY-MM-DD).
 * Falls back to current date if git is unavailable.
 */
function getLastModifiedDate(filePath: string): string {
  try {
    const relPath = relative(PROJECT_ROOT, filePath);
    const timestamp = execSync(`git log -1 --format=%cI "${relPath}"`, { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();

    if (timestamp) {
      return new Date(timestamp).toISOString().split('T')[0];
    }
  } catch (_err) {
    // Git not available or file not tracked - fall back to current date
  }

  return new Date().toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// File Collection
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .md/.mdx files in a directory.
 */
function collectMdxFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectMdxFiles(full, files);
    } else if (extname(entry) === '.mdx' || extname(entry) === '.md') {
      files.push(full);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// URL Configuration
// ---------------------------------------------------------------------------

/**
 * Get priority and changefreq for a URL path.
 * Matches against configured patterns, falls back to defaults.
 */
function getUrlConfig(urlPath: string): { priority: number; changefreq: string } {
  const configLookupPath = urlPath !== '/' && urlPath.endsWith('/') ? urlPath.slice(0, -1) : urlPath;

  // Exact match
  if (URL_CONFIG[configLookupPath]) {
    return URL_CONFIG[configLookupPath];
  }

  // Pattern match (e.g. /reference matches /reference/*); longest prefix wins
  const patterns = Object.entries(URL_CONFIG).sort(([a], [b]) => b.length - a.length);
  for (const [pattern, config] of patterns) {
    if (configLookupPath.startsWith(pattern + '/')) {
      return config;
    }
  }

  return { priority: DEFAULT_PRIORITY, changefreq: DEFAULT_CHANGEFREQ };
}

/**
 * Normalize doc URLs to the deployed canonical format.
 * Vocs serves non-root content with trailing slashes, so emitting slashless
 * URLs in the sitemap creates avoidable 308 redirects in Search Console.
 */
function normalizeSitemapUrlPath(urlPath: string): string {
  if (urlPath === '/') {
    return urlPath;
  }

  return urlPath.endsWith('/') ? urlPath : `${urlPath}/`;
}

// ---------------------------------------------------------------------------
// Sitemap Generation
// ---------------------------------------------------------------------------

/**
 * Generate XML sitemap from entries.
 */
function generateSitemapXml(entries: SitemapEntry[]): string {
  const urls = entries
    .map((entry) => {
      const url = `${SITE_BASE_URL}${entry.urlPath}`;
      return `  <url>
    <loc>${escapeXml(url)}</loc>
    <lastmod>${entry.lastmod}</lastmod>
    <changefreq>${entry.changefreq}</changefreq>
    <priority>${entry.priority.toFixed(1)}</priority>
  </url>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

/**
 * Generate human-readable text sitemap.
 */
function generateSitemapTxt(entries: SitemapEntry[]): string {
  const lines = [
    '# Radius Documentation Sitemap',
    '',
    'All documentation pages with their last modification dates.',
    'Generated automatically at build time.',
    '',
  ];

  for (const entry of entries) {
    const url = `${SITE_BASE_URL}${entry.urlPath}`;
    const title = entry.title ? ` - ${entry.title}` : '';
    lines.push(`${url}${title}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Escape XML special characters.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  console.log('🗺️  Generating sitemap...');

  const mdxFiles = collectMdxFiles(PAGES_DIR);
  const entries: SitemapEntry[] = [];
  const errors: string[] = [];

  for (const filePath of mdxFiles) {
    const relPath = relative(PAGES_DIR, filePath);

    try {
      const source = readFileSync(filePath, 'utf-8');
      const frontmatter = parseFrontmatter(source);

      // Skip if explicitly excluded
      if (frontmatter.sitemap?.exclude) {
        console.log(`   ⊗ Excluded: ${relPath}`);
        continue;
      }

      // Convert file path to URL path
      let urlPath =
        '/' +
        relPath
          .replace(/\\/g, '/') // Windows compatibility
          .replace(/\.mdx?$/, '') // Remove .md/.mdx extension
          .replace(/\/index$/, '') // index.mdx → /
          .replace(/^index$/, ''); // Root index.mdx → /

      // Ensure root path is just '/'
      if (urlPath === '') urlPath = '/';
      urlPath = normalizeSitemapUrlPath(urlPath);

      // Get configuration (with frontmatter overrides)
      const config = getUrlConfig(urlPath);
      const priority = frontmatter.sitemap?.priority ?? config.priority;
      const changefreq = frontmatter.sitemap?.changefreq ?? config.changefreq;

      // Get last modified date from git
      const lastmod = getLastModifiedDate(filePath);

      entries.push({
        urlPath,
        lastmod,
        priority,
        changefreq,
        title: frontmatter.title,
      });

      console.log(`   ✓ ${urlPath}`);
    } catch (err) {
      errors.push(`Error processing ${relPath}: ${err}`);
    }
  }

  // Sort entries by URL for consistency
  entries.sort((a, b) => a.urlPath.localeCompare(b.urlPath));

  // Generate and write sitemap.xml
  const sitemapXml = generateSitemapXml(entries);
  const xmlPath = join(PUBLIC_DIR, 'sitemap.xml');
  writeFileSync(xmlPath, sitemapXml, 'utf-8');
  console.log(`   ✓ Written: sitemap.xml (${entries.length} URLs)`);

  // Generate and write sitemap.txt
  const sitemapTxt = generateSitemapTxt(entries);
  const txtPath = join(PUBLIC_DIR, 'sitemap.txt');
  writeFileSync(txtPath, sitemapTxt, 'utf-8');
  console.log(`   ✓ Written: sitemap.txt (${entries.length} URLs)`);

  // Report errors
  if (errors.length > 0) {
    console.error('\n⚠️  Errors encountered:');
    errors.forEach((err) => console.error(`   ${err}`));
  }

  const elapsed = Date.now() - startTime;
  console.log(`\n✅ Sitemap generation complete in ${elapsed}ms`);
  console.log(`   ${entries.length} pages, ${errors.length} errors`);
}

main().catch((err) => {
  console.error('❌ Sitemap generation failed:', err);
  process.exit(1);
});
