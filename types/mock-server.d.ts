declare module 'mock-server/server' {
  import type { Server } from 'http';
  export interface MockServerHandle {
    server: Server;
    listen: () => Promise<{ address: string; port: number; family: string }>;
    close: () => Promise<void>;
  }
  export function createMockServer(opts?: {
    port?: number;
    latencyMs?: number;
    clock?: () => number;
  }): MockServerHandle;
}
