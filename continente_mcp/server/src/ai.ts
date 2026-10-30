/**
 * Optional text AI provider, configured in the add-on options (`ai_provider`, `ai_api_key`, `ai_model`).
 * The same settings are meant for the planned vision AI. Default `none`: nothing leaves the server.
 */
export type AiProviderName = 'none' | 'openai' | 'anthropic';
export const AI_PROVIDERS: readonly AiProviderName[] = ['none', 'openai', 'anthropic'];
export interface AiConfig { provider: AiProviderName; apiKey: string | null; model: string | null }

export interface AiClient { readonly name: AiProviderName; completeJson(system: string, user: string): Promise<unknown> }

const DEFAULT_MODEL: Record<Exclude<AiProviderName, 'none'>, string> = { openai: 'gpt-4o-mini', anthropic: 'claude-3-5-haiku-latest' };
const TIMEOUT_MS = 20_000;

/** Extracts the first JSON object from a model reply (models sometimes wrap it in a code fence). */
export function parseJsonReply(text: string): unknown {
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in AI reply');
  return JSON.parse(text.slice(start, end + 1));
}

export function createAiClient(cfg: AiConfig, fetchImpl: typeof fetch = fetch): AiClient | null {
  if (cfg.provider === 'none' || !cfg.apiKey) return null;
  const key = cfg.apiKey;
  const model = cfg.model || DEFAULT_MODEL[cfg.provider];
  const post = async (url: string, headers: Record<string, string>, body: unknown) => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`AI provider returned HTTP ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  if (cfg.provider === 'openai') return {
    name: 'openai',
    async completeJson(system, user) {
      const r = await post('https://api.openai.com/v1/chat/completions', { authorization: `Bearer ${key}` },
        { model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
      const text = (r.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('empty AI reply');
      return parseJsonReply(text);
    },
  };
  return {
    name: 'anthropic',
    async completeJson(system, user) {
      const r = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        { model, max_tokens: 2000, system, messages: [{ role: 'user', content: user }] });
      const text = (r.content as { type: string; text?: string }[] | undefined)?.find(c => c.type === 'text')?.text;
      if (typeof text !== 'string') throw new Error('empty AI reply');
      return parseJsonReply(text);
    },
  };
}
