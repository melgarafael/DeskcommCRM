/**
 * O TETO DO SILÊNCIO: o fluxo só começa enquanto o silêncio for recente.
 *
 * Pedido de uma loja que vende pelo WhatsApp (27/09/2026): uma pergunta curta 10
 * minutos depois de o cliente parar de responder ("de que cidade você é?")
 * reanima a conversa — medido à mão por quem opera. Mas o gatilho de silêncio só
 * tinha MÍNIMO: ligado com 10 minutos, ele pegaria de uma vez todo contato calado
 * há horas ou dias, e mandaria "o que achou?" para quem sumiu na semana passada.
 *
 * Este arquivo prende:
 * - o contrato aceita `max_silence_minutes` (5 a 10080);
 * - a varredura passa o limite de baixo (`desdeIso`) só quando há teto MAIOR que o mínimo;
 * - a consulta de PRODUÇÃO descarta quem falou antes do limite, e mantém quem está na faixa.
 *
 * O que NÃO prova: o efeito no PostgREST (o espelho em SQL puro está no invariante
 * `tests/invariants/followup-silence-sweep.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";

import { triggerConfigSchema } from "@/lib/followup/api-schemas";
import { createSupabaseSilenceSweepDb, runSilenceSweep, type SilenceSweepDb } from "@/lib/followup/silence-sweep";

const AGORA = new Date("2026-09-27T15:00:00.000Z");
const MIN = 60_000;

describe("contrato do gatilho de silêncio", () => {
  const base = { kind: "silence", params: { threshold_minutes: 10 }, cancel_on_reply: true };
  it("aceita o teto e recusa o que sai da faixa", () => {
    expect(triggerConfigSchema.safeParse({ ...base, params: { threshold_minutes: 10, max_silence_minutes: 60 } }).success).toBe(true);
    expect(triggerConfigSchema.safeParse({ ...base, params: { threshold_minutes: 10, max_silence_minutes: 4 } }).success).toBe(false);
    expect(triggerConfigSchema.safeParse({ ...base, params: { threshold_minutes: 10, max_silence_minutes: 10_081 } }).success).toBe(false);
  });
});

describe("varredura de silêncio com teto", () => {
  function sweepDb(max?: number) {
    const loadSilentContactIds = vi.fn(async (_org: string, _corte: string, _seg: string[], _desde?: string) => [] as string[]);
    const db: SilenceSweepDb = {
      loadActiveSilencePointers: async () => [
        { id: "ptr", organization_id: "org", active_version_id: "v1", threshold_minutes: 10, segments: [], ...(max ? { max_silence_minutes: max } : {}) },
      ],
      loadSilentContactIds,
      loadContatosComRetornoVivo: async () => new Set<string>(),
      loadContatosComInscricaoViva: async () => new Set<string>(),
      loadContactIdsEmCooldown: async () => new Set<string>(),
      loadEncerramentosDoFluxo: async () => new Map(),
      loadContatosComPessoaNoComando: async () => new Set<string>(),
      loadTriggerNode: async () => ({ id: "inicio", pedeAgente: false }),
      insertEnrollment: async () => ({ inserted: true }),
    };
    return { db, loadSilentContactIds };
  }
  const gateDb = { loadEnabledPublishedFollowupAgents: async () => [] };

  it("⭐ com teto, pede só quem falou depois de (agora − teto)", async () => {
    const { db, loadSilentContactIds } = sweepDb(60);
    await runSilenceSweep({ db, gateDb, clock: () => AGORA });
    expect(loadSilentContactIds).toHaveBeenCalledWith(
      "org",
      new Date(AGORA.getTime() - 10 * MIN).toISOString(),
      [],
      new Date(AGORA.getTime() - 60 * MIN).toISOString(),
    );
  });

  it("controle: sem teto, a leitura é a de sempre", async () => {
    const { db, loadSilentContactIds } = sweepDb();
    await runSilenceSweep({ db, gateDb, clock: () => AGORA });
    expect(loadSilentContactIds.mock.calls[0]?.[3]).toBeUndefined();
  });
});

/** Registra a cadeia do PostgREST; cada `await` devolve a próxima resposta da fila. */
function fakeSupabase(respostas: unknown[][]) {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: respostas.shift() ?? [], error: null });
        return () => proxy;
      },
    },
  ) as Record<string, unknown>;
  return { from: () => proxy } as never;
}

describe("createSupabaseSilenceSweepDb — a consulta de PRODUÇÃO", () => {
  const conversa = (contato: string, falouEm: string) => ({
    id: `conv-${contato}`,
    service_revision: 1,
    current_demanda_id: null,
    demandas: null,
    status: "open",
    contact_id: contato,
    last_inbound_at: falouEm,
    assignee_kind: null,
    bot_silenced_until: null,
    messages: [
      { organization_id: "org", contact_id: contato, conversation_id: `conv-${contato}`, service_revision: 1, demanda_id: null, demanda_revision: null, sent_at: falouEm },
    ],
    contacts: { tags: [], is_blocked: false, ai_authorized_at: null, phone_number: null, force_human: false },
    sessao: { metadata: { ai_gate_mode: "open" } },
    organizations: { status: "active" },
  });

  it("⭐ quem falou antes do teto fica de fora; quem está na faixa entra", async () => {
    const client = fakeSupabase([
      [
        conversa("na-faixa", new Date(AGORA.getTime() - 20 * MIN).toISOString()),
        conversa("antigo", new Date(AGORA.getTime() - 3 * 60 * MIN).toISOString()),
        conversa("recente-demais", new Date(AGORA.getTime() - 5 * MIN).toISOString()),
      ],
    ]);
    const ids = await createSupabaseSilenceSweepDb(client).loadSilentContactIds(
      "org",
      new Date(AGORA.getTime() - 10 * MIN).toISOString(),
      [],
      new Date(AGORA.getTime() - 60 * MIN).toISOString(),
    );
    expect(ids).toEqual(["na-faixa"]);
  });

  it("controle: sem teto, o antigo também entra", async () => {
    const client = fakeSupabase([
      [
        conversa("na-faixa", new Date(AGORA.getTime() - 20 * MIN).toISOString()),
        conversa("antigo", new Date(AGORA.getTime() - 3 * 60 * MIN).toISOString()),
      ],
    ]);
    const ids = await createSupabaseSilenceSweepDb(client).loadSilentContactIds(
      "org",
      new Date(AGORA.getTime() - 10 * MIN).toISOString(),
      [],
    );
    expect(ids.sort()).toEqual(["antigo", "na-faixa"]);
  });
});
