import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc/react';
import type { RouterInputs } from '@/trpc/client';

export function useEventNames(params: {
  projectId: string;
  anyEvents?: boolean;
  screenshotContexts?: RouterInputs['chart']['events']['screenshotContexts'];
}) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.chart.events.queryOptions(
      {
        projectId: params.projectId,
        screenshotContexts: params.screenshotContexts,
      },
      {
        enabled: !!params.projectId,
        // Refresh before Regain's ten-minute signed screenshot URLs expire.
        staleTime: 1000 * 60 * 4,
        refetchInterval: 1000 * 60 * 4,
      }
    )
  );
  return (query.data ?? []).filter((event) =>
    (params.anyEvents ?? true) ? true : event.name !== '*'
  );
}
