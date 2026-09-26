import { describe, expect, it } from 'vitest';

import type { CatalogoMapeamento } from '@/lib/external-db/catalogo';

import type { MotoDoCatalogo } from './fotos-do-catalogo';
import { filtrarPorHipoteses, querAlternativa, selecionarPorIntencao } from './selecao-por-intencao';

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
    // Sem a flag, respeita o teto (3).
    expect(semFlag.motos.length).toBe(3);
    // Com a flag, traz todas as unidades do catálogo.
    expect(comFlag.motos.length).toBe(familia.length);
  });

  it('toggle B: `aplicarLimite: false` abre o teto e devolve todas as candidatas', () => {
    const semTeto = selecionarPorIntencao({
      termoBase: 'quero uma moto',
      criterios: {},
      intencao: 'pedido',
      motoAtual: null,
      candidatos: CATALOGO,
      mapeamento: MAPEAMENTO,
      aplicarLimite: false,
    });
    expect(semTeto.motos.length).toBe(CATALOGO.length);
  });

  it('quantidade vem do chamador (config do agente) e sobrepõe o mapeamento', () => {
    const r = selecionarPorIntencao({
      termoBase: 'quero uma moto',
      criterios: {},
      intencao: 'pedido',
      motoAtual: null,
      candidatos: CATALOGO,
      mapeamento: { ...MAPEAMENTO, similaresQtd: 1 },
      quantidade: 2,
    });
    expect(r.motos.length).toBe(2);
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

describe('filtrarPorHipoteses (C-089)', () => {
  it('filtra por marca (texto) e cilindrada (faixa)', () => {
    const passou = filtrarPorHipoteses(
      CATALOGO,
      [{ marca: 'HONDA', categoria: 'Street' }],
      { cilindrada: { min: 100, max: 170 } },
      30,
    );
    // Honda street com cc ≤170: Pop 110 (110), Biz 125 (125), CG 160 (160). CB 300 fora.
    expect(passou.map((m) => m.nome).sort()).toEqual([
      'HONDA Biz 125',
      'HONDA CG 160',
      'HONDA Pop 110',
    ]);
  });

  it('sem hipótese/faixa válida → lista vazia (filtro é ignorado pelo chamador)', () => {
    expect(filtrarPorHipoteses(CATALOGO, [], {}, 30)).toEqual([]);
    expect(filtrarPorHipoteses(CATALOGO, [{}, { marca: '' }], {}, 30)).toEqual([]);
  });

  it('filtro que zera → lista vazia (não inventa resultado)', () => {
    const passou = filtrarPorHipoteses(CATALOGO, [{ marca: 'DUCATI' }], {}, 30);
    expect(passou).toEqual([]);
  });
});

describe('selecionarPorIntencao com hipóteses/faixas (C-089)', () => {
  const estoqueGrande: MotoDoCatalogo[] = [
    ...CATALOGO,
    moto('BMW S 1000 RR', { categoria: 'Esportivas', cilindrada: '999', marca: 'BMW', preco: '95000' }),
    moto('SUZUKI V-Strom DL 1000', { categoria: 'Adventure', cilindrada: '1037', marca: 'SUZUKI', preco: '29900' }),
  ];

  it('"CB 50" (inexistente): hipóteses pequenas NÃO trazem a BMW 1000 nem a V-Strom 1000', () => {
    const r = selecionarPorIntencao({
      termoBase: 'quero uma cb 50',
      criterios: {},
      intencao: 'pedido',
      motoAtual: null,
      candidatos: estoqueGrande,
      mapeamento: MAPEAMENTO,
      quantidade: 3,
      filtrarPorComparacao: true,
      hipoteses: [{ marca: 'HONDA', categoria: 'Street' }, { cilindrada: '125', marca: 'HONDA' }],
      faixas: { cilindrada: { min: 100, max: 170 } },
    });
    const nomes = r.motos.map((m) => m.nome);
    expect(nomes).not.toContain('BMW S 1000 RR');
    expect(nomes).not.toContain('SUZUKI V-Strom DL 1000');
    expect(r.filtrados).toBeGreaterThan(0);
  });

  it('filtro que zera cai no ranking (fallback) — nunca vazio', () => {
    const r = selecionarPorIntencao({
      termoBase: 'quero uma cb 50',
      criterios: {},
      intencao: 'pedido',
      motoAtual: null,
      candidatos: CATALOGO,
      mapeamento: MAPEAMENTO,
      quantidade: 3,
      filtrarPorComparacao: true,
      hipoteses: [{ marca: 'DUCATI' }],
      faixas: {},
    });
    expect(r.filtrados).toBe(0);
    expect(r.motos.length).toBeGreaterThan(0);
  });

  it('C-089: filtro que casa 1 moto COMPLETA até N com as mais próximas', () => {
    // Hipótese específica casa só a Biz 125; o motor deve completar até 3.
    const r = selecionarPorIntencao({
      termoBase: 'quero uma biz',
      criterios: {},
      intencao: 'pedido',
      motoAtual: null,
      candidatos: CATALOGO,
      mapeamento: MAPEAMENTO,
      quantidade: 3,
      filtrarPorComparacao: true,
      hipoteses: [{ nome: 'Biz 125' }],
      faixas: {},
    });
    expect(r.filtrados).toBe(1);
    expect(r.motos.map((m) => m.nome)).toContain('HONDA Biz 125');
    // Completou até N (3), sem repetir.
    expect(r.motos.length).toBe(3);
    expect(new Set(r.motos.map((m) => m.nome)).size).toBe(r.motos.length);
  });

  it('C-089: completar prioriza o MESMO PERFIL (marca/categoria)', () => {
    // Catálogo com Honda (mesmo perfil) e perfis alheios (scooter/BMW).
    const mapaPerfil: CatalogoMapeamento = {
      ...MAPEAMENTO,
      colunas: [
        ...(MAPEAMENTO.colunas ?? []),
        { coluna: 'marca', comparar: true, ordem: 3 },
      ],
    };
    const catalogo: MotoDoCatalogo[] = [
      moto('HONDA Biz 125', { categoria: 'Street', cilindrada: '125', marca: 'HONDA', preco: '14500' }),
      moto('HONDA CG 160', { categoria: 'Street', cilindrada: '160', marca: 'HONDA', preco: '12000' }),
      moto('YAMAHA XMax 250', { categoria: 'Scooter', cilindrada: '250', marca: 'YAMAHA', preco: '31900' }),
      moto('BMW G 310 R', { categoria: 'Roadster', cilindrada: '313', marca: 'BMW', preco: '22990' }),
    ];
    const r = selecionarPorIntencao({
      termoBase: 'quero uma cb 50',
      criterios: {},
      intencao: 'pedido',
      motoAtual: null,
      candidatos: catalogo,
      mapeamento: mapaPerfil,
      quantidade: 3,
      filtrarPorComparacao: true,
      // Perfil: HONDA / Street (a IA entendeu "CB 50" como Honda street pequena).
      hipoteses: [{ marca: 'HONDA', categoria: 'Street' }],
      faixas: {},
    });
    // A 1ª (filtro) casa o perfil; o completar traz SÓ o mesmo perfil (HONDA) e
    // NÃO completa com perfil alheio (XMax scooter / BMW roadster).
    const nomes = r.motos.map((m) => m.nome);
    expect(nomes[0]).toBe('HONDA Biz 125');
    expect(nomes).toContain('HONDA CG 160');
    expect(nomes).not.toContain('YAMAHA XMax 250');
    expect(nomes).not.toContain('BMW G 310 R');
  });

  it('C-089: temMaisOpcoes quando sobra moto fora do corte', () => {
    const r = selecionarPorIntencao({
      termoBase: 'quero uma honda',
      criterios: {},
      intencao: 'pedido',
      motoAtual: null,
      candidatos: CATALOGO,
      mapeamento: MAPEAMENTO,
      quantidade: 1,
      filtrarPorComparacao: true,
      hipoteses: [{ marca: 'HONDA' }],
      faixas: {},
    });
    expect(r.motos.length).toBe(1);
    expect(r.temMaisOpcoes).toBe(true);
  });

  it('C-090: enviarTodasQueCasam devolve TODAS as que casam (sem teto, sem paginar)', () => {
    const r = selecionarPorIntencao({
      termoBase: 'quero uma honda',
      criterios: {},
      intencao: 'pedido',
      motoAtual: null,
      candidatos: CATALOGO,
      mapeamento: MAPEAMENTO,
      quantidade: 1, // teto baixo, ignorado pelo toggle
      filtrarPorComparacao: true,
      hipoteses: [{ marca: 'HONDA' }],
      faixas: {},
      enviarTodasQueCasam: true,
    });
    // Todas as Honda do CATALOGO, independente do teto 1.
    expect(r.motos.length).toBeGreaterThan(1);
    expect(r.motos.every((m) => m.valores?.marca === 'HONDA')).toBe(true);
    // Já mandou tudo: não há "mais opções".
    expect(r.temMaisOpcoes).toBe(false);
  });
});
