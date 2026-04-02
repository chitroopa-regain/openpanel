import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CheckIcon, ClockIcon, CopyIcon, MoreHorizontal, TrashIcon } from 'lucide-react';
import * as React from 'react';

export interface ReportEventMoreProps {
  onClick: (action: 'remove' | 'duplicate' | 'firstTimeFilter') => void;
  firstTimeFilter?: boolean;
  hideFirstTimeFilter?: boolean;
}

export function ReportEventMore({ onClick, firstTimeFilter, hideFirstTimeFilter }: ReportEventMoreProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[200px]">
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
