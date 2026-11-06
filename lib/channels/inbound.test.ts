/**
 * AVISO DE STATUS DO MODELO NA CENTRAL — canal oficial direto (fatia 3 do #3635).
 *
 * ─── O que estava invisível ────────────────────────────────────────────────
 *
 * A Meta decide o destino de uma definição DEPOIS da criação: aprova, reprova,
 * pausa, desativa. O espelho (`meta_templates.status`) era atualizado em
 * silêncio e ninguém abria a tela de modelos por acaso — a descoberta acontecia
 * no disparo que não saiu, com a campanha montada e o cliente esperando. O canal
 * de parceiro já avisava na Central (`lib/channels/zernio/avisos.ts`); este
 * arquivo prova que o canal oficial direto passou a avisar pelo MESMO caminho.
 *
 * ─── As seis coisas que este arquivo prova ─────────────────────────────────
 *
 *   1. APPROVED atualiza o espelho E abre UM aviso com o nome do modelo e a
 *      conexão certa (`ref_kind='channel_session'` + `ref_id` da sessão);
 *   2. REJECTED leva o motivo LEGÍVEL — o código cru da Meta não vaza;
 *   3. duas entregas idênticas abrem UM aviso (a Meta re-entrega webhook);
 *   4. evento de outra conexão da mesma organização não abre aviso na errada;
 *   5. evento desconhecido não abre aviso e não vira erro (2xx, outcomes);
 *   6. falha ao abrir o aviso não derruba o espelho nem devolve 5xx (o evento
 *      seria re-entregue para sempre — auto-DDoS).
 *
 * A prova é webhook SINTÉTICO: não houve chamada à Meta real, e o desenho trata
 * `reason` ausente com texto genérico porque não se sabe se a Meta entrega
 * motivo em todos os eventos.
 */
import { createHmac } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  /** `channel_sessions` falsas: id → refs que `graphPartnerRefsDaSessao` devolve. */
  sessoes: {} as Record<string, { phoneNumberId: string | null; wabaId: string | null }>,
  /** Updates em `meta_templates`, com os filtros aplicados. */
  espelhos: [] as Array<{ payload: Record<string, unknown>; filtros: Array<[string, unknown]> }>,
  /** Linhas que existiriam em `agent_inbox_items`. */
  avisos: [] as Array<Record<string, unknown>>,
  /** Quando true, todo insert de aviso falha — a prova do critério 6. */
  falharAviso: false,
  /** Quando true, o update do espelho devolve erro. */
  falharEspelho: false,
  /** Quantas tentativas de INSERT chegaram ao banco (para provar o dedupe). */
  inserts: 0,
}));

vi.mock("@/lib/channels/graph-parceiro/session", () => ({
  graphPartnerRefsDaSessao: async (_admin: unknown, _org: string, sessionId: string) =>
    estado.sessoes[sessionId] ?? { phoneNumberId: null, wabaId: null },
}));

/**
 * Admin de mentira com o MÍNIMO que o ramo `template_status` toca. Qualquer
 * outra tabela explode: é assim que "o aviso mora na mesma Central" é provado,
 * e não declarado.
 */
