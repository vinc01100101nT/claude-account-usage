# account-usage

A Claude Code add-on that shows every Claude account you have signed in to on this computer above the prompt:
each one's 5-hour and weekly usage with when they reset, and its free resets. Buttons let you switch to another
account, refresh, sort by reset time, hide the list, and use a free reset (it asks you to confirm first).

An account appears after you `/login` to it once. The numbers refresh every minute and after every reply, and all
open sessions share one fetch.

## Install

At the prompt of a terminal session:

```
/plugin install account-usage --marketplace vinc01100101nT/claude-account-usage
```

Answer `y` to add the marketplace, then pick a scope (the user scope loads it in every session).

From a shell:

```
claude plugin install account-usage --marketplace vinc01100101nT/claude-account-usage
```

In VS Code: in the Claude Code panel, type `/plugin` to open Manage plugins, add `vinc01100101nT/claude-account-usage`
as a marketplace, then install account-usage.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with
`vinc01100101nT/claude-account-usage`, then Add plugin.
