// Stand-in for a CMS or content collection lookup.
const ARTICLES: Record<string, { title: string; body: string }> = {
  'hello-radius': { title: 'Hello, Radius', body: 'Paid content delivered after settlement.' },
};

export async function loadArticle(slug: string | undefined) {
  return slug ? ARTICLES[slug] : undefined;
}
