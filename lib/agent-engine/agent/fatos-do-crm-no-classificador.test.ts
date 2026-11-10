/**
 * #3917 — o classificador do roteador recebe FATOS DO CRM do contato.
 *
 * Este arquivo é o RED: ele fala com `buildClassifierPrompt`/`classifyIntent`
 * como o turno fala, sem importar o módulo novo. Na `main` anterior ao fix, o
 * quarto argumento não existe e o campo `fatosDoCrm` não existe — os testes que
 * dependem deles reprovam com "expected … to contain Experiência", que é
 * exatamente o defeito: o classificador decide "Bom dia! Tudo bem?" só pelo
 * texto, sem saber que a cliente já tem viagem fechada.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildClassifierPrompt, classifyIntent } from './intent-classifier';

const members = [
  {
    agentId: 'a-clara',
    intentName: 'vendas',
    intentDescription: 'Viagem nova, orçamento, primeiro contato ou saudação sem assunto',
    examples: ['quanto custa', 'bom dia'],
  },
  {
    agentId: 'a-heloisa',
    intentName: 'pos_venda',
    intentDescription: 'Cliente que já fechou a viagem — experiência, pós-viagem',
    examples: ['minha viagem foi ótima'],
  },
];

const router = {
  id: 'r1', name: 'R', classifierModel: 'claude-haiku-4-5', classifierProvider: null,
  sticky: true, minConfidence: 0.6, fallbackAgentId: null, members,
};

/** O caso da issue: cliente com viagem fechada (card aberto em "Experiência"). */
const fatosDaClienteComViagemFechada = {
  funis: [{ funil: 'Experiência', etapas: ['Pós-viagem'] }],
  etiquetas: ['cliente', 'viagem-fechada'],
  funisOmitidos: 0,
  etiquetasOmitidas: 0,
};

describe('#3917 — fatos do CRM no prompt do classificador', () => {
  it('o funil e a etapa onde o contato tem negócio ABERTO vão para o prompt', () => {
    const p = buildClassifierPrompt(members, 'Bom dia! Tudo bem?', [], fatosDaClienteComViagemFechada);
    expect(p).toContain('Fatos do CRM deste contato');
    expect(p).toContain('Funil "Experiência"');
    expect(p).toContain('Pós-viagem');
    expect(p).toContain('negócio ABERTO');
  });

  it('as etiquetas do contato vão para o prompt', () => {
    const p = buildClassifierPrompt(members, 'Bom dia! Tudo bem?', [], fatosDaClienteComViagemFechada);
    expect(p).toContain('Etiquetas do contato: cliente, viagem-fechada');
  });

  it('o bloco de fatos fica DEPOIS das intenções e ANTES da mensagem a classificar', () => {
    const p = buildClassifierPrompt(members, 'Bom dia! Tudo bem?', [], fatosDaClienteComViagemFechada);
    const posicoes = [
      '- none: nenhuma das intenções acima se aplica.',
      'Fatos do CRM deste contato',
      'Mensagem do lead a classificar:\nBom dia! Tudo bem?',
    ].map((trecho) => p.indexOf(trecho));
    expect(posicoes.every((i) => i >= 0)).toBe(true);
    expect([...posicoes].sort((a, b) => a - b)).toEqual(posicoes);
  });

  it('o cabeçalho dos fatos avisa que eles NÃO são o que se classifica', () => {
    const p = buildClassifierPrompt(members, 'Agradeço', [], fatosDaClienteComViagemFechada);
    expect(p).toContain('NÃO é o que classificar');
    // O contrato de saída não muda: continua pedindo SÓ o JSON de intenção.
    expect(p).toContain('Responda SOMENTE JSON');
    expect(p).toContain('"intent"');
  });

  it('sem fato nenhum o prompt é byte a byte o de antes (nada de texto fantasma)', () => {
    const semFatos = { funis: [], etiquetas: [], funisOmitidos: 0, etiquetasOmitidas: 0 };
    const antes = buildClassifierPrompt(members, 'oi');
    expect(buildClassifierPrompt(members, 'oi', [], null)).toBe(antes);
    expect(buildClassifierPrompt(members, 'oi', [], semFatos)).toBe(antes);
    expect(antes).not.toContain('Fatos do CRM');
  });

  it('lista no teto DIZ que truncou, em vez de fingir que é completa', () => {
    const p = buildClassifierPrompt(members, 'ok', [], {
      funis: [{ funil: 'Experiência', etapas: ['Pós-viagem'] }],
      etiquetas: ['cliente'],
      funisOmitidos: 2,
      etiquetasOmitidas: 12,
    });
    expect(p).toContain('mais 2 funil(is) e 12 etiqueta(s)');
    expect(p).toContain('não é completa');
  });

  it('o bloco de fatos não carrega telefone/e-mail/documento', () => {
    const p = buildClassifierPrompt(members, 'Bom dia', [], fatosDaClienteComViagemFechada);
    expect(p).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/); // CPF
    expect(p).not.toMatch(/\+?\d{2}\s?\(?\d{2}\)?\s?9?\d{4}-?\d{4}/); // telefone
    expect(p).not.toContain('@');
  });

  it('classifyIntent leva os fatos até a mensagem que o MODELO recebe', async () => {
    const runModelCall = vi.fn().mockResolvedValue({ result: { text: '{"intent":"pos_venda","confidence":0.82}' } });
    const out = await classifyIntent({} as never, {} as never,
      {
        tenantId: 'o1', leadId: 'contato-1', jobId: 'j1', router, signal: 'Bom dia! Tudo bem?',
        fatosDoCrm: fatosDaClienteComViagemFechada,
      },
      { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, runModelCall } as never);
    expect(out).toEqual({ intentName: 'pos_venda', confidence: 0.82 });
    const conteudo = (runModelCall.mock.calls[0]![2] as { messages: { content: string }[] }).messages[0]!.content;
    expect(conteudo).toContain('Funil "Experiência"');
    expect(conteudo).toContain('Etiquetas do contato: cliente, viagem-fechada');
  });

  it('sem fatos, classifyIntent manda o mesmo prompt de antes (nenhum campo novo na saída)', async () => {
    const runModelCall = vi.fn().mockResolvedValue({ result: { text: '{"intent":"vendas","confidence":0.7}' } });
    await classifyIntent({} as never, {} as never,
      { tenantId: 'o1', leadId: 'contato-1', jobId: 'j1', router, signal: 'oi' },
      { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, runModelCall } as never);
    const conteudo = (runModelCall.mock.calls[0]![2] as { messages: { content: string }[] }).messages[0]!.content;
    expect(conteudo).toBe(buildClassifierPrompt(members, 'oi', [], null));
    expect(conteudo).not.toContain('Fatos do CRM');
  });
});
