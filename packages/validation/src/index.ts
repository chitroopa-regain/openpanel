import {
  chartSegments,
  chartTypes,
  intervals,
  lineTypes,
  metrics,
  operators,
  timeWindows,
} from '@openpanel/constants';
import { z } from 'zod';

export function objectToZodEnums<K extends string>(
  obj: Record<K, any>
): [K, ...K[]] {
  const [firstKey, ...otherKeys] = Object.keys(obj) as K[];
  return [firstKey!, ...otherKeys];
}

export const mapKeys = objectToZodEnums;

export const zChartEventFilter = z.object({
  id: z.string().optional().describe('Unique identifier for the filter'),
  name: z.string().describe('The property name to filter on'),
  operator: z
    .enum(objectToZodEnums(operators))
    .describe('The operator to use for the filter'),
  value: z
    .array(z.string().or(z.number()).or(z.boolean()).or(z.null()))
    .describe('The values to filter on'),
});

export const zChartEventSegment = z
  .enum(objectToZodEnums(chartSegments))
  .default('event')
  .describe('Defines how the event data should be segmented or aggregated');

/**
 * ONE row of the report's cohort filter. Cohort ids inside a row are
 * OR-combined — Mixpanel's semantics, where adding a cohort to a row WIDENS the
 * population. Rows themselves AND together (see `zCohortFilters`), exactly like
 * the property filter rows beside them.
 *
 * There is deliberately no per-metric scope: membership is a property of the
 * profile, pinned at one instant, so scoping a cohort to one funnel step or one
 * retention leg cannot change the answer.
 */
export const zCohortFilter = z.object({
  operator: z.enum(['in', 'not_in']).default('in'),
  cohortIds: z
    .array(z.string())
    .min(1)
    .max(5)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate cohort ids'),
});
export type ICohortFilter = z.infer<typeof zCohortFilter>;

/**
 * The report's cohort filter: an ordered list of rows. Ids within a row are OR,
 * rows AND together. Order is preserved so a saved report renders its rows the
 * way they were written.
 */
export const zCohortFilters = z.array(zCohortFilter).max(5);
export type ICohortFilters = z.infer<typeof zCohortFilters>;

export const zChartEvent = z.object({
  id: z
    .string()
    .optional()
    .describe('Unique identifier for the chart event configuration'),
  name: z.string().describe('The name of the event as tracked in the system'),
  displayName: z
    .string()
    .optional()
    .describe('A user-friendly name for display purposes'),
  hidden: z
    .boolean()
    .optional()
    .describe('When true, hide this metric from chart visualizations'),
  property: z
    .string()
    .optional()
    .describe(
      'Optional property of the event used for specific segment calculations (e.g., value for property_sum/average)'
    ),
  segment: zChartEventSegment,
  filters: z
    .array(zChartEventFilter)
    .default([])
    .describe('Filters applied specifically to this event'),
  firstTimeFilter: z
    .boolean()
    .optional()
    .describe(
      'When true, only match this event if it is the users absolute first-ever occurrence'
    ),
});

export const zChartFormula = z.object({
  id: z
    .string()
    .optional()
    .describe('Unique identifier for the formula configuration'),
  type: z.literal('formula'),
  formula: z.string().describe('The formula expression (e.g., A+B, A/B)'),
  displayName: z
    .string()
    .optional()
    .describe('A user-friendly name for display purposes'),
  hidden: z
    .boolean()
    .optional()
    .describe('When true, hide this metric from chart visualizations'),
});

// Event with type field for discriminated union
export const zChartEventWithType = zChartEvent.extend({
  type: z.literal('event'),
});

