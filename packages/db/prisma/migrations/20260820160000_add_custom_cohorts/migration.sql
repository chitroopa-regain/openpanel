-- CreateTable
CREATE TABLE "custom_cohorts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "projectId" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "evaluation" TEXT NOT NULL DEFAULT 'unclassified',
    "lastCount" INTEGER,
    "lastEvaluatedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_cohort_references" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cohortId" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_cohort_references_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "reports" ADD COLUMN "audience" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "custom_cohorts_name_projectId_key" ON "custom_cohorts"("name", "projectId");
CREATE UNIQUE INDEX "custom_cohort_references_cohortId_reportId_key" ON "custom_cohort_references"("cohortId", "reportId");
CREATE INDEX "custom_cohort_references_reportId_idx" ON "custom_cohort_references"("reportId");

-- AddForeignKey
ALTER TABLE "custom_cohorts" ADD CONSTRAINT "custom_cohorts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "custom_cohort_references" ADD CONSTRAINT "custom_cohort_references_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "custom_cohorts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "custom_cohort_references" ADD CONSTRAINT "custom_cohort_references_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
