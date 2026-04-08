import EventDropManager from '@/components/settings/event-drop-manager';
import { useAppParams } from '@/hooks/use-app-params';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/settings/_tabs/events',
)({
  component: Component,
});

function Component() {
  const { projectId } = useAppParams();
  return <EventDropManager projectId={projectId} />;
}
