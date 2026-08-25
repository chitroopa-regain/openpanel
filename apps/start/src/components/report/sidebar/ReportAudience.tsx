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
/**
 * Chart types whose query path applies the audience. Anything else would accept
 * a cohort and silently ignore it — the exact failure this feature exists to
 * prevent — so the picker is disabled with a reason instead.
 */
export const AUDIENCE_SUPPORTED_CHART_TYPES = new Set([
  'linear',
  'bar',
  'area',
  'pie',
  'metric',
  'table',
  'map',
  'histogram',
  'funnel',
  'funnel_metric',
  'retention',
]);

export function ReportAudience() {
  const { projectId } = useAppParams();
  const trpc = useTRPC();
  const dispatch = useDispatch();
  const audience = useSelector((state) => state.report.audience);
  const chartType = useSelector((state) => state.report.chartType);
  const supported = AUDIENCE_SUPPORTED_CHART_TYPES.has(chartType);

  const cohortsQuery = useQuery(
    trpc.customCohort.list.queryOptions({ projectId })
  );
  const cohorts = cohortsQuery.data ?? [];
  const selected = audience?.cohortIds ?? [];

  // The Audience section is retired in favour of cohort breakdown. It is hidden
  // for reports that do not have one — but a report that DOES carry an audience
  // keeps filtering, so hiding it outright would show filtered numbers with no
  // indication anywhere that a filter is applied. Those reports get a read-only
  // notice and a Clear action instead.
  if (selected.length === 0) {
    return null;
  }

  if (!supported) {
    return (
      <div>
        <h3 className="mb-2 font-medium">Audience</h3>
        <div className="rounded-md border border-dashed p-3 text-muted-foreground text-sm">
          Audiences aren't supported on this chart type yet.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3 className="mb-2 font-medium">Audience</h3>
      <p className="mb-2 text-muted-foreground text-xs">
        This report was built with the older Audience filter. It still filters
        the results.
      </p>

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


    </div>
  );
}
