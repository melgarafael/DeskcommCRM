import { describe, expect, it } from 'vitest';

import type { MotoDoCatalogo } from './fotos-do-catalogo';
import {
  cilindradaDaMoto,
  extrairCilindrada,
  extrairPrecoDoPedido,
  numeroDaCelula,
  ordenarSimilares,
  parsePreco,
  relevanciaDoNome,
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

describe('relevanciaDoNome', () => {
  it('nome igual ao termo vale 2 (máximo)', () => {
    expect(relevanciaDoNome('Neo 125', 'Neo 125')).toBe(2);
  });

  it('nome inteiro citado num termo maior pontua alto', () => {
    expect(relevanciaDoNome('quero a Neo 125 por favor', 'Neo 125')).toBeGreaterThan(1);
    expect(relevanciaDoNome('YAMAHA Neo 125 UBS 2025', 'Neo 125')).toBeGreaterThan(0);
  });

  it('pontua mais o nome mais específico (com versão)', () => {
    const termo = 'quero a Biz 125 Flex';
    expect(relevanciaDoNome(termo, 'Biz 125 Flex')).toBeGreaterThan(
      relevanciaDoNome(termo, 'Biz 125'),
    );
  });

  it('sem tokens em comum → 0; sem nome → 0', () => {
    expect(relevanciaDoNome('nenhum token aqui', 'Neo 125')).toBe(0);
    expect(relevanciaDoNome('Neo 125', undefined)).toBe(0);
    expect(relevanciaDoNome('Neo 125', '')).toBe(0);
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

  it('critério `nome` põe a moto de nome igual primeiro (ex.: Neo 125)', () => {
    const catalogo = [
      moto('Biz 125', '14500.00'),
      moto('CBX 250', '9990.00'),
      moto('Neo 125', '13500.00'),
    ];
    const r = ordenarSimilares('YAMAHA Neo 125 UBS 2025', catalogo, {
      quantidade: 1,
      criterios: ['nome'],
    });
    expect(r[0]?.nome).toBe('Neo 125');
  });

  it('nome composto (nome + versão) casa o pedido com a versão', () => {
    const catalogo = [moto('Biz 125', '14500.00'), moto('Biz 125 Flex', '15000.00')];
    const r = ordenarSimilares('quero a Biz 125 Flex', catalogo, {
      quantidade: 1,
      criterios: ['nome'],
    });
    expect(r[0]?.nome).toBe('Biz 125 Flex');
  });
});

describe('ordenarSimilares — critérios por COLUNA (qualquer coluna marcada "Comparar")', () => {
  const COM_VALORES: MotoDoCatalogo[] = [
    { nome: 'XRE 300', valores: { marca: 'Honda', cilindrada: '300', ano: '2022' }, fotos: [] },
    { nome: 'Lander 250', valores: { marca: 'Yamaha', cilindrada: '250', ano: '2020' }, fotos: [] },
    { nome: 'Biz 125', valores: { marca: 'Honda', cilindrada: '125', ano: '2024' }, fotos: [] },
  ];

  it('coluna numérica: o mais próximo do número do pedido vem primeiro', () => {
    const r = ordenarSimilares('quero uma 300', COM_VALORES, {
      quantidade: 3,
      criteriosColunas: ['cilindrada'],
    });
    expect(r[0]?.nome).toBe('XRE 300');
  });

  it('coluna de texto: o mais parecido com o pedido vem primeiro (sem limitar marca)', () => {
    const r = ordenarSimilares('prefiro Honda', COM_VALORES, {
      quantidade: 3,
      criteriosColunas: ['marca'],
    });
    // Honda antes de Yamaha, mas Yamaha continua na lista (não filtra).
    expect(r.map((m) => m.nome)).toContain('Lander 250');
    expect(r[0]?.valores?.marca).toBe('Honda');
  });
});

describe('numeroDaCelula — numérico só quando a célula é essencialmente número', () => {
  it('números com rótulo de moeda/unidade contam', () => {
    expect(numeroDaCelula('14500.00')).toBe(14500);
    expect(numeroDaCelula('R$ 14.500,00')).toBe(14500);
    expect(numeroDaCelula('125')).toBe(125);
    expect(numeroDaCelula('125 cc')).toBe(125);
    expect(numeroDaCelula('29000 km')).toBe(29000);
    expect(numeroDaCelula('2021')).toBe(2021);
  });

  it('nome/categoria/marca com letras NÃO é número (era o defeito da BMW)', () => {
    expect(numeroDaCelula('HONDA Biz 125 FLEX 2021')).toBeNull();
    expect(numeroDaCelula('BMW G 310 GS 2022')).toBeNull();
    expect(numeroDaCelula('Street')).toBeNull();
    expect(numeroDaCelula('HONDA')).toBeNull();
  });

  it('coluna `nome` com dígitos usa relevância textual (não distância numérica)', () => {
    const cat: MotoDoCatalogo[] = [
      { nome: 'HONDA CG 160 Titan', valores: { nome: 'HONDA CG 160 Titan' }, fotos: [] },
      { nome: 'BMW G 310 GS 2022', valores: { nome: 'BMW G 310 GS 2022' }, fotos: [] },
    ];
    const r = ordenarSimilares('HONDA Biz 125 FLEX 2021 HONDA', cat, {
      quantidade: 2,
      criteriosColunas: ['nome'],
    });
    expect(r[0]?.nome).toBe('HONDA CG 160 Titan');
  });
});

describe('ordenarSimilares — preferência de ordem (qualquer coluna)', () => {
  const CAT: MotoDoCatalogo[] = [
    { nome: 'A', valores: { categoria: 'Naked', preco: '30000', ano: '2015' }, fotos: [] },
    { nome: 'B', valores: { categoria: 'Naked', preco: '20000', ano: '2022' }, fotos: [] },
    { nome: 'C', valores: { categoria: 'Naked', preco: '25000', ano: '2018' }, fotos: [] },
  ];

  it('preco "menor" → mais baratas primeiro, entre as parecidas', () => {
    const r = ordenarSimilares('naked', CAT, {
      quantidade: 3,
      criteriosColunas: ['categoria'],
      preferencias: { preco: 'menor' },
    });
    expect(r.map((m) => m.nome)).toEqual(['B', 'C', 'A']);
  });

  it('ano "maior" → mais novas primeiro', () => {
    const r = ordenarSimilares('naked', CAT, {
      quantidade: 3,
      criteriosColunas: ['categoria'],
      preferencias: { ano: 'maior' },
    });
    expect(r.map((m) => m.nome)).toEqual(['B', 'C', 'A']);
  });
});
