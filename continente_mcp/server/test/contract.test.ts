import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { makeApp } from './helpers.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

describe('OpenAPI contract', () => {
  it('every documented operation is a registered route', async () => {
    const spec = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    const { app } = makeApp();
    await app.ready();
    let count = 0;
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const method of METHODS) {
        if (!ops[method]) continue;
        count++;
        const url = `/api/v1${path.replace(/\{(\w+)\}/g, ':$1')}`;
        expect(app.hasRoute({ method: method.toUpperCase() as 'GET', url }), `${method} ${url}`).toBe(true);
      }
    }
    expect(count).toBeGreaterThanOrEqual(6);
  });
});
