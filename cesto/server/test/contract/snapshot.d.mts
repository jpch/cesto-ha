export interface SnapshotTool { name: string; inputSchema: unknown; outputSchema: unknown }
export declare const canonical: (v: unknown) => unknown;
export declare const shapeOnly: (v: unknown) => unknown;
export declare function normalise(tools: readonly { name: string; inputSchema?: unknown; outputSchema?: unknown }[]): SnapshotTool[];
export declare function diff(expected: readonly SnapshotTool[], actual: readonly SnapshotTool[]): { added: string[]; removed: string[]; changed: { name: string; parts: string[] }[] };
