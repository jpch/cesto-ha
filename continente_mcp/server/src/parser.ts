/** Simple pt-PT shopping-list parser (decision 19): quantity, unit and description per line. */
export type Unit = 'un' | 'kg' | 'g' | 'l' | 'ml';
export interface ParsedItem { name: string; quantity: number | null; unit: Unit | null; raw: string }

const NUMBER_WORDS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, 'três': 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8,
  nove: 9, dez: 10, onze: 11, doze: 12, meio: 0.5, meia: 0.5,
};
const UNIT_WORDS: [RegExp, Unit, number][] = [
  [/^(kg|kgs|quilos?|kilos?|quilogramas?)$/, 'kg', 1],
  [/^(g|gr|grs|gramas?)$/, 'g', 1],
  [/^(l|lt|lts|litros?)$/, 'l', 1],
  [/^(ml|mililitros?)$/, 'ml', 1],
  [/^(cl|centilitros?)$/, 'ml', 10],
  [/^(un|und|unid|unids|unidades?|x)$/, 'un', 1],
];
const PACK_WORDS = /^(pacotes?|embalagens?|garrafas?|latas?|frascos?|caixas?|sacos?|packs?|cuvetes?|molhos?)$/;

const toNumber = (token: string): number | null => {
  const t = token.toLowerCase();
  if (/^\d+([.,]\d+)?$/.test(t)) return Number(t.replace(',', '.'));
  return NUMBER_WORDS[t] ?? null;
};
const toUnit = (token: string): [Unit, number] | null => {
  const t = token.toLowerCase().replace(/\.$/, '');
  for (const [re, unit, factor] of UNIT_WORDS) if (re.test(t)) return [unit, factor];
  return null;
};
/** Splits glued forms like "2kg", "500gr", "1,5l", "x6", "6x". */
const splitGlued = (token: string): string[] => {
  const m = /^(\d+(?:[.,]\d+)?)([a-zA-Z]+)\.?$/.exec(token);
  if (m && toUnit(m[2]!)) return [m[1]!, m[2]!];
  const x = /^[xX](\d+)$/.exec(token) ?? /^(\d+)[xX]$/.exec(token);
  if (x) return ['x', x[1]!];
  return [token];
};

export function parseLine(raw: string): ParsedItem | null {
  const line = raw.replace(/^\s*([-*•·+]|\d+[.)])\s+/, '').replace(/^\s*\[[ xX]?\]\s*/, '').trim();
  if (!line) return null;
  let tokens = line.split(/\s+/).flatMap(splitGlued);
  let quantity: number | null = null;
  let unit: Unit | null = null;

  // "meia dúzia (de) ovos", "uma dúzia de ovos", "2 dúzias de ovos"
  const dz = tokens.findIndex(t => /^d[uú]zias?$/i.test(t));
  if (dz >= 0) {
    const n = dz > 0 ? toNumber(tokens[dz - 1]!) : 1;
    quantity = (n ?? 1) * 12; unit = 'un';
    tokens.splice(Math.max(0, dz - (n !== null && dz > 0 ? 1 : 0)), n !== null && dz > 0 ? 2 : 1);
    if (/^de$/i.test(tokens[0] ?? '')) tokens.shift();
  }

  // Leading: [number] [unit|pack word] [de] name
  if (quantity === null && tokens.length > 1) {
    const n = toNumber(tokens[0]!);
    if (n !== null) {
      const u = toUnit(tokens[1] ?? '');
      if (u) {
        quantity = n * u[1]; unit = u[0]; tokens = tokens.slice(2);
      } else if (PACK_WORDS.test((tokens[1] ?? '').toLowerCase())) {
        quantity = n; unit = 'un'; tokens = tokens.slice(2);
      } else {
        quantity = n; unit = 'un'; tokens = tokens.slice(1);
      }
      if (/^de$/i.test(tokens[0] ?? '') && tokens.length > 1) tokens.shift();
    } else if (tokens[0]!.toLowerCase() === 'x' && toNumber(tokens[1] ?? '') !== null) {
      quantity = toNumber(tokens[1]!); unit = 'un'; tokens = tokens.slice(2);
    }
  }

  // Trailing: name [number] [unit] | name x [number] | name [number]
  if (quantity === null && tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    const prev = tokens[tokens.length - 2]!;
    const u = toUnit(last);
    if (u && u[0] !== 'un' && toNumber(prev) !== null && tokens.length > 2) {
      quantity = toNumber(prev)! * u[1]; unit = u[0]; tokens = tokens.slice(0, -2);
    } else if (prev.toLowerCase() === 'x' && toNumber(last) !== null && tokens.length > 2) {
      quantity = toNumber(last); unit = 'un'; tokens = tokens.slice(0, -2);
    } else if (/^\d+([.,]\d+)?$/.test(last)) {
      quantity = toNumber(last); unit = 'un'; tokens = tokens.slice(0, -1);
    } else if (u && u[0] === 'un' && /^\d+$/.test(prev) && tokens.length > 2) {
      quantity = Number(prev); unit = 'un'; tokens = tokens.slice(0, -2);
    }
  }

  const name = tokens.join(' ').replace(/[,;:.\-–]+$/, '').trim();
  if (!name) return null;
  return { name: name.charAt(0).toLocaleUpperCase('pt-PT') + name.slice(1), quantity, unit, raw: raw.trim() };
}

export function parseList(text: string): ParsedItem[] {
  return text
    .split(/\r?\n|;|,(?!\d)/)
    .map(parseLine)
    .filter((i): i is ParsedItem => i !== null);
}
