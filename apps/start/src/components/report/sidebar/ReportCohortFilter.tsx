import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useAppParams } from '@/hooks/use-app-params';
import { useTRPC } from '@/integrations/trpc/react';
import { useDispatch, useSelector } from '@/redux';
import { cn } from '@/utils/cn';
import type { ICohortFilter } from '@openpanel/validation';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, MoreVerticalIcon, PlusIcon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import {
  COHORT_FILTER_UNSUPPORTED_CHART_TYPES,
  changeCohortFilters,
} from '../reportSlice';

/**
 * Report-level cohort filter — the "Filter" section, mirroring Mixpanel.
 *
 * One row reads "Users in <cohort>". Ids inside a row are OR-combined (adding a
 * cohort to a row WIDENS the population); rows AND together (adding a row
 * NARROWS it). Both directions are stated on screen, because a filter whose
 * composition you have to guess is worse than no filter.
 *
 * There is deliberately no per-metric cohort filter: membership is a property of
 * the profile, evaluated at one instant, so scoping it to a single metric,
 * funnel step or retention leg cannot change the answer.
 */
export function ReportCohortFilter() {
  const { projectId } = useAppParams();
  const trpc = useTRPC();
  const dispatch = useDispatch();
  const chartType = useSelector((state) => state.report.chartType);
  const rows = useSelector((state) => state.report.cohortFilters) ?? [];
  const supported = !COHORT_FILTER_UNSUPPORTED_CHART_TYPES.has(chartType);

  const cohortsQuery = useQuery(
    trpc.customCohort.list.queryOptions({ projectId }),
  );
  const cohorts = cohortsQuery.data ?? [];
  const nameOf = (id: string) =>
    cohorts.find((cohort) => cohort.id === id)?.name ?? id;

  const setRows = (next: ICohortFilter[]) =>
    dispatch(changeCohortFilters(next.length ? next : undefined));

  const updateRow = (index: number, row: ICohortFilter) =>
    setRows(rows.map((existing, i) => (i === index ? row : existing)));

  const removeRow = (index: number) =>
    setRows(rows.filter((_, i) => i !== index));

  // Disabled with the reason, never hidden. A missing control reads as a bug;
  // a disabled one with an explanation reads as a limitation.
  if (!supported) {
    return (
      <div>
        <h3 className="mb-2 font-medium">Filter</h3>
        <div className="rounded-md border border-dashed p-3 text-muted-foreground text-sm">
          Cohort filters aren't applied on {chartType} reports, so they can't be
          set here.
        </div>
      </div>
    );
  }

  return (
    <div data-testid="report-cohort-filter">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-medium">Filter</h3>
        <CohortPicker
          cohorts={cohorts}
          onSelect={(cohortId) =>
            setRows([...rows, { operator: 'in', cohortIds: [cohortId] }])
          }
          trigger={
            <Button size="icon" variant="ghost" aria-label="Add cohort filter">
              <PlusIcon className="h-4 w-4" />
            </Button>
          }
        />
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          Restrict every metric in this report to the users in a cohort.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((row, index) => (
            <div
              className="flex items-center gap-2 rounded-md border p-2 text-sm"
              // Rows are positional and may repeat a cohort with a different
              // operator, so the index IS the identity here.
              key={`cohort-filter-row-${index}`}
            >
              <UsersIcon className="h-4 w-4 shrink-0 text-emerald-500" />
              <span className="flex-1 truncate">
                Users {row.operator === 'not_in' ? 'not in' : 'in'}{' '}
                {row.cohortIds.map(nameOf).join(' or ')}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label="Cohort filter options"
                    size="icon"
                    variant="ghost"
                  >
                    <MoreVerticalIcon className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => updateRow(index, { ...row, operator: 'in' })}
                  >
                    <CheckIcon
                      className={cn(
                        'mr-2 h-3 w-3',
                        row.operator === 'not_in' && 'opacity-0',
                      )}
                    />
                    In cohort
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      updateRow(index, { ...row, operator: 'not_in' })
                    }
                  >
                    <CheckIcon
                      className={cn(
                        'mr-2 h-3 w-3',
                        row.operator !== 'not_in' && 'opacity-0',
                      )}
                    />
                    Not in cohort
                  </DropdownMenuItem>
                  <CohortPicker
                    cohorts={cohorts}
                    onSelect={(cohortId) =>
                      updateRow(index, {
                        ...row,
                        cohortIds: row.cohortIds.includes(cohortId)
                          ? row.cohortIds.filter((id) => id !== cohortId)
                          : [...row.cohortIds, cohortId],
                      })
                    }
                    selected={row.cohortIds}
                    trigger={
                      <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                        Add cohort to this row (or)
                      </DropdownMenuItem>
                    }
                  />
                  <DropdownMenuItem onClick={() => removeRow(index)}>
                    Remove
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
          {rows.length > 1 && (
            <p className="text-muted-foreground text-xs">
              A user must match every row.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CohortPicker({
  cohorts,
  onSelect,
  selected = [],
  trigger,
}: {
  cohorts: Array<{ id: string; name: string }>;
  onSelect: (cohortId: string) => void;
  selected?: string[];
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search cohorts" />
          <CommandList>
            <CommandEmpty>No cohorts yet.</CommandEmpty>
            <CommandGroup>
              {cohorts.map((cohort) => (
                <CommandItem
                  key={cohort.id}
                  onSelect={() => {
                    onSelect(cohort.id);
                    setOpen(false);
                  }}
                  value={cohort.name}
                >
                  <CheckIcon
                    className={cn(
                      'mr-2 h-3 w-3',
                      !selected.includes(cohort.id) && 'opacity-0',
                    )}
                  />
                  {cohort.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
