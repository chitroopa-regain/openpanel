/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ComboboxAdvanced } from './combobox-advanced';

const ITEMS = [
  { value: 'meta-ads', label: 'meta-ads' },
  { value: 'apps.facebook.com', label: 'apps.facebook.com' },
  { value: 'apps.instagram.com', label: 'apps.instagram.com' },
];
const SELECT_SOURCES = /select sources/i;

afterEach(cleanup);

function Harness() {
  const [value, setValue] = useState<string[]>([]);

  return (
    <>
      <ComboboxAdvanced
        items={ITEMS}
        onChange={setValue}
        placeholder="Select sources"
        value={value}
      />
      <output aria-label="selected values">{value.join(',')}</output>
    </>
  );
}

describe('ComboboxAdvanced', () => {
  it('preserves the search query while selecting multiple matching values', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: SELECT_SOURCES }));

    const search = screen.getByPlaceholderText('Search');
    fireEvent.change(search, { target: { value: 'apps' } });

    fireEvent.click(screen.getByText('apps.facebook.com'));

    expect((search as HTMLInputElement).value).toBe('apps');
    expect(screen.getByText('Select all matching (2)')).toBeTruthy();

    fireEvent.click(screen.getByText('apps.instagram.com'));

    expect((search as HTMLInputElement).value).toBe('apps');
    expect(screen.getByLabelText('selected values').textContent).toBe(
      'apps.facebook.com,apps.instagram.com'
    );
  });
});