export const zChartCustomEvent = z.object({
  id: z.string().optional(),
  type: z.literal('custom_event'),
  customEventId: z.string().describe('UUID of the CustomEvent definition'),
  displayName: z
    .string()
    .optional()
    .describe('A user-friendly name for display purposes'),
  hidden: z
    .boolean()
    .optional()
    .describe('When true, hide this metric from chart visualizations'),
  segment: zChartEventSegment,
  filters: z
    .array(zChartEventFilter)
    .default([])
    .describe('Filters applied to the custom event'),
  property: z
    .string()
    .optional()
    .describe(
      'Optional property for specific segment calculations (e.g., value for property_sum/average)'
    ),
  firstTimeFilter: z
    .boolean()
    .optional()
    .describe(
      'When true, only match this custom event if it is the users absolute first-ever occurrence'
    ),
});

export const zChartEventItem = z.discriminatedUnion('type', [
  zChartEventWithType,
  zChartFormula,
  zChartCustomEvent,
]);

export const zCustomEventComponent = z.object({
  eventName: z.string().describe('The real event name in ClickHouse'),
  filters: z
    .array(zChartEventFilter)
    .default([])
    .describe('Optional per-event filters'),
});

export const zCustomEventInput = z.object({
  name: z.string().min(1),
  projectId: z.string(),
  components: z
    .array(zCustomEventComponent)
    .min(1)
    .describe('At least one sub-event required'),
  color: z.string().optional(),
  icon: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Custom Cohorts (audience definitions)
// ---------------------------------------------------------------------------
// A cohort resolves to a set of profile_ids. It is referenced by id from a
// report's `audience` and compiled server-side into a membership predicate.
// See custom-cohort.service.ts for the compiler.

/**
 * Date.parse() normalises impossible dates (2026-02-30 becomes March 2nd), so a
 * round-trip comparison is the only way to reject them.
 */
function isRealDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

export const zCustomCohortWindow = z.union([
  z.object({
    type: z.literal('last'),
    amount: z.number().int().positive().max(730),
    unit: z.enum(['day', 'week', 'month']),
  }),
  z.object({
      type: z.literal('fixed'),
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
    })
    .refine((w) => w.start <= w.end, {
      message: 'Window start must be on or before end',
    })
    .refine((w) => isRealDate(w.start) && isRealDate(w.end), {
      message: 'Window dates must be real calendar dates',
    }),
  z.object({ type: z.literal('ever') }),
]);

export const zCustomCohortAggregate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('total_events') }),
  z.object({ kind: z.literal('distinct_days') }),
  z.object({
    kind: z.literal('property_sum'),
    property: z.string().min(1),
    coercion: z.enum(['float_or_null', 'float_or_zero']).default('float_or_null'),
  }),
  z.object({
    kind: z.literal('property_average'),
    property: z.string().min(1),
    coercion: z.enum(['float_or_null', 'float_or_zero']).default('float_or_null'),
  }),
]);

export const zCustomCohortCriterion = z.object({
  id: z.string().optional(),
  kind: z.enum(['did', 'did_not']).default('did'),
  /** Event name, or a reference to a CustomEvent definition. */
  event: z.union([z.string().min(1), z.object({ customEventId: z.string() })]),
  aggregate: zCustomCohortAggregate.default({ kind: 'total_events' }),
  operator: z.enum(['gte', 'lte', 'eq', 'between']).default('gte'),
  value: z.number(),
  value2: z.number().optional(),
  window: zCustomCohortWindow,
  /**
   * Only meaningful for kind='did_not'. Defines the population the criterion
   * subtracts from. 'all_identified' means a dormant user with zero events in
   * the window DOES match "did not do X".
   */
  universe: z.enum(['all_identified', 'active_in_window']).default('all_identified'),
  /**
   * Property filters. The `name` is restricted here as defence in depth: it
   * reaches SQL generation, and while the generator now escapes the key, a
   * cohort definition is stored and replayed server-side so it should not be
   * able to carry arbitrary text into a query in the first place.
   */
  filters: z
    .array(
      zChartEventFilter.extend({
        name: z
          .string()
          .regex(
            /^[a-zA-Z0-9_.\-*\[\]]+$/,
            'Property name contains unsupported characters',
          ),
      }),
    )
    .default([]),
});

