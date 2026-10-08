/**
 * #2555 — a prévia ("Sugerir resposta") monta o GateContext SEM `resposta: true`,
 * e o `pacingGate` (`before-send.ts`: `resposta: ctx.pacing.resposta`) caía na
 * janela de DISPARO (`window_*`, padrão 7h-22h) em vez da de RESPOSTA
 * (`resposta_*`, 0-24): fora do horário comercial o rascunho assistido morria
 * com `error_code='outside_window'` antes de existir.
 *
 * O mesmo ponto já estava resolvido no ENVIO do rascunho aprovado
 * (`approved-reply.ts`, comentário citando #1984) — a prévia, que GERA o
 * rascunho, ficou de fora.
 *
 * O segundo bloco guarda o outro lado do mesmo arquivo: no sandbox o veto de
 * pacing segue rebaixado a aviso (`gatesDoSandbox`, preview.ts) — o conserto
 * muda QUAL janela gera o aviso, não o rebaixamento, e não acrescenta veto novo.
 */
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { tool } from '@/lib/agent-engine/edge/llm/run-model-call';
import {
  applyPreviewPolicy,
  newPreviewResult,
  previewGateContext,
  scenarioContext,
  type TurnPreview,
} from '@/lib/agent-engine/agent/preview';
import { evaluateBeforeSend, type GateContext } from '@/lib/agent-engine/guardrails/before-send';
import type { Logger } from '@/lib/agent-engine/obs/logger';

/** 22h57 em São Paulo (UTC-3) — fora da janela de disparo 7h-22h. */
const NOITE = new Date('2026-10-04T01:57:58Z');
/** 12h em São Paulo — dentro das duas janelas. */
const DIA = new Date('2026-10-04T15:00:00Z');

const ORG = 'org-do-teste';
const SESSAO = 'sessao-do-teste';

/**
 * O pool do cenário da ISSUE: a conexão tem janela de RESPOSTA 0-24 gravada em
 * `channel_knobs` e a de disparo no padrão 7h-22h. As demais consultas da
 * prévia (promise, disclosure, camadas, ledger, spinning) voltam vazias e caem
 * nos defaults — o que está sob teste é a flag de pacing, não o resto da carga.
 */
function poolComJanelasConfiguradas(): pg.Pool {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('window_start_hour'))
        return {
          rows: [
            {
              throttle_ms: null,
              jitter_max_ms: null,
              window_start_hour: 7,
              window_end_hour: 22,
              resposta_start_hour: 0,
              resposta_end_hour: 24,
              atraso_notar_ms: null,
              ms_por_caractere: null,
              atraso_minimo_ms: null,
              atraso_maximo_ms: null,
              allow_sunday: true,
              timezone: 'America/Sao_Paulo',
              warmup_daily_caps: null,
              number_activated_at: null,
              org_timezone: 'America/Sao_Paulo',
            },
          ],
        };
      return { rows: [] };
    }),
  } as unknown as pg.Pool;
}

const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function previa(kind: TurnPreview['kind']): TurnPreview {
  return {
    kind,
    organizationId: ORG,
    runId: 'run-do-teste',
    contactId: null,
    channelId: SESSAO,
    agent: {
      casesEnabled: false,
      toolIds: [],
      handoffKeywords: [],
    } as unknown as TurnPreview['agent'],
    context: scenarioContext([]),
    result: newPreviewResult(),
  };
}

/** O GateContext que a prévia monta AGORA, com a mensagem recém-chegada. */
async function contextoDaPrevia(now: Date): Promise<GateContext> {
  const ctx = await previewGateContext(poolComJanelasConfiguradas(), previa('assisted'), log, now);
  // A mensagem que disparou a prévia acabou de chegar — o carimbo da janela de 24h.
  return { ...ctx, messagingWindow: { lastInboundAt: now } };
}

const definicao = (executar: (args: unknown) => unknown) =>
  tool({
    inputSchema: z.object({ body: z.string().optional() }).passthrough(),
    execute: async (args) => executar(args),
  });

