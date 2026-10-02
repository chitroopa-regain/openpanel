import type { Dashboard, Prisma } from '../prisma-client';
import { db } from '../prisma-client';

export type IServiceDashboard = Dashboard;
// The sidebar and dashboards list only show each dashboard's reports by name
// and type. Returning full report rows (series, filters, options for 1,000+
// reports) made this list 1.3 MB, refetched on every page.
const dashboardListReportSelect = {
  id: true,
  name: true,
  chartType: true,
} as const;

export type IServiceDashboards = Prisma.DashboardGetPayload<{
  include: {
    reports: { select: typeof dashboardListReportSelect };
  };
}>[];

export async function getDashboardById(id: string, projectId: string) {
  const dashboard = await db.dashboard.findUnique({
    where: {
      id,
      projectId,
    },
    include: {
      project: true,
    },
  });

  if (!dashboard) {
    return null;
  }

  return dashboard;
}

export function getDashboardsByProjectId(projectId: string) {
  return db.dashboard.findMany({
    where: {
      projectId,
    },
    include: {
      reports: { select: dashboardListReportSelect },
    },
    orderBy: [
      { pinnedAt: { sort: 'desc', nulls: 'last' } },
      { updatedAt: 'desc' },
    ],
  });
}
