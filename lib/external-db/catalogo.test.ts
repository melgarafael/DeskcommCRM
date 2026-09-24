import { describe, expect, it } from 'vitest';

import {
  atribuirPapeisUnicos,
  colunaDeSimilares,
  colunasConfiguradas,
  colunasDaIA,
  colunasDeComparacao,
  colunasDoCatalogo,
  colunasDoNome,
  colunasParaConsulta,
  configEfetiva,
  criteriosDaIA,
  criteriosDeSimilaridade,
  detectarPapelColuna,
  legendaParaExibicao,
  renderBlocoCatalogo,
  type CatalogoMapeamento,
} from './catalogo';

const BASE: CatalogoMapeamento = {
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
  colCilindrada: null,
  colTipo: null,
  buscaOperador: 'contem',
};

describe('colunasDoCatalogo', () => {
  it('mapeia só as colunas preenchidas', () => {
    const c = colunasDoCatalogo(BASE);
    expect(c).toEqual({
      nome: 'nome',
      nomeComposto: ['nome'],
      ano: 'ano',
      cor: 'cor',
      km: 'quilometragem',
      preco: 'preco',
      imagem: 'imagem_url',
    });
    expect('estoque' in c).toBe(false);
    expect('versao' in c).toBe(false);
  });
});

describe('colunasDoNome (nome correto da moto)', () => {
  it('junta nome + versão quando ambos são prioridade 1', () => {
    expect(
      colunasDoNome({ ...BASE, colVersao: 'versao', ordem: { nome: 1, versao: 1 } }),
    ).toEqual(['nome', 'versao']);
  });

  it('sem prioridade 1 → só o nome', () => {
    expect(colunasDoNome({ ...BASE, colVersao: 'versao', ordem: { versao: 2 } })).toEqual(['nome']);
  });

  it('inclui o nome mesmo quando ele não é prioridade 1', () => {
    expect(
      colunasDoNome({ ...BASE, colVersao: 'versao', ordem: { versao: 1 } }),
    ).toEqual(['nome', 'versao']);
  });
});

describe('colunasParaConsulta', () => {
  it('lista nome + as colunas configuradas, sem os nulos', () => {
    expect(colunasParaConsulta(BASE)).toEqual([
      'nome',
      'ano',
      'cor',
      'quilometragem',
      'preco',
      'imagem_url',
    ]);
  });
});

describe('detectarPapelColuna', () => {
  it('reconhece os nomes usuais das colunas', () => {
    expect(detectarPapelColuna('nome')).toBe('nome');
    expect(detectarPapelColuna('preco')).toBe('preco');
    expect(detectarPapelColuna('imagem_url')).toBe('imagem');
    expect(detectarPapelColuna('quilometragem')).toBe('km');
    expect(detectarPapelColuna('cilindrada')).toBe('cilindrada');
    expect(detectarPapelColuna('categoria')).toBe('tipo');
  });

  it('reconhece a coluna de versão (antes ficava "não reconhecida")', () => {
    expect(detectarPapelColuna('versao')).toBe('versao');
    expect(detectarPapelColuna('versão')).toBe('versao');
    expect(detectarPapelColuna('versao_nome')).toBe('versao');
    expect(detectarPapelColuna('submodelo')).toBe('versao');
  });

  it('igualdade exata vence o "contém" (preco vs preco_promocional)', () => {
    expect(detectarPapelColuna('preco')).toBe('preco');
    expect(detectarPapelColuna('preco_promocional')).toBe('preco');
  });

  it('coluna sem papel conhecido → null', () => {
    expect(detectarPapelColuna('id')).toBeNull();
    expect(detectarPapelColuna('garantia')).toBeNull();
  });
});