export const zCustomCohortGroup = z.object({
  id: z.string().optional(),
  op: z.enum(['and', 'or']).default('and'),
  criteria: z.array(zCustomCohortCriterion).min(1).max(10),
});

export const zCustomCohortDefinition = z.object({
  op: z.enum(['and', 'or']).default('and'),
  groups: z.array(zCustomCohortGroup).min(1).max(10),
});

export const zCustomCohortInput = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  projectId: z.string(),
  definition: zCustomCohortDefinition,
});

/**
 * Breakdown by cohort: one series per selected cohort.
 *
 * Deliberately NOT part of `breakdowns[]`. Every consumer of that array treats
 * `breakdown.name` as a column reference — it flows into getSelectPropertyKey,
 * into GROUP BY, and into `context.breakdowns` as { country: 'SE' }. A cohort id
 * there would either be rejected by the identifier check or generate nonsense
 * SQL. The picker lives in the Breakdown menu; the value lives in its own field.
 */
export const zCohortBreakdown = z.object({
  cohortIds: z
    .array(z.string())
    .max(5)
    // Duplicates would produce two indistinguishable series over the same
    // membership set. Selection ORDER is preserved so series order is stable.
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate cohort ids')
    .default([]),
});
export type ICohortBreakdown = z.infer<typeof zCohortBreakdown>;

export type ICustomCohortWindow = z.infer<typeof zCustomCohortWindow>;
export type ICustomCohortAggregate = z.infer<typeof zCustomCohortAggregate>;
export type ICustomCohortCriterion = z.infer<typeof zCustomCohortCriterion>;
export type ICustomCohortGroup = z.infer<typeof zCustomCohortGroup>;
export type ICustomCohortDefinition = z.infer<typeof zCustomCohortDefinition>;

export const zChartBreakdown = z.object({
  id: z.string().optional(),
  name: z.string(),
});

export const zChartSeries = z
  .array(zChartEventItem)
  .describe(
    'Array of series (events or formulas) to be tracked and displayed in the chart'
  );

export const zChartBreakdowns = z.array(zChartBreakdown);

export const zChartType = z.enum(objectToZodEnums(chartTypes));

export const zLineType = z.enum(objectToZodEnums(lineTypes));

export const zTimeInterval = z.enum(objectToZodEnums(intervals));

export const zMetric = z.enum(objectToZodEnums(metrics));

export const zRange = z.enum(objectToZodEnums(timeWindows));

export const zCriteria = z.enum(['on_or_after', 'on', 'on_or_before']);
export const zRetentionTimeUnit = z.enum(['day', 'week', 'month']);
export const zRetentionBreakdownSort = z.enum([
  'profile_count_desc',
  'profile_count_asc',
]);
export const zRetentionMeasure = z.enum([
  'retention_rate',
  'unique_users',
  'property_sum',
  'property_average',
]);
export const zReportDisplayMode = z.enum(['both', 'chart', 'table']);

// Report Options - Discriminated union based on chart type
export const zFunnelWindowUnit = z.enum([
  'second',
  'minute',
  'hour',
  'day',
  'week',
  'month',
]);
export const zFunnelMeasure = z.enum([
  'conversion_rate',
  'unique_users',
  'property_sum',
  'property_average',
]);

export const zFunnelOptions = z.object({
  type: z.literal('funnel'),
  displayMode: zReportDisplayMode.optional(),
  funnelGroup: z.string().optional(),
  funnelWindow: z.number().optional(),
  funnelWindowUnit: zFunnelWindowUnit.optional(),
  /** 0-based step index for breakdown extraction. undefined = all steps (current behavior). */
  breakdownStep: z.number().int().nonnegative().optional(),
  /** Number of top breakdown rows to show in chart. undefined = 10. */
  topN: z.number().int().positive().optional(),
  /** Property to aggregate for funnel property measures (e.g. 'properties.value_inr') */
  funnelProperty: z.string().optional(),
  /** Measure displayed for funnel breakdown comparison. */
  funnelMeasure: zFunnelMeasure.optional(),
  /** Breakdown IDs explicitly hidden by the user. Survives reload. */
  hiddenBreakdowns: z.array(z.string()).optional(),
});

