import { useTRPC } from '@/integrations/trpc/react';
import type { RouterOutputs } from '@/trpc/client';
import type { IChartRange, IDateConfig } from '@openpanel/validation';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { TriangleAlertIcon } from 'lucide-react';
import { createContext, useContext } from 'react';
import { ReferenceLine } from 'recharts';

export type DropNote = RouterOutputs['event']['dropNotes'][string][number];

const EMPTY: DropNote[] = [];
const DropNotesContext = createContext<Record<string, DropNote[]>>({});

/** Notes for every report of a board (or the one report page), from one query. */
export const DropNotesProvider = DropNotesContext.Provider;

export function useDropNotes(reportId: string | undefined): DropNote[] {
  const notes = useContext(DropNotesContext);
  return (reportId && notes[reportId]) || EMPTY;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function day(iso: string) {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function dayTime(iso: string) {
  const d = new Date(iso);
  return `${day(iso)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function DropNoteBanner({
  notes,
  organizationId,
  projectId,
}: {
  notes: DropNote[];
  organizationId: string;
  projectId: string;
}) {
  if (notes.length === 0) {
    return null;
  }
  const hasCurrent = notes.some((note) => note.to === null);
  return (
    <div className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm leading-normal text-yellow-200">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        {notes.map((note) => (
          <div key={`${note.eventName}:${note.from}`}>
            Event "<span className="font-mono">{note.eventName}</span>"{' '}
            {note.to === null
              ? `dropped on ${day(note.from)} by OpenPanel admin: no new data after this date.`
              : `dropped ${dayTime(note.from)}–${dayTime(note.to)}; ${
                  note.replayRequested
                    ? 'replay of that window was requested.'
                    : 'data missing in that window unless replayed.'
                }`}
          </div>
        ))}
        {hasCurrent && (
          <Link
            to="/$organizationId/$projectId/settings/events"
            params={{ organizationId, projectId }}
            className="text-blue-400 hover:underline"
          >
            Undrop in Settings → Events
          </Link>
        )}
      </div>
    </div>
  );
}

/** Report page: one query for this report, the banner, and the chart marker context. */
export function ReportDropNotes({
  reportId,
  projectId,
  organizationId,
  range,
  startDate,
  endDate,
  dateConfig,
  children,
}: {
  reportId: string | undefined;
  projectId: string;
  organizationId: string;
  range?: IChartRange | null;
  startDate?: string | null;
  endDate?: string | null;
  dateConfig?: IDateConfig | null;
  children: React.ReactNode;
}) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.event.dropNotes.queryOptions(
      { projectId, reportId, range, startDate, endDate, dateConfig },
      { enabled: Boolean(reportId), staleTime: 60 * 1000 }
    )
  );
  const notes = query.data ?? {};
  return (
    <DropNotesProvider value={notes}>
      {reportId && notes[reportId] && (
        <DropNoteBanner
          notes={notes[reportId]}
          organizationId={organizationId}
          projectId={projectId}
        />
      )}
      {children}
    </DropNotesProvider>
  );
}

const DROP_RED = 'rgb(242 103 125)';

function hhmm(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Dashed red markers at each drop (and undrop) inside a time chart. Returns
 * elements, not a component, because Recharts only reads direct children.
 * Recharts discards a marker outside the x domain.
 */
export function dropMarkerLines(notes: DropNote[]) {
  const lines: React.ReactElement[] = [];
  for (const note of notes) {
    lines.push(
      <ReferenceLine
        key={`drop:${note.eventName}:${note.from}`}
        x={new Date(note.from).getTime()}
        stroke={DROP_RED}
        strokeDasharray="4 3"
        label={{
          value: `dropped ${hhmm(note.from)}`,
          position: 'insideTopRight',
          fill: DROP_RED,
          fontSize: 11,
        }}
      />
    );
    if (note.to) {
      lines.push(
        <ReferenceLine
          key={`undrop:${note.eventName}:${note.to}`}
          x={new Date(note.to).getTime()}
          stroke={DROP_RED}
          strokeDasharray="4 3"
          label={{
            value: `undropped ${hhmm(note.to)}`,
            position: 'insideTopLeft',
            fill: DROP_RED,
            fontSize: 11,
          }}
        />
      );
    }
  }
  return lines;
}
