import { cn } from '@/utils/cn';
import type { LucideIcon } from 'lucide-react';

import { ProjectLink } from '@/components/links';
import { Tooltiper } from '@/components/ui/tooltip';

export function SidebarLink({
  href,
  icon: Icon,
  label,
  className,
  exact,
  compact = false,
}: {
  href: string;
  icon: LucideIcon;
  label: React.ReactNode;
  className?: string;
  exact?: boolean;
  compact?: boolean;
}) {
  const link = (
    <ProjectLink
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-2 font-medium transition-all hover:bg-def-200 text-[13px]',
        compact &&
          'lg:justify-center lg:px-0 lg:py-2.5 lg:[&_svg]:mx-auto',
        className,
      )}
      href={href}
      exact={exact}
    >
      <Icon size={20} />
      <div className={cn('flex-1', compact && 'lg:hidden')}>{label}</div>
    </ProjectLink>
  );

  if (!compact) return link;

  return (
    <Tooltiper align="center" asChild content={label} side="right">
      {link}
    </Tooltiper>
  );
}
