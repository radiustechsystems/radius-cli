import { cardsToMarkdownList } from './card-list-markdown';
import { FEATURE_CARDS } from './feature-cards-data';

/**
 * Homepage feature cards. Card content lives in feature-cards-data.ts so the
 * HTML page and the generated Markdown twin are produced from one source.
 */
export const FeatureCards = Object.assign(
  function FeatureCards() {
    return (
      <section aria-label="Feature links" style={{ marginTop: '2rem', marginBottom: '3rem' }}>
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1.5rem',
          }}
        >
          {FEATURE_CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <li key={card.href}>
                <a href={card.href} className="a11y-card-link" aria-label={`${card.title}: ${card.description}`}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '0.75rem',
                    }}
                  >
                    <h3
                      style={{
                        fontSize: '1.125rem',
                        fontWeight: 500,
                        color: 'var(--vocs-text-color-heading)',
                        lineHeight: 1.4,
                        margin: 0,
                      }}
                    >
                      {card.title}
                    </h3>
                    {Icon && (
                      <div
                        aria-hidden="true"
                        style={{
                          width: '2.5rem',
                          height: '2.5rem',
                          marginLeft: '1rem',
                          flexShrink: 0,
                        }}
                      >
                        <Icon />
                      </div>
                    )}
                  </div>
                  <p
                    style={{
                      fontSize: '0.875rem',
                      color: 'var(--vocs-text-color-secondary)',
                      lineHeight: 1.6,
                      margin: 0,
                      flexGrow: 1,
                    }}
                  >
                    {card.description}
                  </p>
                </a>
              </li>
            );
          })}
        </ul>
      </section>
    );
  },
  {
    /** Markdown twin / llms-full.txt representation (invoked by Vocs at build time). */
    toMarkdown: () => cardsToMarkdownList(FEATURE_CARDS),
  },
);
