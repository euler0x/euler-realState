/** @jest-environment node */
import { expect, jest } from '@jest/globals';
import type { SearchEvent } from '~/types';
import { emitSearchEvent, getBuffer, subscribe, subscribeWithReplay } from '../events';

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

  it('a throwing listener does not stop delivery to subsequent listeners', () => {
    const broken = jest.fn(() => {
      throw new Error('closed stream');
    });
    const good = jest.fn();
    subscribe('err1', broken);
    subscribe('err1', good);
    emitSearchEvent('err1', ev('intake'));
    expect(broken).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledWith(ev('intake'));
  });

  it('subscribeWithReplay returns a snapshot of existing events and delivers new ones live', () => {
    emitSearchEvent('sw1', ev('intake'));
    const live = jest.fn();
    const { snapshot, unsub } = subscribeWithReplay('sw1', live);
    expect(snapshot).toEqual([ev('intake')]);
    emitSearchEvent('sw1', ev('done'));
    expect(live).toHaveBeenCalledWith(ev('done'));
    unsub();
    emitSearchEvent('sw1', ev('done'));
    expect(live).toHaveBeenCalledTimes(1);
  });
});