function adminFalso(): SupabaseClient {
  const from = (tabela: string) => {
    if (tabela === "meta_templates") {
      return {
        update: (payload: Record<string, unknown>) => {
          const registro = { payload, filtros: [] as Array<[string, unknown]> };
          estado.espelhos.push(registro);
          const cadeia: Record<string, unknown> = {
            eq: (coluna: string, valor: unknown) => {
              registro.filtros.push([coluna, valor]);
              return cadeia;
            },
            then: (resolver: (v: unknown) => unknown) =>
              resolver({ error: estado.falharEspelho ? { message: "indisponivel" } : null }),
          };
          return cadeia;
        },
      };
    }

    if (tabela === "agent_inbox_items") {
      const filtros: Array<[string, unknown]> = [];
      const cadeia: Record<string, unknown> = {
        select: () => cadeia,
        eq: (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          return cadeia;
        },
        limit: () => cadeia,
        maybeSingle: async () => ({
          data:
            estado.avisos.find((a) => filtros.every(([coluna, valor]) => a[coluna] === valor)) ?? null,
          error: null,
        }),
        insert: async (payload: Record<string, unknown>) => {
          estado.inserts += 1;
          if (estado.falharAviso) return { error: { code: "08006", message: "banco fora" } };
          const repetido = estado.avisos.find(
            (a) =>
              a.status === "open" &&
              a.organization_id === payload.organization_id &&
              a.kind === payload.kind &&
              a.ref_kind === payload.ref_kind &&
              a.ref_id === payload.ref_id &&
              a.title === payload.title,
          );
          if (repetido) return { error: { code: "23505", message: "duplicate key" } };
          estado.avisos.push({ ...payload, status: "open" });
          return { error: null };
        },
      };
      return cadeia;
    }

    throw new Error(`tabela inesperada no teste: ${tabela}`);
  };

  return { from } as unknown as SupabaseClient;
}

const SEGREDO = "whsec_segredo_do_painel_123";
const TS = "1700000000";

function headersAssinados(corpo: string): Headers {
  return new Headers({
    "x-datafy-signature-256": `sha256=${createHmac("sha256", SEGREDO)
      .update(`${TS}.${corpo}`)
      .digest("hex")}`,
    "x-datafy-timestamp": TS,
  });
}

function envelopeDoModelo(input: {
  nome: string;
  evento: string;
  motivo?: string | null;
  wabaId?: string;
  idioma?: string;
}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: input.wabaId ?? "waba-A",
        changes: [
          {
            field: "message_template_status_update",
            value: {
              event: input.evento,
              message_template_name: input.nome,
              message_template_language: input.idioma ?? "pt_BR",
              ...(input.motivo ? { reason: input.motivo } : {}),
            },
          },
        ],
      },
    ],
  };
}

async function entregar(
  input: Parameters<typeof envelopeDoModelo>[0],
  sessao: { id: string; organizationId?: string; displayName?: string } = { id: "sess-A" },
) {
  const { handleInboundWebhook } = await import("@/lib/channels/inbound");
  const { CHANNEL_PROVIDER_DATAFY } = await import("@/lib/channels/capabilities");
  const corpo = JSON.stringify(envelopeDoModelo(input));
  const resposta = await handleInboundWebhook(adminFalso(), {
    session: {
      id: sessao.id,
      organization_id: sessao.organizationId ?? "org-1",
      provider: CHANNEL_PROVIDER_DATAFY,
      display_name: sessao.displayName ?? `Conexão ${sessao.id}`,
      phone_number: "5511999999999",
    },
    rawBody: corpo,
    headers: headersAssinados(corpo),
    secret: SEGREDO,
  });
  return resposta;
}

