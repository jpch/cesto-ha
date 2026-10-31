import { describe, expect, it } from 'vitest';
import { parseLine, parseList } from '../src/parser.js';

const cases: [string, string, number | null, string | null][] = [
  ['2 kg batata', 'Batata', 2, 'kg'],
  ['batata 2kg', 'Batata', 2, 'kg'],
  ['1,5 kg de laranjas', 'Laranjas', 1.5, 'kg'],
  ['500g fiambre', 'Fiambre', 500, 'g'],
  ['250 gr queijo flamengo', 'Queijo flamengo', 250, 'g'],
  ['fiambre 200 gramas', 'Fiambre', 200, 'g'],
  ['1 l azeite', 'Azeite', 1, 'l'],
  ['azeite 1lt', 'Azeite', 1, 'l'],
  ['2 litros de leite', 'Leite', 2, 'l'],
  ['750 ml vinho tinto', 'Vinho tinto', 750, 'ml'],
  ['33cl cerveja', 'Cerveja', 330, 'ml'],
  ['leite x6', 'Leite', 6, 'un'],
  ['leite x 6', 'Leite', 6, 'un'],
  ['6x iogurtes', 'Iogurtes', 6, 'un'],
  ['6 ovos', 'Ovos', 6, 'un'],
  ['ovos 12', 'Ovos', 12, 'un'],
  ['meia dúzia de ovos', 'Ovos', 6, 'un'],
  ['uma dúzia ovos', 'Ovos', 12, 'un'],
  ['2 dúzias de ovos', 'Ovos', 24, 'un'],
  ['dois pacotes de leite', 'Leite', 2, 'un'],
  ['três latas de atum', 'Atum', 3, 'un'],
  ['uma garrafa de água', 'Água', 1, 'un'],
  ['3 un pão de forma', 'Pão de forma', 3, 'un'],
  ['pão de forma 2 un', 'Pão de forma', 2, 'un'],
  ['- 4 iogurtes naturais', 'Iogurtes naturais', 4, 'un'],
  ['• bananas', 'Bananas', null, null],
  ['[ ] papel higiénico', 'Papel higiénico', null, null],
  ['1. arroz carolino', 'Arroz carolino', null, null],
  ['detergente da loiça', 'Detergente da loiça', null, null],
  ['café', 'Café', null, null],
  ['1 kg arroz', 'Arroz', 1, 'kg'],
  ['coca-cola 1,5l', 'Coca-cola', 1.5, 'l'],
  ['2 quilos de cebolas', 'Cebolas', 2, 'kg'],
  ['sal', 'Sal', null, null],
];

describe('pt-PT parser', () => {
  it.each(cases)('%s', (input, name, quantity, unit) => {
    expect(parseLine(input)).toMatchObject({ name, quantity, unit });
  });

  it('has at least 30 cases', () => expect(cases.length).toBeGreaterThanOrEqual(30));

  it('splits a pasted list by lines, commas and semicolons, skipping blanks', () => {
    const items = parseList('2 kg batata\n\nleite x6, pão; 1,5 kg laranjas\n  ');
    expect(items.map(i => [i.name, i.quantity, i.unit])).toEqual([
      ['Batata', 2, 'kg'], ['Leite', 6, 'un'], ['Pão', null, null], ['Laranjas', 1.5, 'kg'],
    ]);
  });
});
