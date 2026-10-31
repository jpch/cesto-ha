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
