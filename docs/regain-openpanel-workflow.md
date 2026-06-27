# Regain OpenPanel workflow

This document is for Hermes Agent and Regain team members making changes to the Regain OpenPanel fork.

## Source of truth

- Repository checkout on this host: `/root/openpanel`
- GitHub repo: `chitroopa-regain/openpanel`
- Deployment branch/tag: `dashboard-plus`
- Do **not** work from an unrelated standalone fork or from upstream `openpanel-dev` unless explicitly asked.
- The `regainapp.ai` repo contains deployment manifests and historical helper scripts, but OpenPanel application code is in `/root/openpanel`.

Before changing code:

```bash
cd /root/openpanel
git remote -v
git status --short --branch
git fetch origin dashboard-plus
git switch dashboard-plus
git pull --ff-only origin dashboard-plus
```

If the checkout is dirty or someone else is working there, create a worktree instead of overwriting local work:

```bash
git fetch origin dashboard-plus
git worktree add -B <your-branch> /root/projects/regainapp.ai/server/jitsu/openpanel-worktrees/<your-branch> origin/dashboard-plus
cd /root/projects/regainapp.ai/server/jitsu/openpanel-worktrees/<your-branch>
```

For small urgent fixes that Nizam wants deployed immediately, commit directly to `dashboard-plus` after tests. For larger/riskier work, use a branch/PR, then land the intended product commit on `dashboard-plus` before deployment.

## Deployment model

Both staging and prod use images built from the `dashboard-plus` branch.

The relevant GitHub Actions workflow is:

```text
.github/workflows/ghcr-build.yml
```

It publishes:

```text
ghcr.io/chitroopa-regain/openpanel-api:dashboard-plus
ghcr.io/chitroopa-regain/openpanel-worker:dashboard-plus
ghcr.io/chitroopa-regain/openpanel-dashboard:dashboard-plus
ghcr.io/chitroopa-regain/openpanel-api:dashboard-plus-swr
ghcr.io/chitroopa-regain/openpanel-worker:dashboard-plus-swr
ghcr.io/chitroopa-regain/openpanel-dashboard:dashboard-plus-swr
```

The deployment hosts currently pull the `dashboard-plus-swr` tags.

There is also an inherited upstream workflow:

```text
.github/workflows/docker-build.yml
```

That workflow may try to push `ghcr.io/openpanel-dev/*` and can fail with `403 Forbidden` from this fork. Do **not** treat that as a Regain deploy blocker unless Nizam explicitly asks to fix upstream publishing. The Regain deploy path is the `Build and Push to GHCR` workflow above.

## Staging and prod hosts

Staging:

```text
Public URL: https://openpanel.regainapp.ai
SSH host: jitsu-dashboard1-regain
Compose dir: /root/regainapp.ai/server/jitsu/ha_setup/dashboard-1
```

Prod:

```text
Public URL: https://openpanel-prod.regainapp.ai
SSH host: jitsu-prod-dashboard1-regain
Compose dir: /root/regainapp.ai/server/jitsu/prod_ha_setup/dashboard-1
```

Both are reachable over Tailscale from this Hermes host. SSH as root generally works without specifying a key:

```bash
ssh root@jitsu-dashboard1-regain hostname
ssh root@jitsu-prod-dashboard1-regain hostname
```

## Normal change workflow

1. Start from fresh `dashboard-plus`:

   ```bash
   cd /root/openpanel
   git fetch origin dashboard-plus
   git switch dashboard-plus
   git pull --ff-only origin dashboard-plus
   ```

2. Make the code change.

3. Run targeted tests/checks. Use the narrowest meaningful checks for the touched area, then broader checks when practical.

   Examples used for retention-chart work:

   ```bash
   pnpm install --frozen-lockfile
   pnpm codegen
   pnpm --filter @openpanel/trpc test -- --run chart-retention.utils.test.ts
   pnpm exec biome check <changed-files>
   git diff --check
   ```

   Notes:
   - Local Redis may be absent. Some tests log `ECONNREFUSED 127.0.0.1:6379` warnings but can still pass. Trust the test exit code.
   - Repo-wide typecheck can fail on unrelated existing JSON/Prisma typing areas; if that happens, grep for changed file paths and report unrelated failures clearly.

4. Commit and push to `dashboard-plus` when the change is meant to deploy:

   ```bash
   git status --short --branch
   git add <files>
   git commit -m "fix(scope): concise message"
   git push origin dashboard-plus
   ```

   If push is rejected because someone else pushed first:

   ```bash
   git fetch origin dashboard-plus
   git rebase origin/dashboard-plus
   # re-run targeted tests
   git push origin dashboard-plus
   ```

5. Wait for the Regain image build:

   ```bash
   gh run list --branch dashboard-plus --limit 10 \
     --json databaseId,name,status,conclusion,headSha,url \
     | jq -r '.[] | [.databaseId,.name,.status,(.conclusion//""),.headSha[0:8],.url] | @tsv'
   ```

   The required run is `Build and Push to GHCR`. It must complete with `success` for the commit being deployed.

## Deploy to staging and prod

