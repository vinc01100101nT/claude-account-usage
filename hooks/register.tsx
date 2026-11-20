import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Account, FreeReset, UsageWindow } from '../types'

const EVERY_MS = 60 * 1000
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
// Every session shares one result: it is fetched again only when it is a minute old (or on Refresh), by one session
// at a time, and an account the usage service rate-limits waits as long as it says.
const FRESH_MS = 60 * 1000
const LOCK_MS = 90 * 1000
const MIN_WAIT_MS = 60 * 1000

const accounts = atom({ plugin: 'account-usage', key: 'accounts' } as const, [] as Account[])
const isCollapsed = atom({ plugin: 'account-usage', key: 'isCollapsed' } as const, false)
const switchingTo = atom({ plugin: 'account-usage', key: 'switchingTo' } as const, '')
const isRefreshing = atom({ plugin: 'account-usage', key: 'isRefreshing' } as const, false)
const sortBy = atom({ plugin: 'account-usage', key: 'sortBy' } as const, '')
const confirmingReset = atom({ plugin: 'account-usage', key: 'confirmingReset' } as const, '')
const resettingFor = atom({ plugin: 'account-usage', key: 'resettingFor' } as const, '')

type Host = Parameters<Hook<'session.start'>>[0]
type Json = Record<string, any>
type Cached = { windows?: UsageWindow[]; freeResets?: FreeReset[]; retryAt?: number; error?: string }
type Shared = { fetchedAt: number; accounts: Record<string, Cached> }

