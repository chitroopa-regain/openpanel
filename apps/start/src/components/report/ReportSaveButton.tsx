import { Button } from '@/components/ui/button';
import { clearReportDraft } from '@/components/report-chart/report-draft';
import { useAppParams } from '@/hooks/use-app-params';
import { handleError } from '@/integrations/trpc/react';
import { pushModal } from '@/modals';
import { useDispatch, useSelector } from '@/redux';
import { CopyIcon, SaveIcon } from 'lucide-react';
import { toast } from 'sonner';

import { useTRPC } from '@/integrations/trpc/react';
import {
  useIsFetching,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useParams, useRouter, useSearch } from '@tanstack/react-router';
import { resetDirty } from './reportSlice';

interface ReportSaveButtonProps {
  className?: string;
}
export function ReportSaveButton({ className }: ReportSaveButtonProps) {
  const trpc = useTRPC();
  const router = useRouter();
  const { organizationId, projectId } = useAppParams();
  const fetching = [
    useIsFetching(trpc.chart.chart.pathFilter()),
    useIsFetching(trpc.chart.cohort.pathFilter()),
  ];
  const { reportId } = useParams({ strict: false });
  const savedReportSearch = useSearch({
    from: '/_app/$organizationId/$projectId/reports_/$reportId',
    shouldThrow: false,
  });
  const newReportSearch = useSearch({
    from: '/_app/$organizationId/$projectId/reports',
    shouldThrow: false,
  });
  const search = savedReportSearch ?? newReportSearch;
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const create = useMutation(
    trpc.report.create.mutationOptions({
      onSuccess(res) {
        toast('Success', {
          description: 'Report created.',
        });
        queryClient.invalidateQueries(
          trpc.report.list.queryFilter({
            dashboardId: res.dashboardId,
            projectId: res.projectId,
          }),
        );
        queryClient.invalidateQueries(trpc.dashboard.list.pathFilter());
        void router.navigate({
          to: '/$organizationId/$projectId/reports/$reportId',
          params: {
            organizationId,
            projectId,
            reportId: res.id,
          },
          search: search?.dashboardId
            ? { dashboardId: search.dashboardId }
            : undefined,
        });
      },
      onError: handleError,
    }),
  );
  const update = useMutation(
    trpc.report.update.mutationOptions({
      async onSuccess(res) {
        if (reportId) {
          const reportQuery = trpc.report.get.queryOptions({ reportId });
          queryClient.setQueryData(reportQuery.queryKey, {
            ...report,
            id: reportId,
            dashboardId: res.dashboardId,
            projectId: res.projectId,
            // Optimistic revision stamp. The server's own value arrives with
            // the refetch below; this only keeps the cached shape complete in
            // the meantime.
            updatedAt: res.updatedAt ?? new Date(),
          });
          try {
            await queryClient.fetchQuery({ ...reportQuery, staleTime: 0 });
          } catch {
            // The mutation succeeded and the cache already contains the saved
            // editor state. A later invalidation can retry the server refresh.
          }
        }
        if (search?.draft && reportId && organizationId && projectId) {
          clearReportDraft(search.draft);
          void router.navigate({
            to: '/$organizationId/$projectId/reports/$reportId',
            params: {
              organizationId,
              projectId,
              reportId,
            },
            search: {
              ...(search ?? {}),
              draft: undefined,
            },
            replace: true,
          });
        }
        dispatch(resetDirty());
        toast('Success', {
          description: 'Report updated.',
        });
        queryClient.invalidateQueries(
          trpc.report.list.queryFilter({
            dashboardId: res.dashboardId,
            projectId: res.projectId,
          }),
        );
        queryClient.invalidateQueries(
          trpc.report.get.queryFilter({
            reportId,
          }),
        );
      },
      onError: handleError,
    }),
  );
  const report = useSelector((state) => state.report);
  const isLoading =
    create.isPending || update.isPending || fetching.some((f) => f !== 0);

  if (reportId && organizationId && projectId) {
    return (
      <div className="flex items-center gap-2">
        {/* "Save As New" — same name and placement as Mixpanel: secondary,
            immediately left of the primary action. Keeps the original
            untouched and stores the current editor state as a NEW report.
            Deliberately NOT gated on `dirty` — branching from an unmodified
            report is a normal thing to want, and Update already covers the
            modify-in-place case. */}
        <Button
          className={className}
          data-testid="save-as-report"
          icon={CopyIcon}
          loading={create.isPending}
          onClick={() => {
            // `report.create` writes `dateConfig`, never the top-level
            // startDate/endDate, and rewrites `range: 'custom'` to '30d' when
            // no dateConfig is present. Legacy or draft-hydrated state can be
            // in exactly that shape, so the copy would silently show a
            // different period than the screen it was made from. Reconstruct
            // the dateConfig instead of letting the range be substituted.
            const needsFixedDates =
              report.range === 'custom' &&
              !report.dateConfig &&
              Boolean(report.startDate && report.endDate);
            pushModal('SaveReport', {
              report: needsFixedDates
                ? {
                    ...report,
                    dateConfig: {
                      dateMode: 'fixed' as const,
                      fixedStartDate: report.startDate,
                      fixedEndDate: report.endDate,
                    },
                  }
                : report,
              // Same default a brand-new report gets, not "Copy of <name>":
              // this creates a NEW report, and the name is editable in the
              // dialog. Inheriting the original's name would leave two
              // identically-named reports in the list.
              defaultName: 'Untitled report',
              // The dashboard the ORIGINAL lives on, so the copy lands beside
              // it. Route search is the wrong source — absent on a direct
              // link, and wrong when a stale `?dashboardId=` points elsewhere.
              defaultDashboardId: report.dashboardId ?? search?.dashboardId,
            });
          }}
          variant="outline"
        >
          Save As New
        </Button>
        <Button
          className={className}
          disabled={!report.dirty}
          loading={update.isPending || isLoading}
          onClick={() => {
            update.mutate({
              reportId: reportId,
              report,
            });
          }}
          icon={SaveIcon}
        >
          Update
        </Button>
      </div>
    );
  }
  return (
      <Button
        className={className}
        disabled={!report.dirty}
        onClick={() => {
          if (search?.dashboardId) {
            create.mutate({
              dashboardId: search.dashboardId,
              report: {
                ...report,
                name: report.name || 'Untitled report',
              },
            });
            return;
          }

          pushModal('SaveReport', {
            report,
          });
        }}
        icon={SaveIcon}
        loading={isLoading}
    >
      Save
    </Button>
  );
}
