/**
 * A RÉGUA DO PÚBLICO DO AGENTE (#3722) — pura, sem banco.
 *
 * O que este arquivo prova, e por que cada caso existe:
 *
 *  - a EXCLUSÃO VENCE a inclusão. É a promessa que faz o caso real da issue
 *    funcionar: o agente de vendas exclui `cliente ativo` e, mesmo que a mesma
 *    etiqueta esteja no "só atender", o cliente com contrato não é atendido por
 *    ele;
 *  - OU dentro de cada lista, E entre as listas;
 *  - etiqueta sem diferença de maiúscula (é o contrato da issue);
 *  - "estar no funil" é ter negócio ABERTO. Quem não tem card nenhum não entra
 *    em "só estes funis" e NÃO é barrado por "não estes funis" — a direção que
 *    não cala o número novo;
 *  - config torta (lista que não é lista, item que não é string) é IGNORADA, e
 *    um público sem nenhuma lista utilizável vira `null` — quer dizer "atende
 *    todo mundo", nunca "não atende ninguém".
 */
import { describe, expect, it, vi } from 'vitest';

import {
  avaliarPublico,
  carregarFatosDoContato,
  lerPublicoDoGatilho,
  passaNoPublico,
  type FatosDoContato,
  type PublicoDoAgente,
} from './publico-do-gatilho';

const vazio: FatosDoContato = { etiquetas: [], funisAbertos: [] };

function publico(p: Partial<PublicoDoAgente>): PublicoDoAgente {
  return {
    incluirEtiquetas: [],
    excluirEtiquetas: [],
    incluirFunis: [],
    excluirFunis: [],
    ...p,
  };
}

describe('lerPublicoDoGatilho — a leitura defensiva do jsonb', () => {
  it('lê as quatro listas do filters', () => {
    const p = lerPublicoDoGatilho({
      filters: {
        include_tags: ['Cliente Ativo'],
        exclude_tags: ['Bloqueado'],
        include_pipeline_ids: ['p1'],
        exclude_pipeline_ids: ['p2'],
      },
    });
    expect(p).toEqual({
      incluirEtiquetas: ['Cliente Ativo'],
      excluirEtiquetas: ['Bloqueado'],
      incluirFunis: ['p1'],
      excluirFunis: ['p2'],
    });
  });

  it.each([
    ['trigger_config nulo', null],
    ['sem filters', { events: ['message'] }],
    ['filters nulo', { filters: null }],
    ['filters vazio', { filters: {} }],
    ['listas vazias', { filters: { include_tags: [], exclude_tags: [] } }],
    ['lista que não é lista', { filters: { include_tags: 'cliente' } }],
    ['itens que não são texto', { filters: { include_tags: [1, null, true] } }],
  ])('%s ⇒ null (atende todo mundo, como antes)', (_c, trigger) => {
    expect(lerPublicoDoGatilho(trigger)).toBeNull();
  });

  it('descarta item vazio, tira espaço de borda e repete sem caixa', () => {
    const p = lerPublicoDoGatilho({
      filters: { include_tags: ['  Cliente  ', '', 'cliente', 'VIP'] },
    });
    expect(p?.incluirEtiquetas).toEqual(['Cliente', 'VIP']);
  });

  it('lista malformada não derruba a lista boa (falha aberta por lista)', () => {
    const p = lerPublicoDoGatilho({
      filters: { include_tags: 42, exclude_pipeline_ids: ['p1'] },
    });
    expect(p).toEqual(publico({ excluirFunis: ['p1'] }));
  });
});