async function chamar(
  tools: ReturnType<typeof applyPreviewPolicy>,
  nome: string,
  args: unknown = {},
): Promise<unknown> {
  return tools[nome]!.execute!(args, { toolCallId: 't', messages: [], context: undefined });
}

const RESPOSTA = 'Que bom! Para eu te ajudar melhor: o chalé seria para lazer, moradia ou locação?';

describe('#2555 a prévia avalia a janela de RESPOSTA, não a de disparo', () => {
  it('fora do horário de disparo (resposta 0-24) o rascunho NÃO é vetado por outside_window', async () => {
    const ctx = await contextoDaPrevia(NOITE);

    // O conserto: o pacing do GateContext da prévia se declara turno de resposta.
    expect(ctx.pacing.resposta).toBe(true);
    // A premissa do caso: resposta 0-24 e disparo 7h-22h, como na issue.
    expect(ctx.pacing.knobs.windowStartHour).toBe(7);
    expect(ctx.pacing.knobs.windowEndHour).toBe(22);
    expect(ctx.pacing.knobs.respostaStartHour).toBe(0);
    expect(ctx.pacing.knobs.respostaEndHour).toBe(24);

    const r = evaluateBeforeSend({ ...ctx, body: RESPOSTA });
    expect(r.veto).toBeNull();
    expect(r.trace.find((t) => t.gate === 'pacing')).toEqual({ gate: 'pacing', verdict: 'pass' });
  });

  it('sem a flag, o MESMO contexto cai na janela de disparo — a causa medida da issue', async () => {
    const ctx = await contextoDaPrevia(NOITE);
    const semResposta: GateContext = { ...ctx, pacing: { ...ctx.pacing, resposta: undefined } };

    const r = evaluateBeforeSend({ ...semResposta, body: RESPOSTA });
    expect(r.veto?.code).toBe('outside_window');
    expect(r.veto?.message).toMatch(/janela de envio/);
  });
});

describe('o sandbox segue rebaixando o veto de pacing a aviso (#2555 não mexe no rebaixamento)', () => {
  it('cap estourado: candidato + aviso no Testar; o rascunho assistido continua vetado', async () => {
    // De DIA as duas janelas estão abertas, então o veredito abaixo é o CAP e
    // não o horário: o teste mede o rebaixamento, não a janela.
    const ctx = await contextoDaPrevia(DIA);
    const estourado: GateContext = {
      ...ctx,
      pacing: {
        ...ctx.pacing,
        state: { lastSentAt: null, sentToday: 999, numberActivatedAt: null },
      },
    };

    const pSandbox = previa('sandbox');
    const sandbox = applyPreviewPolicy(
      { send_message: definicao(vi.fn()) },
      pSandbox,
      estourado,
      () => [],
    );
    await chamar(sandbox, 'send_message', { body: RESPOSTA });

    expect(pSandbox.result.candidates.map((c) => c.body)).toEqual([RESPOSTA]);
    expect(pSandbox.result.warnings.map((w) => w.code)).toEqual(['warmup_cap']);
    expect(pSandbox.result.warnings[0]!.message).toMatch(/não sairia agora/);
    const pacing = pSandbox.result.candidates[0]!.trace.find((t) => t.gate === 'pacing');
    expect(pacing).toEqual({ gate: 'pacing', verdict: 'skipped', code: 'sandbox_send_embargo' });

    const pAssistido = previa('assisted');
    const assistido = applyPreviewPolicy(
      { send_message: definicao(vi.fn()) },
      pAssistido,
      estourado,
      () => [],
    );
    await chamar(assistido, 'send_message', { body: RESPOSTA });

    expect(pAssistido.result.candidates).toEqual([]);
    expect(pAssistido.result.impediments.map((i) => i.code)).toEqual(['warmup_cap']);
    expect(pAssistido.result.warnings).toEqual([]);
  });
});
