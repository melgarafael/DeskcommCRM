import { DEFAULT_CHANNEL_PROVIDER } from '@/lib/channels';
import { describe, it, expect, vi } from 'vitest';
import { tool } from '../edge/llm/run-model-call';
import { z } from 'zod';
import {
  applyPreviewPolicy,
  blocoDeNotasDaPrevia,
  lerNotaDaPrevia,
  newPreviewResult,
  PREVIEW_NOTES_INLINE_MAX_TOKENS,
  scenarioContext,
  type TurnPreview,
} from './preview';
import { renderNotesIndexBlock } from './lead-notes';
import { countPayloadTokens } from '@/lib/ai/estimativa-de-tokens';
import { evaluateBeforeSend, type GateContext } from '../guardrails/before-send';
import { marcarLeituraRemota } from '@/lib/mcp/servidor-externo/leitura-remota';
import { PACING_DEFAULTS } from '../pacing/defaults';
import { SPINNING_DEFAULTS } from '../spinning/defaults';
const gate = (): GateContext => ({
  now: new Date('2026-09-07T15:00:00Z'),
  body: 'Olá, posso ajudar?',
  optedOut: false,
  provider: DEFAULT_CHANNEL_PROVIDER,
  messagingWindow: { lastInboundAt: new Date('2026-09-07T14:00:00Z') },
  pacing: {
    knobs: PACING_DEFAULTS,
    state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
    crmDailyLimit: null,
  },
  spinning: { knobs: SPINNING_DEFAULTS, window: [] },
  promise: { table: null },
  semanticPromise: null,
  disclosure: { template: null, isFirstOutbound: false, mode: 'inject' },
  lgpd: null,
  casesEnabled: false,
  hasOpenCase: false,
  openedCaseThisTurn: false,
});
const preview = () =>
  ({
    kind: 'sandbox',
    organizationId: 'real-org',
    runId: 'preview-run',
    contactId: null,
    channelId: null,
    agent: {},
    context: scenarioContext([]),
    result: newPreviewResult(),
  }) as TurnPreview;
const definition = (execute: (args: unknown) => unknown) =>
  tool({
    inputSchema: z.object({ body: z.string().optional() }),
    execute: async (args) => execute(args),
  });
