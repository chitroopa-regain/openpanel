import { cn } from '@/utils/cn';
import { ChevronRightIcon } from 'lucide-react';

import { NOT_SET_VALUE } from '@openpanel/constants';

import React, { Fragment } from 'react';
import { useReportChartContext } from '../context';

interface SerieNameProps {
  name: string | string[];
  className?: string;
}

export function SerieName({ name, className }: SerieNameProps) {
  const {
    options: { renderSerieName },
  } = useReportChartContext();

  if (Array.isArray(name)) {
    if (renderSerieName) {
      return renderSerieName(name);
    }
    return (
      <div className={cn('flex min-w-0 items-center gap-1 overflow-hidden', className)}>
        {name.map((n, index) => {
          return (
            <Fragment key={n}>
              <span className="min-w-0 truncate">{n || NOT_SET_VALUE}</span>
              {name.length - 1 > index && (
                <ChevronRightIcon
                  className="shrink-0 text-muted-foreground"
                  size={12}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    );
  }

  if (renderSerieName) {
    return renderSerieName([name]);
  }

  return <span className={className}>{name}</span>;
}
