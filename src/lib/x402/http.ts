import { readFileSync } from 'node:fs';

export const SUPPORTED_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
export type HttpVerb = typeof SUPPORTED_VERBS[number];

const FORBIDDEN_REQUEST_HEADERS = new Set(['host', 'x-payment']);
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
  contentType: string | null;
}

export function isSupportedVerb(v: string): v is HttpVerb {
  return (SUPPORTED_VERBS as readonly string[]).includes(v.toLowerCase());
}

export function readBodyArg(input: string | undefined): Uint8Array | undefined {
  if (input === undefined) return undefined;
  if (input === '-') {
    return new Uint8Array(readFileSync(0));
  }
  if (input.startsWith('@')) {
    return new Uint8Array(readFileSync(input.slice(1)));
  }
  return new TextEncoder().encode(input);
}

export function looksLikeJson(body: Uint8Array): boolean {
  if (body.length === 0) return false;
  let i = 0;
  while (i < body.length && (body[i] === 0x20 || body[i] === 0x09 || body[i] === 0x0a || body[i] === 0x0d)) i++;
  if (i >= body.length) return false;
  const c = body[i];
  return c === 0x7b || c === 0x5b || c === 0x22; // { [ "
}

export function parseHeaderArgs(headerArgs: string[] | undefined): Headers {
  const out = new Headers();
  if (!headerArgs) return out;
  for (const h of headerArgs) {
    const idx = h.indexOf(':');
    if (idx < 0) throw new Error(`-H expects 'Key: Value', got: ${h}`);
    const key = h.slice(0, idx).trim();
    const value = h.slice(idx + 1).trim();
    if (!key) throw new Error(`-H has an empty header name: ${h}`);
    if (FORBIDDEN_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    out.append(key, value);
  }
  return out;
}

export async function runRequest(
  verb: HttpVerb,
  url: string,
  init: { headers: Headers; body?: Uint8Array; redirect?: 'follow' | 'manual' },
): Promise<HttpResponse> {
  const method = verb.toUpperCase();
  const hasBody = init.body !== undefined && method !== 'GET' && method !== 'HEAD';

  const res = await fetch(url, {
    method,
    headers: init.headers,
    body: hasBody ? (init.body as BodyInit) : undefined,
    redirect: init.redirect ?? 'follow',
  });

  const buf = await readCappedBody(res);
  return {
    status: res.status,
    headers: res.headers,
    body: buf,
    contentType: res.headers.get('content-type'),
  };
}

async function readCappedBody(res: Response): Promise<Uint8Array> {
  if (!res.body) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error(`response body exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    return new Uint8Array(ab);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* noop */ }
        throw new Error(`response body exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export function decodeBodyAsUtf8(body: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}
