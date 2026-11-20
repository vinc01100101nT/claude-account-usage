"""Claude accounts signed in on this computer.

  claude_accounts.py save           (hook, silent) keep the signed-in account in ~/.claude/accounts/<email>.json
  claude_accounts.py switch <email> sign in as a saved account
  claude_accounts.py reset <email> --version <Claude Code version>
                                    spend one of that account's free resets
  claude_accounts.py [--force] [--version <Claude Code version>]
                                    print each saved account's 5-hour and weekly usage and free resets, as JSON

Every session shares one result in ~/.claude/account-usage.json: it is fetched again only when it is a minute
old (or --force), by one session at a time, and an account the usage service rate-limits waits as long as it says.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

HOME = Path.home()
CREDS = HOME / ".claude" / ".credentials.json"
PROFILE = HOME / ".claude.json"
STORE = HOME / ".claude" / "accounts"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
SHARED = HOME / ".claude" / "account-usage.json"
LOCK = HOME / ".claude" / "account-usage.lock"
FRESH_MS = 60 * 1000
MIN_WAIT_S = 60


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, data, indent=None):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=indent, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def current():
    account = read(PROFILE)["oauthAccount"]
    oauth = read(CREDS)["claudeAiOauth"]
    return account, oauth


def save():
    try:
        account, oauth = current()
    except Exception:
        return
    # Mid-switch, the sign-in and the profile can belong to two different accounts.
    if oauth.get("accountUuid") != account.get("accountUuid"):
        return
    STORE.mkdir(parents=True, exist_ok=True)
    path = STORE / f"{account['emailAddress']}.json"
    entry = {"claudeAiOauth": oauth, "oauthAccount": account}
    try:
        if read(path) == entry:
            return
    except Exception:
        pass
    write(path, entry)


def switch(email):
    path = STORE / f"{email}.json"
    if not path.exists():
        return f"{email} is not saved. /login to it once first."
    save()
    entry = read(path)
    creds = read(CREDS)
    creds["claudeAiOauth"] = entry["claudeAiOauth"]
    write(CREDS, creds)
    profile = read(PROFILE)
    profile["oauthAccount"] = entry["oauthAccount"]
    write(PROFILE, profile, indent=2)
    return f"Switched to {email}"


def post_json(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": "claude-code"})
    return json.load(urllib.request.urlopen(req, timeout=15))


def refresh(path, entry):
    oauth = entry["claudeAiOauth"]
    d = post_json(TOKEN_URL, {
        "grant_type": "refresh_token",
        "refresh_token": oauth["refreshToken"],
        "client_id": CLIENT_ID,
        "scope": " ".join(oauth.get("scopes") or []),
    })
    oauth["accessToken"] = d["access_token"]
    oauth["refreshToken"] = d.get("refresh_token", oauth["refreshToken"])
    oauth["expiresAt"] = int(time.time() * 1000) + int(d.get("expires_in", 3600)) * 1000
    write(path, entry)
    return oauth


def usage(token, version):
    # The free resets are only answered to a request naming Claude Code's command-line app and its real version.
    url, agent = (f"{USAGE_URL}?cedar_ember=1", f"claude-cli/{version} (external, cli)") if version else (USAGE_URL, "claude-code")
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": agent,
    })
    return json.load(urllib.request.urlopen(req, timeout=15))


def use_reset(email, version):
    """Spend one of the account's free resets, the way Claude Code itself claims one."""
    path = STORE / f"{email}.json"
    if not path.exists():
        return f"{email} is not saved. /login to it once first."
    if not version:
        return "Reset not used: the add-on did not say which Claude Code version is running."
    try:
        entry = read(path)
        oauth = entry["claudeAiOauth"]
        me_account, me_oauth = current()
        if me_account.get("emailAddress") == email:
            oauth = me_oauth
        elif oauth.get("expiresAt", 0) < now_ms() + 60000:
            oauth = refresh(path, entry)
        org = entry["oauthAccount"]["organizationUuid"]
        grants = (usage(oauth["accessToken"], version).get("cedar_ember") or {}).get("grants") or []
        grant = next((g for g in grants if (g.get("resets_left") or 0) > 0 and not g.get("paused")), None)
        if grant is None:
            return f"Reset not used: {email} has no free reset left."
        body = {"program": "cedar_ember", "grant_id": grant["id"], "request_id": str(uuid.uuid4())}
        req = urllib.request.Request(f"https://api.anthropic.com/api/organizations/{org}/reset_rate_limits",
                                     data=json.dumps(body).encode(), method="POST", headers={
                                         "Authorization": f"Bearer {oauth['accessToken']}",
                                         "anthropic-beta": "oauth-2025-04-20",
                                         "Content-Type": "application/json",
                                         "User-Agent": f"claude-cli/{version} (external, cli)",
                                     })
        d = json.load(urllib.request.urlopen(req, timeout=25))
    except urllib.error.HTTPError as e:
        return f"Reset not used: {e} {e.read()[:200].decode('utf-8', 'replace')}"
    except Exception as e:
        return f"Reset not used: {e}"
    if d.get("result") == "reset":
        return f"Reset used on {email} · {d.get('resets_left')} left"
    return f"Reset not used: {d.get('result')}" + (f" ({d['reason']})" if d.get("reason") else "")


