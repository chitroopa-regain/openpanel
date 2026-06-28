ALTER TABLE "dashboards"
  ADD COLUMN "dashboardRange" TEXT,
  ADD COLUMN "dashboardStartDate" TEXT,
  ADD COLUMN "dashboardEndDate" TEXT,
  ADD COLUMN "dashboardDateConfig" JSONB;
