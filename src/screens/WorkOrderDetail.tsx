import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { WorkOrder, WorkOrderStatus } from '../core/types';

export interface WorkOrderDetailProps {
  order: WorkOrder | undefined;
  hasPendingEdit: boolean;
  onAdvance: (id: string, next: WorkOrderStatus) => void;
}

const NEXT: Partial<Record<WorkOrderStatus, WorkOrderStatus>> = {
  open: 'in_progress',
  in_progress: 'done',
};

export function WorkOrderDetailView({ order, hasPendingEdit, onAdvance }: WorkOrderDetailProps) {
  if (!order) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Work order not found (it may have been deleted server-side).</Text>
      </View>
    );
  }
  const next = NEXT[order.status];
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{order.title || '(untitled)'}</Text>
      <Text style={styles.meta}>Site: {order.site || '—'}</Text>
      <Text style={styles.meta}>Status: {order.status.replace('_', ' ')}</Text>
      <Text style={styles.notes}>{order.notes || 'No notes.'}</Text>
      {next ? (
        <Pressable testID="advance-button" onPress={() => onAdvance(order.id, next)} style={styles.button}>
          <Text style={styles.buttonText}>Mark {next.replace('_', ' ')}</Text>
        </Pressable>
      ) : (
        <Text style={styles.meta}>Order complete.</Text>
      )}
      {hasPendingEdit && <Text style={styles.pending}>Unsynced changes — will flush when online.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#0e1116' },
  title: { color: '#e6e9ee', fontSize: 20, fontWeight: '700', marginBottom: 12 },
  meta: { color: '#8b95a1', fontSize: 14, marginBottom: 4 },
  notes: { color: '#c6ccd4', fontSize: 14, marginTop: 12, lineHeight: 20 },
  button: { backgroundColor: '#2563eb', padding: 14, borderRadius: 8, marginTop: 24, alignSelf: 'flex-start' },
  buttonText: { color: '#fff', fontWeight: '600' },
  pending: { color: '#f0a', marginTop: 16, fontSize: 12 },
  empty: { color: '#8b95a1', padding: 24 },
});
