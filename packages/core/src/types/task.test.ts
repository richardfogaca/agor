import { describe, expect, it } from 'vitest';
import { isTaskExecuting, isTaskTurnHolding, TaskStatus } from './task';

describe('task execution helpers', () => {
  it('identifies executor-owned task states', () => {
    expect(isTaskExecuting({ status: TaskStatus.DISPATCHING })).toBe(true);
    expect(isTaskExecuting({ status: TaskStatus.RUNNING })).toBe(true);
    expect(isTaskExecuting({ status: TaskStatus.STOPPING })).toBe(true);
    expect(isTaskExecuting({ status: TaskStatus.AWAITING_PERMISSION })).toBe(true);
    expect(isTaskExecuting({ status: TaskStatus.AWAITING_INPUT })).toBe(true);
  });

  it('holds a terminal turn until executor cleanup releases it', () => {
    expect(
      isTaskTurnHolding({
        status: TaskStatus.COMPLETED,
        executor_attempt: { id: 'attempt-1' },
      })
    ).toBe(true);
    expect(
      isTaskTurnHolding({
        status: TaskStatus.COMPLETED,
        executor_attempt: { id: 'attempt-1', released_at: '2026-07-15T00:00:00.000Z' },
      })
    ).toBe(false);
  });

  it('excludes queued, pre-executor, and terminal task states', () => {
    expect(isTaskExecuting({ status: TaskStatus.QUEUED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.CREATED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.COMPLETED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.FAILED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.STOPPED })).toBe(false);
    expect(isTaskExecuting({ status: TaskStatus.TIMED_OUT })).toBe(false);
  });
});
