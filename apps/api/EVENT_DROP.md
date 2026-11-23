# Event drop (Settings → Events and /manage API): deploy runbook

Drop = event name in the Redis set `op:dropped:<projectId>` + `event_meta.droppedAt`.
Jitsu ingest reads that set every 5 s and sends dropped track/screen events to the
Kafka topic `destination-messages-short` (24 h). ClickHouse history is never deleted.

## What ships

- Postgres migration `20261123120000_event_drop_audit_views_replays` (additive: three new
  tables `event_drop_audit`, `resource_views`, `event_replay_requests`; nothing existing changes).
- api: REST routes under `/manage` (below), tRPC `event.managedEvents | eventDropAudit |
  dropEvent | undropEvent | recordView`. `event.clearDroppedEvent` is gone.
- start (dashboard): new Settings → Events page; boards and reports record a view on open.
- worker: nothing.

## Env (api container)

| Variable | Needed | Effect |
|---|---|---|
| `OPENPANEL_ADMIN_API_TOKEN` | for the REST API | `Authorization: Bearer <token>`; unset = every `/manage/.../events`, `/audit`, `/replays` request is 401. The UI does not need it. |
| `OPENPANEL_SLACK_WEBHOOK_URL` | optional | Slack incoming webhook for #analytics; unset = no post (audit `slackPosted` stays empty). |
| `DASHBOARD_URL` | already set | Base of the board/report links in "Used in" and Slack. |

Never print the token; keep it in the Maker vault / server env only.

## Order

1. Back up nothing extra: the migration only creates tables.
2. Run Prisma migrations (`pnpm migrate:deploy` from the image / migrate job, as for any release).
3. Deploy api (needs the new tables; the new routes 401 until the token is set).
4. Deploy start (the page calls the new tRPC procedures).
5. Set `OPENPANEL_ADMIN_API_TOKEN` and `OPENPANEL_SLACK_WEBHOOK_URL` on the api container, restart api.
6. Volume columns read ClickHouse `event_name_daily` (built by the regainapp rollup job). Until it
   exists the page shows "—" and works otherwise; no deploy order between the two.
7. Replay worker (regainapp, on a Kafka node) reads `event_replay_requests` where `status='pending'`.
   It must not start a request before its `to_ts` (to_ts = undrop time + 30 s, so ingest has
   picked up the undrop). `from_ts` = drop time (taken before the Redis write), clamped to the
   last 24 h.

## REST API

All need `Authorization: Bearer $OPENPANEL_ADMIN_API_TOKEN`.

- `GET  /manage/projects/:projectId/events?filter=all|unused|used|dropped|protected|unused_high&q=`
- `POST /manage/projects/:projectId/events/drop` `{name, confirmName, reason?, source:"UI"|"Agent", requestedBy?, chatUrl?}`
  → 400 confirm mismatch / already dropped / bad input, 403 protected, 409 used and no reason, 404 project.
  `requestedBy` is required when `source` is `Agent`.
- `POST /manage/projects/:projectId/events/undrop` `{name, confirmName, replay, source, requestedBy?, chatUrl?, reason?}` → `{replayRequestId|null, ...}`
- `GET  /manage/replays/:id` → `{status, copied, error, ...}`
- `GET  /manage/projects/:projectId/audit?limit=`

## Rollback

Redeploy the previous api/start images. The three tables can stay (nothing else reads them).
Events dropped meanwhile stay in the Redis set; undrop them first (or remove the names from
`op:dropped:<projectId>` and clear `event_meta.droppedAt`) if the old UI must show them active.
