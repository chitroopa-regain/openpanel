import { shortId } from '@openpanel/common';
import {
  extractRetentionSelection,
  fitSeriesToChartType,
  fromRetentionShape,
  toRetentionShape,
} from '@openpanel/validation';
import {
  getDefaultIntervalByDates,
  getDefaultIntervalByRange,
  isHourIntervalEnabledByRange,
  isMinuteIntervalEnabledByRange,
} from '@openpanel/constants';
import type {
  IChartBreakdown,
  IChartEventItem,
  ICohortFilters,
  IChartLineType,
  IChartRange,
  IChartType,
  IDateConfig,
  IInterval,
  IReport,
  IReportOptions,
  UnionOmit,
  zCriteria,
  zFunnelMeasure,
  zReportDisplayMode,
  zRetentionBreakdownSort,
  zRetentionTimeUnit,
} from '@openpanel/validation';
import type { PayloadAction } from '@reduxjs/toolkit';
import { createSlice } from '@reduxjs/toolkit';
import type { z } from 'zod';

type InitialState = IReport & {
  id?: string;
  dirty: boolean;
  ready: boolean;
  startDate: string | null;
  endDate: string | null;
  /**
   * What the last chart-type change silently removed, for the UI to show.
   * Editor-only: never persisted, cleared at the start of every transition.
   */
  lastTransitionNotice?: string;
  /**
   * The dashboard this report belongs to. Present at runtime because
   * `setReport` spreads the transformed database report; declared here so
   * consumers can read it without casting. "Save As New" needs it to default
   * the copy to the dashboard the original lives on — route search params are
   * the wrong source, being absent on a direct link and stale when a leftover
   * `?dashboardId=` points elsewhere.
   */
  dashboardId?: string;
};

/** Chart types whose query path does not apply a cohort breakdown. */
export const COHORT_BREAKDOWN_UNSUPPORTED_CHART_TYPES = new Set<string>([
  'sankey',
  'conversion',
]);

/**
 * Chart types whose query path does not apply a cohort FILTER. A shorter list
 * than the breakdown's: funnel and retention DO apply the filter (funnel as a
 * mode-dependent eligibility restriction, retention on the day-0 population),
 * they just cannot be split into In/Not In buckets yet.
 *
 * Two lists rather than one because collapsing them would either hide a filter
 * that works or offer a breakdown that does nothing.
 */
export const COHORT_FILTER_UNSUPPORTED_CHART_TYPES = new Set<string>([
  'sankey',
  'conversion',
]);

/**
 * A cohort breakdown only means anything on the chart/aggregate query paths.
 * Applied on HYDRATION as well as on chart-type changes: a report saved before
 * this rule existed, or created straight through the API, can arrive with an
 * unsupported chart type and a cohortBreakdown still set, and its query path
 * would ignore the field and render an unsplit series without complaint.
 */
function normalizeCohortBreakdown<
  T extends {
    chartType: string;
    cohortBreakdown?: unknown;
    cohortFilters?: unknown;
  },
>(report: T): T {
  const next = { ...report };
  if (COHORT_BREAKDOWN_UNSUPPORTED_CHART_TYPES.has(report.chartType)) {
    next.cohortBreakdown = undefined;
  }
  // The filter is stripped on a SHORTER list. A stale filter is worse than a
  // stale breakdown: the query guard rejects it outright, so a report switched
  // to an unsupporting chart type would error rather than merely render
  // unsplit.
  if (COHORT_FILTER_UNSUPPORTED_CHART_TYPES.has(report.chartType)) {
    next.cohortFilters = undefined;
  }
  return next;
}

// First approach: define the initial state using that type
const initialState: InitialState = {
  ready: false,
  dirty: false,
  projectId: '',
  name: '',
  chartType: 'linear',
  lineType: 'monotone',
  interval: 'day',
  breakdowns: [],
  series: [],
  range: '30d',
  startDate: null,
  endDate: null,
  previous: false,
  formula: undefined,
  unit: undefined,
  metric: 'sum',
  limit: 500,
  options: { type: 'generic', displayMode: 'both' },
  dateConfig: undefined,
  cohortBreakdown: undefined,
  cohortFilters: undefined,
};

