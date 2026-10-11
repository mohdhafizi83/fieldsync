import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import type { WorkOrder } from '../core/types';

export interface WorkOrderListProps {
  orders: WorkOrder[];
  pendingCount: number;
  syncing: boolean;
  onOpen: (id: string) => void;
  onSync: () => void;
}

const STATUS_COLOR: Record<WorkOrder['status'], string> = {
  open: '#8884',
  in_progress: '#f0a',
  done: '#0a6',
};

/** Presentational list — navigation wiring lives in the screen wrapper. */
export function WorkOrderListView({ orders, pendingCount, syncing, onOpen, onSync }: WorkOrderListProps) {
  return (
    <View style={styles.container}>
      <FlatList
        data={orders}
        keyExtractor={(o) => o.id}
        ListEmptyComponent={<Text style={styles.empty}>No work orders yet. Pull from the server to start.</Text>}
        renderItem={({ item }) => (
          <Pressable testID={`row-${item.id}`} onPress={() => onOpen(item.id)} style={styles.row}>
            <View style={[styles.dot, { backgroundColor: STATUS_COLOR[item.status] }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{item.title || '(untitled)'}</Text>
              <Text style={styles.sub}>
                {item.site} · {item.status.replace('_', ' ')}
              </Text>
            </View>
          </Pressable>
        )}
      />
      <View style={styles.footer}>
        <Text style={styles.sub}>
          {pendingCount} pending sync {pendingCount === 1 ? 'mutation' : 'mutations'}
        </Text>
        <Pressable testID="sync-button" onPress={onSync} disabled={syncing} style={styles.button}>
          <Text style={styles.buttonText}>{syncing ? 'Syncing…' : 'Sync now'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116' },
  row: { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: '#1d232c' },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  title: { color: '#e6e9ee', fontSize: 15 },
  sub: { color: '#8b95a1', fontSize: 12, marginTop: 2 },
  empty: { color: '#8b95a1', padding: 24, textAlign: 'center' },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderTopWidth: 1, borderTopColor: '#1d232c' },
  button: { backgroundColor: '#2563eb', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  buttonText: { color: '#fff', fontWeight: '600' },
});
