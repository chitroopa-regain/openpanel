// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ComboboxAdvanced } from './combobox-advanced';

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

function Picker({
  items = [],
  allowCustomValue = true,
  initial = [],
}: {
  items?: { value: string; label: string }[];
  allowCustomValue?: boolean;
  initial?: string[];
}) {
  const [value, setValue] = React.useState(initial);
  return (
    <>
      <ComboboxAdvanced
        items={items}
        value={value}
        onChange={setValue}
        allowCustomValue={allowCustomValue}
      >
        <button type="button">Values</button>
      </ComboboxAdvanced>
      <output data-testid="selection">{JSON.stringify(value)}</output>
    </>
  );
}

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Values' }));
  return screen.getByPlaceholderText('Search') as HTMLInputElement;
}
function query(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}
function selected() {
  return JSON.parse(screen.getByTestId('selection').textContent!);
}
const items = ['alpha one', 'alpha two', 'beta'].map((value) => ({
  value,
  label: value,
}));

describe('ComboboxAdvanced controlled interactions', () => {
  it('specifies an unavailable value by keyboard while suggestions are empty/loading, and removes it', async () => {
    const view = render(<Picker />);
    const input = open();
    query(input, '989b3ad7ba943263');
    expect(
      screen.getByRole('option', { name: 'Specify: 989b3ad7ba943263' })
    ).toBeTruthy();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(selected()).toEqual(['989b3ad7ba943263']));
    expect(input.value).toBe('989b3ad7ba943263');
    expect(screen.queryByText(/^Specify:/)).toBeNull();
    view.rerender(
      <Picker
        items={[{ value: '989b3ad7ba943263', label: '989b3ad7ba943263' }]}
      />
    );
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: '989b3ad7ba943263' }));
    expect(selected()).toEqual([]);
    expect(input.value).toBe('989b3ad7ba943263');
  });

  it('preserves the query across consecutive selection and removal parent rerenders', () => {
    render(<Picker items={items} />);
    const input = open();
    query(input, 'alpha');
    fireEvent.click(screen.getByRole('option', { name: 'alpha one' }));
    expect(input.value).toBe('alpha');
    fireEvent.click(screen.getByRole('option', { name: 'alpha two' }));
    expect(input.value).toBe('alpha');
    expect(selected()).toEqual(['alpha one', 'alpha two']);
    fireEvent.click(screen.getByRole('option', { name: 'alpha one' }));
    expect(input.value).toBe('alpha');
    expect(selected()).toEqual(['alpha two']);
  });

  it.each([
    '"MiXeD" 100% %2F &quot; \\ [x] 😃',
    'ABC',
    'abc',
  ])('round trips literal %s without URI/entity/case corruption', (raw) => {
    render(<Picker />);
    const input = open();
    query(input, raw);
    const specify = screen.getByRole('option');
    expect(specify.textContent).toBe(`Specify: ${raw}`);
    fireEvent.click(specify);
    expect(selected()).toEqual([raw]);
    expect(input.value).toBe(raw);
    expect(screen.queryByText(/^Specify:/)).toBeNull();
    fireEvent.click(screen.getByRole('option'));
    expect(selected()).toEqual([]);
  });

  it('does not offer whitespace or exact duplicates, but distinguishes case and label from value', () => {
    render(
      <Picker
        items={[
          { value: 'ABC', label: 'Pretty' },
          { value: 'ABC', label: 'Pretty' },
        ]}
      />
    );
    const input = open();
    expect(screen.getAllByRole('option')).toHaveLength(1);
    query(input, '   ');
    expect(screen.queryByText(/^Specify:/)).toBeNull();
    query(input, 'ABC');
    expect(screen.queryByText(/^Specify:/)).toBeNull();
    query(input, 'abc');
    fireEvent.click(screen.getByRole('option', { name: 'Specify: abc' }));
    expect(selected()).toEqual(['abc']);
    query(input, 'ABC');
    fireEvent.click(screen.getByRole('option', { name: 'Pretty' }));
    expect(selected()).toEqual(['abc', 'ABC']);
    query(input, 'Pretty');
    expect(
      screen.getByRole('option', { name: 'Specify: Pretty' })
    ).toBeTruthy();
  });

  it('select all only toggles matching suggestions, not custom or unrelated selections', () => {
    render(
      <Picker items={[...items, items[0]!]} initial={['custom', 'beta']} />
    );
    const input = open();
    query(input, 'alpha');
    fireEvent.click(
      screen.getByRole('button', { name: 'Select all matching (2)' })
    );
    expect(selected()).toEqual(['custom', 'beta', 'alpha one', 'alpha two']);
    expect(input.value).toBe('alpha');
    fireEvent.click(
      screen.getByRole('button', { name: 'Select all matching (2)' })
    );
    expect(selected()).toEqual(['custom', 'beta']);
    expect(input.value).toBe('alpha');
    expect(screen.getByRole('option', { name: 'Specify: alpha' })).toBeTruthy();
  });

  it('shows and stores trimmed custom boundaries consistently with filter persistence', () => {
    render(<Picker />);
    const input = open();
    query(input, '  custom ID  ');
    const option = screen.getByRole('option', { name: 'Specify: custom ID' });
    expect(option.textContent).toBe('Specify: custom ID');
    fireEvent.click(option);
    expect(selected()).toEqual(['custom ID']);
    expect(input.value).toBe('  custom ID  ');
    expect(screen.queryByText(/^Specify:/)).toBeNull();
  });

  it('keeps enum/settings pickers closed to custom values by default', () => {
    render(
      <ComboboxAdvanced items={items} value={[]} onChange={vi.fn()}>
        <button type="button">Values</button>
      </ComboboxAdvanced>
    );
    query(open(), 'not a project');
    expect(screen.queryByText(/^Specify:/)).toBeNull();
  });

  it('preserves literal fetched suggestions as well as custom values', () => {
    const raw = '"100%" &quot; %2F';
    render(<Picker items={[{ value: raw, label: raw }]} />);
    const input = open();
    query(input, raw);
    fireEvent.click(screen.getByRole('option'));
    expect(selected()).toEqual([raw]);
    expect(screen.queryByText(/^Specify:/)).toBeNull();
  });
});