describe('passaNoPublico — a decisão', () => {
  it('sem nenhuma lista, todo contato passa', () => {
    expect(passaNoPublico(publico({}), vazio)).toBe(true);
  });

  it('include_tags: basta UMA etiqueta da lista', () => {
    const p = publico({ incluirEtiquetas: ['cliente ativo', 'contrato'] });
    expect(passaNoPublico(p, { etiquetas: ['contrato'], funisAbertos: [] })).toBe(true);
    expect(passaNoPublico(p, { etiquetas: ['prospect'], funisAbertos: [] })).toBe(false);
  });

  it('etiqueta sem diferença de maiúscula, dos dois lados', () => {
    const p = publico({ incluirEtiquetas: ['Cliente Ativo'] });
    expect(passaNoPublico(p, { etiquetas: ['cliente ativo'], funisAbertos: [] })).toBe(true);
  });

  it('a EXCLUSÃO VENCE a inclusão — o caso do agente de vendas', () => {
    const vendas = publico({
      incluirEtiquetas: ['prospect', 'cliente ativo'],
      excluirEtiquetas: ['cliente ativo'],
    });
    expect(
      passaNoPublico(vendas, { etiquetas: ['cliente ativo'], funisAbertos: [] }),
      'cliente com contrato não pode ser atendido pelo agente de vendas',
    ).toBe(false);
  });

  it('include_pipeline_ids: exige negócio ABERTO em um dos funis', () => {
    const p = publico({ incluirFunis: ['funil-suporte'] });
    expect(passaNoPublico(p, { etiquetas: [], funisAbertos: ['funil-suporte'] })).toBe(true);
    expect(
      passaNoPublico(p, { etiquetas: [], funisAbertos: [] }),
      'quem ainda não tem card não entra em "só estes funis"',
    ).toBe(false);
    expect(passaNoPublico(p, { etiquetas: [], funisAbertos: ['funil-vendas'] })).toBe(false);
  });

  it('exclude_pipeline_ids: contato SEM card nenhum NÃO é barrado', () => {
    const p = publico({ excluirFunis: ['funil-vendas'] });
    expect(
      passaNoPublico(p, { etiquetas: [], funisAbertos: [] }),
      'o número novo, sem card, tem de passar por uma exclusão de funil',
    ).toBe(true);
    expect(passaNoPublico(p, { etiquetas: [], funisAbertos: ['funil-vendas'] })).toBe(false);
  });

  it('E entre as listas: cumprir a etiqueta não dispensa o funil', () => {
    const p = publico({ incluirEtiquetas: ['cliente'], incluirFunis: ['funil-suporte'] });
    expect(passaNoPublico(p, { etiquetas: ['cliente'], funisAbertos: [] })).toBe(false);
    expect(passaNoPublico(p, { etiquetas: ['cliente'], funisAbertos: ['funil-suporte'] })).toBe(true);
  });

  it('exclusão de funil vence inclusão de etiqueta', () => {
    const p = publico({ incluirEtiquetas: ['cliente'], excluirFunis: ['funil-vendas'] });
    expect(passaNoPublico(p, { etiquetas: ['cliente'], funisAbertos: ['funil-vendas'] })).toBe(false);
  });
});

/**
 * O RASTRO da regra (#3722) — "por que" e não só "se".
 *
 * `passaNoPublico` responde sim/não e é tudo o que a ESCOLHA precisa para
 * decidir. Quem investiga um turno precisa do resto: QUAL lista e QUAL item
 * decidiram. `avaliarPublico` devolve isso, e `passaNoPublico` passa a delegar
 * nela — uma regra só, com a decisão e o motivo sempre concordando (o teste de
 * concordância no fim deste bloco é o que impede as duas de divergirem na
 * primeira mudança, como já aconteceu com régua duplicada em SQL/TS).
 *
 * O `valor` é sempre o item DECLARADO na config (o que o admin digitou na
 * tela), nunca um dado do contato: é o que o log pode carregar sem PII.
 */
