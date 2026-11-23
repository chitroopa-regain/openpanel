import EventDropManager from '@/components/settings/event-drop-manager';
import { useAppParams } from '@/hooks/use-app-params';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/settings/_tabs/events',
)({
  // ?tab=dropped|events|audit, so a link opens the right tab. Default: events.
  validateSearch: z.object({
    tab: z.enum(['dropped', 'events', 'audit']).optional().catch(undefined),
  }),
  component: Component,
});

function Component() {
  const { projectId } = useAppParams();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <EventDropManager
      projectId={projectId}
      tab={tab ?? 'events'}
      onTabChange={(next) =>
        navigate({
          search: (prev) => ({ ...prev, tab: next === 'events' ? undefined : next }),
          replace: true,
        })
      }
    />
  );
}
