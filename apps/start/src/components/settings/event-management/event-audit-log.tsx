import { Badge } from '@/components/ui/badge';
import { cn } from '@/utils/cn';
import { ACTION_LABEL, type AuditRow, dateTime, shortCount } from './format';

function reasonText(row: AuditRow) {
  const parts: string[] = row.reason ? [row.reason] : [];
  if (row.action === 'drop_anyway' && row.boardsAffected.length > 0) {
    parts.push(
      `boards: ${row.boardsAffected
        .map((b) => `${b.name} (${b.active ? 'active' : 'idle'})`)
        .join(', ')}`
    );
  }
  if (row.replay) {
    parts.push(
      row.replay.status === 'done'
        ? `${shortCount(row.replay.copied)} events replayed`
        : row.replay.status === 'failed'
          ? `replay failed${row.replay.copied > 0 ? ` after ${shortCount(row.replay.copied)} copied` : ''}${row.replay.error ? `: ${row.replay.error}` : ''}`
          : `replay ${row.replay.status}`
    );
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

export function SourceCell({ row }: { row: AuditRow }) {
  if (row.source !== 'Agent') {
    return <span>UI</span>;
  }
  return (
    <span>
      Agent{' '}
      <span className="text-muted-foreground">
        (asked by {row.requestedBy ?? 'unknown'}
        {row.chatUrl && (
          <>
            ,{' '}
            <a
              href={row.chatUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:underline"
            >
              chat link
            </a>
          </>
        )}
        )
      </span>
    </span>
  );
}

function SlackCell({ posted }: { posted: boolean | null }) {
  if (posted === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return posted ? (
    <span className="text-muted-foreground">#analytics ✓</span>
  ) : (
    <span className="text-destructive">failed</span>
  );
}

export function EventAuditLog({
  rows,
  isLoading,
}: {
  rows: AuditRow[];
  isLoading: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full leading-normal min-w-[900px] text-sm">
          <thead>
            <tr className="border-b bg-def-100 text-left text-sm text-muted-foreground">
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Who</th>
              <th className="px-3 py-2 font-medium">Event</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Reason</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Slack</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                  {isLoading ? 'Loading…' : 'No drops or undrops yet.'}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-b align-top last:border-0">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {dateTime(row.createdAt)}
                </td>
                <td className="whitespace-nowrap px-3 py-2">{row.actor}</td>
                <td className="px-3 py-2 font-mono text-[13px]">
                  {row.eventName}
                </td>
                <td className="px-3 py-2">
                  <Badge
                    className={cn(
                      'border-transparent text-[12px]',
                      row.action.startsWith('undrop')
                        ? 'bg-emerald-500/15 text-emerald-500'
                        : 'bg-destructive/15 text-destructive'
                    )}
                  >
                    {ACTION_LABEL[row.action] ?? row.action}
                  </Badge>
                </td>
                <td
                  className={cn(
                    'px-3 py-2',
                    row.replay?.status === 'failed' && 'text-destructive'
                  )}
                >
                  {reasonText(row)}
                </td>
                <td className="px-3 py-2">
                  <SourceCell row={row} />
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <SlackCell posted={row.slackPosted} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted-foreground">
        The team shares one OpenPanel admin login, so "Who" is always OpenPanel
        admin. Source is UI (someone clicked here) or Agent (Claude dropped it
        on request; shows who asked and links the chat). The Slack #analytics
        post carries the same fields.
      </p>
    </div>
  );
}
