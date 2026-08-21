import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppParams } from '@/hooks/use-app-params';
import { useTRPC } from '@/integrations/trpc/react';
import { useDispatch, useSelector } from '@/redux';
import { useQuery } from '@tanstack/react-query';
import { TargetIcon, XIcon } from 'lucide-react';
import { changeAudience } from '../reportSlice';

/**
 * Report-level audience. A cohort is applied ONCE to the base population of
 * every series, not per series — one audience for the whole report.
 */
export function ReportAudience() {
  const { projectId } = useAppParams();
  const trpc = useTRPC();
  const dispatch = useDispatch();
  const audience = useSelector((state) => state.report.audience);

  const cohortsQuery = useQuery(
    trpc.customCohort.list.queryOptions({ projectId })
  );
  const cohorts = cohortsQuery.data ?? [];
  const selected = audience?.cohortIds ?? [];

  return (
    <div>
      <h3 className="mb-2 font-medium">Audience</h3>

      {selected.length > 0 && (
        <div className="mb-2 flex flex-col gap-1" data-testid="audience-selected">
          {selected.map((id) => {
            const cohort = cohorts.find((c) => c.id === id);
            return (
              <div
                className="flex items-center gap-2 rounded-md border p-2 text-sm"
                key={id}
              >
                <TargetIcon className="h-4 w-4 shrink-0 text-violet-500" />
                <span className="flex-1 truncate">{cohort?.name ?? id}</span>
                <Button
                  onClick={() =>
                    dispatch(changeAudience(selected.filter((s) => s !== id)))
                  }
                  size="icon"
                  variant="ghost"
                >
                  <XIcon className="h-3 w-3" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <Select
        onValueChange={(id) => {
          if (!selected.includes(id)) {
            dispatch(changeAudience([...selected, id]));
          }
        }}
        value=""
      >
        <SelectTrigger data-testid="audience-select">
          <SelectValue placeholder="All users" />
        </SelectTrigger>
        <SelectContent>
          {cohorts.length === 0 ? (
            <SelectItem disabled value="__none">
              No cohorts — create one in Settings
            </SelectItem>
          ) : (
            cohorts
              .filter((c) => !selected.includes(c.id))
              .map((cohort) => (
                <SelectItem key={cohort.id} value={cohort.id}>
                  {cohort.name}
                </SelectItem>
              ))
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