describe('atribuirPapeisUnicos', () => {
  const COLUNAS = [
    'id',
    'nome',
    'marca',
    'versao',
    'categoria',
    'ano',
    'cor',
    'preco',
    'quilometragem',
    'cilindrada',
    'potencia',
    'descricao',
    'imagem_url',
    'tipo_combustivel',
    'cambio',
    'estoque',
    'moto_similar',
    'preco_de_tabela_fipe',
  ];

  it('nunca repete um papel — o caso que quebrava o Salvar', () => {
    const mapa = atribuirPapeisUnicos(COLUNAS);
    const papeis = Object.values(mapa).filter((p): p is NonNullable<typeof p> => p !== null);
    expect(new Set(papeis).size).toBe(papeis.length);
  });

  it('a coluna "de verdade" fica com o papel e a variante fica sem', () => {
    const mapa = atribuirPapeisUnicos(COLUNAS);
    expect(mapa['categoria']).toBe('tipo');
    expect(mapa['tipo_combustivel']).toBeNull();
    expect(mapa['preco']).toBe('preco');
    expect(mapa['preco_de_tabela_fipe']).toBeNull();
    expect(mapa['marca']).toBeNull();
  });

  it('o papel JÁ CONFIGURADO vence o palpite', () => {
    const mapa = atribuirPapeisUnicos(COLUNAS, { tipo: 'tipo_combustivel', nome: 'nome' });
    expect(mapa['tipo_combustivel']).toBe('tipo');
    expect(mapa['categoria']).toBeNull();
  });

  it('papel configurado apontando para coluna inexistente é ignorado', () => {
    const mapa = atribuirPapeisUnicos(['nome', 'preco'], { ano: 'ano_que_sumiu' });
    expect(mapa['nome']).toBe('nome');
    expect(mapa['preco']).toBe('preco');
    expect(Object.values(mapa)).not.toContain('ano');
  });
});

describe('criteriosDeSimilaridade', () => {
  it('usa a ordem configurada, incluindo nome, ignorando papéis que não são critério', () => {
    expect(
      criteriosDeSimilaridade({
        ...BASE,
        ordem: { preco: 1, cilindrada: 2, nome: 3, cor: 4 },
      }),
    ).toEqual(['preco', 'cilindrada', 'nome']);
  });

  it('nome em prioridade 1 vem primeiro', () => {
    expect(
      criteriosDeSimilaridade({ ...BASE, ordem: { nome: 1, tipo: 2, preco: 3 } }),
    ).toEqual(['nome', 'tipo', 'preco']);
  });

  it('sem ordem → default cilindrada, preco', () => {
    expect(criteriosDeSimilaridade({ ...BASE, ordem: {} })).toEqual(['cilindrada', 'preco']);
  });
});

describe('renderBlocoCatalogo', () => {
  it('vazio quando não há mapeamento', () => {
    expect(renderBlocoCatalogo(null)).toBe('');
  });

  it('cita a tabela, a coluna de busca e as colunas reais', () => {
    const bloco = renderBlocoCatalogo(BASE);
    expect(bloco).toContain('Tabela: motos');
    expect(bloco).toContain('nome');
    expect(bloco).toContain('imagem_url');
    expect(bloco).toContain('contem');
  });

  it('instrui a não cravar o número de motos na abertura (texto bate com as fotos)', () => {
    const bloco = renderBlocoCatalogo({ ...BASE, similaresQtd: 3 });
    expect(bloco).toContain('algumas opções');
    expect(bloco).toContain('até 3');
  });
});

