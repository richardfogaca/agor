import { describe, expect, it, vi } from 'vitest';
import { SessionsService } from './sessions.js';

describe('SessionsService queue startup barrier', () => {
  it('coalesces pre-start drains and processes new drains immediately after startup', async () => {
    const service = new SessionsService({} as never, {} as never);
    const processQueue = vi.fn(async () => undefined);
    service.setQueueProcessor(processQueue);

    await service.triggerQueueProcessing('session-1', { provider: 'first' } as never);
    await service.triggerQueueProcessing('session-1', { provider: 'latest' } as never);
    expect(processQueue).not.toHaveBeenCalled();

    await service.startQueueProcessing();
    expect(processQueue).toHaveBeenCalledOnce();
    expect(processQueue).toHaveBeenLastCalledWith('session-1', { provider: 'latest' });

    await service.triggerQueueProcessing('session-2');
    expect(processQueue).toHaveBeenLastCalledWith('session-2', undefined);
  });
});
