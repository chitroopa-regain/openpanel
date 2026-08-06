import { describe, expect, it } from 'vitest';
import {
  getReportDisplayMode,
  getReportDisplayVisibility,
} from './display-mode';

describe('report display mode', () => {
  it('preserves existing editor and dashboard defaults', () => {
    expect(getReportDisplayMode({ options: undefined }, 'default')).toBe(
      'both'
    );
    expect(getReportDisplayMode({ options: undefined }, 'dashboard')).toBe(
      'chart'
    );
  });

  it('honors the saved mode in every layout', () => {
    const report = {
      options: { type: 'generic' as const, displayMode: 'table' as const },
    };
    expect(getReportDisplayMode(report, 'default')).toBe('table');
    expect(getReportDisplayMode(report, 'dashboard')).toBe('table');
    expect(getReportDisplayVisibility('table')).toEqual({
      showChart: false,
      showTable: true,
    });
    expect(getReportDisplayVisibility('both')).toEqual({
      showChart: true,
      showTable: true,
    });
    expect(getReportDisplayVisibility('chart')).toEqual({
      showChart: true,
      showTable: false,
    });
  });
});
