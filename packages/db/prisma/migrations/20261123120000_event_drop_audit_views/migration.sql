-- Additive only: two new tables, no changes to existing ones.

-- CreateTable
CREATE TABLE "event_drop_audit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'OpenPanel admin',
    "requestedBy" TEXT,
    "chatUrl" TEXT,
    "boardsAffected" JSONB NOT NULL DEFAULT '[]',
    "slackPosted" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_drop_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_views" (
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "lastViewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "viewCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "resource_views_pkey" PRIMARY KEY ("resourceType","resourceId")
);

-- CreateIndex
CREATE INDEX "event_drop_audit_projectId_createdAt_idx" ON "event_drop_audit"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "resource_views_projectId_idx" ON "resource_views"("projectId");

