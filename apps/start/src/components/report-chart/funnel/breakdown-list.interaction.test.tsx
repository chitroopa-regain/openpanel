// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ColumnResizeHandle } from './breakdown-list';

beforeAll(() => {
  window.PointerEvent = MouseEvent as typeof PointerEvent;
});

afterEach(cleanup);

describe('ColumnResizeHandle', () => {
  it('resizes by dragging the column boundary', () => {
    const onResize = vi.fn();

    render(
      <ColumnResizeHandle
        column="breakdown"
        label="Breakdown"
        onReset={vi.fn()}
        onResize={onResize}
        width={200}
      />
    );

    const handle = screen.getByRole('separator', {
      name: 'Resize Breakdown column',
    });
    expect((handle as HTMLElement).style.cursor).toBe('col-resize');
    fireEvent.pointerDown(handle, { button: 0, clientX: 200 });
    fireEvent.pointerMove(window, { clientX: 420 });
    fireEvent.pointerUp(window);

    expect(onResize).toHaveBeenLastCalledWith('breakdown', 420);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('supports keyboard resizing and double-click reset', () => {
    const onResize = vi.fn();
    const onReset = vi.fn();

    render(
      <ColumnResizeHandle
        column="breakdown"
        label="Breakdown"
        onReset={onReset}
        onResize={onResize}
        width={200}
      />
    );

    const handle = screen.getByRole('separator', {
      name: 'Resize Breakdown column',
    });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.doubleClick(handle);

    expect(onResize).toHaveBeenCalledWith('breakdown', 216);
    expect(onReset).toHaveBeenCalledWith('breakdown');
  });

  it('cleans up a cancelled drag and ignores later pointer movement', () => {
    const onResize = vi.fn();

    render(
      <ColumnResizeHandle
        column="breakdown"
        label="Breakdown"
        onReset={vi.fn()}
        onResize={onResize}
        width={200}
      />
    );

    const handle = screen.getByRole('separator', {
      name: 'Resize Breakdown column',
    });
    fireEvent.pointerDown(handle, { button: 0, clientX: 200 });
    fireEvent.pointerCancel(window);
    fireEvent.pointerMove(window, { clientX: 420 });

    expect(onResize).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('keeps a repeated metric boundary under the pointer in later steps', () => {
    const onResize = vi.fn();

    render(
      <ColumnResizeHandle
        boundaryWidthMultiplier={2}
        column="time"
        label="Time"
        onReset={vi.fn()}
        onResize={onResize}
        width={96}
      />
    );

    const handle = screen.getByRole('separator', {
      name: 'Resize Time column',
    });
    fireEvent.pointerDown(handle, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 132 });
    fireEvent.pointerUp(window);

    // The boundary contains two shared Time columns, so each grows by 16px
    // and their combined 32px growth follows the pointer exactly.
    expect(onResize).toHaveBeenLastCalledWith('time', 112);
  });
});