def when(iso):
    if not iso:
        return None, None
    t = datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone()
    return f"{t.hour % 12 or 12}:{t:%M %p} || {t:%A} || {t:%b} {t.day}", int(t.timestamp() * 1000)


def window(label, w):
    w = w or {}
    reset, resets_at = when(w.get("resets_at"))
    return {"label": label, "percent": w.get("utilization"), "resets": reset, "resetsAt": resets_at}


def free_resets(d):
    out = []
    for g in (d.get("cedar_ember") or {}).get("grants") or []:
        expires, expires_at = when(g.get("ends_at"))
        kind = f"{g['type'].capitalize()} reset" if g.get("type") else g.get("label")
        out.append({"kind": kind, "left": g.get("resets_left"), "expires": expires, "expiresAt": expires_at})
    return out


def now_ms():
    return int(time.time() * 1000)


def clock(ms):
    t = datetime.fromtimestamp(ms / 1000)
    return f"{t.hour % 12 or 12}:{t:%M %p}"


def load_shared():
    try:
        return read(SHARED)
    except Exception:
        return {"fetchedAt": 0, "accounts": {}}


def take_lock():
    for _ in range(2):
        try:
            os.close(os.open(LOCK, os.O_CREAT | os.O_EXCL))
            return True
        except FileExistsError:
            try:
                if time.time() - LOCK.stat().st_mtime < 90:
                    return False
                LOCK.unlink()
            except FileNotFoundError:
                pass
    return False


def retry_after(e):
    try:
        wait = int(e.headers.get("Retry-After") or 0)
    except ValueError:
        wait = 0
    return now_ms() + max(wait, MIN_WAIT_S) * 1000


def fetch(old, me, version):
    fresh = {}
    for path in sorted(STORE.glob("*.json")):
        email = path.stem
        prev = old.get(email, {})
        if prev.get("retryAt", 0) > now_ms():
            fresh[email] = prev
            continue
        try:
            entry = read(path)
            oauth = entry["claudeAiOauth"]
            if email != me and oauth.get("expiresAt", 0) < now_ms() + 60000:
                oauth = refresh(path, entry)
            d = usage(oauth["accessToken"], version)
            fresh[email] = {"windows": [window("5-hour", d.get("five_hour")), window("Weekly", d.get("seven_day"))],
                            # A caller that does not know the version (an older copy of the add-on) keeps the last answer.
                            "freeResets": free_resets(d) if version else prev.get("freeResets", [])}
        except urllib.error.HTTPError as e:
            if e.code == 429:
                fresh[email] = {"windows": prev.get("windows", []), "freeResets": prev.get("freeResets", []),
                                "retryAt": retry_after(e)}
            else:
                fresh[email] = {"windows": [], "error": f"could not read ({e}); /login to this account once to save it again"}
        except Exception as e:
            fresh[email] = {"windows": [], "error": f"could not read ({e}); /login to this account once to save it again"}
    return {"fetchedAt": now_ms(), "accounts": fresh}


def show(force=False, version=None):
    save()
    try:
        me = current()[0]["emailAddress"]
    except Exception:
        me = None
    shared = load_shared()
    if force or now_ms() - shared.get("fetchedAt", 0) >= FRESH_MS:
        if take_lock():
            try:
                shared = fetch(load_shared().get("accounts", {}), me, version)
                write(SHARED, shared)
            finally:
                LOCK.unlink(missing_ok=True)
        else:
            before = shared.get("fetchedAt", 0)
            deadline = time.time() + 45
            while time.time() < deadline and shared.get("fetchedAt", 0) == before:
                time.sleep(0.5)
                shared = load_shared()
    accounts = []
    for path in sorted(STORE.glob("*.json")):
        email = path.stem
        cached = shared.get("accounts", {}).get(email, {})
        row = {"email": email, "signedIn": email == me, "windows": cached.get("windows", []),
               "freeResets": cached.get("freeResets", [])}
        if cached.get("error"):
            row["error"] = cached["error"]
        elif cached.get("retryAt", 0) > now_ms():
            row["error"] = f"rate limited, retrying at {clock(cached['retryAt'])}"
        accounts.append(row)
    print(json.dumps(accounts))


if __name__ == "__main__":
    args = sys.argv[1:]
    if args == ["save"]:
        save()
    elif args[:1] == ["switch"]:
        print(switch(args[1] if len(args) > 1 else ""))
    else:
        version = args[args.index("--version") + 1] if "--version" in args[:-1] else None
        if args[:1] == ["reset"]:
            print(use_reset(args[1] if len(args) > 1 else "", version))
        else:
            show(force="--force" in args, version=version)
