# Task Queueing

**Tasks are the queueable unit. Sessions accept prompts. Every accepted prompt
enters one durable FIFO before preparation or execution.**

## Wire shape

`POST /sessions/:id/prompt` returns the newly queued `Task`:

- `task.status === 'queued'` → durably accepted; it will be claimed immediately
  if the session is available, otherwise it waits.
- `task.status === 'dispatching'` → admitted; the executor has not connected yet.
- `task.status === 'running'` → the admitted executor authenticated successfully.
- `task.queue_position` → ordering within the session's queue (lowest drains
  first), populated only while QUEUED.

There is no separate "queued vs ran" envelope or `queue: true` flag. Reactive
task events expose the later DISPATCHING/RUNNING transitions.

## Lifecycle

1. **Materialize** — every prompt is atomically created as QUEUED with its
   durable `queue_position` before fallible preparation starts.
2. **Drain** — the repository claims only the lowest `queue_position`, moving
   it to DISPATCHING (or RUNNING for the legacy CLI). The queue processor then
   hands that claimed task to `startClaimedTask`, which is the _sole_ place that pins
   `message_range`/`git_state`, writes the initial user-message row, and
   spawns the executor.
3. **Race safety** — claiming locks the session row and enforces one active or
   unreleased executor turn. Terminal work remains a blocker until process exit
   and required persistence settle; release then drains the FIFO queue.
4. **Stop safety** — Stop reserves the current turn under the same session lock,
   persists STOPPED before signaling the process, and leaves admission blocked
   until exit cleanup releases the turn.

## Key files

- Repo: `packages/core/src/db/repositories/tasks.ts` (`createPending`,
  `claimNextExecutorTurn`, `reserveExecutorStop`, `releaseExecutorTurn`)
- Route: `apps/agor-daemon/src/register-routes.ts` (`/sessions/:id/prompt`,
  `startClaimedTask`, `processNextQueuedTask`)
- Reactive client: `packages/client/src/reactive-session.ts` (handles
  `tasks:created`/`tasks:queued`/`tasks:patched` events)

## Rationale

The queue was originally implemented at the message layer (`messages.status='queued'`).
Tasks are the natural queueable unit: each prompt is exactly one task, the task
already carries the prompt + metadata + lifecycle, and the executor only needs
to know "give me the next task to run." Migration to task-level queueing
landed in `never-lose-prompt` (sqlite/0040, postgres/0030).
