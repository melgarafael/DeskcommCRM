/**
 * Regressão: o sandbox permite inspecionar um candidato fora da janela de envio,
 * mas a prévia assistida e a política real continuam vetando o envio.
 * Ferramentas de escrita não são executadas por esta política de preview.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels";
import { tool } from "@/lib/agent-engine/edge/llm/run-model-call";
import {
  applyPreviewPolicy,
  newPreviewResult,
  scenarioContext,
  type TurnPreview,
} from "@/lib/agent-engine/agent/preview";
import { evaluateBeforeSend, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

/** Um horário fora da janela de envio em America/Sao_Paulo (UTC-3). */
const NOITE = new Date("2026-10-04T01:57:58Z");
/** Meio-dia em São Paulo, dentro da janela. */
const DIA = new Date("2026-10-04T15:00:00Z");

function contexto(now: Date, over: Partial<GateContext> = {}): GateContext {
  return {
    now,
    body: "",
    optedOut: false,
    provider: DEFAULT_CHANNEL_PROVIDER,
    // O cenário do sandbox: a mensagem do cliente acabou de chegar.
    messagingWindow: { lastInboundAt: now },
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: true, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    internalVocabularyEnforced: true,
    ...over,
  };
}

function previa(kind: TurnPreview["kind"]): TurnPreview {
  return {
    kind,
    organizationId: "org-do-teste",
    runId: "run-do-teste",
    contactId: kind === "assisted" ? "contato-real" : null,
    channelId: null,
    agent: {} as TurnPreview["agent"],
    context: scenarioContext([]),
    result: newPreviewResult(),
  };
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
  return tools[nome]!.execute!(args, { toolCallId: "t", messages: [], context: undefined });
}

const RESPOSTA = "Que bom! Para eu te ajudar melhor: o chalé seria para lazer, moradia ou locação?";

