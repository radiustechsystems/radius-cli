import type { List } from 'mdast';

type CardLike = { title: string; description: string; href: string };

/**
 * Markdown representation shared by the card components' `toMarkdown` hooks.
 * Vocs calls the hook while generating `.md` twins and `llms-full.txt`.
 */
export function cardsToMarkdownList(cards: readonly CardLike[]): List {
  return {
    type: 'list',
    ordered: false,
    spread: false,
    children: cards.map((card) => ({
      type: 'listItem',
      spread: false,
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: card.href,
              children: [{ type: 'strong', children: [{ type: 'text', value: card.title }] }],
            },
            { type: 'text', value: `: ${card.description}` },
          ],
        },
      ],
    })),
  };
}
