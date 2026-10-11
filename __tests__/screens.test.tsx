import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';

import { WorkOrderListView } from '../src/screens/WorkOrderList';
import { WorkOrderDetailView } from '../src/screens/WorkOrderDetail';
import type { WorkOrder } from '../src/core/types';

const order = (over: Partial<WorkOrder> = {}): WorkOrder => ({
  id: 'wo-1', title: 'Fix boiler', site: 'Plant B', status: 'open', notes: 'pressure drop', updatedAt: 100,
  ...over,
});

describe('WorkOrderListView', () => {
  it('renders a row per order with title, site and humanised status', async () => {
    await render(
      <WorkOrderListView
        orders={[order(), order({ id: 'wo-2', title: 'Calibrate valve', site: 'Site 7', status: 'in_progress' })]}
        pendingCount={3}
        syncing={false}
        onOpen={() => {}}
        onSync={() => {}}
      />,
    );
    expect(screen.getByText('Fix boiler')).toBeTruthy();
    expect(screen.getByText(/Plant B/)).toBeTruthy();
    expect(screen.getByText('Calibrate valve')).toBeTruthy();
    expect(screen.getByText(/in progress/)).toBeTruthy();
    expect(screen.getByText('3 pending sync mutations')).toBeTruthy();
  });

  it('tapping a row calls onOpen with the id; sync button calls onSync', async () => {
    const onOpen = jest.fn();
    const onSync = jest.fn();
    await render(<WorkOrderListView orders={[order()]} pendingCount={0} syncing={false} onOpen={onOpen} onSync={onSync} />);
    await fireEvent.press(screen.getByTestId('row-wo-1'));
    expect(onOpen).toHaveBeenCalledWith('wo-1');
    await fireEvent.press(screen.getByTestId('sync-button'));
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('disables the sync button while syncing and shows progress label', async () => {
    const onSync = jest.fn();
    await render(<WorkOrderListView orders={[]} pendingCount={0} syncing onOpen={() => {}} onSync={onSync} />);
    expect(screen.getByText('Syncing…')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('sync-button'));
    expect(onSync).not.toHaveBeenCalled();
  });
});

describe('WorkOrderDetailView', () => {
  it('offers the next status transition for an open order', async () => {
    const onAdvance = jest.fn();
    await render(<WorkOrderDetailView order={order()} hasPendingEdit={false} onAdvance={onAdvance} />);
    await fireEvent.press(screen.getByTestId('advance-button'));
    expect(onAdvance).toHaveBeenCalledWith('wo-1', 'in_progress');
  });

  it('shows the pending-edit hint only when there is an un-acked mutation', async () => {
    const { rerender } = await render(<WorkOrderDetailView order={order()} hasPendingEdit={false} onAdvance={() => {}} />);
    expect(screen.queryByText(/Unsynced changes/)).toBeNull();
    await rerender(<WorkOrderDetailView order={order()} hasPendingEdit onAdvance={() => {}} />);
    expect(screen.getByText(/Unsynced changes/)).toBeTruthy();
  });

  it('handles a missing order (deleted server-side) without crashing', async () => {
    await render(<WorkOrderDetailView order={undefined} hasPendingEdit={false} onAdvance={() => {}} />);
    expect(screen.getByText(/not found/)).toBeTruthy();
  });
});
