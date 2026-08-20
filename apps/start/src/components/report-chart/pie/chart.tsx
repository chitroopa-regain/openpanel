import { Fragment, useMemo } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { AXIS_FONT_PROPS } from '../common/axis';
import { PreviousDiffIndicator } from '../common/previous-diff-indicator';
import { ReportTable } from '../common/report-table';
import {
  ReportSeriesScreenshot,
  ReportSeriesScreenshotsProvider,
} from '../common/report-series-screenshots';
import { SerieIcon } from '../common/serie-icon';
import { SerieName } from '../common/serie-name';
import { useReportChartContext } from '../context';
import { useReportDisplayVisibility } from '../display-mode';
import {
  ChartTooltipContainer,
  ChartTooltipHeader,
  ChartTooltipItem,
} from '@/components/charts/chart-tooltip';
import { useNumber } from '@/hooks/use-numer-formatter';
import {
  getHiddenSeriesKeys,
  useVisibleSeries,
} from '@/hooks/use-visible-series';
import type { IChartData } from '@/trpc/client';
import { cn } from '@/utils/cn';
import { formatDate } from '@/utils/date';
import { round } from '@/utils/math';
import { getChartColor } from '@/utils/theme';
import { truncate } from '@/utils/truncate';

interface Props {
  data: IChartData;
}

const PieTooltip = (props: { payload?: any[] }) => {
  const number = useNumber();
  return (
    <ChartTooltipContainer>
      {props.payload?.map((serie, index) => {
        const item = serie.payload;
        return (
          <Fragment key={item.id}>
            {index === 0 && item.date && (
              <ChartTooltipHeader>
                <div>{formatDate(new Date(item.date))}</div>
              </ChartTooltipHeader>
            )}
            <ChartTooltipItem color={item.color}>
              <div className="flex items-center gap-1">
                <ReportSeriesScreenshot
                  eventName={item.names.join(' — ')}
                  serieId={item.id}
                  showNoMatch={false}
                />
                <SerieIcon name={item.name} />
                <SerieName className="font-medium" name={item.names} />
              </div>
              <div className="flex justify-between gap-8 font-medium font-mono">
                <div className="row gap-1">
                  {number.formatWithUnit(item.count)}
                  {!!item.previous && (
                    <span className="text-muted-foreground">
                      ({number.formatWithUnit(item.previous.sum.value)})
                    </span>
                  )}
                </div>
                <PreviousDiffIndicator {...item.previous?.sum} />
              </div>
            </ChartTooltipItem>
          </Fragment>
        );
      })}
    </ChartTooltipContainer>
  );
};

export function Chart({ data }: Props) {
  const { showChart, showTable } = useReportDisplayVisibility();
  const { isEditMode, report } = useReportChartContext();
  const hiddenSeriesIds = useMemo(
    () => getHiddenSeriesKeys(report.series),
    [report.series]
  );
  const { series, setVisibleSeries } = useVisibleSeries(
    data,
    undefined,
    hiddenSeriesIds
  );
  const number = useNumber();

  const isFrequencyDistribution = report.series?.some(
    (e) => 'segment' in e && e.segment === 'frequency_distribution'
  );

  const sum = series.reduce((acc, serie) => acc + serie.metrics.sum, 0);
  const hasBreakdown = (report.breakdowns?.length ?? 0) > 0;
  // When a breakdown is configured, the slice label shows only the breakdown
  // value (e.g. "google-play") rather than "<event> > <breakdown>" — the event
  // prefix is redundant. A series with no breakdown value is the "(not set)"
  // bucket; without a breakdown configured, fall back to the event name.
  const pieData = series.map((serie) => ({
    id: serie.id,
    color: getChartColor(serie.index),
    index: serie.index,
    name: hasBreakdown
      ? serie.names.length > 1
        ? serie.names.slice(1).join(' > ')
        : '(not set)'
      : serie.names[0],
    names: serie.names,
    count: serie.metrics.sum,
    percent: serie.metrics.sum / sum,
    previous: serie.metrics.previous ? serie.metrics.previous : undefined,
  }));

  const labelRenderer = isFrequencyDistribution
    ? renderFrequencyLabel
    : renderLabel;

  return (
    <ReportSeriesScreenshotsProvider chartSeries={data.series}>
      {showChart && (
        <div
          className={cn('h-full w-full max-sm:-mx-3', isEditMode && 'card p-4')}
        >
        <ResponsiveContainer>
          <PieChart>
            <Tooltip content={<PieTooltip />} />
            <Pie
              data={pieData}
              dataKey={'count'}
              // Smaller outerRadius leaves room for the external labels
              // ("google-play", "apps.instagram.com" etc.) so they don't get
              // clipped by the card edges.
              innerRadius={'25%'}
              isAnimationActive={false}
              label={labelRenderer}
              outerRadius={'62%'}
            >
              {pieData.map((item) => {
                return (
                  <Cell
                    className="stroke-background"
                    fill={item.color}
                    key={item.id}
                    strokeWidth={4}
                  />
                );
              })}
            </Pie>
            {
              <text
                dominantBaseline="central"
                textAnchor="middle"
                x="50%"
                y="50%"
                {...AXIS_FONT_PROPS}
                fill="currentColor"
                fontSize={18}
                fontWeight={700}
              >
                {number.shortWithUnit(sum)}
              </text>
            }
          </PieChart>
        </ResponsiveContainer>
        </div>
      )}
      {showTable && (
        <ReportTable
          chartType="pie"
          data={data}
          setVisibleSeries={setVisibleSeries}
          visibleSeries={data.series}
        />
      )}
    </ReportSeriesScreenshotsProvider>
  );
}

