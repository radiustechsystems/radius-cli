/**
 * remark-llm-output
 *
 * Output-only remark plugin registered via `markdown.outputRemarkPlugins` in
 * vocs.config.ts. Vocs runs it ONLY while generating agent-facing Markdown
 * (per-page `.md` twins, `llms-full.txt`, and `vocs markdown-audit`); the
 * rendered HTML site is untouched.
 *
 * It makes the generated Markdown read like the rendered page by handling the
 * MDX features this site uses that Vocs leaves as raw JSX or MDX syntax:
 *
 *  1. `{CONSTANT}` expressions (and template literals of constants) imported
 *     from docs/constants.ts are resolved to their values.
 *  2. `<TransactionCost field=… format=… />` becomes the same static value the
 *     component shows before hydration (docs/components/transaction-cost-format.ts).
 *  3. Plain HTML JSX (`<a href>`, `<b>`, `<img>`, `<div>` wrappers …) becomes
 *     Markdown links/emphasis/images or is unwrapped to its children.
 *  4. `:::note` / `:::info` / `:::tip` / `:::warning` / `:::danger` / `:::success`
 *     callouts become labelled blockquotes.
 *  5. The Vocs subtitle syntax `# Title [Subtitle]` becomes a heading followed
 *     by an italic subtitle line.
 *
 * Components that still appear as PascalCase JSX after this plugin need a
 * `toMarkdown` hook (see docs/components/FeatureCards.tsx) — `pnpm docs:markdown-audit`
 * reports them.
 */

