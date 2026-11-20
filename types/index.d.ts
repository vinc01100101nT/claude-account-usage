export type UsageWindow = { label: string; percent: number | null; resets: string | null; resetsAt: number | null }

export type FreeReset = { kind: string; left: number | null; expires: string | null; expiresAt: number | null }

export type Account = { email: string; signedIn: boolean; windows: UsageWindow[]; freeResets?: FreeReset[]; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'account-usage': { accounts: Account[]; isCollapsed: boolean; switchingTo: string; isRefreshing: boolean; sortBy: string; confirmingReset: string; resettingFor: string; scrollRow: number }
  }
}