beforeEach(() => {
  estado.sessoes = {
    "sess-A": { phoneNumberId: "phone-A", wabaId: "waba-A" },
    "sess-B": { phoneNumberId: "phone-B", wabaId: "waba-B" },
  };
  estado.espelhos = [];
  estado.avisos = [];
  estado.falharAviso = false;
  estado.falharEspelho = false;
  estado.inserts = 0;
  vi.stubEnv("DATAFY_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("template_status no canal oficial direto — espelho e aviso", () => {
  it("APPROVED atualiza o espelho e abre UM aviso com o modelo e a conexão certos", async () => {
    const r = await entregar({ nome: "boas_vindas", evento: "APPROVED" });

    expect(r).toEqual({ ok: true, body: { received: 1, outcomes: ["modelo"] } });

    // O espelho continua sendo atualizado como antes.
    expect(estado.espelhos).toHaveLength(1);
    expect(estado.espelhos[0]!.payload).toMatchObject({ status: "APPROVED" });
    expect(estado.espelhos[0]!.filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", "org-1"],
        ["channel_session_id", "sess-A"],
        ["name", "boas_vindas"],
        ["language", "pt_BR"],
      ]),
    );

    // E agora o operador fica sabendo, na MESMA Central do canal de parceiro.
    expect(estado.avisos).toHaveLength(1);
    const aviso = estado.avisos[0]!;
    expect(aviso).toMatchObject({
      organization_id: "org-1",
      kind: "channel_template_review_direct",
      severity: "info",
      ref_kind: "channel_session",
      ref_id: "sess-A",
    });
    expect(String(aviso.title)).toContain("boas_vindas");
    expect(String(aviso.title)).toContain("pt_BR");
    expect(String(aviso.body)).toContain("aprovado");
    expect(String(aviso.body)).toContain("Conexão sess-A");
    expect(String(aviso.body)).toContain("/app/connections?aba=oficial&sub=templates");
  });

  it("REJECTED traz o motivo legível e NUNCA o código cru da Meta", async () => {
    const r = await entregar({
      nome: "promo_janeiro",
      evento: "REJECTED",
      motivo: "INCORRECT_CATEGORY",
    });

    expect(r).toEqual({ ok: true, body: { received: 1, outcomes: ["modelo"] } });
    expect(estado.avisos).toHaveLength(1);
    const aviso = estado.avisos[0]!;
    expect(aviso.severity).toBe("critical");
    expect(String(aviso.body)).toContain("reprovado");
    expect(String(aviso.body)).toContain("categoria");
    expect(String(aviso.body)).not.toContain("INCORRECT_CATEGORY");
  });

  it("duas entregas idênticas abrem UM aviso (a Meta re-entrega webhook)", async () => {
    const entrada = { nome: "reengajamento", evento: "PAUSED", motivo: "NONE" } as const;

    await entregar(entrada);
    await entregar(entrada);

    // 1º abre; 2º encontra o aberto pela chave (kind, ref e título) e não insere.
    expect(estado.avisos).toHaveLength(1);
    expect(estado.inserts).toBe(1);
    expect(estado.espelhos).toHaveLength(2);
  });

  it("evento de OUTRA conexão da mesma organização não abre aviso na conexão errada", async () => {
    // Entrega endereçada à sessão A, mas carimbada com a conta da sessão B.
    const alheio = await entregar({ nome: "cardapio", evento: "APPROVED", wabaId: "waba-B" });
    expect(alheio).toEqual({ ok: true, body: { received: 1, outcomes: ["outra_conta"] } });
    expect(estado.avisos).toHaveLength(0);
    expect(estado.espelhos).toHaveLength(0);

    // Na conexão dona do evento, o aviso nasce — e aponta para ELA.
    const proprio = await entregar(
      { nome: "cardapio", evento: "APPROVED", wabaId: "waba-B" },
      { id: "sess-B" },
    );
    expect(proprio).toEqual({ ok: true, body: { received: 1, outcomes: ["modelo"] } });
    expect(estado.avisos).toHaveLength(1);
    expect(estado.avisos[0]).toMatchObject({ ref_kind: "channel_session", ref_id: "sess-B" });
    expect(estado.avisos.some((a) => a.ref_id === "sess-A")).toBe(false);
  });

  it("evento desconhecido é IGNORADO: nenhum aviso, nenhum erro, outcomes preservados", async () => {
    const r = await entregar({ nome: "novo_modelo", evento: "EM_ANALISE" });

    expect(r).toEqual({ ok: true, body: { received: 1, outcomes: ["modelo"] } });
    expect(estado.avisos).toHaveLength(0);
    expect(estado.inserts).toBe(0);
  });

  it("falha ao abrir o aviso não derruba o espelho nem devolve 5xx", async () => {
    estado.falharAviso = true;

    const r = await entregar({ nome: "cobranca", evento: "APPROVED" });

    // 2xx: a Meta não pode re-entregar para sempre por um aviso que falhou.
    expect(r).toEqual({ ok: true, body: { received: 1, outcomes: ["modelo"] } });
    // O espelho foi atualizado ANTES do aviso e sobreviveu à falha dele.
    expect(estado.espelhos).toHaveLength(1);
    expect(estado.avisos).toHaveLength(0);
  });
});
