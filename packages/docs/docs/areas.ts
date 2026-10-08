/** The three docs areas, in navigation order. `link` is each area's landing page and sidebar key. */
export const AREAS = [
  { text: 'Discover', link: '/' },
  { text: 'Build', link: '/build' },
  { text: 'Reference', link: '/reference' },
] as const;

/** The area a page belongs to: the longest area link that prefixes the path (as Vocs picks sidebars). */
export function areaOf(path: string): (typeof AREAS)[number] {
  const clean = path.replace(/\/$/, '') || '/';
  return (
    [...AREAS]
      .filter((area) => area.link === '/' || clean === area.link || clean.startsWith(`${area.link}/`))
      .sort((a, b) => b.link.length - a.link.length)[0] ?? AREAS[0]
  );
}
