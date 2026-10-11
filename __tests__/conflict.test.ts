import { applyPulledRecord, resolveConflict } from '../src/sync/conflict';
import type { WorkOrder } from '../src/core/types';

const order = (over: Partial<WorkOrder> = {}): WorkOrder => ({
  id: 'wo-1',
  title: 'local title',
  site: 'A',
  status: 'open',
  notes: 'local notes',
  updatedAt: 100,
  ...over,
});

describe('resolveConflict (LWW by updatedAt)', () => {
  it('local wins when strictly newer', () => {
    const r = resolveConflict(order({ updatedAt: 200 }), order({ updatedAt: 100, title: 'srv' }));
    expect(r.winner).toBe('local');
    expect(r.record.title).toBe('local title');
  });

  it('server wins when strictly newer', () => {
    const r = resolveConflict(order({ updatedAt: 100 }), order({ updatedAt: 200, title: 'srv' }));
    expect(r.winner).toBe('server');
    expect(r.record.title).toBe('srv');
  });

  it('ties go to the server (convergence point for all replicas)', () => {
    const r = resolveConflict(order({ updatedAt: 150 }), order({ updatedAt: 150, title: 'srv' }));
    expect(r.winner).toBe('server');
  });
});

describe('applyPulledRecord (local-pending-wins-until-acked)', () => {
  it('no local copy -> apply incoming', () => {
    const incoming = order({ updatedAt: 5 });
    expect(applyPulledRecord(undefined, incoming, false)).toBe(incoming);
  });

  it('incoming newer and no pending edit -> apply incoming', () => {
    const local = order({ updatedAt: 100 });
    const incoming = order({ updatedAt: 200, title: 'srv' });
    expect(applyPulledRecord(local, incoming, false)?.title).toBe('srv');
  });

  it('incoming newer but local edit still pending -> keep local', () => {
    const local = order({ updatedAt: 50 });
    const incoming = order({ updatedAt: 200, title: 'srv' });
    expect(applyPulledRecord(local, incoming, true)?.title).toBe('local title');
  });

  it('incoming older -> keep local regardless of pending state', () => {
    const local = order({ updatedAt: 300 });
    const incoming = order({ updatedAt: 200, title: 'srv' });
    expect(applyPulledRecord(local, incoming, false)?.title).toBe('local title');
    expect(applyPulledRecord(local, incoming, true)?.title).toBe('local title');
  });
});
