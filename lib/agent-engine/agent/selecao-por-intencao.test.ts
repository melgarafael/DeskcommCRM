import { describe, expect, it } from 'vitest';

import type { CatalogoMapeamento } from '@/lib/external-db/catalogo';

import type { MotoDoCatalogo } from './fotos-do-catalogo';
import { querAlternativa, selecionarPorIntencao } from './selecao-por-intencao';

const MAPEAMENTO: CatalogoMapeamento = {
  connectionId: 'c1',
  schemaName: 'public',
  tableName: 'motos',
  colNome: 'nome',
  colVersao: null,
  colAno: 'ano',
  colCor: 'cor',
  colKm: 'quilometragem',
  colPreco: 'preco',
  colImagem: 'imagem_url',
  colEstoque: null,
  colCilindrada: 'cilindrada',
  colTipo: 'categoria',
  buscaOperador: 'contem',
  similaridadeDeterministica: true,
  similaresQtd: 3,
  colunas: [
    { coluna: 'nome', comparar: true, ordem: 1, compoeNome: true },
    { coluna: 'categoria', comparar: true, ordem: 2 },
    { coluna: 'cilindrada', comparar: true, ordem: 2 },
    { coluna: 'marca', comparar: true, ordem: 3 },
    { coluna: 'preco', comparar: true, ordem: 4 },
  ],
  colSimilares: 'moto_similar',
};

function moto(
  nome: string,
  dados: {
    categoria: string;
    cilindrada: string;
    marca: string;
    preco: string;
    similar?: string;
  },
): MotoDoCatalogo {
  return {
    nome,
    fotos: [`http://x/${nome.replace(/\s+/g, '-')}.jpg`],
    preco: dados.preco,
    valores: {
      nome,
      categoria: dados.categoria,
      cilindrada: dados.cilindrada,
      marca: dados.marca,
      preco: dados.preco,
      moto_similar: dados.similar ?? '',
    },
  };
}

const ATUAL = moto('HONDA Biz 125', {
  categoria: 'Street',
  cilindrada: '125',
  marca: 'HONDA',
  preco: '14500',
});

const CATALOGO: MotoDoCatalogo[] = [
  ATUAL,
  moto('HONDA Pop 110', { categoria: 'Street', cilindrada: '110', marca: 'HONDA', preco: '9000' }),
  moto('HONDA CG 160', { categoria: 'Street', cilindrada: '160', marca: 'HONDA', preco: '12000' }),
  moto('HONDA CB 300', { categoria: 'Naked', cilindrada: '300', marca: 'HONDA', preco: '28000' }),
];

describe('querAlternativa (pré-filtro)', () => {
  it('reconhece objeção de preço e pedido de outra moto', () => {
    for (const frase of [
      'Achei caro',
      'ta muito caro',
      'consegue uma mais barata?',
      'quero outra moto',
      'mudei de ideia',
      'quero trocar de moto',
      'tem outra cor?',
      'quero ver mais opções',
      'queria algo diferente',
    ]) {
      expect(querAlternativa(frase), frase).toBe(true);
    }
  });

  it('não dispara em turnos sem necessidade de consultar o catálogo', () => {
    for (const frase of ['obrigado', 'ok', 'beleza', 'bom dia', 'vou financiar', 'quanto fica?']) {
      expect(querAlternativa(frase), frase).toBe(false);
    }
  });
});

