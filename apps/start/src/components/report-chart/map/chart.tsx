import { useMemo } from 'react';
import WorldMap from 'react-svg-worldmap';
import AutoSizer from 'react-virtualized-auto-sizer';
import { ReportTable } from '../common/report-table';
import { useReportChartContext } from '../context';
import { useReportDisplayVisibility } from '../display-mode';
import { useEventQueryFilters } from '@/hooks/use-event-query-filters';
import {
  getHiddenSeriesKeys,
  useVisibleSeries,
} from '@/hooks/use-visible-series';
import type { IChartData } from '@/trpc/client';

interface Props {
  data: IChartData;
}

export function Chart({ data }: Props) {
  const { showChart, showTable } = useReportDisplayVisibility();
  const {
    report: { metric, unit, series: reportSeries },
  } = useReportChartContext();
  const hiddenSeriesIds = useMemo(
    () => getHiddenSeriesKeys(reportSeries),
    [reportSeries]
  );
  const { series, setVisibleSeries } = useVisibleSeries(
    data,
    99_999,
    hiddenSeriesIds
  );
  const [_, setFilter] = useEventQueryFilters();
  const mapData = useMemo(
    () =>
      series.map((s) => ({
        country: s.names[1]?.toLowerCase() ?? '',
        value: s.metrics[metric] ?? 0,
      })),
    [series, metric]
  );

  return (
    <>
      {showChart && <AutoSizer disableHeight>
      {({ width }) => (
        <WorldMap
          borderColor={'var(--foreground)'}
          color={'var(--chart-0)'}
          data={mapData}
          onClickFunction={(event) => {
            if (event.countryCode) {
              setFilter('country', event.countryCode);
            }
          }}
          size={width}
          value-suffix={unit}
        />
      )}
      </AutoSizer>}
      {showTable && (
        <ReportTable
          data={data}
          setVisibleSeries={setVisibleSeries}
          visibleSeries={series}
        />
      )}
    </>
  );
}
