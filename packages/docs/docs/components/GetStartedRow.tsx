import { ArrowRight } from 'lucide-react';
import { cardsToMarkdownList } from './card-list-markdown';
import { GET_STARTED_CARDS } from './get-started-cards-data';

/**
 * Get Started landing cards. Card content lives in get-started-cards-data.ts so
 * the HTML page and the generated Markdown twin are produced from one source.
 * Favicon hover opacity is handled in docs/pages/_root.css.
 */
export const GetStartedRow = Object.assign(
  function GetStartedRow() {
    return (
      <section aria-label="Get started guides" style={{ marginTop: '2rem', marginBottom: '3rem' }}>
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '1rem',
          }}
        >
          {GET_STARTED_CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <li key={card.href}>
                <a
                  href={card.href}
                  className="a11y-card-link a11y-card-link--get-started"
                  aria-label={`${card.title}: ${card.description}`}
                >
                  <div
                    aria-hidden="true"
                    style={{
                      width: '56px',
                      height: '56px',
                      borderRadius: '0.5rem',
                      backgroundColor: 'rgba(235, 99, 89, 0.1)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: '1.25rem',
                    }}
                  >
                    <Icon size={28} color="#EB6359" strokeWidth={2} />
                  </div>

                  <h3
                    style={{
                      fontSize: '1.25rem',
                      fontWeight: 600,
                      color: 'var(--vocs-text-color-heading)',
                      lineHeight: 1.3,
                      margin: '0 0 0.75rem 0',
                    }}
                  >
                    {card.title}
                  </h3>

                  <p
                    style={{
                      fontSize: '0.9375rem',
                      color: 'var(--vocs-text-color-secondary)',
                      lineHeight: 1.6,
                      margin: '0 0 1.5rem 0',
                      flexGrow: 1,
                    }}
                  >
                    {card.description}
                  </p>

                  {card.companies && card.companies.length > 0 && (
                    <div
                      style={{
                        borderTop: '1px solid var(--vocs-border-color-primary)',
                        paddingTop: '1rem',
                        marginTop: 'auto',
                      }}
                    >
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--vocs-text-color-muted)',
                          marginBottom: '0.5rem',
                          fontWeight: 500,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                        }}
                      >
                        {card.socialProofLabel || 'Used by'}
                      </div>
                      <div
                        className="a11y-card-link__companies"
                        style={{
                          display: 'flex',
                          gap: '0.75rem',
                          alignItems: 'center',
                        }}
                      >
                        {card.companies.slice(0, 4).map((domain) => (
                          <img
                            key={domain}
                            src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
                            alt={domain}
                            width={20}
                            height={20}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  <div
                    aria-hidden="true"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      marginTop: '1rem',
                      fontSize: '0.875rem',
                      fontWeight: 500,
                      color: '#EB6359',
                      gap: '0.5rem',
                    }}
                  >
                    <span>Get started</span>
                    <ArrowRight size={16} />
                  </div>
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
    toMarkdown: () => cardsToMarkdownList(GET_STARTED_CARDS),
  },
);