async function execute(t: ReturnType<typeof applyPreviewPolicy>, name: string, args: unknown = {}) {
  return t[name]!.execute!(args, { toolCallId: 'test', messages: [], context: undefined });
}
describe('preview policy shares gates and contains side effects', () => {
  it('registers text and mutation proposals without calling either operational executor', async () => {
    const send = vi.fn(),
      write = vi.fn(),
      p = preview();
    const tools = applyPreviewPolicy(
      { send_message: definition(send), update_lead_state: definition(write) },
      p,
      gate(),
      () => [],
    );
    await execute(tools, 'update_lead_state', { stage: 'qualified' });
    await execute(tools, 'send_message', { body: 'Olá, posso ajudar?' });
    expect(send).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(p.result.proposals).toHaveLength(1);
    expect(p.result.candidates[0]?.body).toBe('Olá, posso ajudar?');
  });
  it('uses exactly the real opt-out decision and prevents a simulated candidate too', async () => {
    const p = preview(),
      ctx = { ...gate(), optedOut: true },
      spy = vi.fn();
    const tools = applyPreviewPolicy({ send_message: definition(spy) }, p, ctx, () => []);
    await execute(tools, 'send_message', { body: ctx.body });
    expect(p.result.candidates).toEqual([]);
    expect(p.result.impediments[0]?.code).toBe(evaluateBeforeSend(ctx).veto?.code);
    expect(spy).not.toHaveBeenCalled();
  });
  it('keeps knowledge reads real and preserves independently generated citations', async () => {
    const read = vi.fn(async () => ({
        ok: true,
        results: [{ content: 'Conhecimento autorizado' }],
      })),
      p = preview();
    const tools = applyPreviewPolicy(
      { search_knowledge: definition(read), send_message: definition(vi.fn()) },
      p,
      gate(),
      () => [],
    );
    await execute(tools, 'search_knowledge');
    await execute(tools, 'send_message', { body: 'Conhecimento autorizado' });
    expect(read).toHaveBeenCalledOnce();
    expect(p.result.candidates).toHaveLength(1);
  });
  it('fails closed for unknown capability and never invokes it', async () => {
    const p = preview(),
      spy = vi.fn();
    const tools = applyPreviewPolicy({ hidden_mutation: definition(spy) }, p, gate(), () => []);
    await execute(tools, 'hidden_mutation');
    expect(spy).not.toHaveBeenCalled();
    expect(p.result.impediments[0]?.code).toBe('unknown_preview_tool');
  });
  it('runs only the remote MCP tool pickToolsFromMcp classified as read', async () => {
    // O catálogo de um servidor MCP externo (#2147) chega ao turno pelo nome que o
    // servidor anuncia; sem isto a prévia — que é também o rascunho do modo
    // assistido — recusava `buscar_produtos` como `unknown_preview_tool`.
    // A marca é do OBJETO: o `tool_ids` dizer "leitura" não basta (o servidor pode
    // não ter declarado readOnlyHint), e um nome nativo não vira leitura remota.
    const p = preview(),
      leitura = vi.fn().mockResolvedValue({ itens: [] }),
      semHint = vi.fn(),
      nativo = vi.fn();
    (p.agent as { toolIds: string[] }).toolIds = [
      'mcp_externo:leitura:buscar_produtos',
      'mcp_externo:leitura:cancelar_pedido',
      'mcp_externo:leitura:hidden_mutation',
    ];
    const tools = applyPreviewPolicy(
      {
        buscar_produtos: marcarLeituraRemota(definition(leitura)),
        cancelar_pedido: definition(semHint),
        hidden_mutation: definition(nativo),
      },
      p,
      gate(),
      () => [],
    );
    await execute(tools, 'buscar_produtos', { body: 'colar 925' });
    await execute(tools, 'cancelar_pedido');
    await execute(tools, 'hidden_mutation');
    expect(leitura).toHaveBeenCalledOnce();
    expect(semHint).not.toHaveBeenCalled();
    expect(nativo).not.toHaveBeenCalled();
    expect(p.result.impediments.map((i) => i.message)).toEqual([
      'cancelar_pedido',
      'hidden_mutation',
    ]);
  });
  it('does not mutate the original gate context when disclosure amends a body', () => {
    const ctx = {
      ...gate(),
      disclosure: {
        template: 'Sou assistente virtual.',
        isFirstOutbound: true,
        mode: 'inject' as const,
      },
    };
    const before = structuredClone(ctx);
    const result = evaluateBeforeSend(ctx);
    expect(ctx).toEqual(before);
    expect(result.trace.length).toBeGreaterThan(1);
  });
});

it('refreshes agenda read state for each candidate while writes stay proposals', async () => {
  const p = preview();
  p.contactId = 'actual-contact';
  let called = false;
  const ctx = { ...gate(), agenda: { active: true, ferramentas: ['crm_find_free_slots'], toolCalledThisTurn: false } };
  const tools = applyPreviewPolicy(
    {
      crm_find_free_slots: definition(() => {
        called = true;
        return { ok: true, slots: [] };
      }),
      send_message: definition(vi.fn()),
    },
    p,
    ctx,
    () => [],
    undefined,
    () => ({ agenda: { active: true, ferramentas: ['crm_find_free_slots'], toolCalledThisTurn: called } }),
  );
  await execute(tools, 'send_message', { body: 'Vou verificar o horário para você.' });
  expect(p.result.impediments.some((i) => i.code === 'agenda_stall_sem_ferramenta')).toBe(true);
  await execute(tools, 'crm_find_free_slots');
  await execute(tools, 'send_message', { body: 'Vou verificar o horário para você.' });
  expect(p.result.candidates).toHaveLength(1);
});
it('uses only supplied in-memory sample contact in sandbox', () => {
  const context = scenarioContext([], { name: 'Maria Cenário', phone: '+5511999999999' });
  expect(context.context.contact.name).toBe('Maria Cenário');
  expect(context.context.contact.phone).toBe('+5511999999999');
});