class HttpError extends Error {
  constructor(readonly status: number, readonly headers: Record<string, string>, readonly body: string) {
    super(`HTTP Error ${status}`)
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function paths($: Host) {
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
  return {
    creds: `${home}/.claude/.credentials.json`,
    profile: `${home}/.claude.json`,
    store: `${home}/.claude/accounts`,
    shared: `${home}/.claude/account-usage.json`,
    lock: `${home}/.claude/account-usage.lock.json`,
  }
}

async function readJson($: Host, path: string): Promise<Json> {
  return JSON.parse(await $.fs.read(path))
}

async function current($: Host) {
  const p = await paths($)
  return { account: (await readJson($, p.profile)).oauthAccount as Json, oauth: (await readJson($, p.creds)).claudeAiOauth as Json }
}

async function savedEmails($: Host) {
  const entries = await $.fs.list((await paths($)).store).catch(() => [])
  return entries
    .filter(e => e.kind === 'file' && e.name.endsWith('.json'))
    .map(e => e.name.slice(0, -'.json'.length))
    .sort()
}

// Keep the signed-in account in ~/.claude/accounts/<email>.json.
async function save($: Host) {
  let me: { account: Json; oauth: Json }
  try {
    me = await current($)
  } catch {
    return
  }
  // Mid-switch, the sign-in and the profile can belong to two different accounts.
  if (me.oauth.accountUuid !== me.account.accountUuid) return
  const path = `${(await paths($)).store}/${me.account.emailAddress}.json`
  const entry = JSON.stringify({ claudeAiOauth: me.oauth, oauthAccount: me.account })
  const old = await readJson($, path).catch(() => null)
  if (old && JSON.stringify(old) === entry) return
  await $.fs.write(path, entry)
}

async function post($: Host, url: string, body: Json, headers: Record<string, string>) {
  const r = await $.http.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new HttpError(r.status, r.headers, r.text)
  return JSON.parse(r.text) as Json
}

async function renew($: Host, path: string, entry: Json) {
  const oauth = entry.claudeAiOauth
  const d = await post(
    $,
    TOKEN_URL,
    {
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: CLIENT_ID,
      scope: (oauth.scopes ?? []).join(' '),
    },
    { 'User-Agent': 'claude-code' },
  )
  oauth.accessToken = d.access_token
  oauth.refreshToken = d.refresh_token ?? oauth.refreshToken
  oauth.expiresAt = Date.now() + Number(d.expires_in ?? 3600) * 1000
  await $.fs.write(path, JSON.stringify(entry))
  return oauth
}

// The free resets are only answered to a request naming Claude Code's command-line app and its real version.
const agent = (version: string) => `claude-cli/${version} (external, cli)`

async function usage($: Host, token: string, version: string) {
  const r = await $.http.fetch(`${USAGE_URL}?cedar_ember=1`, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': agent(version) },
  })
  if (!r.ok) throw new HttpError(r.status, r.headers, r.text)
  return JSON.parse(r.text) as Json
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function clock(t: Date) {
  return `${t.getHours() % 12 || 12}:${String(t.getMinutes()).padStart(2, '0')} ${t.getHours() < 12 ? 'AM' : 'PM'}`
}

function when(iso: unknown): [string | null, number | null] {
  if (!iso) return [null, null]
  const t = new Date(String(iso))
  return [`${clock(t)} || ${DAYS[t.getDay()]} || ${MONTHS[t.getMonth()]} ${t.getDate()}`, t.getTime()]
}

function usageWindow(label: string, w: Json | undefined): UsageWindow {
  const [resets, resetsAt] = when(w?.resets_at)
  return { label, percent: w?.utilization ?? null, resets, resetsAt }
}

function freeResets(d: Json): FreeReset[] {
  return ((d.cedar_ember?.grants ?? []) as Json[]).map(g => {
    const [expires, expiresAt] = when(g.ends_at)
    const kind = g.type ? `${g.type.charAt(0).toUpperCase()}${g.type.slice(1).toLowerCase()} reset` : g.label
    return { kind, left: g.resets_left ?? null, expires, expiresAt }
  })
}

async function fetchAll($: Host, old: Record<string, Cached>, me: string | null, version: string): Promise<Shared> {
  const store = (await paths($)).store
  const fresh: Record<string, Cached> = {}
  for (const email of await savedEmails($)) {
    const prev = old[email] ?? {}
    if ((prev.retryAt ?? 0) > Date.now()) {
      fresh[email] = prev
      continue
    }
    try {
      const path = `${store}/${email}.json`
      const entry = await readJson($, path)
      let oauth = entry.claudeAiOauth
      if (email !== me && (oauth.expiresAt ?? 0) < Date.now() + 60000) oauth = await renew($, path, entry)
      const d = await usage($, oauth.accessToken, version)
      fresh[email] = { windows: [usageWindow('5-hour', d.five_hour), usageWindow('Weekly', d.seven_day)], freeResets: freeResets(d) }
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) {
        const wait = Number(e.headers['retry-after']) * 1000 || 0
        fresh[email] = { windows: prev.windows ?? [], freeResets: prev.freeResets ?? [], retryAt: Date.now() + Math.max(wait, MIN_WAIT_MS) }
      } else {
        fresh[email] = { windows: [], error: `could not read (${errorText(e)}); /login to this account once to save it again` }
      }
    }
  }
  return { fetchedAt: Date.now(), accounts: fresh }
}

async function loadShared($: Host): Promise<Shared> {
  const s = await readJson($, (await paths($)).shared).catch(() => null)
  return s && typeof s.fetchedAt === 'number' ? (s as Shared) : { fetchedAt: 0, accounts: {} }
}

const randomId = () => Array.from({ length: 32 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')

// One session fetches at a time: the lock names its owner, and a lock older than LOCK_MS is free again.
async function takeLock($: Host, owner: string) {
  const path = (await paths($)).lock
  const held = await readJson($, path).catch(() => null)
  if (held?.owner && Date.now() - held.at < LOCK_MS) return false
  await $.fs.write(path, JSON.stringify({ owner, at: Date.now() }))
  await $.clock.sleep(200)
  return (await readJson($, path).catch(() => null))?.owner === owner
}

async function freeLock($: Host) {
  await $.fs.write((await paths($)).lock, JSON.stringify({ owner: '', at: 0 }))
}

async function rows($: Host, force: boolean, version: string): Promise<Account[]> {
  await save($)
  const me = await current($).then(c => c.account.emailAddress as string).catch(() => null)
  let shared = await loadShared($)
  if (force || Date.now() - shared.fetchedAt >= FRESH_MS) {
    if (await takeLock($, randomId())) {
      try {
        shared = await fetchAll($, (await loadShared($)).accounts, me, version)
        await $.fs.write((await paths($)).shared, JSON.stringify(shared))
      } finally {
        await freeLock($)
      }
    } else {
      // Another session is fetching: show what is there now, and its answer a few seconds later.
      $.clock.after(5000, () => void refresh($))
    }
  }
  return (await savedEmails($)).map(email => {
    const cached = shared.accounts[email] ?? {}
    const row: Account = { email, signedIn: email === me, windows: cached.windows ?? [], freeResets: cached.freeResets ?? [] }
    if (cached.error) row.error = cached.error
    else if ((cached.retryAt ?? 0) > Date.now()) row.error = `rate limited, retrying at ${clock(new Date(cached.retryAt!))}`
    return row
  })
}

async function refresh($: Host, force = false) {
  if (await read($, isRefreshing)) return
  await update($, isRefreshing, () => true)
  try {
    const { version } = await $.session.version()
    const list = await rows($, force, version)
    await update($, accounts, () => list)
  } catch (e) {
    await update($, accounts, () => [{ email: 'account usage', signedIn: false, windows: [], error: `could not run (${errorText(e)})` }])
  } finally {
    await update($, isRefreshing, () => false)
  }
}

async function signInAs($: Host, email: string) {
  const p = await paths($)
  const path = `${p.store}/${email}.json`
  if (!(await $.fs.exists(path))) return `${email} is not saved. /login to it once first.`
  await save($)
  const entry = await readJson($, path)
  const creds = await readJson($, p.creds)
  creds.claudeAiOauth = entry.claudeAiOauth
  await $.fs.write(p.creds, JSON.stringify(creds))
  const profile = await readJson($, p.profile)
  profile.oauthAccount = entry.oauthAccount
  await $.fs.write(p.profile, JSON.stringify(profile, null, 2))
  return `Switched to ${email}`
}

async function switchTo($: Host, email: string) {
  if (await read($, switchingTo)) return
  await update($, switchingTo, () => email)
  try {
    $.ui.toast(await signInAs($, email).catch(e => `Not switched: ${errorText(e)}`), { timeoutMs: 8000 })
    await refresh($)
  } finally {
    await update($, switchingTo, () => '')
  }
}

// Spend one of the account's free resets, the way Claude Code itself claims one.
async function claimReset($: Host, email: string) {
  const path = `${(await paths($)).store}/${email}.json`
  if (!(await $.fs.exists(path))) return `${email} is not saved. /login to it once first.`
  try {
    const { version } = await $.session.version()
    const entry = await readJson($, path)
    const me = await current($).catch(() => null)
    let oauth = entry.claudeAiOauth
    if (me?.account.emailAddress === email) oauth = me.oauth
    else if ((oauth.expiresAt ?? 0) < Date.now() + 60000) oauth = await renew($, path, entry)
    const grants = ((await usage($, oauth.accessToken, version)).cedar_ember?.grants ?? []) as Json[]
    const grant = grants.find(g => (g.resets_left ?? 0) > 0 && !g.paused)
    if (!grant) return `Reset not used: ${email} has no free reset left.`
    const d = await post(
      $,
      `https://api.anthropic.com/api/organizations/${entry.oauthAccount.organizationUuid}/reset_rate_limits`,
      { program: 'cedar_ember', grant_id: grant.id, request_id: randomId() },
      { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': agent(version) },
    )
    if (d.result === 'reset') return `Reset used on ${email} · ${d.resets_left} left`
    return `Reset not used: ${d.result}${d.reason ? ` (${d.reason})` : ''}`
  } catch (e) {
    if (e instanceof HttpError) return `Reset not used: ${e.message} ${e.body.slice(0, 200)}`
    return `Reset not used: ${errorText(e)}`
  }
}

async function useReset($: Host, email: string) {
  if (await read($, resettingFor)) return
  await update($, confirmingReset, () => '')
  await update($, resettingFor, () => email)
  try {
    $.ui.toast(await claimReset($, email), { timeoutMs: 8000 })
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

function resetTime(account: Account, label: string) {
  const at = (account.windows ?? []).find(w => w.label === label)?.resetsAt
  return at ?? Number.MAX_SAFE_INTEGER
}

function sorted(list: Account[], label: string) {
  if (!label) return list
  return [...list].sort((a, b) => resetTime(a, label) - resetTime(b, label))
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

  on('prompt.submit', async ($, e, next) => {
    void save($).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

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
