import React from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import type { SyncEvent } from '../sync/engine';

export interface SyncStatusProps {
  events: SyncEvent[];
  pendingCount: number;
  cursor: number;
}

/** Rolling transcript of what the sync engine actually did — the debug view. */
export function SyncStatusView({ events, pendingCount, cursor }: SyncStatusProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.header}>
        {pendingCount} pending · cursor {cursor || 'never-synced'}
      </Text>
      <FlatList
        data={[...events].reverse()}
        keyExtractor={(e, i) => `${e.ts}-${i}`}
        ListEmptyComponent={<Text style={styles.message}>No sync activity yet.</Text>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.kind}>{item.kind}</Text>
            <Text style={styles.message}>{item.message}</Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116' },
  header: { color: '#e6e9ee', padding: 14, fontWeight: '600' },
  row: { paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#1d232c' },
  kind: { color: '#5eead4', fontSize: 11, textTransform: 'uppercase', marginBottom: 2 },
  message: { color: '#c6ccd4', fontSize: 13 },
});