/**
 * #4592 — no Testar, `open_human_case` é PROPOSTA (nada é gravado), mas a trava
 * `case_promise_without_case` lia `openedCaseThisTurn: false` FIXO no contexto
 * montado por `previewGateContext`. Resultado: a mesma frase que passa em
 * produção era vetada no teste, e quem afina o prompt corrigia um problema que
 * não existe. Aqui a chamada com payload válido conta para a trava SEM gravar
 * nada, e o status devolvido ao modelo continua `proposal_only`.
 *
 * O contexto do gate é montado ANTES da chamada (como na prévia real, em que
 * `previewGateContext` roda antes das ferramentas), então o verde deste teste
 * prova que a marcação é lida VIVA na hora do `send_message` — não no valor
 * congelado na montagem.
 */
describe('prévia: open_human_case chamado conta como caso aberto para a trava (#4592)', () => {
  /** A família de frase do issue ("aguarde um pouquinho por aqui") que a trava detém. */
  const fraseDeEspera = 'Vou verificar com a equipe e já te retorno, aguarde um pouquinho por aqui.';
  const casoValido = {
    title: 'Voo cancelado',
    summary: 'Cliente pede reembolso da passagem cancelada.',
    blocker: 'Estorno fora do playbook e exige decisão de uma pessoa.',
  };
  const contextoCases = () => ({ ...gate(), casesEnabled: true });

  it('com a ferramenta chamada e payload válido, a frase de espera passa — e nada é gravado', async () => {
    const p = preview(),
      executarDeVerdade = vi.fn(),
      send = vi.fn();
    const tools = applyPreviewPolicy(
      { open_human_case: definition(executarDeVerdade), send_message: definition(send) },
      p,
      contextoCases(),
      () => [],
    );
    const proposta = await execute(tools, 'open_human_case', casoValido);
    // O contrato com o modelo não muda: a operação continua só PROPOSTA.
    expect(proposta).toMatchObject({ ok: true, status: 'proposal_only' });
    await execute(tools, 'send_message', { body: fraseDeEspera });
    expect(p.result.impediments).toEqual([]);
    expect(p.result.candidates.map((c) => c.body)).toEqual([fraseDeEspera]);
    expect(p.result.proposals).toEqual([{ tool: 'open_human_case', arguments: casoValido }]);
    // Nem o execute original da ferramenta nem o do envio rodaram: a prévia não grava caso.
    expect(executarDeVerdade).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('sem a chamada, a trava veta a mesma frase — como hoje', async () => {
    const p = preview(),
      executarDeVerdade = vi.fn();
    const tools = applyPreviewPolicy(
      { open_human_case: definition(executarDeVerdade), send_message: definition(vi.fn()) },
      p,
      contextoCases(),
      () => [],
    );
    await execute(tools, 'send_message', { body: fraseDeEspera });
    expect(p.result.impediments.map((i) => i.code)).toEqual(['case_promise_without_case']);
    expect(p.result.candidates).toEqual([]);
    expect(executarDeVerdade).not.toHaveBeenCalled();
  });

  it('payload inválido não marca o caso: a trava continua vetando', async () => {
    const p = preview(),
      executarDeVerdade = vi.fn();
    const tools = applyPreviewPolicy(
      { open_human_case: definition(executarDeVerdade), send_message: definition(vi.fn()) },
      p,
      contextoCases(),
      () => [],
    );
    // `.strict()`: campo fora da whitelist derruba o payload no turno real também.
    await execute(tools, 'open_human_case', { ...casoValido, status: 'resolved' });
    await execute(tools, 'send_message', { body: fraseDeEspera });
    expect(p.result.impediments.map((i) => i.code)).toEqual(['case_promise_without_case']);
    expect(p.result.candidates).toEqual([]);
    expect(executarDeVerdade).not.toHaveBeenCalled();
  });
});


describe('proteção comercial: ferramenta e prévia concordam', () => {
  it.each(['Os óculos custam R$ 299,90.', 'Pode pagar em 10x.', 'Temos desconto de 15%.'])
    ('barra o mesmo texto sem acionar transporte: %s', async body => {
      const p = preview(), send = vi.fn(), ctx = { ...gate(), body, commercialRestrictionEnforced: true };
      const direto = evaluateBeforeSend(ctx);
      const tools = applyPreviewPolicy({ send_message: definition(send) }, p, ctx, () => []);
      await execute(tools, 'send_message', { body });
      expect(direto.veto?.code).toBe('commercial_requires_human');
      expect(p.result.impediments[0]?.code).toBe(direto.veto?.code);
      expect(p.result.candidates).toEqual([]);
      expect(p.result.proposals).toContainEqual({ tool: 'crm_request_human_handoff', arguments: {
        reason: 'Valores e negociação: atendimento exclusivamente humano.',
      } });
      expect(send).not.toHaveBeenCalled();
    });
  it('mantém endereço literal e não altera organizações sem essa restrição', async () => {
    const p = preview(), body = 'Rua das Flores, 2054';
    await execute(applyPreviewPolicy({ send_message: definition(vi.fn()) }, p,
      { ...gate(), commercialRestrictionEnforced: true }, () => []), 'send_message', { body });
    expect(p.result.candidates[0]?.body).toBe(body);
    expect(evaluateBeforeSend({ ...gate(), body: 'São R$ 299,90.' }).veto).toBeNull();
  });
});

/**
 * Notas na prévia (frente F1): inteiras enquanto cabem no teto inline — a string
 * de sempre —, e no índice do turno real acima dele, com o corpo pelo id.
 */
describe('notas da prévia: teto inline e índice', () => {
  const longa = (i: number) => ({
    id: `n${i}`,
    headline: `Nota ${i}`,
    body: `CORPO-LONGO-${i} ` + 'x'.repeat(4_000),
  });

  it('sem notas, o bloco é vazio e inline — a saída de antes', () => {
    expect(blocoDeNotasDaPrevia([], 500)).toEqual({ bloco: '', inline: true });
  });

  it('nota curta vai inteira, no formato "headline: corpo" de antes', () => {
    const notas = [
      { id: 'n1', headline: 'Prefere manhã', body: 'CORPO-SENTINELA-91' },
      { id: 'n2', headline: 'Tem filho', body: 'Dois anos' },
    ];
    expect(blocoDeNotasDaPrevia(notas, 500)).toEqual({
      bloco: 'Prefere manhã: CORPO-SENTINELA-91\nTem filho: Dois anos',
      inline: true,
    });
  });

  it('acima do teto vira o índice do turno real, sem nenhum corpo', () => {
    const notas = [0, 1, 2, 3].map(longa);
    const inline = notas.map((n) => n.headline + ': ' + n.body).join('\n');
    expect(countPayloadTokens(inline)).toBeGreaterThan(PREVIEW_NOTES_INLINE_MAX_TOKENS);
    const r = blocoDeNotasDaPrevia(notas, 500);
    expect(r.inline).toBe(false);
    expect(r.bloco).toBe(renderNotesIndexBlock(notas, 500));
    expect(r.bloco).toContain('- [n0] Nota 0');
    expect(r.bloco).not.toContain('CORPO-LONGO-');
  });

  it('get_lead_note inline devolve todas as notas, sem o id — a resposta de antes', () => {
    const notas = [{ id: 'n1', headline: 'Prefere manhã', body: 'CORPO-SENTINELA-91' }];
    expect(lerNotaDaPrevia(notas, true, { note_id: 'qualquer' })).toEqual({
      ok: true,
      notes: [{ headline: 'Prefere manhã', body: 'CORPO-SENTINELA-91' }],
    });
  });

  it('get_lead_note no índice devolve UM corpo pelo id, no formato da ferramenta real', () => {
    const notas = [0, 1].map(longa);
    expect(lerNotaDaPrevia(notas, false, { note_id: ' n1 ' })).toEqual({
      ok: true,
      note_id: 'n1',
      body: notas[1]!.body,
    });
  });

  it('id desconhecido (ou ausente) no índice vira note_not_found', () => {
    const notas = [longa(0)];
    for (const args of [{ note_id: 'nao-existe' }, {}, null]) {
      const r = lerNotaDaPrevia(notas, false, args);
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ error: { code: 'note_not_found' } });
    }
  });
});
