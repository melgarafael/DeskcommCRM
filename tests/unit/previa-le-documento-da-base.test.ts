// @vitest-environment node
/**
 * O TESTAR LÊ A BASE EM LEITURA DIRETA COMO A PRODUÇÃO LÊ (#4572).
 *
 * No modo `leitura_direta` (#4133) o agente lê o material inteiro pelo id com
 * `ler_documento`. A política da prévia só deixava passar inteiras as leituras
 * da lista `nativeRead`, e essa ferramenta não estava lá nem no catálogo: caía
 * no fim e voltava `unknown_preview_tool`. O Testar dizia "preciso verificar"
 * sobre o que o WhatsApp real lia e respondia, e quem afinava o agente pela
 * prévia media outro sistema.
 *
 * O que se prende: nos dois tipos de prévia, a chamada chega na leitura
 * ORIGINAL com os mesmos argumentos, o retorno dela volta ao modelo, e nenhum
 * impedimento aparece. O controle é uma escrita (`save_lead_note`), que segue
 * virando proposta sem executar: liberar a leitura não abriu a porta da escrita.
 */
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import type { ToolSet } from "ai";

import { applyPreviewPolicy, newPreviewResult, scenarioContext, type TurnPreview } from "@/lib/agent-engine/agent/preview";
import type { GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels";

const ORG = "a4572000-0000-4000-8000-000000000001";
const CONTATO = "a4572000-0000-4000-8000-000000000002";

function gate(): GateContext {
  return { now: new Date("2026-11-13T15:00:00Z"), body: "", optedOut: false,
    provider: DEFAULT_CHANNEL_PROVIDER, messagingWindow: { lastInboundAt: new Date("2026-11-13T14:00:00Z") },
    pacing: { knobs: PACING_DEFAULTS, state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null }, crmDailyLimit: null },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] }, promise: { table: null },
    semanticPromise: null, disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null, casesEnabled: false, hasOpenCase: false, openedCaseThisTurn: false };
}

function previa(kind: TurnPreview["kind"]): TurnPreview {
  return { kind, organizationId: ORG, runId: CONTATO, agent: {}, context: scenarioContext([]),
    contactId: kind === "assisted" ? CONTATO : null, channelId: null, result: newPreviewResult() } as TurnPreview;
}

const OPCOES = { toolCallId: "controle", messages: [], context: undefined };

describe("Testar no modo leitura_direta", () => {
  it.each(["sandbox", "assisted"] as const)("%s: ler_documento executa a leitura original", async (kind) => {
    const documento = { ok: true, source_id: "doc-1", titulo: "Formas de pagamento", texto: "Pix e cartão em até 3x." };
    const ler = vi.fn(async (_args: unknown) => documento);
    const p = previa(kind);
    const tools = applyPreviewPolicy({ ler_documento: { execute: ler } } as unknown as ToolSet, p, gate(), () => []);

    const out = await tools.ler_documento!.execute!({ source_id: "doc-1" }, OPCOES);

    expect(ler).toHaveBeenCalledTimes(1);
    expect(ler.mock.calls[0]![0]).toEqual({ source_id: "doc-1" });
    expect(out).toEqual(documento);
    expect(p.result.impediments).toEqual([]);
    expect(p.result.proposals).toEqual([]);
  });

  it("controle: uma escrita continua virando proposta, sem executar", async () => {
    const gravar = vi.fn(async () => ({ ok: true }));
    const p = previa("sandbox");
    const tools = applyPreviewPolicy({ save_lead_note: { execute: gravar } } as unknown as ToolSet, p, gate(), () => []);

    const out = await tools.save_lead_note!.execute!({ note: "x" }, OPCOES);

    expect(gravar).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, status: "proposal_only" });
    expect(p.result.proposals).toEqual([{ tool: "save_lead_note", arguments: { note: "x" } }]);
  });
});
