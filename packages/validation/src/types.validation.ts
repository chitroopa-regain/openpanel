import type { z } from 'zod';

export type UnionOmit<T, K extends keyof any> = T extends any
  ? Omit<T, K>
  : never;

import type {
  zChartBreakdown,
  zChartCustomEvent,
  zChartEvent,
  zChartEventItem,
  zChartEventSegment,
  zChartFormula,
  zChartSeries,
  zChartType,
  zCriteria,
  zCustomEventComponent,
  zCustomEventInput,
  zLineType,
  zMetric,
  zRange,
  zReport,
  zReportInput,
  zTimeInterval,
} from './index';

// For saved reports - complete report with required display fields
export type IReport = z.infer<typeof zReport>;

// For API/engine use - flexible input
export type IReportInput = z.infer<typeof zReportInput>;

// With resolved dates (engine internal)
export interface IReportInputWithDates extends IReportInput {
  startDate: string;
  endDate: string;
}
export type IChartEvent = z.infer<typeof zChartEvent>;
export type IChartFormula = z.infer<typeof zChartFormula>;
export type IChartCustomEvent = z.infer<typeof zChartCustomEvent>;
export type IChartEventItem = z.infer<typeof zChartEventItem>;
export type ICustomEventComponent = z.infer<typeof zCustomEventComponent>;
export type ICustomEventInput = z.infer<typeof zCustomEventInput>;
export type IChartSeries = z.infer<typeof zChartSeries>;
// Backward compatibility alias
export type IChartEvents = IChartSeries;
export type IChartEventSegment = z.infer<typeof zChartEventSegment>;
export type IChartEventFilter = IChartEvent['filters'][number];
export type IChartEventFilterValue =
  IChartEvent['filters'][number]['value'][number];
export type IChartEventFilterOperator =
  IChartEvent['filters'][number]['operator'];
export type IChartBreakdown = z.infer<typeof zChartBreakdown>;
export type IInterval = z.infer<typeof zTimeInterval>;
export type IChartType = z.infer<typeof zChartType>;
export type IChartMetric = z.infer<typeof zMetric>;
export type IChartLineType = z.infer<typeof zLineType>;
export type IChartRange = z.infer<typeof zRange>;
export type IGetChartDataInput = {
  event: IChartEvent;
  projectId: string;
  startDate: string;
  endDate: string;
} & Omit<IReportInput, 'series' | 'startDate' | 'endDate' | 'range'>;
export type ICriteria = z.infer<typeof zCriteria>;

export type PreviousValue =
  | {
      value: number;
      diff: number | null;
      state: 'positive' | 'negative' | 'neutral';
    }
  | undefined;

export type Metrics = {
  sum: number;
  average: number;
  min: number;
  max: number;
  count: number | undefined;
  previous?: {
    sum: PreviousValue;
    average: PreviousValue;
    min: PreviousValue;
    max: PreviousValue;
    count: PreviousValue;
  };
};

export type IChartSerie = {
  id: string;
  names: string[];
  event: {
    id?: string;
    name: string;
    breakdowns?: Record<string, string>;
    /**
     * The cohort BUCKET that produced this series, carried to the client so a
     * drill-down ("View Users") reproduces the same population. Omitting it
     * lists people outside the number that was clicked.
     *
     * There is deliberately no per-series cohort filter here: a cohort filter
     * is report-level, so it travels on the report, not on each series. Leaving
     * the field would invite the removed per-metric scope back in.
     */
    cohortId?: string;
    cohortMembership?: 'in' | 'not_in';
  };
  metrics: Metrics;
  serieType?: 'event' | 'formula' | 'custom_event';
  data: {
    date: string;
    count: number;
    previous: PreviousValue;
  }[];
};

export type FinalChart = {
  series: IChartSerie[];
  metrics: Metrics;
  queries?: string[];
  timezone?: string;
  /**
   * The instant cohort membership was evaluated at for this response. Sent to
   * the client so a drill-down echoes it back verbatim: re-deriving an instant
   * on the drill-down side lists a different population than the chart showed,
   * and nothing on screen would say so.
   */
  membershipAsOf?: string;
};

export type ISetCookie = (
  key: string,
  value: string,
  options: {
    maxAge?: number;
    domain?: string;
    path?: string;
    sameSite?: 'lax' | 'strict' | 'none';
    secure?: boolean;
    httpOnly?: boolean;
  }
) => void;
