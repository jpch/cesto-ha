import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface TokenRecord { id: number; name: string; kind: 'phone' | 'app' | 'ha'; created_at: string; last_used_at: string | null; revoked_at: string | null }

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Bearer tokens: only the SHA-256 hash is stored; the plain token is shown once at creation. */
export class TokenStore {
  constructor(private readonly db: DatabaseSync) {}

  create(name: string, kind: 'phone' | 'app'): { token: string; record: TokenRecord } {
    const token = `cmh_${randomBytes(32).toString('base64url')}`;
    const now = new Date().toISOString();
    const info = this.db.prepare('INSERT INTO tokens (name, kind, token_hash, created_at) VALUES (?, ?, ?, ?)').run(name, kind, hash(token), now);
    return { token, record: this.get(Number(info.lastInsertRowid))! };
  }

  get(id: number): TokenRecord | undefined {
    return this.db.prepare('SELECT id, name, kind, created_at, last_used_at, revoked_at FROM tokens WHERE id = ?').get(id) as TokenRecord | undefined;
  }

  list(): TokenRecord[] {
    return this.db.prepare('SELECT id, name, kind, created_at, last_used_at, revoked_at FROM tokens ORDER BY id').all() as unknown as TokenRecord[];
  }

  revoke(id: number): boolean {
    return this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), id).changes > 0;
  }

  /** Returns the token record for a valid, non-revoked token, updating last_used_at. */
  verify(token: string): TokenRecord | undefined {
    const row = this.db.prepare('SELECT id FROM tokens WHERE token_hash = ? AND revoked_at IS NULL').get(hash(token)) as { id: number } | undefined;
    if (!row) return undefined;
    this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    return this.get(row.id);
  }
}
