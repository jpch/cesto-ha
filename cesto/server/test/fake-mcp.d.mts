export declare const TOOLS: string[];
export declare const FAKE_TOKEN: string;
export interface FakeMcp { url: string; token: string; calls: { name: string; args: Record<string, unknown> }[]; clients: ({ name: string; version: string } | null)[]; close(): Promise<void> }
export declare function startFakeMcp(o?: { mode?: 'ok' | 'not_authenticated' | 'drop_once'; token?: string }): Promise<FakeMcp>;