describe('configEfetiva / comparação por coluna (migration 0251)', () => {
  const ANTIGO: CatalogoMapeamento = {
    ...BASE,
    colVersao: 'versao',
    colCilindrada: 'cilindrada',
    colTipo: 'categoria',
    colEstoque: 'estoque',
    ordem: { nome: 1, versao: 1, cilindrada: 2, preco: 3 },
    legenda: ['ano', 'cor', 'preco', 'marca'],
  };

  it('mapeamento ANTIGO (sem `colunas`) deriva a config dos papéis', () => {
    const config = configEfetiva(ANTIGO);
    const porColuna = new Map(config.map((c) => [c.coluna, c]));
    expect(porColuna.get('preco')?.comparar).toBe(true);
    expect(porColuna.get('cilindrada')?.comparar).toBe(true);
    expect(porColuna.get('ano')?.comparar).toBe(false);
    expect(porColuna.get('marca')?.mostrar).toBe(true); // legenda, sem papel
    expect(porColuna.get('versao')?.compoeNome).toBe(true);
  });

  it('colunasDeComparacao ordena pela prioridade (Ordem)', () => {
    // nome=1, cilindrada=2, preco=3, categoria sem ordem (vai por último).
    expect(colunasDeComparacao(ANTIGO)).toEqual(['nome', 'cilindrada', 'preco', 'categoria']);
  });

  it('colunasDaIA e criteriosDaIA caem nas configuradas quando não há marcação', () => {
    expect(colunasDaIA(ANTIGO)).toContain('preco');
    expect(criteriosDaIA(ANTIGO)).toContain('cilindrada');
  });

  it('config NOVA por coluna manda: qualquer coluna pode comparar', () => {
    const novo: CatalogoMapeamento = {
      ...BASE,
      colunas: [
        { coluna: 'nome', ia: true, criterio: true, comparar: true, compoeNome: true, ordem: 1 },
        { coluna: 'marca', ia: true, criterio: true, comparar: true, ordem: 2 },
        { coluna: 'ano', ia: true, criterio: true, comparar: true, ordem: 3 },
      ],
      colSimilares: 'moto_similar',
    };
    expect(colunasDeComparacao(novo)).toEqual(['nome', 'marca', 'ano']);
    expect(colunasDoNome(novo)).toEqual(['nome']);
    expect(colunaDeSimilares(novo)).toBe('moto_similar');
  });

  it('colunasConfiguradas normaliza o jsonb (ignora lixo, lê snake_case)', () => {
    const bruto = [
      { coluna: 'marca', ia: true, compoe_nome: false },
      { coluna: '', ia: true },
      null,
      'x',
      { coluna: 'ano', ordem: 2, comparar: true },
    ];
    const config = colunasConfiguradas(bruto);
    expect(config.map((c) => c.coluna)).toEqual(['marca', 'ano']);
    expect(config[0]?.ia).toBe(true);
    expect(config[1]?.ordem).toBe(2);
  });
});

describe('renderBlocoCatalogo — critérios amplos (F3)', () => {
  it('lista as colunas de CRITÉRIO da IA e manda ampliar quando não achar', () => {
    const m: CatalogoMapeamento = {
      ...BASE,
      colCilindrada: 'cilindrada',
      colTipo: 'categoria',
      colSimilares: 'moto_similar',
    };
    const bloco = renderBlocoCatalogo(m);
    expect(bloco).toContain('CRITÉRIO');
    expect(bloco).toContain('cilindrada');
    expect(bloco).toContain('criterios'); // a IA deve preencher os critérios
    expect(bloco).toContain('não pare em');
    // A coluna de referência NUNCA aparece como critério para a IA.
    expect(bloco).not.toContain('moto_similar');
  });

  it('criteriosDaIA/colunasDaIA nunca incluem a coluna de referência', () => {
    const m: CatalogoMapeamento = {
      ...BASE,
      colSimilares: 'moto_similar',
      colunas: [
        { coluna: 'nome', ia: true, criterio: true, comparar: true, compoeNome: true },
        { coluna: 'moto_similar', ia: true, criterio: true, comparar: true },
      ],
    };
    expect(criteriosDaIA(m)).not.toContain('moto_similar');
    expect(colunasDaIA(m)).not.toContain('moto_similar');
    expect(criteriosDaIA(m)).toContain('nome');
  });
});

describe('prefixo do nome (ex.: marca) — F3/formato', () => {
  const m: CatalogoMapeamento = {
    ...BASE,
    colunas: [
      { coluna: 'nome', ia: true, criterio: true, comparar: true, compoeNome: true, ordem: 1 },
      { coluna: 'marca', ia: true, criterio: true, mostrar: true, prefixoNome: true, ordem: 1 },
      { coluna: 'preco', ia: true, criterio: true, mostrar: true, comparar: true, ordem: 2 },
    ],
  };

  it('o prefixo vem PRIMEIRO no nome composto', () => {
    expect(colunasDoNome(m)).toEqual(['marca', 'nome']);
  });

  it('o prefixo NÃO vira linha de legenda (já está no nome)', () => {
    expect(legendaParaExibicao(m).map((c) => c.coluna)).toEqual(['preco']);
  });
});

describe('renderBlocoCatalogo — glossário das colunas', () => {
  it('explica versão/cilindrada/categoria quando essas colunas existem', () => {
    const m: CatalogoMapeamento = {
      ...BASE,
      colVersao: 'versao',
      colCilindrada: 'cilindrada',
      colTipo: 'categoria',
    };
    const bloco = renderBlocoCatalogo(m);
    expect(bloco).toContain('variação de um mesmo modelo');
    expect(bloco).toContain('volume total do motor');
    expect(bloco).toContain('segmento de uso');
  });
});
