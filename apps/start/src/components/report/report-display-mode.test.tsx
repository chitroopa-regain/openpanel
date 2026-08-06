// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportDisplayMode } from './report-display-mode';

const dispatch = vi.fn();

vi.mock('@/redux', () => ({
  useDispatch: () => dispatch,
  useSelector: () => 'both',
}));

afterEach(() => {
  cleanup();
  dispatch.mockClear();
});

describe('ReportDisplayMode', () => {
  it('renders all three choices and dispatches the selected mode', () => {
    render(<ReportDisplayMode />);

    expect(screen.getByLabelText('Show chart and table')).toBeTruthy();
    expect(screen.getByLabelText('Show chart only')).toBeTruthy();
    expect(screen.getByLabelText('Show table only')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Show table only'));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'report/changeDisplayMode',
        payload: 'table',
      })
    );
  });
});
