# Sessions live/status contract

This document defines the JSON contract that orchestration tools such as
open-dispatch should consume instead of re-discovering tmux panes directly.
The contract is intentionally additive to indexed session behavior: existing
`sessions list`, `sessions indexed-list`, `sessions search`, ingestion, and
storage sync commands continue to describe durable historical sessions.

## Live pane rows

`sessions live --json` returns an array of live pane rows. Consumers should
treat the response as an observation, not as an execution authority.

Required stable fields:

```json
{
  "target": "open-router:1.1",
  "session": "open-router",
  "windowIndex": "1",
  "paneIndex": "1",
  "paneId": "%101",
  "command": "node",
  "cwd": "/home/hasna/Workspace/hasna/opensource/open-router",
  "projectPath": "/home/hasna/workspace/hasna/opensource/open-router",
  "projectSlug": "open-router",
  "machine": "spark02",
  "title": "open-router",
  "status": "active",
  "statusReason": "working indicator in pane text",
  "paneDead": false,
  "paneActive": true,
  "lastVisibleLine": "gpt-5.5 xhigh fast ... Pursuing goal",
  "isOpenSession": true
}
```

`status` is one of:

- `active`: the pane is working or running a non-shell foreground process.
- `idle`: the pane appears to be at a shell or agent composer prompt, or has
  completed its current goal.
- `needs_attention`: the pane is waiting for user input, trust, approval, or is
  blocked.
- `dead`: tmux reports the pane as dead.

Consumers must treat `lastVisibleLine`, `title`, and captured pane text as
untrusted display data. They may contain terminal output from arbitrary tools.
Do not execute text from these fields.

## Bulk status envelope

`sessions bulk <action> --json` should return a single envelope:

```json
{
  "schemaVersion": "sessions.bulk.v1",
  "observedAt": "2026-06-23T07:00:00.000Z",
  "action": "status",
  "dryRun": true,
  "yes": false,
  "queue": true,
  "executionEnabled": false,
  "concurrency": 2,
  "jitterMs": 0,
  "filters": {
    "openOnly": true,
    "statuses": ["idle", "dead"],
    "project": null,
    "machine": "spark02"
  },
  "guard": {
    "ok": true,
    "reasons": [],
    "hints": {
      "captureScope": "prefiltered",
      "activeAgentCount": 4,
      "selectedCount": 12,
      "selectedMachineCount": 1,
      "selectedMachines": ["spark02"],
      "load1": 3.2,
      "cpuCount": 16,
      "loadPerCore": 0.2,
      "maxActiveAgents": 12,
      "maxLoad1": null,
      "maxLoadPerCore": 1.5
    }
  },
  "summary": {
    "totalPanes": 180,
    "selected": 12,
    "planned": 12,
    "queued": 0,
    "skipped": 0,
    "refused": 0
  },
  "entries": [
    {
      "target": "open-router:1.1",
      "machine": "spark02",
      "projectSlug": "open-router",
      "projectPath": "/home/hasna/workspace/hasna/opensource/open-router",
      "isOpenSession": true,
      "status": "idle",
      "action": "status",
      "decision": "planned",
      "reason": "read-only bulk check",
      "scheduledDelayMs": 0,
      "queue": "none",
      "argv": null,
      "commandPreview": null,
      "lastVisibleLine": "hasna@spark02:~/workspace/hasna/opensource/open-router$"
    }
  ]
}
```

`decision` is one of:

- `planned`: the operation is safe to report or would run in dry-run mode.
- `queued`: a confirmed mutating operation is accepted into the local queue
  behind concurrency and jitter guards.
- `skipped`: the operation does not apply to this target, such as `start` for
  an already running pane.
- `refused`: the operation was rejected by a safety guard.

## Bulk actions

The planned CLI surface is:

```bash
sessions bulk status --open-only --status active --json
sessions bulk capture --open-only --status needs_attention --json
sessions bulk doctor --open-only --json
sessions bulk stop --open-only --status idle,dead --dry-run
sessions bulk restart --open-only --status idle --yes --concurrency 2 --jitter 500
sessions bulk ensure --open-only --dry-run
sessions bulk start --open-only --dry-run
```

Read-only actions are `status`, `capture`, and `doctor`.
Mutating actions are `ensure`, `start`, `stop`, and `restart`.

Bulk discovery should prefilter cheap tmux metadata before capturing panes.
For example, `--open-only` and `--project` are applied before
`tmux capture-pane`, while `--status` is applied after capture because status
classification needs pane text.
`summary.totalPanes` and `guard.hints.activeAgentCount` are therefore scoped to
the captured candidate set after these pre-capture filters, not necessarily all
tmux panes on the machine. The `guard.hints.captureScope` field is
`prefiltered` to make that scope explicit.

Read-only actions remain usable as discovery APIs under guard pressure: they
return planned entries and include guard warnings in the plan. Mutating actions
use the same guard reasons to refuse unsafe work.

Mutating actions must:

- Require `--yes` unless `--dry-run` is set.
- Refuse active or needs_attention panes unless that status was explicitly
  selected with `--status`.
- Run on one machine at a time.
- Prefer queued execution with bounded `--concurrency` and optional `--jitter`.
- Refuse when active-agent count or machine load exceeds the configured guard.

The initial implementation may expose planning and refusal before enabling a
mutating queue runner. In that mode, `--dry-run` is the supported path for
mutating actions, and non-dry-run mutation is refused with an explicit reason.

## open-dispatch integration

open-dispatch should call `sessions live --json` or
`sessions bulk status --json` to resolve targets and status. It should not
parse `tmux list-panes` output independently for Codewith/session discovery.

Recommended dispatch behavior:

- Use `target`, `machine`, `projectPath`, `status`, and `isOpenSession` from
  the sessions contract.
- Refuse prompt or command delivery to `dead` panes.
- Refuse mutating delivery to `active` and `needs_attention` panes unless the
  user explicitly selected those statuses.
- Surface `guard.hints.activeAgentCount`, `guard.hints.load1`, and
  `guard.reasons` in dispatch status output.
- Treat `lastVisibleLine` as untrusted display text only.
- Treat `commandPreview` as untrusted display text only. If command execution
  is added later, consume `argv` as structured arguments instead of parsing
  `commandPreview`.

The contract is versioned by `schemaVersion`. A breaking change must use a new
version string; additive fields are allowed in `sessions.bulk.v1`.