export const reportSlice = createSlice({
  name: 'report',
  initialState,
  reducers: {
    resetDirty(state) {
      return {
        ...state,
        dirty: false,
      };
    },
    reset() {
      return initialState;
    },
    ready() {
      return {
        ...initialState,
        ready: true,
      };
    },
    setReport(state, action: PayloadAction<IReport>) {
      action = {
        ...action,
        payload: normalizeCohortBreakdown(action.payload as never) as IReport,
      };
      // Clear breakdowns if any series uses frequency distribution
      const hasFreqDist = action.payload.series.some(
        (s) => s.type !== 'formula' && s.segment === 'frequency_distribution'
      );
      return {
        ...state,
        ...action.payload,
        options: action.payload.options
          ? {
              ...action.payload.options,
              displayMode: action.payload.options.displayMode ?? 'both',
            }
          : { type: 'generic', displayMode: 'both' },
        breakdowns: hasFreqDist ? [] : action.payload.breakdowns,
        startDate: null,
        endDate: null,
        dirty: false,
        ready: true,
      };
    },
    hydrateDraftReport(state, action: PayloadAction<IReport>) {
      action = {
        ...action,
        payload: normalizeCohortBreakdown(action.payload as never) as IReport,
      };
      const hasFreqDist = action.payload.series.some(
        (s) => s.type !== 'formula' && s.segment === 'frequency_distribution'
      );
      return {
        ...state,
        ...action.payload,
        options: action.payload.options
          ? {
              ...action.payload.options,
              displayMode: action.payload.options.displayMode ?? 'both',
            }
          : { type: 'generic', displayMode: 'both' },
        breakdowns: hasFreqDist ? [] : action.payload.breakdowns,
        startDate: action.payload.startDate ?? null,
        endDate: action.payload.endDate ?? null,
        dirty: true,
        ready: true,
      };
    },
    setName(state, action: PayloadAction<string>) {
      state.dirty = true;
      state.name = action.payload;
    },
    // Series (Events and Formulas)
    addSerie: (
      state,
      action: PayloadAction<UnionOmit<IChartEventItem, 'id'>>
    ) => {
      state.dirty = true;
      state.series.push({
        id: shortId(),
        ...action.payload,
      });
    },
    duplicateEvent: (state, action: PayloadAction<IChartEventItem>) => {
      state.dirty = true;
      if (action.payload.type === 'event') {
        state.series.push({
          ...action.payload,
          filters: action.payload.filters.map((filter) => ({
            ...filter,
            id: shortId(),
          })),
          id: shortId(),
        } as IChartEventItem);
      } else {
        state.series.push({
          ...action.payload,
          id: shortId(),
        } as IChartEventItem);
      }
    },
    removeEvent: (
      state,
      action: PayloadAction<{
        id?: string;
      }>
    ) => {
      state.dirty = true;
      state.series = state.series.filter((event) => {
        return event.id !== action.payload.id;
      });
    },
    /**
     * Set or clear the report's cohort filter ROWS.
     *
     * Rows AND together and ids within a row OR, so this is the whole filter in
     * one action: partial row edits are done by the caller on a copy, which
     * keeps the reducer from having to reason about row identity.
     *
     * There is deliberately no per-metric equivalent. Membership is a property
     * of the profile, pinned at one instant, so scoping a cohort to one metric,
     * one funnel step, or one retention leg cannot change the answer.
     */
    changeCohortFilters: (
      state,
      action: PayloadAction<ICohortFilters | undefined>,
    ) => {
      state.dirty = true;
      state.cohortFilters = action.payload?.length ? action.payload : undefined;
    },

    changeEvent: (state, action: PayloadAction<IChartEventItem>) => {
      state.dirty = true;
      state.series = state.series.map((event) => {
        if (event.id === action.payload.id) {
          return action.payload;
        }
        return event;
      });

      // Clear breakdowns when any series uses frequency distribution
      // (frequency distribution IS the breakdown — user-defined breakdowns are ignored)
      const hasFreqDist = state.series.some(
        (s) => s.type !== 'formula' && s.segment === 'frequency_distribution'
      );
      if (hasFreqDist) {
        state.breakdowns = [];
      }
    },

    // Previous
    changePrevious: (state, action: PayloadAction<boolean>) => {
      state.dirty = true;
      state.previous = action.payload;
    },
    changeDisplayMode: (
      state,
      action: PayloadAction<z.infer<typeof zReportDisplayMode>>
    ) => {
      state.dirty = true;
      if (state.options) {
        state.options.displayMode = action.payload;
      } else {
        state.options = {
          type: 'generic',
          displayMode: action.payload,
        };
      }
    },

    // Breakdowns
    addBreakdown: (
      state,
      action: PayloadAction<Omit<IChartBreakdown, 'id'>>
    ) => {
      state.dirty = true;
      // Symmetric to changeCohortBreakdown: the two are mutually exclusive, so
      // adding a property breakdown clears any cohort breakdown.
      state.cohortBreakdown = undefined;
      state.breakdowns.push({
        id: shortId(),
        ...action.payload,
      });
    },
    removeBreakdown: (
      state,
      action: PayloadAction<{
        id?: string;
      }>
    ) => {
      state.dirty = true;
      state.breakdowns = state.breakdowns.filter(
        (event) => event.id !== action.payload.id
      );
      // Reset breakdownStep when all breakdowns are removed
      if (
        state.breakdowns.length === 0 &&
        state.options?.type === 'funnel' &&
        state.options.breakdownStep !== undefined
      ) {
        state.options.breakdownStep = undefined;
      }
    },
    changeBreakdown: (state, action: PayloadAction<IChartBreakdown>) => {
      state.dirty = true;
      state.breakdowns = state.breakdowns.map((breakdown) => {
        if (breakdown.id === action.payload.id) {
          return action.payload;
        }
        return breakdown;
      });
    },

    // Interval
    changeCohortBreakdown: (state, action: PayloadAction<string[]>) => {
      state.cohortBreakdown = action.payload.length
        ? { cohortIds: action.payload }
        : undefined;
      // A cohort breakdown and property breakdowns are mutually exclusive (the
      // server rejects the combination), so selecting cohorts clears any
      // property breakdown rather than letting the user build a report that
      // will only fail when it runs.
      if (action.payload.length) {
        state.breakdowns = [];
      }
      state.dirty = true;
    },
    changeInterval: (state, action: PayloadAction<IInterval>) => {
      state.dirty = true;
      state.interval = action.payload;
    },

    // Chart type
    changeChartType: (state, action: PayloadAction<IChartType>) => {
      state.dirty = true;
      const previousChartType = state.chartType;
      state.chartType = action.payload;
      state.lastTransitionNotice = undefined;

      // Only the chart/aggregate query paths apply a cohort breakdown. Carrying
      // it onto funnel/retention/sankey/conversion would leave a field set that
      // those paths ignore, so the report would quietly render unsplit while
      // still claiming a breakdown. Drop it on the transition instead.
      // Cross the retention boundary: the selected event lives in `name` for
      // every chart type EXCEPT retention, which carries it in a reserved
      // `name` filter. Without translating, the events are still in the store
      // but where the new chart type is not looking, so both slots read
      // "Select event".
      const enteringRetention =
        action.payload === 'retention' && previousChartType !== 'retention';
      const leavingRetention =
        previousChartType === 'retention' && action.payload !== 'retention';

      if (enteringRetention) {
        state.series = state.series.map(
          (serie) => toRetentionShape(serie as any) as typeof serie,
        );
      } else if (leavingRetention) {
        const dropped: string[] = [];
        state.series = state.series.map((serie) => {
          const converted = fromRetentionShape(serie as any);
          dropped.push(...converted.droppedNames);
          return converted.serie as typeof serie;
        });
        // A multi-event slot cannot fit a single-event chart type. Keeping the
        // first silently changes the NUMBER while the report looks unchanged,
        // so say what was removed.
        state.lastTransitionNotice = dropped.length
          ? `Kept the first event per metric. Dropped: ${dropped.join(', ')}.`
          : undefined;
      }

      // Trim to what the target can actually run — over the SUPPORTED series,
      // never raw indices. Matches Mixpanel: entering retention keeps the first
      // two metrics and drops the rest, permanently. Replaces the old state
      // where extras were persisted but silently ignored by the query.
      const fitted = fitSeriesToChartType(state.series as any[], action.payload, {
        sankeyMode:
          state.options?.type === 'sankey' ? state.options.mode : undefined,
      });
      if (fitted.removed.length > 0) {
        state.series = fitted.kept as typeof state.series;
        // State the REAL reason. "Cannot use" and "no room for" are different
        // things, and reporting the wrong one sends people looking for a
        // compatibility problem they do not have.
        const notes: string[] = [];
        if (fitted.unsupported.length > 0) {
          const formulas = fitted.unsupported.filter(
            (serie: any) => serie.type === 'formula',
          ).length;
          const kind =
            formulas === fitted.unsupported.length
              ? formulas > 1
                ? 'formulas'
                : 'a formula'
              : `${fitted.unsupported.length} metric${fitted.unsupported.length > 1 ? 's' : ''}`;
          notes.push(`Removed ${kind}, which ${action.payload} cannot use.`);
        }
        if (fitted.overCap.length > 0) {
          notes.push(
            `${action.payload} uses ${fitted.kept.length} metric${fitted.kept.length > 1 ? 's' : ''}, so ${fitted.overCap.length} more ${fitted.overCap.length > 1 ? 'were' : 'was'} removed.`,
          );
        }
        state.lastTransitionNotice = [state.lastTransitionNotice, ...notes]
          .filter(Boolean)
          .join(' ');
      }

      if (COHORT_BREAKDOWN_UNSUPPORTED_CHART_TYPES.has(action.payload)) {
        state.cohortBreakdown = undefined;
      }
      // Shorter list for the filter: funnel and retention keep it (their query
      // paths apply it), only the types that ignore it entirely lose it — and
      // they must, because the query guard rejects a filter it cannot apply.
      if (COHORT_FILTER_UNSUPPORTED_CHART_TYPES.has(action.payload)) {
        state.cohortFilters = undefined;
      }

      // Initialize sankey options if switching to sankey
      if (action.payload === 'sankey' && state.options?.type !== 'sankey') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'sankey',
          mode: 'after',
          steps: 5,
          exclude: [],
        };
      }

      if (
        !isMinuteIntervalEnabledByRange(state.range) &&
        state.interval === 'minute'
      ) {
        state.interval = 'hour';
      }

      if (
        !isHourIntervalEnabledByRange(state.range) &&
        state.interval === 'hour'
      ) {
        state.interval = 'day';
      }
    },

    // Line type
    changeLineType: (state, action: PayloadAction<IChartLineType>) => {
      state.dirty = true;
      state.lineType = action.payload;
    },

    // Date range
    changeStartDate: (state, action: PayloadAction<string>) => {
      state.dirty = true;
      state.startDate = action.payload;

      const interval = getDefaultIntervalByDates(
        state.startDate,
        state.endDate
      );
      if (interval) {
        state.interval = interval;
      }
    },

    // Date range
    changeEndDate: (state, action: PayloadAction<string>) => {
      state.dirty = true;
      state.endDate = action.payload;

      const interval = getDefaultIntervalByDates(
        state.startDate,
        state.endDate
      );
      if (interval) {
        state.interval = interval;
      }
    },

    changeDateRanges: (state, action: PayloadAction<IChartRange>) => {
      state.dirty = true;
      state.range = action.payload;
      if (action.payload !== 'custom') {
        state.startDate = null;
        state.endDate = null;
        state.dateConfig = undefined;
        state.interval = getDefaultIntervalByRange(action.payload);
      }
    },

    // Formula
    changeFormula: (state, action: PayloadAction<string>) => {
      state.dirty = true;
      state.formula = action.payload;
    },

    changeCriteria(state, action: PayloadAction<z.infer<typeof zCriteria>>) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'retention') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'retention',
          criteria: action.payload,
        };
      } else {
        state.options.criteria = action.payload;
      }
    },

    changeUnit(state, action: PayloadAction<string | undefined>) {
      state.dirty = true;
      state.unit = action.payload || undefined;
    },
    changeRetentionMetric(
      state,
      action: PayloadAction<
        | 'retention_rate'
        | 'unique_users'
        | 'property_sum'
        | 'property_average'
        | undefined
      >
    ) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'retention') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'retention',
          metric: action.payload,
        };
      } else {
        state.options.metric = action.payload;
        if (
          action.payload !== 'property_sum' &&
          action.payload !== 'property_average'
        ) {
          state.options.property = undefined;
        }
        if (action.payload !== 'property_average') {
          state.options.propertyAverageDenominatorStep = undefined;
        }
      }
    },

    changeRetentionProperty(state, action: PayloadAction<string | undefined>) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'retention') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'retention',
          metric: action.payload ? 'property_average' : undefined,
          property: action.payload,
        };
      } else {
        const currentMetric = state.options.metric;
        state.options.metric = action.payload
          ? currentMetric === 'property_sum'
            ? 'property_sum'
            : 'property_average'
          : currentMetric;
        state.options.property = action.payload;
      }
    },

    changeRetentionUnit(
      state,
      action: PayloadAction<z.infer<typeof zRetentionTimeUnit> | undefined>
    ) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'retention') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'retention',
          retentionUnit: action.payload,
        };
      } else {
        state.options.retentionUnit = action.payload;
      }
    },

    changeRetentionPropertyAverageDenominatorStep(
      state,
      action: PayloadAction<number | undefined>
    ) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'retention') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'retention',
          metric: 'property_average',
          propertyAverageDenominatorStep: action.payload,
        };
      } else {
        state.options.propertyAverageDenominatorStep = action.payload;
      }
    },

    changeRetentionTopN(state, action: PayloadAction<number | undefined>) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'retention') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'retention',
          topN: action.payload,
        };
      } else {
        state.options.topN = action.payload;
      }
    },

    changeRetentionBreakdownSort(
      state,
      action: PayloadAction<z.infer<typeof zRetentionBreakdownSort> | undefined>
    ) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'retention') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'retention',
          breakdownSort: action.payload,
        };
      } else {
        state.options.breakdownSort = action.payload;
      }
    },

    changeFunnelGroup(state, action: PayloadAction<string | undefined>) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'funnel') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'funnel',
          funnelGroup: action.payload,
          funnelWindow: undefined,
        };
      } else {
        state.options.funnelGroup = action.payload;
      }
    },

    changeFunnelWindow(state, action: PayloadAction<number | undefined>) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'funnel') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'funnel',
          funnelGroup: undefined,
          funnelWindow: action.payload,
        };
      } else {
        state.options.funnelWindow = action.payload;
      }
    },

    changeFunnelWindowUnit(state, action: PayloadAction<string | undefined>) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'funnel') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'funnel',
          funnelGroup: undefined,
          funnelWindow: undefined,
          funnelWindowUnit: action.payload as any,
        };
      } else {
        state.options.funnelWindowUnit = action.payload as any;
      }
    },

    changeFunnelTopN(state, action: PayloadAction<number | undefined>) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'funnel') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'funnel',
          funnelGroup: undefined,
          funnelWindow: undefined,
          topN: action.payload,
        };
      } else {
        state.options.topN = action.payload;
      }
    },

    changeFunnelProperty(state, action: PayloadAction<string | undefined>) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'funnel') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'funnel',
          funnelProperty: action.payload,
        };
      } else {
        state.options.funnelProperty = action.payload;
      }
    },

    changeFunnelMeasure(
      state,
      action: PayloadAction<z.infer<typeof zFunnelMeasure> | undefined>
    ) {
      state.dirty = true;
      const measure = action.payload || undefined;
      if (!state.options || state.options.type !== 'funnel') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'funnel',
          funnelMeasure: measure,
        };
      } else {
        state.options.funnelMeasure = measure;
      }
    },

    changeFunnelHiddenBreakdowns(state, action: PayloadAction<string[]>) {
      state.dirty = true;
      const next = action.payload.length > 0 ? action.payload : undefined;
      if (!state.options || state.options.type !== 'funnel') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'funnel',
          hiddenBreakdowns: next,
        };
      } else {
        state.options.hiddenBreakdowns = next;
      }
    },

    changeDateConfig(state, action: PayloadAction<IDateConfig | undefined>) {
      state.dirty = true;
      state.dateConfig = action.payload;
      // Clear concrete dates for relative modes — they resolve from dateConfig at query time
      if (action.payload && action.payload.dateMode !== 'fixed') {
        state.startDate = null;
        state.endDate = null;
      }
    },

    changeFunnelBreakdownStep(
      state,
      action: PayloadAction<number | undefined>
    ) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'funnel') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'funnel',
          funnelGroup: undefined,
          funnelWindow: undefined,
          breakdownStep: action.payload,
        };
      } else {
        state.options.breakdownStep = action.payload;
      }
    },
    changeOptions(state, action: PayloadAction<IReportOptions | undefined>) {
      state.dirty = true;
      state.options = action.payload || undefined;
    },
    changeSankeyMode(
      state,
      action: PayloadAction<'between' | 'after' | 'before'>
    ) {
      state.dirty = true;
      if (!state.options) {
        state.options = {
          type: 'sankey',
          mode: action.payload,
          steps: 5,
          exclude: [],
        };
      } else if (state.options.type === 'sankey') {
        state.options.mode = action.payload;
      }
    },
    changeSankeySteps(state, action: PayloadAction<number>) {
      state.dirty = true;
      if (!state.options) {
        state.options = {
          type: 'sankey',
          mode: 'after',
          steps: action.payload,
          exclude: [],
        };
      } else if (state.options.type === 'sankey') {
        state.options.steps = action.payload;
      }
    },
    changeSankeyExclude(state, action: PayloadAction<string[]>) {
      state.dirty = true;
      if (!state.options) {
        state.options = {
          type: 'sankey',
          mode: 'after',
          steps: 5,
          exclude: action.payload,
        };
      } else if (state.options.type === 'sankey') {
        state.options.exclude = action.payload;
      }
    },
    changeSankeyInclude(state, action: PayloadAction<string[] | undefined>) {
      state.dirty = true;
      if (!state.options) {
        state.options = {
          type: 'sankey',
          mode: 'after',
          steps: 5,
          exclude: [],
          include: action.payload,
        };
      } else if (state.options.type === 'sankey') {
        state.options.include = action.payload;
      }
    },
    changeStacked(state, action: PayloadAction<boolean>) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'histogram') {
        state.options = {
          displayMode: state.options?.displayMode,
          type: 'histogram',
          stacked: action.payload,
        };
      } else {
        state.options.stacked = action.payload;
      }
    },
    reorderEvents(
      state,
      action: PayloadAction<{ fromIndex: number; toIndex: number }>
    ) {
      state.dirty = true;
      const { fromIndex, toIndex } = action.payload;
      const [movedEvent] = state.series.splice(fromIndex, 1);
      if (movedEvent) {
        state.series.splice(toIndex, 0, movedEvent);
      }
    },
  },
});

