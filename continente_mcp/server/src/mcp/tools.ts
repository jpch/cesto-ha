/** continentept-mcp 0.12.1 tools, split by whether they can change the real cart. */
export const READ_TOOLS = [
  'search_products', 'get_product', 'get_product_labels', 'choose_products', 'list_favorites',
  'get_cart', 'preview_cart_changes', 'list_orders', 'get_order', 'list_frequently_bought_products',
  'get_session_status',
] as const;
export const MUTATING_TOOLS = ['add_cart_item', 'set_cart_item_quantity', 'remove_cart_item', 'clear_cart'] as const;

export type ReadTool = (typeof READ_TOOLS)[number];
export type MutatingTool = (typeof MUTATING_TOOLS)[number];
export type ToolName = ReadTool | MutatingTool;

export const isMutating = (name: string): name is MutatingTool => (MUTATING_TOOLS as readonly string[]).includes(name);

export type ResultStatus = 'success' | 'empty' | 'partial' | 'error';
export interface McpError { code: string; message: string; retryable?: boolean }
export interface ToolResult<T = Record<string, unknown>> {
  status: ResultStatus;
  data?: T;
  error?: McpError;
  /** Set by the server when a call was simulated in test mode instead of being sent. */
  simulated?: boolean;
}
