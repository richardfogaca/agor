import { describe, expect, it } from 'vitest';
import { renderAgorSystemPrompt } from './session-context';

describe('renderAgorSystemPrompt', () => {
  it('refreshes repository policy when a provider thread is resumed', async () => {
    const prompt = await renderAgorSystemPrompt();

    expect(prompt).toMatch(/including one that resumes an existing provider\s+thread/);
    expect(prompt).toContain('re-resolve the current repository instruction entry point from disk');
    expect(prompt).toContain('instruction text already present in the conversation is historical');
  });

  it('tells agents which portable and rich Markdown constructs to use', async () => {
    const prompt = await renderAgorSystemPrompt();

    expect(prompt).toContain('portable GitHub-flavored Markdown');
    expect(prompt).toContain('Mermaid, math, and GitHub callouts');
    expect(prompt).toContain('gateways such as Slack support fewer constructs');
  });
});
