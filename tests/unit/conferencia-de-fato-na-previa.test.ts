/**
 * #2923 — a conferência de fato (#2231) só era passada ao `runBeforeSend` do envio
 * automático (`inbound-turn.ts`). A prévia — "Sugerir resposta" do modo assistido e o
 * "Testar" — chamava `evaluateBeforeSend` sem `factualClaim`, então a camada 6.3 nunca
 * avaliava o rascunho e a tarefa do Jev nunca observava o modo assistido (medido numa
 * v1.80.0: 533 rascunhos, 0 observações de `afirmacao_de_fato`).
 *
 * O conserto passa à prévia o MESMO conferidor do turno. Quem decide continua sendo o
 * estado da tarefa (`factualClaimGate`): decidindo, o fato contradito vira impedimento
 * visível; observando, o rascunho sai e a observação fica gravada pelo próprio conferidor.
 *
 * Mutação conferida em 2026-10-15: sem o `factualClaim` no contexto do
 * `evaluateBeforeSend` da prévia, o primeiro teste falha (o rascunho sai como candidato).
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
import type { GateContext } from '@/lib/agent-engine/guardrails/before-send';
import type { ConferenciaDeFato } from '@/lib/agent-engine/guardrails/factual-claim';
import type { Logger } from '@/lib/agent-engine/obs/logger';

/** 12h em São Paulo — dentro de qualquer janela: o que está sob teste é a camada 6.3. */
const DIA = new Date('2026-10-04T15:00:00Z');
const RESPOSTA = 'O check-in é a partir das 12h.';

/** Todas as consultas da prévia voltam vazias e caem nos defaults. */
const poolVazio = { query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool;
const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function previa(kind: TurnPreview['kind']): TurnPreview {
  return {
    kind,
    organizationId: 'org-do-teste',
    runId: 'run-do-teste',
    contactId: null,
    channelId: 'sessao-do-teste',
    agent: { casesEnabled: false, toolIds: [], handoffKeywords: [] } as unknown as TurnPreview['agent'],
    context: scenarioContext([]),
    result: newPreviewResult(),
  };
}

async function contexto(p: TurnPreview): Promise<GateContext> {
  const ctx = await previewGateContext(poolVazio, p, log, DIA);
  return { ...ctx, messagingWindow: { lastInboundAt: DIA } };
}

const envio = () =>
  tool({ inputSchema: z.object({ body: z.string() }).passthrough(), execute: vi.fn() });

const conferencia = (estado: ConferenciaDeFato['estado']): ConferenciaDeFato => ({
  estado,
  veredito: 'contradiz',
  frase: RESPOSTA,
  quantidadeDeFrases: 1,
  pediu: true,
});

async function sugerir(p: TurnPreview, conferir?: (body: string) => Promise<ConferenciaDeFato | null>) {
  const tools = applyPreviewPolicy(
    { send_message: envio() },
    p,
    await contexto(p),
    () => [],
    undefined,
    undefined,
    undefined,
    conferir,
  );
  return tools.send_message!.execute!({ body: RESPOSTA }, { toolCallId: 't', messages: [], context: undefined });
}

describe('#2923 a prévia passa pela conferência de fato do turno', () => {
  it('tarefa decidindo: fato contradito vira impedimento do rascunho, e o conferidor recebe o corpo', async () => {
    const conferir = vi.fn(async () => conferencia('decidindo'));
    const p = previa('assisted');

    const r = (await sugerir(p, conferir)) as { ok: boolean; error?: { code: string } };

    expect(conferir).toHaveBeenCalledWith(RESPOSTA);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('factual_claim_contradicted');
    expect(p.result.impediments.map((i) => i.code)).toEqual(['factual_claim_contradicted']);
    expect(p.result.candidates).toEqual([]);
  });

  it('tarefa só observando: o rascunho sai — a conferência roda, mas não barra', async () => {
    const conferir = vi.fn(async () => conferencia('observando'));
    const p = previa('assisted');

    await sugerir(p, conferir);

    expect(conferir).toHaveBeenCalledTimes(1);
    expect(p.result.impediments).toEqual([]);
    expect(p.result.candidates.map((c) => c.body)).toEqual([RESPOSTA]);
    expect(p.result.candidates[0]!.trace.find((t) => t.gate === 'factual_claim')).toEqual({
      gate: 'factual_claim',
      verdict: 'pass',
    });
  });

  it('sem conferidor (quem ainda não passa o argumento): comportamento de antes, o rascunho sai', async () => {
    const p = previa('assisted');

    await sugerir(p);

    expect(p.result.candidates.map((c) => c.body)).toEqual([RESPOSTA]);
  });
});