describe('selecionarPorIntencao', () => {
  /**
   * C-085: pedido de ESPECIFICAÇÃO ("CB 300") com `todasSeEspecificacao` devolve
   * TODAS as unidades que batem, em vez de recortar em `similaresQtd` (3).
   */
  it('C-085: especificação devolve TODAS as que batem quando todasSeEspecificacao', () => {
    const familia = [
      moto('HONDA CB 300 R 2011', { categoria: 'Naked', cilindrada: '300', marca: 'HONDA', preco: '12500' }),
      moto('HONDA CB 300 R FLEX 2015', { categoria: 'Naked', cilindrada: '300', marca: 'HONDA', preco: '14990' }),
      moto('HONDA CB 300 F Twister 2022', { categoria: 'Naked', cilindrada: '300', marca: 'HONDA', preco: '28990' }),
      moto('HONDA CB 300 F Twister 2023', { categoria: 'Naked', cilindrada: '300', marca: 'HONDA', preco: '31990' }),
      moto('HONDA CB 500 F', { categoria: 'Naked', cilindrada: '500', marca: 'HONDA', preco: '42000' }),
    ];
    const semFlag = selecionarPorIntencao({
      termoBase: 'CB 300',
      criterios: {},
      intencao: 'pedido',
      motoAtual: null,
      candidatos: familia,
      mapeamento: MAPEAMENTO,
    });
    const comFlag = selecionarPorIntencao({
      termoBase: 'CB 300',
      criterios: {},
      intencao: 'pedido',
      motoAtual: null,
      candidatos: familia,
      mapeamento: MAPEAMENTO,
      todasSeEspecificacao: true,
    });
    // Sem a flag, respeita o teto da tela (3).
    expect(semFlag.motos.length).toBe(3);
    // Com a flag, traz todas as unidades do catálogo.
    expect(comFlag.motos.length).toBe(familia.length);
  });

  it('alternativa: ancora a moto atual, tira ela e traz as mais baratas parecidas', () => {
    const r = selecionarPorIntencao({
      termoBase: 'Achei caro',
      criterios: { preco: 'menor' },
      intencao: 'alternativa',
      motoAtual: ATUAL,
      candidatos: CATALOGO,
      mapeamento: MAPEAMENTO,
    });
    // A preferência NÃO vira critério de semelhança (senão diluiria "mais barata").
    expect(r.preferencias).toEqual({ preco: 'menor' });
    expect(r.criterios.preco).toBeUndefined();
    // Âncora: atributos da atual nas colunas de comparação que não são preferência.
    expect(r.criterios.categoria).toBe('Street');
    expect(r.criterios.cilindrada).toBe('125');
    expect(r.criterios.marca).toBe('HONDA');
    // A moto atual sai da lista; a mais cara que a atual (CB 300) é filtrada.
    expect(r.motos.map((m) => m.nome)).not.toContain('HONDA Biz 125');
    expect(r.motos.map((m) => m.nome)).not.toContain('HONDA CB 300');
    expect(r.motos[0]?.nome).toBe('HONDA Pop 110');
    expect(r.motos.length).toBe(2);
  });

  it('alternativa: "preco menor" FILTRA as mais caras que a atual e ordena por semelhança', () => {
    // A mais PARECIDA é a mais cara (Biz 125 FLEX, R$14.000) e continua; a
    // MAIS cara que a atual (Biz 125 Turbo, R$20.000) é EXCLUÍDA pelo filtro.
    const at = moto('HONDA Biz 125', {
      categoria: 'Street',
      cilindrada: '125',
      marca: 'HONDA',
      preco: '14500',
    });
    const cat: MotoDoCatalogo[] = [
      at,
      moto('HONDA Biz 125 FLEX', { categoria: 'Street', cilindrada: '125', marca: 'HONDA', preco: '14000' }),
      moto('HONDA Pop 110', { categoria: 'Street', cilindrada: '110', marca: 'HONDA', preco: '8000' }),
      moto('HONDA CG 160', { categoria: 'Street', cilindrada: '160', marca: 'HONDA', preco: '12000' }),
      moto('HONDA Biz 125 Turbo', { categoria: 'Street', cilindrada: '125', marca: 'HONDA', preco: '20000' }),
    ];
    const r = selecionarPorIntencao({
      termoBase: 'Achei caro',
      criterios: { preco: 'menor' },
      intencao: 'alternativa',
      motoAtual: at,
      candidatos: cat,
      mapeamento: MAPEAMENTO,
    });
    // Nada mais caro que a atual entra; a mais parecida lidera.
    expect(r.motos.map((m) => m.nome)).not.toContain('HONDA Biz 125 Turbo');
    expect(r.motos[0]?.nome).toBe('HONDA Biz 125 FLEX');
    expect(r.motos.map((m) => m.nome)).toContain('HONDA Pop 110');
  });

  it('alternativa: "outra cor" filtra a MESMA cor da moto atual', () => {
    const at: MotoDoCatalogo = {
      nome: 'HONDA Biz 125',
      fotos: ['http://x/biz.jpg'],
      preco: '14500',
      valores: {
        nome: 'Biz 125',
        categoria: 'Scooter',
        cilindrada: '125',
        marca: 'HONDA',
        preco: '14500',
        cor: 'Marrom',
      },
    };
    const cat: MotoDoCatalogo[] = [
      at,
      {
        nome: 'HONDA Biz 125 Prata',
        fotos: ['http://x/2.jpg'],
        preco: '13000',
        valores: { nome: 'Biz 125', categoria: 'Scooter', cilindrada: '125', marca: 'HONDA', preco: '13000', cor: 'Marrom' },
      },
      {
        nome: 'YAMAHA Neo 125',
        fotos: ['http://x/3.jpg'],
        preco: '13500',
        valores: { nome: 'Neo 125', categoria: 'Scooter', cilindrada: '125', marca: 'YAMAHA', preco: '13500', cor: 'Preto' },
      },
    ];
    const r = selecionarPorIntencao({
      termoBase: 'quero outra cor',
      criterios: { cor: 'outra' },
      intencao: 'alternativa',
      motoAtual: at,
      candidatos: cat,
      mapeamento: MAPEAMENTO,
    });
    expect(r.motos.map((m) => m.valores?.cor)).not.toContain('Marrom');
    expect(r.motos.map((m) => m.nome)).toContain('YAMAHA Neo 125');
    expect(r.criterios.cor).toBeUndefined();
  });

  it('alternativa: remove a moto atual mesmo com nome composto diferente (compara a BASE)', () => {
    // A referência veio de uma consulta parcial ("Biz 125 2021"); o catálogo traz
    // o nome composto completo ("HONDA Biz 125 FLEX 2021"). A base ("Biz 125")
    // casa → a moto atual sai da lista.
    const at: MotoDoCatalogo = {
      nome: 'Biz 125 2021',
      fotos: ['http://x/biz.jpg'],
      preco: '14500',
      valores: { nome: 'Biz 125', preco: '14500' },
    };
    const cat: MotoDoCatalogo[] = [
      {
        nome: 'HONDA Biz 125 FLEX 2021',
        fotos: ['http://x/biz2.jpg'],
        preco: '14500',
        valores: { nome: 'Biz 125', categoria: 'Scooter', cilindrada: '125', marca: 'HONDA', preco: '14500' },
      },
      {
        nome: 'YAMAHA Neo 125',
        fotos: ['http://x/neo.jpg'],
        preco: '13500',
        valores: { nome: 'Neo 125', categoria: 'Scooter', cilindrada: '125', marca: 'YAMAHA', preco: '13500' },
      },
    ];
    const r = selecionarPorIntencao({
      termoBase: 'achei caro',
      criterios: { preco: 'menor' },
      intencao: 'alternativa',
      motoAtual: at,
      candidatos: cat,
      mapeamento: MAPEAMENTO,
    });
    expect(r.motos.map((m) => m.nome)).not.toContain('HONDA Biz 125 FLEX 2021');
    expect(r.motos.map((m) => m.nome)).toContain('YAMAHA Neo 125');
  });

  it('alternativa: coluna de preferência já informada não é sobrescrita pela âncora', () => {
    const r = selecionarPorIntencao({
      termoBase: 'quero mais nova',
      criterios: { ano: 'maior' },
      intencao: 'alternativa',
      motoAtual: { ...ATUAL, valores: { ...ATUAL.valores, ano: '2015' } },
      candidatos: CATALOGO,
      mapeamento: { ...MAPEAMENTO, colunas: [...(MAPEAMENTO.colunas ?? []), { coluna: 'ano', comparar: true, ordem: 5 }] },
    });
    expect(r.preferencias).toEqual({ ano: 'maior' });
    expect(r.criterios.ano).toBeUndefined();
  });

  it('pedido: NÃO ancora a moto atual (intenção é pedido novo)', () => {
    const r = selecionarPorIntencao({
      termoBase: 'quero uma naked',
      criterios: { categoria: 'Naked' },
      intencao: 'pedido',
      motoAtual: ATUAL,
      candidatos: CATALOGO,
      mapeamento: MAPEAMENTO,
    });
    expect(r.criterios).toEqual({ categoria: 'Naked' });
    expect(r.criterios.marca).toBeUndefined();
    expect(r.criterios.cilindrada).toBeUndefined();
  });

  it('sem moto atual: não ancora e mantém os candidatos', () => {
    const r = selecionarPorIntencao({
      termoBase: 'quero uma 160',
      criterios: {},
      intencao: 'alternativa',
      motoAtual: null,
      candidatos: CATALOGO,
      mapeamento: MAPEAMENTO,
    });
    expect(r.criterios).toEqual({});
    expect(r.motos.length).toBeGreaterThan(0);
  });

  it('candidatos vazios → resultado vazio (fallback do chamador)', () => {
    const r = selecionarPorIntencao({
      termoBase: 'Achei caro',
      criterios: { preco: 'menor' },
      intencao: 'alternativa',
      motoAtual: ATUAL,
      candidatos: [],
      mapeamento: MAPEAMENTO,
    });
    expect(r.motos).toEqual([]);
  });
});
