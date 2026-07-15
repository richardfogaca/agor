# Task Queueing

**Tasks are the queueable unit. Sessions accept prompts. The Task entity itself
encodes whether the prompt ran or got queued.**

## Wire shape

`POST /sessions/:id/prompt` always returns a `Task`. Callers inspect:

- `task.status === 'queued'` → session was busy; the task is waiting and will
  drain automatically when the session goes idle.
- `task.status === 'dispatching'` → admitted; the executor has not connected yet.
- `task.status === 'running'` → the admitted executor authenticated successfully.
- `task.queue_position` → ordering within the session's queue (lowest drains
  first), populated only while QUEUED.

There is no separate "queued vs ran" envelope. The route does not take a
`queue: true` flag. Callers don't ask, the response answers.

## Lifecycle

1. **Materialize** — the route creates the same CREATED Task shape for every
   prompt. `TaskRepository.admitExecutorTurn` atomically decides whether that
   task becomes DISPATCHING or QUEUED.
2. **Drain** — when a session reaches a terminal task state, the queue
   processor picks the lowest `queue_position` and hands it to
   `spawnTaskExecutor`, which is the _sole_ place that pins
   `message_range`/`git_state`, writes the initial user-message row, and
   spawns the executor.
3. **Race safety** — admission locks the session row and enforces one active or
   unreleased executor turn. Terminal work remains a blocker until process exit
   and required persistence settle; release then drains the FIFO queue.
4. **Stop safety** — Stop reserves the current turn under the same session lock,
   persists STOPPED before signaling the process, and leaves admission blocked
   until exit cleanup releases the turn.

## Key files

- Repo: `packages/core/src/db/repositories/tasks.ts` (`createPending`,
  `admitExecutorTurn`, `reserveExecutorStop`, `releaseExecutorTurn`)
- Route: `apps/agor-daemon/src/register-routes.ts` (`/sessions/:id/prompt`,
  `spawnTaskExecutor`, `processNextQueuedTask`)
- Reactive client: `packages/client/src/reactive-session.ts` (handles
  `tasks:created`/`tasks:queued`/`tasks:patched` events)

## Rationale

The queue was originally implemented at the message layer (`messages.status='queued'`).
Tasks are the natural queueable unit: each prompt is exactly one task, the task
already carries the prompt + metadata + lifecycle, and the executor only needs
to know "give me the next task to run." Migration to task-level queueing
landed in `never-lose-prompt` (sqlite/0040, postgres/0030).
