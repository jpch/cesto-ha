import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

const withOptions = (options: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  writeFileSync(join(dir, 'options.json'), JSON.stringify(options));
  return loadConfig({ OPTIONS_PATH: join(dir, 'options.json') });
};

describe('config', () => {
  it('defaults to test mode on when options are missing', () => {
    expect(loadConfig({ OPTIONS_PATH: '/nonexistent.json' }).testMode).toBe(true);
  });
  it('keeps test mode on for anything but an explicit false', () => {
    expect(withOptions({ test_mode: 'false' }).testMode).toBe(true);
    expect(withOptions({ test_mode: false }).testMode).toBe(false);
  });
  it('defaults vision provider to none and language to pt-PT', () => {
    const c = withOptions({});
    expect(c.visionProvider).toBe('none');
    expect(c.language).toBe('pt-PT');
  });
});

describe('addonSlug', () => {
  it('derives the slug from the Supervisor hostname, or ADDON_SLUG', async () => {
    const { addonSlug } = await import('../src/config.js');
    expect(addonSlug({ HOSTNAME: '0369824b-cesto' })).toBe('0369824b_cesto');
    expect(addonSlug({ HOSTNAME: 'local-cesto' })).toBe('local_cesto');
    expect(addonSlug({ HOSTNAME: 'abc' })).toBeNull();
    expect(addonSlug({ HOSTNAME: 'Bad Host' })).toBeNull();
    expect(addonSlug({ ADDON_SLUG: 'x1_cesto', HOSTNAME: '0369824b-cesto' })).toBe('x1_cesto');
    expect(addonSlug({ ADDON_SLUG: '../evil' })).toBeNull();
  });
});
