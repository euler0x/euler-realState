/** @jest-environment node */
import { expect, jest } from '@jest/globals';
import type { SearchEvent } from '~/types';
import { emitSearchEvent, getBuffer, subscribe } from '../events';

const ev = (phase: 'intake' | 'done'): SearchEvent => ({ type: 'phase', phase });

describe('search events', () => {
  it('buffers events for late subscribers and notifies live ones', () => {
    emitSearchEvent('e1', ev('intake'));
    expect(getBuffer('e1')).toEqual([ev('intake')]);

    const listener = jest.fn();
    const unsub = subscribe('e1', listener);
    emitSearchEvent('e1', ev('done'));
    expect(listener).toHaveBeenCalledWith(ev('done'));

    unsub();
    emitSearchEvent('e1', ev('done'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates channels per search id', () => {
    emitSearchEvent('a', ev('intake'));
    expect(getBuffer('b')).toEqual([]);
  });
});
