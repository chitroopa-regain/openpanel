import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/$organizationId/$projectId/')({
  component: Component,
  beforeLoad({ params }) {
    throw redirect({
      to: '/$organizationId/$projectId/dashboards',
      params,
    });
  },
});

function Component() {
  return null;
}
