# pi-bg

Long-running processes and external-condition waits for pi.

pi ships no background bash on purpose, so a tool call runs to completion: a dev server dies with
the turn that started it, and waiting for CI means a subagent spending a model turn per poll.
Both are process problems rather than agent problems, which is why they live here rather than in
a subagent package.

## Install

```bash
pi install git:github.com/emizuki/pi-bg
```

## Processes

```
bg_start { command, cwd?, name?, keepAlive? }   -> id, returns immediately
bg_list                                         -> processes and watches
bg_logs  { id, tail? }
bg_stop  { id }
```

`bg_start` returns as soon as the child is spawned and the process keeps running between tool
calls, which is the whole point:

```
bg_start "npm run dev"        -> Started b00f2c2a (npm)
bg_list                       -> b00f2c2a  npm  running 4s
bg_logs  b00f2c2a             -> the output so far
bg_stop  b00f2c2a             -> Stopping b00f2c2a (npm).
```

`keepAlive` is off by default, so a process is stopped when the session ends. An orphaned server
holding a port is harder to find than it is to restart. Pass `keepAlive: true` to detach one
deliberately. At that session boundary the process becomes unmanaged: it keeps running and writing
to its private log, but no notification is sent through the old session and later sessions do not
list or stop it.

Stopping signals the process **group**, not just the shell pi spawned. With `shell: true` a
command containing any shell operator — `cd app && npm run dev` — runs as a grandchild, and
signalling the wrapper alone would leave the server running while this tool reported it stopped.
At session shutdown the escalation to SIGKILL is immediate rather than graceful, because a
graceful one runs on a timer that an exiting process never reaches.

A command ending in `&` is rejected: backgrounding is what this tool does, and a self-backgrounding
command exits at once, leaving the real process untracked.

An unexpected exit is announced; a process you stopped yourself is not, because that is not news.
The distinction is whether this tool asked for the exit, not which signal arrived, so a process
killed by the OOM killer or from another terminal still gets reported.

## Waiting for something outside the session

```
bg_watch { command, until?, intervalMs?, timeoutMs?, cwd?, label? }
```

Polls `command` until it succeeds — exit code 0, or output matching the `until` regex — and does
it inside the extension, so waiting costs no model turns at all:

```
bg_watch { command: "gh pr checks --required", label: "CI" }
```

The interval defaults to 60s and is floored at 5s: below that, polling something like `gh` costs
more in rate limit than it saves in latency. `timeoutMs` is a hard deadline independent of that
interval; an active poll is killed at the deadline and a success arriving late is rejected. The
first poll runs immediately, because the condition is often already true and waiting a full
interval to discover that is the worst possible behaviour.

**It adapts to the session it is in**, because a session without a UI has no later turn:

- **Interactive**: returns straight away and carries on. When the condition is met, fails, or
  times out, the session is told through `sendMessage` with `triggerTurn`, which wakes an idle
  agent so it can act on the result.
- **Print and JSON modes** (`pi -p`, `--mode json`): wait inside the tool call and return the
  outcome. They have no later interactive delivery channel, so a notification would have nowhere
  reliable to land. `pi -p "wait for CI, then deploy"` therefore does what it says.

Notifications are collected into a single wake-up over a short window, so five things finishing
together produce one turn rather than five.

## Cleanup

Logs live in a randomly suffixed, owner-only (`0700`) directory named after the pi process that
owns them; files are `0600`. The directory is removed at session shutdown unless a `keepAlive`
process still writes there. Versioned metadata records pending registrations and every managed
process group. On Linux, startup sweeping SIGKILLs a dead owner's non-keepAlive groups only when
the recorded process-birth identity still matches; keepAlive groups remain untouched. Legacy,
malformed, or otherwise uncertain roots are conservatively left in place. Only the last 64 KB of a
log is read internally, and every tool result is
capped at Pi's 50 KB / 2000-line limit with the full private path reported when truncation occurs.
The most recent twenty exited entries are kept for `bg_logs` before older ones are discarded.

The second half matters: a killed process never runs its shutdown handler, and cleanup that
depends on a single event is cleanup that silently stops happening. Owner and process-group
liveness are checked with `kill(pid, 0)`; Linux birth identities prevent a recycled numeric PGID
from authorizing a kill. Live or uncertain writers' logs are never swept based on age.

## Checks

`./check.sh` runs the complete merge gate: strict TypeScript checking followed by the integration
test suite. The tests exercise real detached process groups, cancellation/deadline races, session
shutdown, permissions, output bounds, and failure cleanup.

## Known limits

Roots created by versions that predate current ownership metadata cannot be swept safely and may
require manual removal once their writers are known to be gone. After an abrupt owner crash,
non-Linux systems likewise preserve an orphan and its log when no safe process-birth identity is
available. Commands that deliberately daemonize into a different process group cannot be managed
after they leave the group pi-bg created.

`bg_watch` runs its first poll before returning, in every mode, so a slow poll command delays even
the interactive path by that one poll. The poll is capped by the smaller of the watch interval and
the remaining deadline, so the delay is bounded rather than open-ended.