export const zRetentionOptions = z.object({
  type: z.literal('retention'),
  displayMode: zReportDisplayMode.optional(),
  criteria: zCriteria.optional(),
  funnelGroup: z.string().optional(),
  day: z.number().optional(),
  metric: zRetentionMeasure.optional(),
  property: z.string().optional(),
  /** Time unit used for retention return buckets. Independent from report.interval, which controls cohort aggregation. */
  retentionUnit: zRetentionTimeUnit.optional(),
  /** 0-based retention step used as the denominator for Property Average. undefined/0 = step 1 cohort users. */
  propertyAverageDenominatorStep: z.number().int().nonnegative().optional(),
  /** Number of highest-profile-count breakdowns shown. undefined = 20. */
  topN: z.number().int().positive().max(20).optional(),
  /** Display order for the selected top breakdowns. */
  breakdownSort: zRetentionBreakdownSort.optional(),
});

export const zSankeyOptions = z.object({
  type: z.literal('sankey'),
  displayMode: zReportDisplayMode.optional(),
  mode: z.enum(['between', 'after', 'before']),
  steps: z.number().min(2).max(10).default(5),
  exclude: z.array(z.string()).default([]),
  include: z.array(z.string()).optional(),
});

export const zHistogramOptions = z.object({
  type: z.literal('histogram'),
  displayMode: zReportDisplayMode.optional(),
  stacked: z.boolean().default(false),
});

export const zGenericReportOptions = z.object({
  type: z.literal('generic'),
  displayMode: zReportDisplayMode.optional(),
});

export const zReportOptions = z.discriminatedUnion('type', [
  zFunnelOptions,
  zRetentionOptions,
  zSankeyOptions,
  zHistogramOptions,
  zGenericReportOptions,
]);

export type IReportOptions = z.infer<typeof zReportOptions>;
export type ISankeyOptions = z.infer<typeof zSankeyOptions>;
export type IHistogramOptions = z.infer<typeof zHistogramOptions>;

export const zWidgetType = z.enum(['realtime', 'counter']);
export type IWidgetType = z.infer<typeof zWidgetType>;

export const zRealtimeWidgetOptions = z.object({
  type: z.literal('realtime'),
  referrers: z.boolean().default(true),
  countries: z.boolean().default(true),
  paths: z.boolean().default(false),
});

export const zCounterWidgetOptions = z.object({
  type: z.literal('counter'),
});

export const zWidgetOptions = z.discriminatedUnion('type', [
  zRealtimeWidgetOptions,
  zCounterWidgetOptions,
]);

export type IWidgetOptions = z.infer<typeof zWidgetOptions>;
export type ICounterWidgetOptions = z.infer<typeof zCounterWidgetOptions>;
export type IRealtimeWidgetOptions = z.infer<typeof zRealtimeWidgetOptions>;

export const zDateConfig = z.object({
  dateMode: z.enum(['fixed', 'last', 'since', 'period_to_date']),
  fixedStartDate: z.string().nullish(),
  fixedEndDate: z.string().nullish(),
  lastAmount: z.number().nullish(),
  lastUnit: z.string().nullish(),
  lastEndingDaysAgo: z.number().nullish(),
  sinceDate: z.string().nullish(),
  periodToDateUnit: z.string().nullish(),
  enableTimeRanges: z.boolean().nullish(),
});

export type IDateConfig = z.infer<typeof zDateConfig>;