describe('avaliarPublico — a decisão COM o motivo', () => {
  it('público vazio: passa sem regra de exclusão/inclusão', () => {
    expect(avaliarPublico(publico({}), vazio)).toEqual({ passa: true, regra: 'passou', valor: null });
  });

  it('exclusão de etiqueta vence a inclusão e devolve a ETIQUETA declarada', () => {
    const vendas = publico({
      incluirEtiquetas: ['prospect', 'cliente ativo'],
      excluirEtiquetas: ['cliente ativo'],
    });
    expect(avaliarPublico(vendas, { etiquetas: ['Cliente Ativo'], funisAbertos: [] })).toEqual({
      passa: false,
      regra: 'barrado_por_etiqueta_excluida',
      valor: 'cliente ativo',
    });
  });

  it('exclusão de funil devolve o PIPELINE declarado', () => {
    const p = publico({ excluirFunis: ['funil-vendas'] });
    expect(avaliarPublico(p, { etiquetas: [], funisAbertos: ['funil-vendas'] })).toEqual({
      passa: false,
      regra: 'barrado_por_funil_excluido',
      valor: 'funil-vendas',
    });
  });

  it('inclusão de etiqueta não cumprida: barra sem valor (nada do contato casou)', () => {
    const p = publico({ incluirEtiquetas: ['cliente ativo'] });
    expect(avaliarPublico(p, { etiquetas: ['prospect'], funisAbertos: [] })).toEqual({
      passa: false,
      regra: 'barrado_por_etiqueta_exigida',
      valor: null,
    });
  });

  it('inclusão de funil não cumprida: barra sem valor', () => {
    const p = publico({ incluirFunis: ['funil-contrato'] });
    expect(avaliarPublico(p, { etiquetas: [], funisAbertos: ['funil-vendas'] })).toEqual({
      passa: false,
      regra: 'barrado_por_funil_exigido',
      valor: null,
    });
  });

  it('CONCORDÂNCIA: em toda a matriz, `passaNoPublico` == `avaliarPublico().passa`', () => {
    const publicos = [
      publico({}),
      publico({ incluirEtiquetas: ['cliente'] }),
      publico({ excluirEtiquetas: ['cliente'] }),
      publico({ incluirEtiquetas: ['cliente'], excluirEtiquetas: ['cliente'] }),
      publico({ incluirFunis: ['p1'], excluirEtiquetas: ['cliente'] }),
      publico({ incluirEtiquetas: ['cliente'], incluirFunis: ['p1'], excluirFunis: ['p2'] }),
      publico({ excluirFunis: ['p1'], incluirFunis: ['p1'] }),
    ];
    const fatos = [
      { etiquetas: [], funisAbertos: [] },
      { etiquetas: ['cliente'], funisAbertos: [] },
      { etiquetas: ['CLIENTE'], funisAbertos: ['p1'] },
      { etiquetas: ['outro'], funisAbertos: ['p1', 'p2'] },
      { etiquetas: ['outro'], funisAbertos: ['p3'] },
    ];
    for (const p of publicos) {
      for (const f of fatos) {
        expect(passaNoPublico(p, f), `${JSON.stringify(p)} × ${JSON.stringify(f)}`).toBe(avaliarPublico(p, f).passa);
      }
    }
  });
});

describe('carregarFatosDoContato — uma consulta, com a organização no filtro', () => {
  it('lê etiquetas da ficha e os funis dos negócios ABERTOS', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ tags: ['VIP'], funis: ['p1', 'p2'] }] });
    const fatos = await carregarFatosDoContato({ query } as never, 'org1', 'contato1');
    expect(fatos).toEqual({ etiquetas: ['VIP'], funisAbertos: ['p1', 'p2'] });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['org1', 'contato1']);
    expect(sql).toMatch(/c\.organization_id\s*=\s*\$1/);
    expect(sql, "só negócio aberto conta como 'estar no funil'").toMatch(/status\s*=\s*'open'/);
  });

  it('contato inexistente devolve fatos vazios (não é erro)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(carregarFatosDoContato({ query } as never, 'org1', 'sumiu')).resolves.toEqual({
      etiquetas: [],
      funisAbertos: [],
    });
  });

  it('erro de banco SOBE — quem chama deixa a fila re-tentar', async () => {
    const query = vi.fn().mockRejectedValue(new Error('db fora do ar'));
    await expect(carregarFatosDoContato({ query } as never, 'org1', 'c1')).rejects.toThrow(
      'db fora do ar',
    );
  });
});
