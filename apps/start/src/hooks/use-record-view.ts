import { useTRPC } from '@/integrations/trpc/react';
import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';

/**
 * Records that a board or report was opened, once per mount. Feeds "Last
 * viewed" and active/idle on Settings → Events. Failures are ignored.
 */
export function useRecordView(
  projectId: string | undefined,
  resourceType: 'dashboard' | 'report',
  resourceId: string | undefined
) {
  const trpc = useTRPC();
  const { mutate } = useMutation(trpc.event.recordView.mutationOptions());
  useEffect(() => {
    if (projectId && resourceId) {
      mutate({ projectId, resourceType, resourceId });
    }
  }, [projectId, resourceType, resourceId, mutate]);
}
