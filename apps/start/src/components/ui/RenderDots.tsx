import { cn } from '@/utils/cn';
import { Asterisk, ChevronRight } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

interface RenderDotsProps extends React.HTMLAttributes<HTMLDivElement> {
  children: string;
  truncate?: boolean;
}

export function RenderDots({
  children,
  className,
  truncate,
  ...props
}: RenderDotsProps) {
  const parts = children.split('.');
  const sliceAt = truncate && parts.length > 3 ? 3 : 0;
  return (
    <Tooltip
      disableHoverableContent={true}
      open={sliceAt === 0 ? false : undefined}
    >
      <TooltipTrigger className="min-w-0">
        <div {...props} className={cn('flex min-w-0 items-center gap-1', className)}>
          {parts.slice(-sliceAt).map((str, index) => {
            return (
              <div
                className="flex min-w-0 items-center gap-1"
                key={str + (index as number)}
              >
                {index !== 0 && (
                  <ChevronRight className="relative top-[0.9px] !h-3 !w-3 flex-shrink-0" />
                )}
                {str.includes('[*]') ? (
                  <>
                    <span className="min-w-0 truncate">{str.replace('[*]', '')}</span>
                    <Asterisk className="relative top-[0.9px] !h-3 !w-3 flex-shrink-0" />
                  </>
                ) : str === '*' ? (
                  <Asterisk className="relative top-[0.9px] !h-3 !w-3 flex-shrink-0" />
                ) : (
                  <span className="min-w-0 truncate">{str}</span>
                )}
              </div>
            );
          })}
        </div>
      </TooltipTrigger>
      <TooltipContent align="start">
        <p>{children}</p>
      </TooltipContent>
    </Tooltip>
  );
}