// Action creators are generated for each case reducer function
export const {
  reset,
  ready,
  changeCohortBreakdown,
  changeCohortFilters,
  setReport,
  hydrateDraftReport,
  setName,
  addSerie,
  removeEvent,
  duplicateEvent,
  changeEvent,
  addBreakdown,
  removeBreakdown,
  changeBreakdown,
  changeInterval,
  changeStartDate,
  changeEndDate,
  changeDateRanges,
  changeChartType,
  changeLineType,
  resetDirty,
  changeFormula,
  changePrevious,
  changeDisplayMode,
  changeCriteria,
  changeUnit,
  changeRetentionMetric,
  changeRetentionProperty,
  changeRetentionUnit,
  changeRetentionPropertyAverageDenominatorStep,
  changeRetentionTopN,
  changeRetentionBreakdownSort,
  changeFunnelGroup,
  changeFunnelWindow,
  changeFunnelWindowUnit,
  changeFunnelTopN,
  changeFunnelProperty,
  changeFunnelMeasure,
  changeFunnelHiddenBreakdowns,
  changeDateConfig,
  changeFunnelBreakdownStep,
  changeOptions,
  changeSankeyMode,
  changeSankeySteps,
  changeSankeyExclude,
  changeSankeyInclude,
  changeStacked,
  reorderEvents,
} = reportSlice.actions;

export default reportSlice.reducer;
