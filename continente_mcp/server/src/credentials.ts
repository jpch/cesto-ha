import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class CredentialsError extends Error {
  constructor(readonly key: string) { super(key); }
}

/**
 * Continente account details for continentept-mcp, kept in `<dataDir>/continente/credentials.env` (0600).
 * The password is write-only: the API never returns it.
 */
export class CredentialsStore {
  readonly dir: string;
  readonly file: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'continente');
    this.file = join(this.dir, 'credentials.env');
  }

  save(email: unknown, secret: unknown): void {
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(email.trim()))
      throw new CredentialsError('error.invalid_email');
    if (typeof secret !== 'string' || !secret || secret.length > 256 || /[\r\n\0']/.test(secret))
      throw new CredentialsError('error.invalid_password');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    // Single-quoted values: the file format strips one pair of quotes and expands nothing.
    const entries = [['CONTINENTE_EMAIL', email.trim()], ['CONTINENTE_PASSWORD', secret]];
    writeFileSync(this.file, entries.map(([k, v]) => `${k}='${v}'\n`).join(''), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  remove(): boolean {
    if (!existsSync(this.file)) return false;
    rmSync(this.file);
    return true;
  }

  /** Masked email only, e.g. `jo…@gmail.com`. */
  status(): { configured: boolean; email: string | null } {
    if (!existsSync(this.file)) return { configured: false, email: null };
    const m = /^CONTINENTE_EMAIL='?([^'\n]*)'?$/m.exec(readFileSync(this.file, 'utf8'));
    const email = m?.[1] ?? '';
    const [user = '', domain = ''] = email.split('@');
    return { configured: !!email, email: email ? `${user.slice(0, 2)}…@${domain}` : null };
  }
}
