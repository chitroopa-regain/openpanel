import type {
  IChartBreakdown,
  IChartEvent,
  IChartEventFilter,
  IChartEventItem,
  IChartFormula,
  IReportInput,
  IReportInputWithDates,
} from '@openpanel/validation';

/**
 * Series Definition - The input representation of what the user wants
 * This is what comes from the frontend (events or formulas)
 */
export type SeriesDefinition = IChartEventItem;

/**
 * Concrete Series - A resolved series that will be displayed as a line/bar on the chart
 * When breakdowns exist, one SeriesDefinition can expand into multiple ConcreteSeries
 */
export type ConcreteSeries = {
  id: string;
  definitionId: string; // ID of the SeriesDefinition this came from
  definitionIndex: number; // Index in the original series array (for A, B, C references)
  name: string[]; // Display name parts: ["Session Start", "Chrome"] or ["Formula 1"]
  
  // Context for Drill-down / Profiles
  // This contains everything needed to query 'who are these users?'
  context: {
    event?: string; // Event name (if this is an event series)
    filters: IChartEventFilter[]; // All filters including breakdown value
    breakdownValue?: string; // The breakdown value for this concrete series (deprecated, use breakdowns instead)
    breakdowns?: Record<string, string>; // Breakdown keys and values: { country: 'SE', path: '/ewoqmepwq' }
    /**
     * Set when this series came from a COHORT breakdown. Identity is the id,
     * never the name: cohort names are user-editable and not unique, so two
     * cohorts sharing a name would otherwise be indistinguishable downstream
     * and could collide in chart/React keys.
     */
    cohortId?: string;
  };

  // Data points for this series
  data: Array<{
    date: string;
    count: number;
    total_count?: number;
  }>;

  // The original definition (event or formula)
  definition: SeriesDefinition;
};

/**
 * Plan - The execution plan after normalization and expansion
 */
export type Plan = {
  concreteSeries: ConcreteSeries[];
  definitions: SeriesDefinition[];
  input: IReportInputWithDates;
  timezone: string;
  /**
   * The instant cohort membership is evaluated at. Set explicitly so the
   * PREVIOUS period uses the same snapshot as the current one — resolving it
   * from each plan's own endDate would compare two different populations and
   * conflate membership change with behaviour change.
   */
  membershipAsOf?: string;
};

/**
 * Chart Response - The final output format
 */
export type ChartResponse = {
  series: Array<{
    id: string;
    name: string[];
    data: Array<{
      date: string;
      value: number;
      previous?: number;
    }>;
    summary: {
      total: number;
      average: number;
      min: number;
      max: number;
      count?: number;
    };
    context?: ConcreteSeries['context']; // Include context for drill-down
  }>;
  summary: {
    total: number;
    average: number;
    min: number;
    max: number;
  };
};

