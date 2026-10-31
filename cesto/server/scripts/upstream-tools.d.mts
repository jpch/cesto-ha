export function canonical<T>(v: T): T;
export function shapeOnly<T>(v: T): T;
export function normalise(tools: readonly { name: string; inputSchema?: unknown; outputSchema?: unknown }[]): { name: string; inputSchema: object; outputSchema: object }[];
export function diff(expected: readonly { name: string }[], actual: readonly { name: string }[]): { added: string[]; removed: string[]; changed: { name: string; parts: string[] }[] };
export function report(d: ReturnType<typeof diff>, version?: string | null): string;
export const FORBIDDEN: RegExp;