import type { Blockquote, Heading, Paragraph, PhrasingContent, Root, RootContent, Strong, Text } from 'mdast';
import type { MdxFlowExpression, MdxTextExpression } from 'mdast-util-mdx-expression';
import type { MdxJsxAttribute, MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx-jsx';
import type { Plugin } from 'unified';
import * as constantsModule from './constants.js';
import {
  getStaticFallback,
  type TransactionCostField,
  type TransactionCostFormat,
} from './components/transaction-cost-format.js';

// ---------------------------------------------------------------------------
// Constants (single source of truth: docs/constants.ts)
// ---------------------------------------------------------------------------

const CONSTANTS: Record<string, string> = Object.fromEntries(
  Object.entries(constantsModule).map(([key, value]) => [key, String(value)]),
);

const CALLOUT_LABELS: Record<string, string> = {
  info: 'Info',
  warning: 'Warning',
  danger: 'Danger',
  success: 'Success',
  tip: 'Tip',
  note: 'Note',
};

type ContainerDirective = {
  type: 'containerDirective';
  name: string;
  attributes?: Record<string, string | null | undefined>;
  children: RootContent[];
};

type Node = RootContent | Root;
type Parent = Node & { children: Node[] };

// ---------------------------------------------------------------------------
// Expression resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a JS expression source string to a plain string when it is made only
 * of known constants and string literals. Returns `undefined` otherwise.
 */
export function resolveExpression(source: string): string | undefined {
  const expr = source.trim();
  if (!expr) return undefined;

  // Bare identifier: {NATIVE_TOKEN}
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) return CONSTANTS[expr];

  // String literal: {'text'} / {"text"}
  const literal = expr.match(/^(['"])(.*)\1$/s);
  if (literal) return literal[2];

  // Template literal made of constants: {`${A}/path${B}`}
  const template = expr.match(/^`(.*)`$/s);
  if (template) {
    let unresolved = false;
    const value = template[1].replace(/\$\{([^}]+)\}/g, (_match, inner: string) => {
      const resolved = resolveExpression(inner);
      if (resolved === undefined) unresolved = true;
      return resolved ?? '';
    });
    return unresolved ? undefined : value;
  }

  return undefined;
}

function isComment(source: string): boolean {
  return source.trim().startsWith('/*');
}

// ---------------------------------------------------------------------------
// JSX helpers
// ---------------------------------------------------------------------------

type JsxElement = MdxJsxFlowElement | MdxJsxTextElement;

function getAttribute(node: JsxElement, name: string): string | undefined {
  const attribute = node.attributes.find(
    (attr): attr is MdxJsxAttribute => attr.type === 'mdxJsxAttribute' && attr.name === name,
  );
  if (!attribute) return undefined;
  if (typeof attribute.value === 'string') return attribute.value;
  if (attribute.value && typeof attribute.value === 'object') return resolveExpression(attribute.value.value);
  return undefined;
}

function text(value: string): Text {
  return { type: 'text', value };
}

function paragraph(children: PhrasingContent[]): Paragraph {
  return { type: 'paragraph', children };
}

/** Flatten flow content (paragraphs etc.) into phrasing content. */
function toPhrasing(nodes: Node[]): PhrasingContent[] {
  const result: PhrasingContent[] = [];
  for (const node of nodes) {
    if (node.type === 'paragraph') result.push(...node.children);
    else if (node.type === 'text' || isPhrasing(node)) result.push(node as PhrasingContent);
    else if ('children' in node && Array.isArray(node.children)) result.push(...toPhrasing(node.children as Node[]));
  }
  return result;
}

const PHRASING_TYPES = new Set([
  'text',
  'emphasis',
  'strong',
  'delete',
  'inlineCode',
  'break',
  'link',
  'image',
  'linkReference',
  'imageReference',
  'footnoteReference',
  'html',
  'mdxJsxTextElement',
  'mdxTextExpression',
]);

function isPhrasing(node: Node): boolean {
  return PHRASING_TYPES.has(node.type);
}

// ---------------------------------------------------------------------------
// Node transforms
// ---------------------------------------------------------------------------

function transformTransactionCost(node: JsxElement): Node[] {
  const field = getAttribute(node, 'field') as TransactionCostField | undefined;
  const format = getAttribute(node, 'format') as TransactionCostFormat | undefined;
  const fallback = getAttribute(node, 'fallback');
  const value = text(getStaticFallback(field, format, fallback));
  return node.type === 'mdxJsxFlowElement' ? [paragraph([value])] : [value];
}

function transformHtmlElement(node: JsxElement, children: Node[]): Node[] {
  const isFlow = node.type === 'mdxJsxFlowElement';
  const wrapPhrasing = (phrasing: PhrasingContent[]): Node[] => (isFlow ? [paragraph(phrasing)] : phrasing);

  switch (node.name) {
    case 'a': {
      const href = getAttribute(node, 'href');
      const phrasing = toPhrasing(children);
      if (!href) return wrapPhrasing(phrasing);
      return wrapPhrasing([{ type: 'link', url: href, children: phrasing.length > 0 ? phrasing : [text(href)] }]);
    }
    case 'b':
    case 'strong':
      return wrapPhrasing([{ type: 'strong', children: toPhrasing(children) }]);
    case 'i':
    case 'em':
      return wrapPhrasing([{ type: 'emphasis', children: toPhrasing(children) }]);
    case 'code':
      return wrapPhrasing([{ type: 'inlineCode', value: phrasingToString(toPhrasing(children)) }]);
    case 'img': {
      const src = getAttribute(node, 'src');
      if (!src) return [];
      return wrapPhrasing([{ type: 'image', url: src, alt: getAttribute(node, 'alt') ?? '' }]);
    }
    case 'br':
      return isFlow ? [] : [{ type: 'break' }];
    case 'style':
    case 'script':
      return [];
    default:
      // div, span, section, p, ul, li, … → keep the content, drop the wrapper
      if (!isFlow) return toPhrasing(children);
      return children.every(isPhrasing) ? [paragraph(children as PhrasingContent[])] : children;
  }
}

function phrasingToString(nodes: PhrasingContent[]): string {
  return nodes
    .map((node) => ('value' in node ? node.value : 'children' in node ? phrasingToString(node.children) : ''))
    .join('');
}

function transformDirective(node: ContainerDirective, children: Node[]): Node[] {
  const label = CALLOUT_LABELS[node.name];
  if (!label) return [{ ...node, children } as unknown as RootContent];

  const strong: Strong = { type: 'strong', children: [text(`${label}:`)] };
  const [first, ...rest] = children;
  const body =
    first && first.type === 'paragraph'
      ? [paragraph([strong, text(' '), ...first.children]), ...rest]
      : [paragraph([strong]), ...children];

  const blockquote = { type: 'blockquote', children: body } as unknown as Blockquote;
  return [blockquote];
}

/** `# Title [Subtitle]` → `# Title` + `*Subtitle*` */
function transformHeading(node: Heading): Node[] {
  if (node.depth !== 1) return [node];
  const last = node.children[node.children.length - 1];
  if (!last || last.type !== 'text') return [node];

  const match = last.value.match(/^(.*?)\s*\[([^\]]+)\]\s*$/s);
  if (!match) return [node];

  const [, before, subtitle] = match;
  const headingChildren = [...node.children.slice(0, -1)];
  if (before) headingChildren.push(text(before));

  return [
    { ...node, children: headingChildren.length > 0 ? headingChildren : [text(before)] },
    paragraph([{ type: 'emphasis', children: [text(subtitle.trim())] }]),
  ];
}

function transformNode(node: Node): Node[] {
  // Recurse first so children are already clean.
  const children =
    'children' in node && Array.isArray(node.children) ? (node.children as Node[]).flatMap(transformNode) : undefined;
  const withChildren: Node = children ? ({ ...node, children } as Parent) : node;

  switch ((withChildren as { type: string }).type) {
    case 'mdxTextExpression':
    case 'mdxFlowExpression': {
      const { value } = withChildren as MdxTextExpression | MdxFlowExpression;
      if (isComment(value)) return [];
      const resolved = resolveExpression(value);
      if (resolved === undefined) return [withChildren];
      return withChildren.type === 'mdxFlowExpression' ? [paragraph([text(resolved)])] : [text(resolved)];
    }
    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement': {
      const element = withChildren as JsxElement;
      if (element.name === 'TransactionCost') return transformTransactionCost(element);
      if (element.name && /^[a-z]/.test(element.name)) return transformHtmlElement(element, children ?? []);
      return [withChildren];
    }
    case 'containerDirective':
      return transformDirective(withChildren as unknown as ContainerDirective, children ?? []);
    case 'heading':
      return transformHeading(withChildren as Heading);
    default:
      return [withChildren];
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const remarkLlmOutput: Plugin<[], Root> = () => {
  return (tree: Root) => {
    tree.children = tree.children.flatMap(transformNode) as RootContent[];
  };
};

export default remarkLlmOutput;
