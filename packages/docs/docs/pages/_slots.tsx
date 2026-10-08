import { AreaSwitcher } from '../components/AreaSwitcher';

/**
 * Vocs layout slots. `Footer` renders below every page's content; `SidebarHeader` above the
 * desktop sidebar. See https://vocs.dev/features/slots
 */
export function SidebarHeader() {
  return <AreaSwitcher />;
}

export function Footer() {
  return (
    <footer
      style={{
        padding: '2rem',
        textAlign: 'center',
        borderTop: '1px solid var(--vocs-border-color-primary)',
      }}
    >
      <nav aria-label="Radius links" style={{ marginBottom: '0.5rem' }}>
        <a
          href="https://discord.gg/radiustech"
          style={{ marginRight: '1rem' }}
          target="_blank"
          rel="noopener noreferrer"
        >
          Discord
        </a>
        <a
          href="https://github.com/radiustechsystems"
          style={{ marginRight: '1rem' }}
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
        <a
          href="https://x.com/radiustech_xyz"
          style={{ marginRight: '1rem' }}
          target="_blank"
          rel="noopener noreferrer"
        >
          X
        </a>
        <a href="https://radiustech.xyz" target="_blank" rel="noopener noreferrer">
          Website
        </a>
      </nav>
      <p style={{ fontSize: '0.875rem', color: 'var(--vocs-text-color-secondary)', margin: 0 }}>
        ©{new Date().getFullYear()} Radius. All Rights Reserved.
      </p>
    </footer>
  );
}
