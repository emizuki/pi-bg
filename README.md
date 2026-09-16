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
bg_stop  b00f2c2a             -> b00f2c2a  npm  exited SIGTERM after 8s
```

`keepAlive` is off by default, so a process is stopped when the session ends. An orphaned server
holding a port is harder to find than it is to restart. Pass `keepAlive: true` to detach one
deliberately.

An unexpected exit is announced; a process you stopped yourself is not, because that is not news.

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
more in rate limit than it saves in latency. The first poll runs immediately, because the
condition is often already true and waiting a full interval to discover that is the worst
possible behaviour.

**It adapts to the session it is in**, because a session without a UI has no later turn:

- **Interactive**: returns straight away and carries on. When the condition is met, fails, or
  times out, the session is told through `sendMessage` with `triggerTurn`, which wakes an idle
  agent so it can act on the result.
- **Print mode** (`pi -p`): waits inside the tool call and returns the outcome. pi exits with its
  answer there, so a notification would arrive after the process was gone — this was observed,
  not assumed. `pi -p "wait for CI, then deploy"` therefore does what it says.

Notifications are coalesced over a short window, so five things finishing together wake the
session once rather than five times.

## Cleanup

Logs live in a directory named after the pi process that owns them. It is removed at session
shutdown, and any directory whose owning process is gone is swept at startup.

The second half matters: a killed process never runs its shutdown handler, and cleanup that
depends on a single event is cleanup that silently stops happening. Liveness is checked with
`kill(pid, 0)`, so a running session's logs are never touched no matter how old they are.

## Checks

`./check.sh` type-checks for unresolved identifiers. `bun build` only transpiles and will happily
emit a call to a function that does not exist, so it is not a substitute; the script refuses to
pass if `tsc` is missing rather than reporting success it could not verify.
