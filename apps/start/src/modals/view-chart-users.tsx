import type { IReportInput } from '@openpanel/validation';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ModalHeader } from './Modal/Container';
import {
  ScrollableModal,
  ScrollableSheet,
  useScrollableModal,
} from './Modal/scrollable-modal';
import { ProjectLink } from '@/components/links';
import { ProfileAvatar } from '@/components/profiles/profile-avatar';
import { SerieIcon } from '@/components/report-chart/common/serie-icon';
import { Button } from '@/components/ui/button';
import { DropdownMenuShortcut } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTRPC } from '@/integrations/trpc/react';
import type { IChartData } from '@/trpc/client';
import { cn } from '@/utils/cn';
import { getProfileName } from '@/utils/getters';

const ProfileItem = ({ profile }: { profile: any }) => {
  const profileName = getProfileName(profile, false);
  return (
    <ProjectLink
      preload={false}
      href={`/profiles/${encodeURIComponent(profile.id)}/events`}
      target="_blank"
      rel="noreferrer"
      title={profileName}
      className="col gap-2 rounded-lg border p-2 bg-card hover:bg-def-100"
    >
      <div className="row gap-2 items-center">
        <ProfileAvatar {...profile} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono font-medium">{profile.id}</div>
          {profileName !== profile.id && (
            <div className="truncate text-sm text-muted-foreground">
              {profileName}
            </div>
          )}
        </div>
      </div>

      <div className="row gap-4 text-sm overflow-hidden">
        {profile.properties.country && (
          <div className="row gap-2 items-center">
            <SerieIcon name={profile.properties.country} />
            <span>
              {profile.properties.country}
              {profile.properties.city && ` / ${profile.properties.city}`}
            </span>
          </div>
        )}
        {profile.properties.os && (
          <div className="row gap-2 items-center">
            <SerieIcon name={profile.properties.os} />
            <span>{profile.properties.os}</span>
          </div>
        )}
        {profile.properties.browser && (
          <div className="row gap-2 items-center">
            <SerieIcon name={profile.properties.browser} />
            <span>{profile.properties.browser}</span>
          </div>
        )}
      </div>
    </ProjectLink>
  );
};
// Shared profile list component
function ProfileList({ profiles }: { profiles: any[] }) {
  const ITEM_HEIGHT = 74;
  const CONTAINER_PADDING = 20;
  const ITEM_GAP = 5;
  const { scrollAreaRef } = useScrollableModal();
  const [isScrollReady, setIsScrollReady] = useState(false);

  // Check if scroll container is ready
  useEffect(() => {
    if (scrollAreaRef.current) {
      setIsScrollReady(true);
    } else {
      setIsScrollReady(false);
    }
  }, [scrollAreaRef]);

  const virtualizer = useVirtualizer({
    count: profiles.length,
    getScrollElement: () => scrollAreaRef.current,
    estimateSize: () => ITEM_HEIGHT + ITEM_GAP,
    overscan: 5,
    paddingStart: CONTAINER_PADDING,
    paddingEnd: CONTAINER_PADDING,
  });

  // Re-measure when scroll container becomes available or profiles change
  useEffect(() => {
    if (isScrollReady && scrollAreaRef.current) {
      // Small delay to ensure DOM is ready
      const timeoutId = setTimeout(() => {
        virtualizer.scrollToOffset(0);
        virtualizer.measure();
      }, 0);
      return () => clearTimeout(timeoutId);
    }
  }, [isScrollReady, profiles.length, virtualizer]);

  if (profiles.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-muted-foreground">No users found</div>
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        width: '100%',
        position: 'relative',
      }}
    >
      {/* Only the visible items in the virtualizer, manually positioned to be in view */}
      {virtualItems.map((virtualItem) => {
        const profile = profiles[virtualItem.index];
        return (
          <div
            key={profile.id}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualItem.size}px`,
              transform: `translateY(${virtualItem.start}px)`,
              padding: `0px ${CONTAINER_PADDING}px ${ITEM_GAP}px`,
            }}
          >
            <ProfileItem profile={profile} />
          </div>
        );
      })}
    </div>
  );
}

// Chart-specific props and component
interface ChartUsersViewProps {
  chartData: IChartData;
  report: IReportInput;
  date: string;
  serieId?: string;
  /**
   * The instant the chart response resolved cohort membership at. Comes from
   * the server, is never recomputed here — the two must be the same instant or
   * the listed profiles are a different population from the number clicked.
   */
  membershipAsOf?: string;
}

function ChartUsersView({
  chartData,
  report,
  date,
  serieId,
  membershipAsOf,
}: ChartUsersViewProps) {
  const trpc = useTRPC();
  // Seeded from the clicked series' OWN metric, not blindly from the first one.
  // Seeding only the bucket while leaving this at series[0] made a click on a
  // bucket belonging to metric B look up that bucket among metric A's series,
  // miss, and silently fall back to A's first bucket — the wrong metric AND the
  // wrong bucket.
  const [selectedSerieId, setSelectedSerieId] = useState<string | null>(
    (serieId
      ? chartData?.series.find((s) => s.id === serieId)?.event.id
      : undefined) ??
      report.series[0]?.id ??
      null
  );
  // Seeded from the clicked series. Leaving it null would run the first query
  // across EVERY cohort bucket, so a click on `Not In 'X'` would list members
  // and non-members together until the user manually picked a series.
  const [selectedBreakdownId, setSelectedBreakdownId] = useState<string | null>(
    serieId ?? null
  );

  const selectedReportSerie = useMemo(
    () => report.series.find((s) => s.id === selectedSerieId),
    [report.series, selectedSerieId]
  );

  // Get all chart series that match the selected report serie
  const matchingChartSeries = useMemo(() => {
    if (!selectedSerieId || !chartData) return [];
    return chartData.series.filter((s) => s.event.id === selectedSerieId);
  }, [chartData?.series, selectedSerieId]);

  const selectedBreakdown = useMemo(() => {
    const chosen = selectedBreakdownId
      ? matchingChartSeries.find((s) => s.id === selectedBreakdownId)
      : undefined;
    if (chosen) return chosen;
    // Cohort buckets overlap or partition the population, so "all of them at
    // once" is not a population any number on the chart represents. Default to
    // the first bucket instead of querying unrestricted.
    return matchingChartSeries.find((s) => s.event.cohortId) ?? null;
  }, [matchingChartSeries, selectedBreakdownId]);

  // Reset breakdown selection when serie changes
  const handleSerieChange = (value: string) => {
    setSelectedSerieId(value);
    setSelectedBreakdownId(null);
  };

  const profilesQuery = useQuery(
    trpc.chart.getProfiles.queryOptions(
      {
        projectId: report.projectId,
        date: date,
        series:
          selectedReportSerie && selectedReportSerie.type === 'event'
            ? [selectedReportSerie]
            : [],
        breakdowns: selectedBreakdown?.event.breakdowns,
        interval: report.interval,
        // Forward the report's cohort filter. Omitting it lists people outside
        // the population whose number was clicked.
        cohortFilters: report.cohortFilters,
        // Breakdown bucket identity, so `Not In 'X'` drills into non-members
        // rather than members.
        cohortId: selectedBreakdown?.event.cohortId,
        cohortMembership: selectedBreakdown?.event.cohortMembership,
        // The instant the chart's own response reported resolving membership
        // at, passed through untouched. NOT report.endDate: a relative-range
        // report has no endDate on the client, and the server would then fall
        // back to the clicked bucket's date — a different population from the
        // one the number was computed over. The server now rejects a cohort
        // restriction that arrives without it rather than guessing.
        membershipAsOf: membershipAsOf ?? undefined,
      },
      {
        enabled: !!selectedReportSerie && selectedReportSerie.type === 'event',
      }
    )
  );

  const profiles = profilesQuery.data ?? [];

  return (
    <ScrollableModal
      header={
        <div>
          <ModalHeader
            title="View Users"
            text={`Users who performed actions on ${new Date(date).toLocaleDateString()}`}
          />
          {report.series.length > 0 && (
            <div className="col md:row gap-2">
              <Select
                value={selectedSerieId || ''}
                onValueChange={handleSerieChange}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Select Serie" />
                </SelectTrigger>
                <SelectContent>
                  {report.series.map((serie) => (
                    <SelectItem key={serie.id} value={serie.id || ''}>
                      {serie.type === 'event'
                        ? serie.displayName || serie.name
                        : serie.displayName || 'Formula'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {matchingChartSeries.length > 1 && (
                <Select
                  value={selectedBreakdownId || ''}
                  onValueChange={(value) => setSelectedBreakdownId(value)}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Select Breakdown" />
                  </SelectTrigger>
                  <SelectContent>
                    {matchingChartSeries
                      .sort((a, b) => b.metrics.sum - a.metrics.sum)
                      .map((serie) => (
                        <SelectItem key={serie.id} value={serie.id}>
                          {Object.values(serie.event.breakdowns ?? {}).join(
                            ', '
                          )}
                          <DropdownMenuShortcut className="ml-auto">
                            ({serie.data.find((d) => d.date === date)?.count})
                          </DropdownMenuShortcut>
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
        </div>
      }
    >
      <div className="col">
        {profilesQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="text-muted-foreground">Loading users...</div>
          </div>
        ) : (
          <ProfileList profiles={profiles} />
        )}
      </div>
    </ScrollableModal>
  );
}

// Funnel-specific props and component
interface FunnelUsersViewProps {
  cohortId?: string;
  cohortMembership?: 'in' | 'not_in';
  membershipAsOf?: string;
  report: IReportInput;
  stepIndex: number;
  initialShowDropoffs?: boolean;
  breakdownValues?: string[];
}

function FunnelUsersView({
  report,
  stepIndex,
  initialShowDropoffs = false,
  breakdownValues,
  cohortId,
  cohortMembership,
  membershipAsOf,
}: FunnelUsersViewProps) {
  const trpc = useTRPC();
  const [showDropoffs, setShowDropoffs] = useState(initialShowDropoffs);
  const [search, setSearch] = useState('');

  const profilesQuery = useQuery(
    trpc.chart.getFunnelProfiles.queryOptions(
      {
        projectId: report.projectId,
        startDate: report.startDate,
        endDate: report.endDate,
        range: report.range,
        dateConfig: report.dateConfig,
        series: report.series,
        stepIndex: stepIndex,
        showDropoffs: showDropoffs,
        funnelWindow:
          report.options?.type === 'funnel'
            ? report.options.funnelWindow
            : undefined,
        funnelWindowUnit:
          report.options?.type === 'funnel'
            ? report.options.funnelWindowUnit
            : undefined,
        // Every cohort restriction the funnel applied, or this lists the
        // unfiltered population beside a filtered number.
        cohortFilters: report.cohortFilters,
        cohortId,
        cohortMembership,
        membershipAsOf,
        funnelGroup:
          report.options?.type === 'funnel'
            ? report.options.funnelGroup
            : undefined,
        breakdowns: report.breakdowns,
        breakdownValues,
        breakdownStep:
          report.options?.type === 'funnel'
            ? report.options.breakdownStep
            : undefined,
      },
      {
        enabled: stepIndex !== undefined,
      }
    )
  );

  const profiles = profilesQuery.data ?? [];
  const visibleProfiles = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) {
      return profiles;
    }
    return profiles.filter((profile) => {
      const name = getProfileName(profile, false);
      return [profile.id, profile.email, name]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [profiles, search]);
  const isLastStep = stepIndex === report.series.length - 1;

  return (
    <ScrollableSheet
      header={
        <div className="flex flex-col gap-2">
          <ModalHeader
            onClose={false}
            title="View Users"
            text={
              showDropoffs
                ? `${stepIndex + 1 < report.series.length ? `Users who completed step ${stepIndex + 1} but did not reach step ${stepIndex + 2}` : `Users who dropped off at the final step`}`
                : `Users who reached at least step ${stepIndex + 1} of ${report.series.length}`
            }
          />
          {!isLastStep && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowDropoffs(false)}
                className={cn(
                  'px-3 py-1.5 text-sm rounded-md transition-colors',
                  !showDropoffs
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                )}
              >
                Completed
              </button>
              <button
                type="button"
                onClick={() => setShowDropoffs(true)}
                className={cn(
                  'px-3 py-1.5 text-sm rounded-md transition-colors',
                  showDropoffs
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                )}
              >
                Dropped Off
              </button>
            </div>
          )}
          <div className="relative">
            <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search users by ID, name, or email"
              value={search}
            />
          </div>
          {!profilesQuery.isLoading && !profilesQuery.isError && (
            <div className="text-xs text-muted-foreground">
              Showing {visibleProfiles.length} of {profiles.length} loaded users
            </div>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {profilesQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="text-muted-foreground">Loading users...</div>
          </div>
        ) : profilesQuery.isError ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <div>
              <div className="font-medium">Unable to load users</div>
              <div className="text-sm text-muted-foreground">
                The funnel audience query failed. Try again.
              </div>
            </div>
            <Button onClick={() => profilesQuery.refetch()} variant="outline">
              Try again
            </Button>
          </div>
        ) : (
          <ProfileList profiles={visibleProfiles} />
        )}
      </div>
    </ScrollableSheet>
  );
}

// Union type for props
type ViewChartUsersProps =
  | {
      type: 'chart';
      chartData: IChartData;
      report: IReportInput;
      date: string;
      /** The chart series the user actually clicked, when the chart knows it. */
      serieId?: string;
      /** The server-reported membership instant for that chart response. */
      membershipAsOf?: string;
    }
  | {
      type: 'funnel';
      report: IReportInput;
      stepIndex: number;
      initialShowDropoffs?: boolean;
      breakdownValues?: string[];
      /** The cohort bucket that was clicked, when the funnel is broken down. */
      cohortId?: string;
      cohortMembership?: 'in' | 'not_in';
      /** The server-reported membership instant for that funnel response. */
      membershipAsOf?: string;
    };

// Main component that routes to the appropriate view
export default function ViewChartUsers(props: ViewChartUsersProps) {
  if (props.type === 'funnel') {
    return (
      <FunnelUsersView
        report={props.report}
        stepIndex={props.stepIndex}
        initialShowDropoffs={props.initialShowDropoffs}
        breakdownValues={props.breakdownValues}
        cohortId={props.cohortId}
        cohortMembership={props.cohortMembership}
        membershipAsOf={props.membershipAsOf}
      />
    );
  }

  return (
    <ChartUsersView
      chartData={props.chartData}
      report={props.report}
      date={props.date}
      serieId={props.serieId}
      membershipAsOf={props.membershipAsOf}
    />
  );
}
