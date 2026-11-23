-- Additive only: three new tables, no changes to existing ones.

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
    "replayRequestId" UUID,
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

-- CreateTable
CREATE TABLE "event_replay_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "from_ts" TIMESTAMPTZ(3) NOT NULL,
    "to_ts" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "copied" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_replay_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_drop_audit_projectId_createdAt_idx" ON "event_drop_audit"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "resource_views_projectId_idx" ON "resource_views"("projectId");

-- CreateIndex
CREATE INDEX "event_replay_requests_status_created_at_idx" ON "event_replay_requests"("status", "created_at");
