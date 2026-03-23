import { createRouter as createTanstackRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import * as TanstackQuery from './integrations/tanstack-query/root-provider';

import { routeTree } from './routeTree.gen';
import { getServerEnvs } from './server/get-envs';

export const getRouter = async () => {
  const isDev = process.env.NODE_ENV === 'development';
  const envs = isDev
    ? {
        apiUrl: String(process.env.API_URL || 'http://localhost:3333'),
        dashboardUrl: String(process.env.DASHBOARD_URL || 'http://localhost:3100'),
        isSelfHosted: process.env.SELF_HOSTED !== undefined,
        isMaintenance: process.env.MAINTENANCE === '1',
        isDemo: process.env.DEMO_USER_ID !== undefined,
      }
    : await getServerEnvs();
  const rqContext = TanstackQuery.getContext(envs.apiUrl);

  const router = createTanstackRouter({
    routeTree,
    context: {
      ...rqContext,
      ...envs,
    },
    defaultPreload: 'intent',
    defaultSsr: !isDev,
    Wrap: (props: { children: React.ReactNode }) => {
      return (
        <TanstackQuery.Provider {...rqContext} apiUrl={envs.apiUrl}>
          {props.children}
        </TanstackQuery.Provider>
      );
    },
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient: rqContext.queryClient,
  });

  return router;
};

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
