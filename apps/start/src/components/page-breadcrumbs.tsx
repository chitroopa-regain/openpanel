import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

export type BreadcrumbItem = {
  label: ReactNode;
  to?: string;
  params?: Record<string, string>;
  search?: Record<string, string | undefined>;
};

export function PageBreadcrumbs({
  items,
}: {
  items: BreadcrumbItem[];
}) {
  const visibleItems = items.filter((item) => item.label);

  return (
    <div className="flex items-center gap-2 text-muted-foreground text-sm font-medium flex-wrap">
      {visibleItems.map((item, index) => {
        const isLast = index === visibleItems.length - 1;
        const key = `${index}-${String(item.label)}`;

        return (
          <div key={key} className="flex items-center gap-2 min-w-0">
            {index > 0 && <ChevronRight className="size-4 shrink-0 opacity-60" />}
            {item.to && !isLast ? (
              <Link
                to={item.to}
                params={item.params}
                search={item.search}
                className="hover:text-foreground transition-colors truncate"
              >
                {item.label}
              </Link>
            ) : (
              <span
                className={isLast ? 'text-foreground truncate' : 'truncate'}
              >
                {item.label}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
