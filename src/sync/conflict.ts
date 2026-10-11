import type { WorkOrder } from '../core/types';

export interface ConflictResolution {
  winner: 'local' | 'server';
  /** The record that should be kept after resolution. */
  record: WorkOrder;
}

/**
 * Last-write-wins by `updatedAt`. Ties go to the server (it is the convergence
 * point for every device, so picking it on ties makes all replicas agree).
 */
export function resolveConflict(local: WorkOrder, server: WorkOrder): ConflictResolution {
  if (local.updatedAt > server.updatedAt) {
    return { winner: 'local', record: local };
  }
  return { winner: 'server', record: server };
}

/**
 * Decide what a pulled server record means for the local copy.
 *
 * Rule: a local edit that is still pending in the outbox wins until it is
 * acked — otherwise a slow reconnect would silently overwrite work the
 * technician typed minutes ago. Once the mutation is acked, plain LWW applies.
 */
export function applyPulledRecord(
  local: WorkOrder | undefined,
  incoming: WorkOrder,
  hasPendingLocalEdit: boolean,
): WorkOrder | undefined {
  if (!local) return incoming;
  if (hasPendingLocalEdit) return local;
  return incoming.updatedAt > local.updatedAt ? incoming : local;
}
