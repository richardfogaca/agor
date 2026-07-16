import type { HistoricalTaskImport } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

const historicalTask: HistoricalTaskImport = {
  session_id: 'session-1',
  full_prompt: 'Imported prompt',
  message_range: { start_index: 0, end_index: 1, start_timestamp: new Date().toISOString() },
  git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
  tool_use_count: 1,
};

function serviceWithRepo() {
  const importHistorical = vi.fn().mockResolvedValue([]);
  const service = Object.create(TasksService.prototype) as TasksService & {
    taskRepo: { importHistorical: typeof importHistorical };
  };
  service.taskRepo = { importHistorical };
  return { service, importHistorical };
}

describe('TasksService historical import', () => {
  it('passes only the narrow historical DTO to the repository', async () => {
    const { service, importHistorical } = serviceWithRepo();
    await service.importHistorical([historicalTask], 'importer');
    expect(importHistorical).toHaveBeenCalledWith([historicalTask], 'importer');
  });

  it.each([
    'status',
    'task_id',
    'executor_attempt',
    'completed_at',
  ])('rejects caller-controlled %s lifecycle data', async (field) => {
    const { service, importHistorical } = serviceWithRepo();
    await expect(
      service.importHistorical([{ ...historicalTask, [field]: 'forged' }], 'importer')
    ).rejects.toThrow('not allowed');
    expect(importHistorical).not.toHaveBeenCalled();
  });
});