// Base input schema - for API calls, engine, chart queries
export const zReportInput = z.object({
  projectId: z.string().describe('The ID of the project this chart belongs to'),
  chartType: zChartType
    .default('linear')
    .describe('What type of chart should be displayed'),
  interval: zTimeInterval
    .default('day')
    .describe(
      'The time interval for data aggregation (e.g., day, week, month)'
    ),
  series: zChartSeries.describe(
    'Array of series (events or formulas) to be tracked and displayed in the chart'
  ),
  breakdowns: zChartBreakdowns
    .default([])
    .describe('Array of dimensions to break down the data by'),
  range: zRange
    .default('30d')
    .describe('The time range for which data should be displayed'),
  startDate: z
    .string()
    .nullish()
    .describe(
      'Custom start date for the data range (overrides range if provided)'
    ),
  endDate: z
    .string()
    .nullish()
    .describe(
      'Custom end date for the data range (overrides range if provided)'
    ),
  previous: z
    .boolean()
    .default(false)
    .describe('Whether to show data from the previous period for comparison'),
  formula: z
    .string()
    .optional()
    .describe('Custom formula for calculating derived metrics'),
  metric: zMetric
    .default('sum')
    .describe(
      'The aggregation method for the metric (e.g., sum, count, average)'
    ),
  limit: z
    .number()
    .optional()
    .describe('Limit how many series should be returned'),
  offset: z
    .number()
    .optional()
    .describe('Skip how many series should be returned'),
  options: zReportOptions
    .optional()
    .describe('Chart-specific options (funnel, retention, sankey)'),
  cohortFilters: zCohortFilters
    .optional()
    .describe(
      'Report-level cohort filter rows: restrict EVERY series to cohort members. Ids within a row are OR-combined, rows AND together.'
    ),
  cohortBreakdown: zCohortBreakdown
    .optional()
    .describe(
      'Split the chart into one series per cohort. Overlapping members are counted in every matching series.'
    ),
  dateConfig: zDateConfig
    .optional()
    .describe('Custom date mode config (fixed, last, since, period_to_date)'),
  // Optional display fields
  name: z.string().optional().describe('The user-defined name for the report'),
  lineType: zLineType
    .optional()
    .describe('The visual style of the line in the chart'),
  unit: z
    .string()
    .optional()
    .describe(
      "Optional unit of measurement for the chart's Y-axis (e.g., $, %, users)"
    ),
  // Cache-control: forces the server to bypass the cached result, recompute
  // from ClickHouse and overwrite the shared entry. Stripped from the cache
  // key so a refresh updates the same entry everyone else reads.
  bypassCache: z
    .boolean()
    .optional()
    .describe('Bypass the cached result and recompute from source'),
});

// Complete report schema - for saved reports
export const zReport = zReportInput.extend({
  name: z
    .string()
    .default('Untitled')
    .describe('The user-defined name for the report'),
  lineType: zLineType
    .default('monotone')
    .describe('The visual style of the line in the chart'),
});

// Alias for backward compatibility
export const zChartInput = zReportInput;

export const zInviteUser = z.object({
  email: z.string().email(),
  organizationId: z.string(),
  role: z.enum(['org:admin', 'org:member']),
  access: z.array(z.string()),
});

export const zShareOverview = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  password: z.string().nullable(),
  public: z.boolean(),
});

export const zShareDashboard = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  dashboardId: z.string(),
  password: z.string().nullable(),
  public: z.boolean(),
});

export const zShareReport = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  reportId: z.string(),
  password: z.string().nullable(),
  public: z.boolean(),
});

export const zCreateReference = z.object({
  title: z.string(),
  description: z.string().nullish(),
  projectId: z.string(),
  datetime: z.string(),
});

export const zOnboardingProject = z
  .object({
    organization: z.string().optional(),
    organizationId: z.string().optional(),
    project: z.string().min(3),
    domain: z.string().url().or(z.literal('').or(z.null())),
    cors: z.array(z.string()).default([]),
    website: z.boolean(),
    app: z.boolean(),
    backend: z.boolean(),
    timezone: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (!(data.organization || data.organizationId)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Organization is required',
        path: ['organization'],
      });
      ctx.addIssue({
        code: 'custom',
        message: 'Organization is required',
        path: ['organizationId'],
      });
    }

    if (data.website && !data.domain) {
      ctx.addIssue({
        code: 'custom',
        message: 'Domain is required for website tracking',
        path: ['domain'],
      });
    }

    if (
      data.website === false &&
      data.app === false &&
      data.backend === false
    ) {
      for (const key of ['app', 'backend', 'website']) {
        ctx.addIssue({
          code: 'custom',
          message: 'At least one type must be selected',
          path: [key],
        });
      }
    }
  });

