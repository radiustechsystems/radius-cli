#!/usr/bin/env tsx
/**
 * validate-sitemap.ts
 *
 * Validates sitemap.xml against sitemap protocol standards.
 * Checks for:
 *   - Valid XML structure
 *   - Required elements (loc)
 *   - Valid URLs (absolute, proper scheme)
 *   - Valid lastmod dates (ISO 8601)
 *   - Valid priority values (0.0-1.0)
 *   - Valid changefreq values
 *   - Duplicate URLs
 *   - URL count limits (50,000 per sitemap)
 *   - File size limits (50MB uncompressed)
 *
 * Usage:
 *   pnpm validate-sitemap [path/to/sitemap.xml]
 *
 * If no path is provided, validates public/sitemap.xml
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = join(import.meta.dirname ?? __dirname, '..');
const DEFAULT_SITEMAP_PATH = join(PROJECT_ROOT, 'public', 'sitemap.xml');

const VALID_CHANGEFREQ = ['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'];
const MAX_URLS = 50000;
const MAX_SIZE_BYTES = 52428800; // 50MB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ValidationError {
  type: 'error' | 'warning';
  message: string;
  line?: number;
}

interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: string;
}

// ---------------------------------------------------------------------------
// Validation Functions
// ---------------------------------------------------------------------------

/**
 * Validate URL format and structure
 */