describe("sandbox fora da janela de envio", () => {
  it("a cadeia de PRODUÇÃO veta outside_window à noite — a premissa do defeito", () => {
    const r = evaluateBeforeSend({ ...contexto(NOITE), body: RESPOSTA });
    expect(r.veto?.code).toBe("outside_window");
  });

  it("sandbox à noite gera o candidato e avisa do embargo sem bloquear", async () => {
    const enviar = vi.fn();
    const p = previa("sandbox");
    const tools = applyPreviewPolicy(
      { send_message: definicao(enviar) },
      p,
      contexto(NOITE),
      () => [],
    );

    const retorno = await chamar(tools, "send_message", { body: RESPOSTA });

    expect(enviar).not.toHaveBeenCalled();
    expect(p.result.candidates.map((c) => c.body)).toEqual([RESPOSTA]);
    expect(p.result.impediments).toEqual([]);
    expect(p.result.warnings.map((w) => w.code)).toEqual(["outside_window"]);
    // O aviso diz que em produção a mensagem NÃO sairia agora, e que nada saiu.
    const aviso = p.result.warnings[0]!.message;
    expect(aviso).toMatch(/não sairia agora/);
    expect(aviso).toMatch(/nenhuma mensagem foi enviada/i);
    // O modelo é informado de que nada foi enviado — candidato, não entrega.
    expect(retorno).toMatchObject({ ok: true, status: "simulated" });
    // O trace mostra a janela como NÃO aplicada ao teste, nunca como "pass".
    const pacing = p.result.candidates[0]!.trace.find((t) => t.gate === "pacing");
    expect(pacing).toEqual({ gate: "pacing", verdict: "skipped", code: "sandbox_send_embargo" });
  });

  it("vários candidatos no mesmo turno não repetem o aviso", async () => {
    const p = previa("sandbox");
    const tools = applyPreviewPolicy(
      { send_message: definicao(vi.fn()) },
      p,
      contexto(NOITE),
      () => [],
    );
    await chamar(tools, "send_message", { body: RESPOSTA });
    await chamar(tools, "send_message", { body: "E você já tem o terreno?" });
    expect(p.result.candidates).toHaveLength(2);
    expect(p.result.warnings).toHaveLength(1);
  });

  it("sandbox de dia não ganha aviso nenhum", async () => {
    const p = previa("sandbox");
    const tools = applyPreviewPolicy(
      { send_message: definicao(vi.fn()) },
      p,
      contexto(DIA),
      () => [],
    );
    await chamar(tools, "send_message", { body: RESPOSTA });
    expect(p.result.candidates).toHaveLength(1);
    expect(p.result.warnings).toEqual([]);
    const pacing = p.result.candidates[0]!.trace.find((t) => t.gate === "pacing");
    expect(pacing?.verdict).toBe("pass");
  });

  it("o RASCUNHO assistido (contato real) continua vetado pela janela", async () => {
    const enviar = vi.fn();
    const p = previa("assisted");
    const tools = applyPreviewPolicy(
      { send_message: definicao(enviar) },
      p,
      contexto(NOITE),
      () => [],
    );

    const retorno = await chamar(tools, "send_message", { body: RESPOSTA });

    expect(enviar).not.toHaveBeenCalled();
    expect(p.result.candidates).toEqual([]);
    expect(p.result.impediments.map((i) => i.code)).toEqual(["outside_window"]);
    expect(p.result.warnings).toEqual([]);
    expect(retorno).toMatchObject({ ok: false, error: { code: "outside_window" } });
  });

  it("opt-out segue bloqueando o sandbox à noite — o aviso não é aprovação", async () => {
    const p = previa("sandbox");
    const tools = applyPreviewPolicy(
      { send_message: definicao(vi.fn()) },
      p,
      contexto(NOITE, { optedOut: true }),
      () => [],
    );
    await chamar(tools, "send_message", { body: RESPOSTA });
    expect(p.result.candidates).toEqual([]);
    expect(p.result.impediments.map((i) => i.code)).toEqual(["contato_bloqueado"]);
  });

  it("gate de conteúdo segue vetando à noite — e agora chega a ser avaliado", async () => {
    // Antes do conserto, à noite o veto de horário vinha primeiro e o de
    // vocabulário interno nem era avaliado: quem testava via "fora da janela" e
    // não sabia que a resposta vazava termo do sistema.
    const p = previa("sandbox");
    const tools = applyPreviewPolicy(
      { send_message: definicao(vi.fn()) },
      p,
      contexto(NOITE),
      () => [],
    );
    await chamar(tools, "send_message", {
      body: "Registrei aqui com update_lead_state e save_lead_note, pode deixar.",
    });
    expect(p.result.candidates).toEqual([]);
    expect(p.result.impediments.map((i) => i.code)).toEqual(["internal_vocabulary_leak"]);
  });

  it("handoff e escrita no CRM seguem PROPOSTA à noite — nenhum executor roda", async () => {
    const handoff = vi.fn(),
      etapa = vi.fn(),
      enviar = vi.fn();
    const p = previa("sandbox");
    const tools = applyPreviewPolicy(
      {
        request_human_handoff: definicao(handoff),
        update_lead_state: definicao(etapa),
        send_message: definicao(enviar),
      },
      p,
      contexto(NOITE),
      () => [],
    );
    const r1 = await chamar(tools, "request_human_handoff", { reason: "pediu humano" });
    const r2 = await chamar(tools, "update_lead_state", { stage: "contacted" });
    await chamar(tools, "send_message", { body: RESPOSTA });

    expect(handoff).not.toHaveBeenCalled();
    expect(etapa).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
    expect(r1).toMatchObject({ ok: true, status: "proposal_only" });
    expect(r2).toMatchObject({ ok: true, status: "proposal_only" });
    expect(p.result.proposals.map((x) => x.tool)).toEqual([
      "request_human_handoff",
      "update_lead_state",
    ]);
    expect(p.result.restrictions).toContain("preview_no_client_effects");
  });
});
