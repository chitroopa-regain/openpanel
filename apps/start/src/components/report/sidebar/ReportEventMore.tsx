import {
  CheckIcon,
  ClockIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  MoreHorizontal,
  PencilIcon,
  TargetIcon,
  TrashIcon,
} from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';

export interface ReportEventMoreProps {
  onClick: (
    action:
      | 'remove'
      | 'duplicate'
      | 'firstTimeFilter'
      | 'editCustomEvent'
      | 'toggleHidden'
      | 'cohortFilter'
  ) => void;
  firstTimeFilter?: boolean;
  hideFirstTimeFilter?: boolean;
  /** Number of cohorts on this metric's inline filter; 0 when none. */
  cohortFilterCount?: number;
  /** When set, the cohort filter entry is disabled and shows this reason. */
  cohortFilterDisabledReason?: string;
  hideCohortFilter?: boolean;
  displayName?: string;
  displayNamePlaceholder?: string;
  onDisplayNameChange?: (value: string) => void;
  showEditCustomEvent?: boolean;
  triggerClassName?: string;
  hidden?: boolean;
}

export function ReportEventMore({
  onClick,
  firstTimeFilter,
  hideFirstTimeFilter,
  displayName,
  displayNamePlaceholder,
  onDisplayNameChange,
  showEditCustomEvent,
  triggerClassName,
  hidden,
  cohortFilterCount,
  cohortFilterDisabledReason,
  hideCohortFilter,
}: ReportEventMoreProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <Button
          className={triggerClassName}
          data-testid="metric-more-trigger"
          size="sm"
          variant="ghost"
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[240px]">
        {onDisplayNameChange && (
          <>
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Display name
            </DropdownMenuLabel>
            <div className="px-2 pb-2">
              <Input
                className="h-8"
                defaultValue={displayName}
                onChange={(event) => onDisplayNameChange(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                placeholder={displayNamePlaceholder ?? 'Optional display name'}
              />
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuGroup>
          {!hideFirstTimeFilter && (
            <>
              <DropdownMenuItem onClick={() => onClick('firstTimeFilter')}>
                <ClockIcon className="mr-2 h-4 w-4" />
                First Time Filter
                {firstTimeFilter && (
                  <DropdownMenuShortcut>
                    <CheckIcon className="h-4 w-4" />
                  </DropdownMenuShortcut>
                )}
              </DropdownMenuItem>
            </>
          )}
          {!hideCohortFilter && (
            <DropdownMenuItem
              data-testid="metric-cohort-filter"
              disabled={!!cohortFilterDisabledReason}
              title={cohortFilterDisabledReason}
              onClick={(e) => {
                if (cohortFilterDisabledReason) {
                  e.preventDefault();
                  return;
                }
                onClick('cohortFilter');
              }}
            >
              <TargetIcon className="mr-2 h-4 w-4" />
              <span className="min-w-0">
                Cohort Filter
                {cohortFilterDisabledReason ? (
                  <span className="block text-muted-foreground text-xs">
                    {cohortFilterDisabledReason}
                  </span>
                ) : null}
              </span>
              {!cohortFilterDisabledReason && (cohortFilterCount ?? 0) > 0 && (
                <DropdownMenuShortcut>{cohortFilterCount}</DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onClick('duplicate')}>
            <CopyIcon className="mr-2 h-4 w-4" />
            Duplicate
            <DropdownMenuShortcut>⌘⌫</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onClick('toggleHidden')}>
            {hidden ? (
              <EyeIcon className="mr-2 h-4 w-4" />
            ) : (
              <EyeOffIcon className="mr-2 h-4 w-4" />
            )}
            {hidden ? 'Show Metric' : 'Hide Metric'}
          </DropdownMenuItem>
          {showEditCustomEvent && (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setOpen(false);
                requestAnimationFrame(() => {
                  onClick('editCustomEvent');
                });
              }}
            >
              <PencilIcon className="mr-2 h-4 w-4" />
              Edit custom event
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className="text-red-600"
            onClick={() => onClick('remove')}
          >
            <TrashIcon className="mr-2 h-4 w-4" />
            Delete
            <DropdownMenuShortcut>⌘⌫</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
