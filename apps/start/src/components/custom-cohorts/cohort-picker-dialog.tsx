import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAppParams } from '@/hooks/use-app-params';
import { useTRPC } from '@/integrations/trpc/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PlusIcon, TargetIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/utils/cn';

/** Matches the server-side cap in zCohortBreakdown. */
const MAX_COHORTS = 5;

/**
 * Picks the cohorts a report is broken down by — one chart series per cohort.
 * Cohorts overlap, so a user in two of them is counted in both series; that is
 * intended and stated in the dialog so nobody reads the totals as a partition.
 */
export function CohortPickerDialog({
  open,
  onOpenChange,
  value,
  onConfirm,
  title,
  operator,
  onOperatorChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string[];
  onConfirm: (cohortIds: string[]) => void;
  title?: string;
  /** Present only for FILTER use; the breakdown has no polarity to choose. */
  operator?: 'in' | 'not_in';
  onOperatorChange?: (operator: 'in' | 'not_in') => void;
}) {
  const { organizationId, projectId } = useAppParams();
  const trpc = useTRPC();
  const [selected, setSelected] = useState<string[]>(value);

  useEffect(() => {
    if (open) setSelected(value);
  }, [open, value]);

  const cohortsQuery = useQuery(
    trpc.customCohort.list.queryOptions({ projectId })
  );
  const cohorts = cohortsQuery.data ?? [];

  const toggle = (id: string) => {
    setSelected((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length >= MAX_COHORTS
          ? prev
          : // append, so selection ORDER is preserved — it becomes series order
            [...prev, id]
    );
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title ?? 'Break down by custom cohort'}</DialogTitle>
        </DialogHeader>

        {operator ? (
          <>
            <div className="flex gap-2" data-testid="cohort-operator">
              {(['in', 'not_in'] as const).map((op) => (
                <Button
                  key={op}
                  data-testid={`cohort-operator-${op}`}
                  onClick={() => onOperatorChange?.(op)}
                  size="sm"
                  variant={operator === op ? 'default' : 'outline'}
                >
                  {op === 'in' ? 'In cohort' : 'Not in cohort'}
                </Button>
              ))}
            </div>
            <p className="text-muted-foreground text-sm">
              {operator === 'in'
                ? 'Only users in these cohorts are counted.'
                : 'Users in these cohorts are excluded.'}{' '}
              Picking several cohorts matches anyone in <strong>any</strong> of
              them, so adding one widens the group rather than narrowing it.
            </p>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            Two series per cohort — in it and not in it. A user in several
            cohorts is counted in each, so the series will not add up to your
            total.
          </p>
        )}

        {cohorts.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
            No cohorts yet.
          </div>
        ) : (
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto" data-testid="cohort-picker-list">
            {cohorts.map((cohort) => {
              const checked = selected.includes(cohort.id);
              const atLimit = !checked && selected.length >= MAX_COHORTS;
              // A div, not a button: Checkbox renders its own <button>, and
              // nesting one inside another is invalid HTML and breaks hydration.
              return (
                <div
                  aria-disabled={atLimit}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md border p-3 text-left',
                    atLimit && 'pointer-events-none opacity-50'
                  )}
                  key={cohort.id}
                  onClick={() => toggle(cohort.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') toggle(cohort.id);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <Checkbox checked={checked} tabIndex={-1} />
                  <TargetIcon className="h-4 w-4 shrink-0 text-violet-500" />
                  <span className="flex-1 truncate">{cohort.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {cohort.lastCount === null
                      ? 'not evaluated'
                      : `${cohort.lastCount.toLocaleString()} users`}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter className="items-center justify-between gap-2 sm:justify-between">
          <Link
            className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
            data-testid="create-cohort-link"
            params={{ organizationId, projectId }}
            // ?new=1 opens the create dialog on arrival — landing on the list
            // and making the user hunt for the button defeats the link.
            search={{ new: 1 }}
            to="/$organizationId/$projectId/settings/custom-cohorts"
          >
            <PlusIcon className="h-4 w-4" />
            Create cohort
          </Link>
          <div className="flex gap-2">
            <Button onClick={() => onOpenChange(false)} variant="outline">
              Cancel
            </Button>
            <Button
              data-testid="cohort-picker-apply"
              onClick={() => {
                onConfirm(selected);
                onOpenChange(false);
              }}
            >
              Apply
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
