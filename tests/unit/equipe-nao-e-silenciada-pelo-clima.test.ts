/**
 * #3534 — O CONTATO DA EQUIPE NÃO É SILENCIADO PELO CLIMA, E O TURNO CONTINUA
 * ATENDENDO.
 *
 * O medidor de clima é o começo da cadeia:
 *
 *   `ai-sentiment-worker` → `ai.sentiment_alert`
 *     → `ai-handoff-from-sentiment.handler` → `triggerHandoff('low_sentiment')`
 *       → `conversations.status='pending'`, `bot_silenced_until='infinity'`.
 *
 * O primeiro elo está preso em `tests/unit/equipe-nao-passa-por-clima.test.ts`
 * (o alerta não sai). Este arquivo prende os outros dois, porque um alerta
 * antigo na fila, o Jev ou outra origem ainda podem chamar o handoff:
 *
 *   1. `triggerHandoff` recusa `low_sentiment` para contato da equipe — e a
 *      conversa NÃO é tocada (nem status, nem silêncio, nem aviso ao lead);
 *   2. o CONTROLE: o mesmo `low_sentiment`, num contato sem a etiqueta, segue
 *      passando e silenciando como hoje;
 *   3. o turno continua atendendo: `decidirElegibilidade` devolve
 *      `contato_da_equipe` (autorização positiva) — inclusive em canal
 *      `allowlist` sem autorização, onde o cliente comum é barrado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { decidirElegibilidade, type EstadoDeElegibilidade } from "@/lib/ai/elegibilidade/gate";
import { ehContatoDaEquipe } from "@/lib/contacts/tags-da-equipe";

const CONV = "44444444-4444-4444-8444-444444444444";
const ORG = "22222222-2222-4222-8222-222222222222";
const CONTACT = "66666666-6666-4666-8666-666666666666";

const avisarLeadDoCrm = vi.fn(async (..._a: unknown[]) => ({ avisado: true }));
const decidir = vi.fn();

vi.mock("@/lib/ai/handoff/aviso-ao-lead", () => ({
  avisarLeadDoCrm: (...a: unknown[]) => avisarLeadDoCrm(...a),
}));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: (...a: unknown[]) => decidir(...a),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const updates: Array<Record<string, unknown>> = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      update: (p: Record<string, unknown>) => {
        updates.push(p);
        return chain;
      },
      insert: () => chain,
      eq: () => chain,
      maybeSingle: () =>
        Promise.resolve({
          data: {
            id: CONV,
            organization_id: ORG,
            contact_id: CONTACT,
            last_handoff_at: null,
            last_handoff_reason: null,
          },
          error: null,
        }),
      then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r),
    };
    return {
      from: () => chain,
      rpc: () => Promise.resolve({ error: null }),
      channel: () => ({ send: () => Promise.resolve(), subscribe: () => ({}) }),
    };
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: () => false }));

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";

/** Estado base: canal `allowlist` SEM autorização — o caso em que o cliente
 *  comum é barrado e o contato da equipe, não. */
function estado(extra: Partial<EstadoDeElegibilidade> = {}): EstadoDeElegibilidade {
  return {
    orgStatus: "active",
    canalDesativado: false,
    modo: "allowlist",
    forceHuman: false,
    contatoInterno: false,
    contatoDaEquipe: false,
    aiOptOut: false,
    botSilencedUntil: null,
    assigneeKind: "ai",
    aiAuthorizedAt: null,
    preGoLiveAtivo: false,
    numeroDeTesteAutorizado: false,
    agora: new Date("2026-10-20T12:00:00Z"),
    ttlMs: 21 * 24 * 60 * 60 * 1000,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
});

describe("#3534 · contato da equipe não é passado nem silenciado pelo clima", () => {
  it("triggerHandoff('low_sentiment') para contato da equipe → NÃO dispara e NÃO toca a conversa", async () => {
    decidir.mockResolvedValue({
      permite: true,
      motivo: "contato_da_equipe",
      bloqueioPorAllowlist: false,
      contatoDaEquipe: true,
    });

    const r = await triggerHandoff({
      conversationId: CONV,
      organizationId: ORG,
      reason: "low_sentiment",
      origem: "sentimento",
    });

    expect(r.triggered).toBe(false);
    expect(r.reason).toBe("contato_da_equipe:sem_repasse_por_clima");
    // O dano que dói mais: nada de `bot_silenced_until='infinity'`, nada de
    // status pendente e nenhum "já acionei o time" para quem É o time.
    expect(updates, "a conversa da equipe foi silenciada/mexida").toHaveLength(0);
    expect(avisarLeadDoCrm).not.toHaveBeenCalled();
  });

  it("CONTROLE: o mesmo motivo, num contato fora da lista, segue passando e silenciando", async () => {
    decidir.mockResolvedValue({
      permite: true,
      motivo: "gate_aberto",
      bloqueioPorAllowlist: false,
      contatoDaEquipe: false,
    });

    const r = await triggerHandoff({
      conversationId: CONV,
      organizationId: ORG,
      reason: "low_sentiment",
      origem: "sentimento",
    });

    expect(r.triggered).toBe(true);
    const daConversa = updates.find((u) => "bot_silenced_until" in u);
    expect(daConversa, "o cliente irritado deixou de ser passado/silenciado").toMatchObject({
      status: "pending",
      bot_silenced_until: "infinity",
      last_handoff_reason: "low_sentiment",
    });
  });

  it("outros motivos (não o clima) seguem o caminho de sempre para o contato da equipe", async () => {
    decidir.mockResolvedValue({
      permite: true,
      motivo: "contato_da_equipe",
      bloqueioPorAllowlist: false,
      contatoDaEquipe: true,
    });

    const r = await triggerHandoff({
      conversationId: CONV,
      organizationId: ORG,
      reason: "requested_human",
      origem: "legado_pedido",
    });

    expect(r.triggered).toBe(true);
  });

  it("TURNO: contato da equipe é atendido em canal allowlist, onde o cliente comum é barrado", () => {
    const daEquipe = decidirElegibilidade(estado({ contatoDaEquipe: true }));
    expect(daEquipe).toMatchObject({ permite: true, motivo: "contato_da_equipe" });

    const cliente = decidirElegibilidade(estado());
    expect(cliente).toMatchObject({ permite: false, motivo: "sem_autorizacao" });
  });

  it("TURNO: os vetos duros continuam vencendo a equipe (ninguém atropela uma pessoa)", () => {
    for (const extra of [
      { botSilencedUntil: Number.POSITIVE_INFINITY },
      { assigneeKind: "user" },
      { forceHuman: true },
      { aiOptOut: true },
      { canalDesativado: true },
      { orgStatus: "suspended" },
    ] satisfies Array<Partial<EstadoDeElegibilidade>>) {
      expect(decidirElegibilidade(estado({ contatoDaEquipe: true, ...extra })).permite).toBe(false);
    }
  });
});

describe("#3534 · a régua da equipe", () => {
  it("normaliza os dois lados como a lista interna", () => {
    expect(ehContatoDaEquipe(["Socio"], ["socio"])).toBe(true);
    expect(ehContatoDaEquipe([" sócio "], ["sócio"])).toBe(true);
    expect(ehContatoDaEquipe(["cliente"], ["socio"])).toBe(false);
    expect(ehContatoDaEquipe(null, ["socio"])).toBe(false);
    expect(ehContatoDaEquipe(["socio"], [])).toBe(false);
    expect(ehContatoDaEquipe(["socio"], null)).toBe(false);
  });
});
