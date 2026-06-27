import {
  CheckIcon,
  ClockIcon,
  CopyIcon,
  MoreHorizontal,
  PencilIcon,
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
    action: 'remove' | 'duplicate' | 'firstTimeFilter' | 'editCustomEvent'
  ) => void;
  firstTimeFilter?: boolean;
  hideFirstTimeFilter?: boolean;
  displayName?: string;
  displayNamePlaceholder?: string;
  onDisplayNameChange?: (value: string) => void;
  showEditCustomEvent?: boolean;
}

export function ReportEventMore({
  onClick,
  firstTimeFilter,
  hideFirstTimeFilter,
  displayName,
  displayNamePlaceholder,
  onDisplayNameChange,
  showEditCustomEvent,
}: ReportEventMoreProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost">
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
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={() => onClick('duplicate')}>
            <CopyIcon className="mr-2 h-4 w-4" />
            Duplicate
            <DropdownMenuShortcut>⌘⌫</DropdownMenuShortcut>
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