export const zSlackAuthResponse = z.object({
  ok: z.literal(true),
  app_id: z.string(),
  authed_user: z.object({
    id: z.string(),
  }),
  scope: z.string(),
  token_type: z.literal('bot'),
  access_token: z.string(),
  bot_user_id: z.string(),
  team: z.object({
    id: z.string(),
    name: z.string(),
  }),
  incoming_webhook: z.object({
    channel: z.string(),
    channel_id: z.string(),
    configuration_url: z.string().url(),
    url: z.string().url(),
  }),
});

export const zSlackConfig = z
  .object({
    type: z.literal('slack'),
  })
  .merge(zSlackAuthResponse);

export type ISlackConfig = z.infer<typeof zSlackConfig>;

export const zWebhookConfig = z.object({
  type: z.literal('webhook'),
  url: z.string().url(),
  headers: z.record(z.string()),
  payload: z.record(z.string(), z.unknown()).optional(),
  mode: z.enum(['message', 'javascript']).default('message'),
  javascriptTemplate: z.string().optional(),
});
export type IWebhookConfig = z.infer<typeof zWebhookConfig>;

export const zDiscordConfig = z.object({
  type: z.literal('discord'),
  url: z.string().url(),
});
export type IDiscordConfig = z.infer<typeof zDiscordConfig>;

export const zAppConfig = z.object({
  type: z.literal('app'),
});
export type IAppConfig = z.infer<typeof zAppConfig>;

export const zEmailConfig = z.object({
  type: z.literal('email'),
});
export type IEmailConfig = z.infer<typeof zEmailConfig>;

export type IIntegrationConfig =
  | ISlackConfig
  | IDiscordConfig
  | IWebhookConfig
  | IAppConfig
  | IEmailConfig;

const zCreateIntegration = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  organizationId: z.string().min(1),
});

export const zCreateSlackIntegration = zCreateIntegration;

export const zCreateWebhookIntegration = zCreateIntegration.merge(
  z.object({
    config: zWebhookConfig,
  })
);

export const zCreateDiscordIntegration = zCreateIntegration.merge(
  z.object({
    config: zDiscordConfig,
  })
);

export const zNotificationRuleEventConfig = z.object({
  type: z.literal('events'),
  events: z.array(zChartEvent),
});

export type INotificationRuleEventConfig = z.infer<
  typeof zNotificationRuleEventConfig
>;

export const zNotificationRuleFunnelConfig = z.object({
  type: z.literal('funnel'),
  events: z.array(zChartEvent).min(1),
});

export type INotificationRuleFunnelConfig = z.infer<
  typeof zNotificationRuleFunnelConfig
>;

export const zNotificationRuleConfig = z.discriminatedUnion('type', [
  zNotificationRuleEventConfig,
  zNotificationRuleFunnelConfig,
]);

export type INotificationRuleConfig = z.infer<typeof zNotificationRuleConfig>;

export const zCreateNotificationRule = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  template: z.string().optional(),
  config: zNotificationRuleConfig,
  integrations: z.array(z.string()),
  sendToApp: z.boolean(),
  sendToEmail: z.boolean(),
  projectId: z.string(),
});

export const zProjectFilterIp = z.object({
  type: z.literal('ip'),
  ip: z.string(),
});
export type IProjectFilterIp = z.infer<typeof zProjectFilterIp>;

export const zProjectFilterProfileId = z.object({
  type: z.literal('profile_id'),
  profileId: z.string(),
});
export type IProjectFilterProfileId = z.infer<typeof zProjectFilterProfileId>;