function validateUrl(url: string): string | null {
  try {
    const parsed = new URL(url);

    // Must be absolute URL with http or https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return `Invalid protocol: ${parsed.protocol} (must be http or https)`;
    }

    // Should have a proper domain
    if (!parsed.hostname || parsed.hostname.length === 0) {
      return 'Missing hostname';
    }

    return null;
  } catch (err) {
    return `Invalid URL format: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Validate ISO 8601 date format (YYYY-MM-DD)
 */
function validateDate(date: string): string | null {
  // Accept full ISO 8601 formats
  const iso8601Regex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

  if (!iso8601Regex.test(date)) {
    return 'Invalid date format (expected ISO 8601: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)';
  }

  try {
    const parsed = new Date(date);
    if (isNaN(parsed.getTime())) {
      return 'Invalid date value';
    }
  } catch (_err) {
    return 'Failed to parse date';
  }

  return null;
}

/**
 * Validate priority value (0.0 to 1.0)
 */
function validatePriority(priority: string): string | null {
  const num = parseFloat(priority);

  if (isNaN(num)) {
    return 'Invalid priority value (not a number)';
  }

  if (num < 0.0 || num > 1.0) {
    return `Priority out of range: ${num} (must be 0.0-1.0)`;
  }

  return null;
}

/**
 * Validate changefreq value
 */
function validateChangefreq(changefreq: string): string | null {
  if (!VALID_CHANGEFREQ.includes(changefreq)) {
    return `Invalid changefreq: ${changefreq} (must be one of: ${VALID_CHANGEFREQ.join(', ')})`;
  }
  return null;
}

/**
 * Extract text content between XML tags
 */
function extractTagContent(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g');
  const matches: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    matches.push(match[1]);
  }

  return matches;
}

/**
 * Parse sitemap XML and extract URL entries
 */
function parseSitemap(xml: string): SitemapUrl[] {
  const urls: SitemapUrl[] = [];
  const urlRegex = /<url>([\s\S]*?)<\/url>/g;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(xml)) !== null) {
    const urlBlock = match[1];
    const loc = extractTagContent(urlBlock, 'loc')[0];
    const lastmod = extractTagContent(urlBlock, 'lastmod')[0];
    const changefreq = extractTagContent(urlBlock, 'changefreq')[0];
    const priority = extractTagContent(urlBlock, 'priority')[0];

    if (loc) {
      urls.push({ loc, lastmod, changefreq, priority });
    }
  }

  return urls;
}

/**
 * Validate sitemap XML content
 */
function validateSitemap(xml: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // Check XML structure
  if (!xml.includes('<?xml version="1.0"')) {
    errors.push({
      type: 'error',
      message: 'Missing XML declaration (<?xml version="1.0" encoding="UTF-8"?>)',
    });
  }

  if (!xml.includes('<urlset')) {
    errors.push({
      type: 'error',
      message: 'Missing <urlset> root element',
    });
  }

  if (!xml.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"')) {
    errors.push({
      type: 'error',
      message: 'Missing or incorrect xmlns namespace (should be http://www.sitemaps.org/schemas/sitemap/0.9)',
    });
  }

  // Parse URLs
  const urls = parseSitemap(xml);

  if (urls.length === 0) {
    errors.push({
      type: 'error',
      message: 'No <url> entries found in sitemap',
    });
    return errors;
  }

  // Check URL count
  if (urls.length > MAX_URLS) {
    errors.push({
      type: 'error',
      message: `Too many URLs: ${urls.length} (maximum is ${MAX_URLS})`,
    });
  }

  // Track URLs for duplicate detection
  const seenUrls = new Set<string>();

  // Validate each URL entry
  urls.forEach((url, index) => {
    const urlNum = index + 1;

    // Validate loc (required)
    if (!url.loc) {
      errors.push({
        type: 'error',
        message: `URL #${urlNum}: Missing <loc> element (required)`,
      });
      return;
    }

    const urlError = validateUrl(url.loc);
    if (urlError) {
      errors.push({
        type: 'error',
        message: `URL #${urlNum} (${url.loc}): ${urlError}`,
      });
    }

    // Check for duplicates
    if (seenUrls.has(url.loc)) {
      errors.push({
        type: 'error',
        message: `URL #${urlNum}: Duplicate URL: ${url.loc}`,
      });
    }
    seenUrls.add(url.loc);

    // Validate lastmod (optional)
    if (url.lastmod) {
      const dateError = validateDate(url.lastmod);
      if (dateError) {
        errors.push({
          type: 'warning',
          message: `URL #${urlNum} (${url.loc}): Invalid lastmod: ${dateError}`,
        });
      }
    }

    // Validate changefreq (optional)
    if (url.changefreq) {
      const changefreqError = validateChangefreq(url.changefreq);
      if (changefreqError) {
        errors.push({
          type: 'warning',
          message: `URL #${urlNum} (${url.loc}): ${changefreqError}`,
        });
      }
    }

    // Validate priority (optional)
    if (url.priority) {
      const priorityError = validatePriority(url.priority);
      if (priorityError) {
        errors.push({
          type: 'warning',
          message: `URL #${urlNum} (${url.loc}): ${priorityError}`,
        });
      }
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const sitemapPath = args[0] ? join(process.cwd(), args[0]) : DEFAULT_SITEMAP_PATH;

  console.log('🔍 Validating sitemap...\n');
  console.log(`   File: ${sitemapPath}`);

  // Check file exists
  if (!existsSync(sitemapPath)) {
    console.error(`\n❌ Error: Sitemap file not found: ${sitemapPath}`);
    console.error('\nGenerate it first with: pnpm generate-sitemap');
    process.exit(1);
  }

  // Check file size
  const stats = statSync(sitemapPath);
  console.log(`   Size: ${(stats.size / 1024).toFixed(2)} KB`);

  if (stats.size > MAX_SIZE_BYTES) {
    console.error(`\n❌ Error: Sitemap too large (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
    console.error(`   Maximum size is ${MAX_SIZE_BYTES / 1024 / 1024} MB`);
    process.exit(1);
  }

  // Read and validate
  const xml = readFileSync(sitemapPath, 'utf-8');
  const errors = validateSitemap(xml);

  // Count URLs
  const urls = parseSitemap(xml);
  console.log(`   URLs: ${urls.length}\n`);

  // Report errors
  const errorCount = errors.filter((e) => e.type === 'error').length;
  const warningCount = errors.filter((e) => e.type === 'warning').length;

  if (errors.length === 0) {
    console.log('✅ Sitemap is valid!');
    console.log('\nValidation checks passed:');
    console.log('   ✓ XML structure');
    console.log('   ✓ Namespace declaration');
    console.log('   ✓ URL formats');
    console.log('   ✓ Date formats');
    console.log('   ✓ Priority values');
    console.log('   ✓ Changefreq values');
    console.log('   ✓ No duplicates');
    console.log('   ✓ URL count within limits');
    console.log('   ✓ File size within limits');
    process.exit(0);
  }

  // Print errors
  if (errorCount > 0) {
    console.log(`❌ ${errorCount} error${errorCount !== 1 ? 's' : ''} found:\n`);
    errors.filter((e) => e.type === 'error').forEach((err) => console.log(`   • ${err.message}`));
    console.log();
  }

  // Print warnings
  if (warningCount > 0) {
    console.log(`⚠️  ${warningCount} warning${warningCount !== 1 ? 's' : ''} found:\n`);
    errors.filter((e) => e.type === 'warning').forEach((err) => console.log(`   • ${err.message}`));
    console.log();
  }

  // Exit with error if any errors found
  if (errorCount > 0) {
    console.log('❌ Sitemap validation failed');
    process.exit(1);
  } else {
    console.log('✅ Sitemap is valid (with warnings)');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('❌ Validation script failed:', err);
  process.exit(1);
});
