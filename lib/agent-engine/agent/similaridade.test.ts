import { describe, expect, it } from 'vitest';

import type { MotoDoCatalogo } from './fotos-do-catalogo';
import {
  cilindradaDaMoto,
  extrairCilindrada,
  extrairPrecoDoPedido,
  ordenarSimilares,
  parsePreco,
} from './similaridade';

function moto(nome: string, preco: string, extras: Partial<MotoDoCatalogo> = {}): MotoDoCatalogo {
  return { nome, preco, fotos: ['http://x/1.jpg'], ...extras };
}

const CATALOGO: MotoDoCatalogo[] = [
  moto('CB 300 F Twister', '28990.00'),
  moto('YS Fazer 250', '17990.00'),
  moto('XMax 250', '31990.00'),
  moto('XTZ 150 CROSSER', '16990.00'),
  moto('S 1000', '95990.00'),
];

describe('extrairCilindrada', () => {
  it('pega o número da cilindrada no nome/pedido', () => {
    expect(extrairCilindrada('CB 250')).toBe(250);
    expect(extrairCilindrada('cb250')).toBe(250);
    expect(extrairCilindrada('tem uma 300cc?')).toBe(300);
    expect(extrairCilindrada('XTZ 150 CROSSER')).toBe(150);
    expect(extrairCilindrada('S 1000')).toBe(1000);
  });

  it('ignora o ANO (1900–2099)', () => {
    expect(extrairCilindrada('CB 300 F Twister 2025')).toBe(300);
    expect(extrairCilindrada('modelo 2024')).toBeNull();
  });

  it('sem número de cilindrada → null', () => {
    expect(extrairCilindrada('quero uma moto')).toBeNull();
    expect(extrairCilindrada('cb25p')).toBeNull(); // 25 < 50
  });
});

describe('parsePreco / extrairPrecoDoPedido', () => {
  it('formatação BR e US', () => {
    expect(parsePreco('R$ 28.990,00')).toBe(28990);
    expect(parsePreco('28990.00')).toBe(28990);
    expect(parsePreco('17.990,00')).toBe(17990);
    expect(parsePreco(undefined)).toBeNull();
  });

  it('preço no pedido, inclusive "mil"', () => {
    expect(extrairPrecoDoPedido('até 30 mil')).toBe(30000);
    expect(extrairPrecoDoPedido('uns 30000 reais')).toBe(30000);
    expect(extrairPrecoDoPedido('qualquer preço')).toBeNull();
  });
});

describe('cilindradaDaMoto', () => {
  it('usa a coluna quando existe; senão, o nome', () => {
    expect(cilindradaDaMoto(moto('Twister', '1000', { cilindrada: '300' }))).toBe(300);
    expect(cilindradaDaMoto(moto('YS Fazer 250', '17990'))).toBe(250);
  });
});

describe('ordenarSimilares', () => {
  it('mesma cilindrada primeiro, desempate pelo menor preço', () => {
    const r = ordenarSimilares('vc tem a CB 250?', CATALOGO, { quantidade: 3 });
    expect(r.map((m) => m.nome)).toEqual(['YS Fazer 250', 'XMax 250', 'CB 300 F Twister']);
  });

  it('cilindrada mais próxima quando não há a exata', () => {
    const r = ordenarSimilares('tem 400?', CATALOGO, { quantidade: 2 });
    // 300 e 250 são os mais próximos de 400; empate em |diff| (100 vs 150) -> 300 primeiro.
    expect(r[0]?.nome).toBe('CB 300 F Twister');
  });

  it('sem cilindrada no pedido → mais baratas primeiro', () => {
    const r = ordenarSimilares('quero uma moto', CATALOGO, { quantidade: 3 });
    expect(r.map((m) => m.nome)).toEqual(['XTZ 150 CROSSER', 'YS Fazer 250', 'CB 300 F Twister']);
  });

  it('catálogo vazio → []', () => {
    expect(ordenarSimilares('CB 250', [], { quantidade: 3 })).toEqual([]);
  });

  it('nunca devolve vazio com catálogo preenchido', () => {
    const r = ordenarSimilares('xyz', CATALOGO, { quantidade: 3 });
    expect(r).toHaveLength(3);
  });
});
