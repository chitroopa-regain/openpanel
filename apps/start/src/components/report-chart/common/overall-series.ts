import type { IChartData } from '@/trpc/client';

/**
 * Reserved series id for the whole-population companion the server returns
 * as `overall` beside a breakdown. Never present in `data.series`, so it
 * can be recognised wherever the row/line/card is drawn and kept outside
 * positional colours, visibility toggles and top-N.
 */
export const OVERALL_SERIE_ID = '__overall__';

export const OVERALL_SERIE_NAME = 'Overall';

type Serie = IChartData['series'][number];

/**
 * The overall companion shaped as a series (`null` when absent — responses
 * cached before the field existed, or no breakdown). Names are replaced by
 * the single "Overall" label: the event name is the same on every bucket.
 */
export function getOverallSerie(data: {
  overall?: Serie | null;
}): Serie | null {
  const overall = data.overall;
  if (!overall) {
    return null;
  }
  return { ...overall, id: OVERALL_SERIE_ID, names: [OVERALL_SERIE_NAME] };
}

/** Stroke colour shared by every neutral "Overall" line/swatch. */
export const OVERALL_STROKE = 'currentColor';