const renderFrequencyLabel = ({
  cx,
  cy,
  midAngle,
  innerRadius,
  outerRadius,
  fill,
  payload,
}: {
  cx: number;
  cy: number;
  midAngle: number;
  innerRadius: number;
  outerRadius: number;
  fill: string;
  payload: { name: string; count: number };
}) => {
  const RADIAN = Math.PI / 180;
  const radius = 25 + innerRadius + (outerRadius - innerRadius);
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  // Show just the frequency bucket (e.g. "2 times") and count below
  const parts = payload.name.split(' > ');
  const freqLabel = parts[parts.length - 1] || payload.name;
  const anchor = x > cx ? 'start' : 'end';

  return (
    <>
      <text
        dominantBaseline="central"
        fill={fill}
        textAnchor={anchor}
        x={x}
        y={y - 6}
        {...AXIS_FONT_PROPS}
        fontSize={11}
        fontWeight={700}
      >
        {freqLabel}
      </text>
      <text
        dominantBaseline="central"
        fill={fill}
        textAnchor={anchor}
        x={x}
        y={y + 8}
        {...AXIS_FONT_PROPS}
        fontSize={11}
        fontWeight={400}
        opacity={0.65}
      >
        {payload.count.toLocaleString()}
      </text>
    </>
  );
};

const renderLabel = ({
  cx,
  cy,
  midAngle,
  innerRadius,
  outerRadius,
  fill,
  payload,
}: {
  cx: number;
  cy: number;
  midAngle: number;
  innerRadius: number;
  outerRadius: number;
  fill: string;
  payload: { name: string; percent: number };
}) => {
  const RADIAN = Math.PI / 180;
  const radius = 25 + innerRadius + (outerRadius - innerRadius);
  const radiusProcent = innerRadius + (outerRadius - innerRadius) * 0.5;
  const xProcent = cx + radiusProcent * Math.cos(-midAngle * RADIAN);
  const yProcent = cy + radiusProcent * Math.sin(-midAngle * RADIAN);
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  const name = payload.name;
  const percent = round(payload.percent * 100, 1);

  return (
    <>
      <text
        dominantBaseline="central"
        fill="white"
        pointerEvents={'none'}
        textAnchor="middle"
        x={xProcent}
        y={yProcent}
        {...AXIS_FONT_PROPS}
        fontSize={12}
        fontWeight={700}
      >
        {percent}%
      </text>
      <text
        dominantBaseline="central"
        fill={fill}
        textAnchor={x > cx ? 'start' : 'end'}
        x={x}
        y={y}
        {...AXIS_FONT_PROPS}
        fontSize={10}
        fontWeight={700}
      >
        {truncate(name, 20)}
      </text>
    </>
  );
};
