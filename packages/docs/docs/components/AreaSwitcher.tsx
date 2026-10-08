'use client';

import { Link, useConfig, useRouter } from 'vocs';
import { AREAS, areaOf } from '../areas';

/**
 * Discover / Build / Reference links at the top of the desktop sidebar, rendered by the
 * `SidebarHeader` slot. The top nav has the same links, but they are easy to miss.
 */
export function AreaSwitcher() {
  const { path } = useRouter();
  const { basePath } = useConfig();
  const base = basePath && basePath !== '/' ? basePath.replace(/\/$/, '') : '';
  const current = areaOf(base && path.startsWith(base) ? path.slice(base.length) || '/' : path);

  return (
    <nav className="area-switcher" aria-label="Documentation areas">
      {AREAS.map((area) => (
        <Link
          key={area.link}
          to={area.link}
          className="area-switcher__link"
          aria-current={area.link === current.link ? 'true' : undefined}
        >
          {area.text}
        </Link>
      ))}
    </nav>
  );
}
