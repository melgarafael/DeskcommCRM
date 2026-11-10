/**
 * #3917 — a leitura dos fatos do CRM do contato e o texto que vai ao prompt.
 *
 * O que se prova aqui é o que o prompt não pode fazer sozinho: escopo por
 * organização, só negócio ABERTO, teto de tamanho, determinismo e falha que não
 * derruba o turno.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_CARACTERES_DE_NOME,
  MAX_CARACTERES_DOS_FATOS,
  MAX_ETAPAS_POR_FUNIL,
  MAX_ETIQUETAS_NO_CLASSIFICADOR,
  MAX_FUNIS_NO_CLASSIFICADOR,
  carregarFatosDoCrmDoContato,
  formatarFatosDoCrm,
  montarFatosDoCrm,
  normalizarNome,
  temFatosDoCrm,
} from './fatos-do-crm-do-contato';

describe('montarFatosDoCrm', () => {
  it('agrupa as etapas por funil e não repete funil (dois cards abertos no mesmo funil)', () => {
    const fatos = montarFatosDoCrm(
      [
        { funil: 'Experiência', etapa: 'Pós-viagem' },
        { funil: 'Experiência', etapa: 'Pós-viagem' },
        { funil: 'Experiência', etapa: 'Fidelidade' },
      ],
      ['cliente'],
    );
    expect(fatos.funis).toEqual([{ funil: 'Experiência', etapas: ['Fidelidade', 'Pós-viagem'] }]);
  });

  it('ordem é determinística (alfabética), para o prompt não depender da ordem do banco', () => {
    const a = montarFatosDoCrm(
      [{ funil: 'Vendas', etapa: 'Orçamento' }, { funil: 'Experiência', etapa: 'Pós-viagem' }],
      ['zebra', 'cliente', 'Cliente'],
    );
    const b = montarFatosDoCrm(
      [{ funil: 'Experiência', etapa: 'Pós-viagem' }, { funil: 'Vendas', etapa: 'Orçamento' }],
      ['cliente', 'zebra'],
    );
    expect(a).toEqual(b);
    expect(a.funis.map((f) => f.funil)).toEqual(['Experiência', 'Vendas']);
    expect(a.etiquetas).toEqual(['cliente', 'zebra']);
  });

  it('etiqueta repetida sem diferença de caixa conta uma vez', () => {
    const fatos = montarFatosDoCrm([], ['Cliente', 'cliente ', 'VIAGEM']);
    expect(fatos.etiquetas).toEqual(['Cliente', 'VIAGEM']);
  });

  it('contato sem negócio aberto devolve listas VAZIAS, não null nem texto fantasma', () => {
    // A consulta devolve uma linha com funil/etapa nulos (left join) quando o
    // contato existe e não tem card aberto.
    const fatos = montarFatosDoCrm([{ funil: null, etapa: null }], []);
    expect(fatos).toEqual({ funis: [], etiquetas: [], funisOmitidos: 0, etiquetasOmitidas: 0 });
    expect(temFatosDoCrm(fatos)).toBe(false);
    expect(formatarFatosDoCrm(fatos)).toBe('');
  });

  it('teto de funis e de etapas por funil, contando o que ficou de fora', () => {
    const negocios = Array.from({ length: MAX_FUNIS_NO_CLASSIFICADOR + 2 }, (_, i) => ({
      funil: `Funil ${String(i + 1).padStart(2, '0')}`,
      etapa: `Etapa ${i}`,
    }));
    negocios.push(...Array.from({ length: MAX_ETAPAS_POR_FUNIL + 3 }, (_, i) => ({ funil: 'Funil 01', etapa: `Extra ${i}` })));
    const fatos = montarFatosDoCrm(negocios, []);
    expect(fatos.funis).toHaveLength(MAX_FUNIS_NO_CLASSIFICADOR);
    expect(fatos.funis[0]!.etapas).toHaveLength(MAX_ETAPAS_POR_FUNIL);
    expect(fatos.funisOmitidos).toBe(2);
  });

  it('etapa além do teto sai calada: o funil fica, e nada é contado nem anunciado', () => {
    const negocios = Array.from({ length: MAX_ETAPAS_POR_FUNIL + 1 }, (_, i) => ({ funil: 'Vendas', etapa: `Etapa ${i}` }));
    const fatos = montarFatosDoCrm(negocios, []);
    expect(fatos.funis).toEqual([{ funil: 'Vendas', etapas: ['Etapa 0', 'Etapa 1'] }]);
    expect(fatos.funisOmitidos).toBe(0);
    expect(formatarFatosDoCrm(fatos)).toBe('- Funil "Vendas", etapa "Etapa 0" / "Etapa 1": negócio ABERTO');
  });

  it('20 etiquetas: só 8 entram e o resto é CONTADO', () => {
    const vinte = Array.from({ length: 20 }, (_, i) => `etiqueta-${String(i + 1).padStart(2, '0')}`);
    const fatos = montarFatosDoCrm([], vinte);
    expect(fatos.etiquetas).toHaveLength(MAX_ETIQUETAS_NO_CLASSIFICADOR);
    expect(fatos.etiquetasOmitidas).toBe(20 - MAX_ETIQUETAS_NO_CLASSIFICADOR);
    const texto = formatarFatosDoCrm(fatos);
    expect(texto).toContain('12 etiqueta(s)');
    expect(texto).not.toContain('etiqueta-20');
  });

  it('nome de config longo ou com quebra de linha não quebra o bloco', () => {
    const fatos = montarFatosDoCrm([{ funil: 'Funil\ncom quebra', etapa: 'x'.repeat(200) }], []);
    expect(fatos.funis[0]!.funil).toBe('Funil com quebra');
    expect(fatos.funis[0]!.etapas[0]!.length).toBe(MAX_CARACTERES_DE_NOME);
    expect(fatos.funis[0]!.etapas[0]!.endsWith('…')).toBe(true);
    expect(formatarFatosDoCrm(fatos)).not.toContain('\n- Funil "Funil com quebra"'.repeat(2));
  });
});

describe('formatarFatosDoCrm', () => {
  it('o bloco tem uma linha por funil, com a etapa, e uma das etiquetas', () => {
    const texto = formatarFatosDoCrm({
      funis: [{ funil: 'Experiência', etapas: ['Pós-viagem'] }],
      etiquetas: ['cliente'],
      funisOmitidos: 0,
      etiquetasOmitidas: 0,
    });
    expect(texto).toBe(
      ['- Funil "Experiência", etapa "Pós-viagem": negócio ABERTO', '- Etiquetas do contato: cliente'].join('\n'),
    );
  });

  it('só etiqueta (sem card aberto) também é fato', () => {
    const texto = formatarFatosDoCrm({ funis: [], etiquetas: ['lead-frio'], funisOmitidos: 0, etiquetasOmitidas: 0 });
    expect(texto).toBe('- Etiquetas do contato: lead-frio');
  });

  it('o bloco inteiro respeita o teto de caracteres', () => {
    const negocios = Array.from({ length: 30 }, (_, i) => ({
      funil: `Funil com nome bem comprido número ${i}`,
      etapa: `Etapa também comprida ${i}`,
    }));
    const texto = formatarFatosDoCrm(montarFatosDoCrm(negocios, Array.from({ length: 20 }, (_, i) => `tag-${i}`)));
    expect(texto.length).toBeLessThanOrEqual(MAX_CARACTERES_DOS_FATOS);
    // Corta linha inteira, nunca no meio de um fato: toda linha começa com "- ".
    expect(texto.split('\n').every((l) => l.startsWith('- '))).toBe(true);
  });

  it('normalizarNome devolve vazio para o que não é nome', () => {
    expect(normalizarNome(null)).toBe('');
    expect(normalizarNome(42)).toBe('');
    expect(normalizarNome('   ')).toBe('');
    expect(normalizarNome(' Pós  viagem ')).toBe('Pós viagem');
  });
});

describe('carregarFatosDoCrmDoContato', () => {
  function dbFalso(rows: unknown[]) {
    const query = vi.fn().mockResolvedValue({ rows });
    return { query };
  }

  it('lê com organização e contato, e só negócio ABERTO', async () => {
    const fatos = montarFatosDoCrm([{ funil: 'Experiência', etapa: 'Pós-viagem' }], ['cliente']);
    const db = dbFalso([{ tags: ['cliente'], funil: 'Experiência', etapa: 'Pós-viagem' }]);
    const leitura = await carregarFatosDoCrmDoContato(db as never, 'org-1', 'contato-1');
    expect(leitura.motivo).toBeNull();
    expect(leitura.fatos).toEqual(fatos);
    const [sql, params] = db.query.mock.calls[0]! as [string, unknown[]];
    expect(params).toEqual(['org-1', 'contato-1']);
    expect(sql).toContain("l.status = 'open'");
    // A organização aparece em TODA junção: sem isto, o card de outra empresa
    // entraria no prompt deste contato.
    expect(sql.match(/organization_id/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it('não lê PII: sem título do card, sem nome/telefone/e-mail/documento do contato', async () => {
    const db = dbFalso([{ tags: [], funil: null, etapa: null }]);
    await carregarFatosDoCrmDoContato(db as never, 'org-1', 'contato-1');
    const [sql] = db.query.mock.calls[0]! as [string, unknown[]];
    expect(sql).not.toMatch(/\btitle\b/);
    expect(sql).not.toMatch(/\b(phone|whatsapp|email|document|cpf|cnpj|value_cents)\b/);
    // O nome que a consulta lê é o do FUNIL/ETAPA (config), nunca `c.name`.
    expect(sql).not.toMatch(/c\.name/);
  });

  it('contato inexistente vira motivo, com fatos vazios', async () => {
    const leitura = await carregarFatosDoCrmDoContato(dbFalso([]) as never, 'org-1', 'sumiu');
    expect(leitura.motivo).toBe('contato_inexistente');
    expect(temFatosDoCrm(leitura.fatos)).toBe(false);
  });

  it('falha da consulta NÃO lança: devolve o motivo e o turno classifica como antes', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('timeout')) };
    const leitura = await carregarFatosDoCrmDoContato(db as never, 'org-1', 'contato-1');
    expect(leitura.motivo).toBe('falha_na_leitura');
    expect(formatarFatosDoCrm(leitura.fatos)).toBe('');
  });

  it('driver que devolve tags em formato inesperado não vira etiqueta inventada', async () => {
    const leitura = await carregarFatosDoCrmDoContato(
      dbFalso([{ tags: 'cliente, vip', funil: 'Vendas', etapa: 'Novo' }]) as never,
      'org-1', 'contato-1',
    );
    expect(leitura.fatos.etiquetas).toEqual([]);
    expect(leitura.fatos.funis).toEqual([{ funil: 'Vendas', etapas: ['Novo'] }]);
  });
});
