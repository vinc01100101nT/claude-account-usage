import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Account } from '../types'

const EVERY_MS = 60 * 1000

const accounts = atom({ plugin: 'account-usage', key: 'accounts' } as const, [] as Account[])
const isCollapsed = atom({ plugin: 'account-usage', key: 'isCollapsed' } as const, false)
const switchingTo = atom({ plugin: 'account-usage', key: 'switchingTo' } as const, '')
const isRefreshing = atom({ plugin: 'account-usage', key: 'isRefreshing' } as const, false)
const sortBy = atom({ plugin: 'account-usage', key: 'sortBy' } as const, '')
const confirmingReset = atom({ plugin: 'account-usage', key: 'confirmingReset' } as const, '')
const resettingFor = atom({ plugin: 'account-usage', key: 'resettingFor' } as const, '')

function resetTime(account: Account, label: string) {
  const at = (account.windows ?? []).find(w => w.label === label)?.resetsAt
  return at ?? Number.MAX_SAFE_INTEGER
}

function sorted(list: Account[], label: string) {
  if (!label) return list
  return [...list].sort((a, b) => resetTime(a, label) - resetTime(b, label))
}

type Host = Parameters<Hook<'session.start'>>[0]

const script = ($: Host) => `${$.plugin.root}/scripts/claude_accounts.py`

async function refresh($: Host, force = false) {
  if (await read($, isRefreshing)) return
  await update($, isRefreshing, () => true)
  try {
    const { version } = await $.session.version()
    const { stdout } = await $.process.run(['python', script($), '--version', version, ...(force ? ['--force'] : [])], {
      timeoutMs: 60000,
    })
    const list = JSON.parse(stdout) as Account[]
    await update($, accounts, () => list)
  } catch {
    await update($, accounts, () => [{ email: 'account usage', signedIn: false, windows: [], error: 'could not run' }])
  } finally {
    await update($, isRefreshing, () => false)
  }
}

async function switchTo($: Host, email: string) {
  if (await read($, switchingTo)) return
  await update($, switchingTo, () => email)
  try {
    const { stdout, stderr } = await $.process.run(['python', script($), 'switch', email], { timeoutMs: 60000 })
    $.ui.toast((stdout || stderr).trim(), { timeoutMs: 8000 })
    await refresh($)
  } finally {
    await update($, switchingTo, () => '')
  }
}

async function useReset($: Host, email: string) {
  if (await read($, resettingFor)) return
  await update($, confirmingReset, () => '')
  await update($, resettingFor, () => email)
  try {
    const { version } = await $.session.version()
    const { stdout, stderr } = await $.process.run(['python', script($), 'reset', email, '--version', version], {
      timeoutMs: 60000,
    })
    $.ui.toast((stdout || stderr).trim(), { timeoutMs: 8000 })
    await refresh($, true)
  } finally {
    await update($, resettingFor, () => '')
  }
}

function usageColor(percent: number) {
  return percent <= 40 ? 'success' : percent <= 80 ? 'warning' : 'error'
}

async function toggleCollapsed($: Host) {
  const next = !(await read($, isCollapsed))
  await update($, isCollapsed, () => next)
  await $.store.set('isCollapsed', next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    const saved = (await $.store.get('isCollapsed')) === true
    await update($, isCollapsed, () => saved)
    await update($, switchingTo, () => '')
    await update($, isRefreshing, () => false)
    await update($, confirmingReset, () => '')
    await update($, resettingFor, () => '')
    void refresh($)
    $.clock.every(EVERY_MS, () => void refresh($))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, accounts)
    if (list.length === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const collapsed = await read($, isCollapsed)
    const busy = await read($, switchingTo)
    const refreshing = await read($, isRefreshing)
    const sortLabel = await read($, sortBy)
    const confirming = await read($, confirmingReset)
    const resetting = await read($, resettingFor)
    const sortButton = (label: string, text: string) =>
      sortLabel === label ? (
        <Text key={label} dimColor>{` ${text} (sorted)`}</Text>
      ) : (
        <Button key={label} label={text} onPress={() => void update($, sortBy, () => label)} />
      )
    const toggle = (
      <Button
        key="toggle"
        label={collapsed ? 'Show account usage' : 'Hide account usage'}
        onPress={() => void toggleCollapsed($)}
      />
    )
    if (collapsed) return toggle
    return (
      <Box flexDirection="column" gap={1}>
        <Box key="controls">
          {toggle}
          {refreshing ? (
            <Text dimColor> Refreshing…</Text>
          ) : (
            <Button key="refresh" label="Refresh" onPress={() => void refresh($, true)} />
          )}
          {sortButton('5-hour', 'Sort by 5-hour reset')}
          {sortButton('Weekly', 'Sort by weekly reset')}
        </Box>
        {sorted(list, sortLabel).map(account => (
          <Box key={account.email} flexDirection="column">
            <Box>
              <Text bold>{account.email}</Text>
              {account.signedIn ? (
                <Text dimColor> (signed in)</Text>
              ) : busy === account.email ? (
                <Text dimColor> Switching…</Text>
              ) : busy ? null : (
                <Button key="switch" label="Switch" onPress={() => void switchTo($, account.email)} />
              )}
            </Box>
            {account.error ? <Text dimColor>{'   ' + account.error}</Text> : null}
            {(account.windows ?? []).map(w => (
              <Box key={w.label}>
                <Text dimColor>{`   ${w.label}: `}</Text>
                {w.percent === null ? (
                  <Text dimColor>n/a</Text>
                ) : (
                  <Text color={usageColor(w.percent)}>{`${w.percent}%`}</Text>
                )}
                {w.resets ? <Text dimColor>{` · resets: ${w.resets}`}</Text> : null}
              </Box>
            ))}
            {(account.freeResets ?? []).map(r => (
              <Box key={r.kind}>
                <Text dimColor>{`   ${r.kind}: `}</Text>
                <Text>{`${r.left ?? 'n/a'} left`}</Text>
                {r.expires ? <Text dimColor>{` · expires: ${r.expires}`}</Text> : null}
                {!r.left ? null : resetting === account.email ? (
                  <Text dimColor> Using reset…</Text>
                ) : confirming === account.email ? (
                  <Box key="confirm">
                    <Text color="warning"> Use this reset now? </Text>
                    <Button key="yes" label="Yes, use it" onPress={() => void useReset($, account.email)} />
                    <Button key="cancel" label="Cancel" onPress={() => void update($, confirmingReset, () => '')} />
                  </Box>
                ) : resetting ? null : (
                  <Button key="use" label="Use reset" onPress={() => void update($, confirmingReset, () => account.email)} />
                )}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
