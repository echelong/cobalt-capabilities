export type SwarmView = { version: number; tasks: { id: string; agentId: string | null; tier: string; state: string; mode: string; owned: string[]; endedAt: number | null; startedAt: number | null; cancellationRequested: boolean; verification: 'pending' | 'pass' | 'fail' | 'unknown' }[] }
export type Receipt = { capability: 'memory' | 'browser'; operation: string; status: string; at: number; durationMs: number | null; count: number | null; bank: string | null; task: string | null; executed: boolean; effectsPossible: boolean; verification: 'pending' | 'unknown'; operations: string[]; fallback: boolean; error: string | null; reason?: string }
export type Capabilities = { memory: string; browser: string; bank: string | null; receipts: Receipt[] }
declare module 'claude-code' {
  interface PluginState {
    'cobalt-capabilities': { capabilities: Capabilities }
  }
}