After `Build and Push to GHCR` succeeds for the `dashboard-plus` commit, deploy both hosts.

Staging:

```bash
ssh root@jitsu-dashboard1-regain '
  set -euo pipefail
  cd /root/regainapp.ai/server/jitsu/ha_setup/dashboard-1
  docker compose --env-file /etc/infisical/secrets/.env pull openpanel-api openpanel-worker openpanel-dashboard
  docker compose --env-file /etc/infisical/secrets/.env up -d --no-deps --force-recreate openpanel-api openpanel-worker openpanel-dashboard
'
```

Prod:

```bash
ssh root@jitsu-prod-dashboard1-regain '
  set -euo pipefail
  cd /root/regainapp.ai/server/jitsu/prod_ha_setup/dashboard-1
  docker compose --env-file /etc/infisical/secrets/.env pull openpanel-api openpanel-worker openpanel-dashboard
  docker compose --env-file /etc/infisical/secrets/.env up -d --no-deps --force-recreate openpanel-api openpanel-worker openpanel-dashboard
'
```

## Verify deployment

Run on each host after recreation:

```bash
cd <compose-dir>
for i in $(seq 1 24); do
  api=$(docker inspect -f '{{.State.Health.Status}}' $(docker compose --env-file /etc/infisical/secrets/.env ps -q openpanel-api) 2>/dev/null || echo none)
  worker=$(docker inspect -f '{{.State.Health.Status}}' $(docker compose --env-file /etc/infisical/secrets/.env ps -q openpanel-worker) 2>/dev/null || echo none)
  dash=$(docker inspect -f '{{.State.Status}}' $(docker compose --env-file /etc/infisical/secrets/.env ps -q openpanel-dashboard) 2>/dev/null || echo none)
  [ "$api" = healthy ] && [ "$worker" = healthy ] && [ "$dash" = running ] && break
  sleep 5
done

docker compose --env-file /etc/infisical/secrets/.env ps --format '{{.Name}} {{.Image}} {{.Status}}' | grep openpanel
docker inspect --format '{{.Name}} {{.Image}}' $(docker compose --env-file /etc/infisical/secrets/.env ps -q openpanel-api openpanel-worker openpanel-dashboard)
curl -sS -o /dev/null -w 'localhost:8080/healthz %{http_code}\n' http://localhost:8080/healthz
```

From the Hermes host verify the public pages:

```bash
curl -sS -I -L --max-time 20 https://openpanel.regainapp.ai | sed -n '1,12p'
curl -sS -I -L --max-time 20 https://openpanel-prod.regainapp.ai | sed -n '1,12p'
```

Expected public behavior is usually `307 -> /login -> 200`.

Also confirm staging and prod API/dashboard/worker image IDs match. If they differ, one host did not deploy the same build.

## Retention/property metric semantics

For retention charts, be explicit about the metric being calculated.

- `Retention Rate`: retained users divided by cohort size.
- `Unique Users`: retained users count.
- `Property Sum`: sum of the selected property on matching return-event rows.
- `Property Average`: ARPU-style value for the retention bucket, not average purchase/order value.

For `Property Average` with revenue, calculate:

```text
sum(selected revenue property for matching return events in bucket)
/
full cohort user count
```

Do **not** calculate `avg(property)` only across users/events that purchased. That shows average order value among purchasers and can be much larger than ARPU. Example: if 100 users purchase ₹299 in a cohort of 6,664 installs, ARPU is `29900 / 6664 = ₹4.49`, not ₹299.

The current retention helper test is:

```bash
pnpm --filter @openpanel/trpc test -- --run chart-retention.utils.test.ts
```

## Manual image fallback

Use this only if GitHub push/Actions is blocked and Nizam explicitly wants a manual hotfix. Prefer the normal workflow above.

Build dashboard locally:

```bash
cd /root/openpanel
docker build -f apps/start/Dockerfile -t ghcr.io/chitroopa-regain/openpanel-dashboard:dashboard-plus-swr .
```

Stream to a host:

```bash
docker save ghcr.io/chitroopa-regain/openpanel-dashboard:dashboard-plus-swr \
  | gzip -1 \
  | ssh root@<host> 'gunzip | docker load'
```

Recreate dashboard only from the right compose dir:

```bash
docker compose --env-file /etc/infisical/secrets/.env up -d --no-deps --force-recreate openpanel-dashboard
```

Then verify status, image ID, local health, and public URL as above.

## Common pitfalls

- Do not make changes in an unrelated checkout when `/root/openpanel` is available.
- Do not assume `main`; Regain deploys from `dashboard-plus`.
- Do not stop after pushing code; wait for `Build and Push to GHCR`, deploy both staging and prod, then verify.
- Do not deploy only dashboard if API/worker code changed. Pull/recreate API, worker, and dashboard unless you are certain only dashboard changed.
- Do not call upstream `openpanel-dev` GHCR failures an app failure. Check the Regain GHCR workflow instead.
- Do not overwrite dirty work in the main checkout. Use a worktree.
- Do not report deployment success without concrete host status, image IDs, health checks, and public URL responses.
