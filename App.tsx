import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator, NativeStackScreenProps } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { Pressable, Text } from 'react-native';

import { createApiClient, type FetchLike } from './src/api/client';
import { InMemoryStore } from './src/db/in-memory';
import { SqliteWorkOrderRepository } from './src/db/sqlite';
import type { WorkOrderRepository } from './src/db/repository';
import type { WorkOrder, WorkOrderStatus } from './src/core/types';
import { uuidv4 } from './src/core/uuid';
import { SyncEngine, type SyncEvent } from './src/sync/engine';
import type { Outbox } from './src/sync/outbox';
import type { RootStackParamList } from './src/navigation/types';
import { WorkOrderListView } from './src/screens/WorkOrderList';
import { WorkOrderDetailView } from './src/screens/WorkOrderDetail';
import { SyncStatusView } from './src/screens/SyncStatus';

/**
 * Server base URL. Run `npm run mock-server` and point this at the mock to
 * see the sync engine work end-to-end (10.0.2.2 = host from Android emulator,
 * localhost works on iOS simulator / web).
 */
const API_BASE = 'http://10.0.2.2:4000';

const navTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: '#0e1116', primary: '#2563eb', card: '#161b22', text: '#e6e9ee', border: '#1d232c' },
};

interface AppCtx {
  repo: WorkOrderRepository;
  engine: SyncEngine;
  outbox: Outbox;
  events: SyncEvent[];
  refresh: () => void;
  syncing: boolean;
  runSync: () => Promise<void>;
  mutateStatus: (id: string, status: WorkOrderStatus) => Promise<void>;
}

function useAppContext(): AppCtx {
  // Try SQLite (device); fall back to memory (e.g. web preview) so the app
  // always runs. The sync engine only sees the repository interface either way.
  const [repo, setRepo] = useState<WorkOrderRepository>(() => new InMemoryStore());
  const [, setVersion] = useState(0);
  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    SqliteWorkOrderRepository.open()
      .then((db) => {
        if (!cancelled) setRepo(db);
      })
      .catch(() => {
        // keep in-memory store
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchLike: FetchLike = useCallback(async (url, init) => {
    const res = await fetch(url, init as RequestInit);
    return { status: res.status, json: () => res.json() };
  }, []);

  const engine = useMemo(
    () =>
      new SyncEngine({
        api: createApiClient(fetchLike, API_BASE),
        repo,
        onEvent: (e) => setEvents((prev) => [...prev.slice(-199), e]),
      }),
    [repo, fetchLike],
  );

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      await engine.sync();
    } catch {
      // engine already recorded the failure in the event log
    } finally {
      setSyncing(false);
      refresh();
    }
  }, [engine, refresh]);

  const mutateStatus = useCallback(
    async (id: string, status: WorkOrderStatus) => {
      const current = await repo.get(id);
      await engine.mutate({
        id: uuidv4(),
        op: 'update',
        entityId: id,
        baseUpdatedAt: current?.updatedAt ?? 0,
        payload: { status },
      });
      refresh();
    },
    [engine, repo, refresh],
  );

  return { repo, engine, outbox: engine.outbox, events, refresh, syncing, runSync, mutateStatus };
}

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const ctx = useAppContext();
  return (
    <>
      <StatusBar style="light" />
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator
          screenOptions={{ headerStyle: { backgroundColor: '#161b22' }, headerTintColor: '#e6e9ee' }}
        >
          <Stack.Screen
            name="WorkOrderList"
            options={({ navigation }) => ({
              title: 'Work orders',
              headerRight: () => (
                <Pressable
                  onPress={() => navigation.navigate('SyncStatus')}
                  hitSlop={8}
                  style={{ paddingHorizontal: 8 }}
                >
                  <Text style={{ color: '#5eead4', fontSize: 13 }}>Sync log</Text>
                </Pressable>
              ),
            })}
          >
            {(props) => <ListScreen ctx={ctx} navigation={props.navigation} />}
          </Stack.Screen>
          <Stack.Screen name="WorkOrderDetail" options={{ title: 'Work order' }}>
            {(props) => <DetailScreen ctx={ctx} id={props.route.params.id} />}
          </Stack.Screen>
          <Stack.Screen name="SyncStatus" options={{ title: 'Sync log' }}>
            {() => <StatusScreen ctx={ctx} />}
          </Stack.Screen>
        </Stack.Navigator>
      </NavigationContainer>
    </>
  );
}

type ListNav = NativeStackScreenProps<RootStackParamList, 'WorkOrderList'>['navigation'];

function ListScreen({ ctx, navigation }: { ctx: AppCtx; navigation: ListNav }) {
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  useEffect(() => {
    let on = true;
    ctx.repo.all().then((o) => on && setOrders(o));
    return () => {
      on = false;
    };
  }, [ctx.repo, ctx.refresh, ctx.syncing]);
  return (
    <WorkOrderListView
      orders={orders}
      pendingCount={ctx.outbox.pendingCount}
      syncing={ctx.syncing}
      onOpen={(id) => navigation.navigate('WorkOrderDetail', { id })}
      onSync={ctx.runSync}
    />
  );
}

function DetailScreen({ ctx, id }: { ctx: AppCtx; id: string }) {
  const [order, setOrder] = useState<WorkOrder | undefined>();
  useEffect(() => {
    let on = true;
    ctx.repo.get(id).then((o) => on && setOrder(o));
    return () => {
      on = false;
    };
  }, [ctx.repo, id, ctx.refresh, ctx.syncing]);
  return <WorkOrderDetailView order={order} hasPendingEdit={ctx.outbox.hasPendingFor(id)} onAdvance={ctx.mutateStatus} />;
}

function StatusScreen({ ctx }: { ctx: AppCtx }) {
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    ctx.repo.getCursor().then(setCursor);
  }, [ctx.repo, ctx.events.length]);
  return <SyncStatusView events={ctx.events} pendingCount={ctx.outbox.pendingCount} cursor={cursor} />;
}