export const zProjectFilterEvent = zChartEvent.extend({
  type: z.literal('event'),
});
export type IProjectFilterEvent = z.infer<typeof zProjectFilterEvent>;

export const zProjectFilters = z.discriminatedUnion('type', [
  zProjectFilterIp,
  zProjectFilterProfileId,
  zProjectFilterEvent,
]);
export type IProjectFilters = z.infer<typeof zProjectFilters>;

export const zProject = z.object({
  id: z.string(),
  name: z.string().min(1),
  filters: z.array(zProjectFilters).default([]),
  domain: z.string().url().or(z.literal('').or(z.null())),
  cors: z.array(z.string()).default([]),
  crossDomain: z.boolean().default(false),
  allowUnsafeRevenueTracking: z.boolean().default(false),
});
export type IProjectEdit = z.infer<typeof zProject>;

export const zPassword = z.string().min(8);

export const zSignInEmail = z.object({
  email: z.string().email().min(1),
  password: zPassword,
});
export type ISignInEmail = z.infer<typeof zSignInEmail>;

export const zSignUpEmail = z
  .object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    email: z.string().email(),
    password: zPassword,
    confirmPassword: zPassword,
    inviteId: z.string().nullish(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });
export type ISignUpEmail = z.infer<typeof zSignUpEmail>;

export const zResetPassword = z.object({
  token: z.string(),
  password: z.string().min(8),
});
export type IResetPassword = z.infer<typeof zResetPassword>;

export const zRequestResetPassword = z.object({
  email: z.string().email(),
});
export type IRequestResetPassword = z.infer<typeof zRequestResetPassword>;

export const zSignInShare = z.object({
  password: z.string().min(1),
  shareId: z.string().min(1),
  shareType: z
    .enum(['overview', 'dashboard', 'report'])
    .optional()
    .default('overview'),
});
export type ISignInShare = z.infer<typeof zSignInShare>;

export const zCheckout = z.object({
  productPriceId: z.string(),
  organizationId: z.string(),
  projectId: z.string().nullish(),
  productId: z.string(),
});
export type ICheckout = z.infer<typeof zCheckout>;

export const zEditOrganization = z.object({
  id: z.string().min(2),
  name: z.string().min(2),
  timezone: z.string().min(1),
});

const zProjectMapper = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

const createFileImportConfig = <T extends string>(provider: T) =>
  z.object({
    provider: z.literal(provider),
    type: z.literal('file'),
    fileUrl: z.string().url(),
  });

// Import configs
export const zUmamiImportConfig = createFileImportConfig('umami').extend({
  projectMapper: z.array(zProjectMapper),
});

export type IUmamiImportConfig = z.infer<typeof zUmamiImportConfig>;

export const zPlausibleImportConfig = createFileImportConfig('plausible');
export type IPlausibleImportConfig = z.infer<typeof zPlausibleImportConfig>;

export const zMixpanelImportConfig = z.object({
  provider: z.literal('mixpanel'),
  type: z.literal('api'),
  serviceAccount: z.string().min(1),
  serviceSecret: z.string().min(1),
  projectId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  mapScreenViewProperty: z.string().optional(),
});
export type IMixpanelImportConfig = z.infer<typeof zMixpanelImportConfig>;

export type IImportConfig =
  | IUmamiImportConfig
  | IPlausibleImportConfig
  | IMixpanelImportConfig;

export const zCreateImport = z.object({
  projectId: z.string().min(1),
  provider: z.enum(['umami', 'plausible', 'mixpanel']),
  config: z.union([
    zUmamiImportConfig,
    zPlausibleImportConfig,
    zMixpanelImportConfig,
  ]),
});

export type ICreateImport = z.infer<typeof zCreateImport>;

export * from './event-blocklist';
export * from './track.validation';
export * from './types.insights';
export * from './retention-series';
export * from './presentational-options';
