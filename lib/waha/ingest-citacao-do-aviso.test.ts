import { beforeEach, describe, expect, it, vi } from "vitest";

// Mesma montagem de `ingest-numero-interno-de-aviso.test.ts`: o mock de audit
// corta a cadeia de env. A confirmação ao WhatsApp é importada tarde por
// `resposta-whatsapp-ao-caso.ts`; os dois dublês abaixo a deixam muda.
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/escalacao/aviso-ao-suporte.handler", () => ({
  criarTransporteDoAviso: async () => ({
    configurado: async () => true,
    resolveDestino: async () => ({ to: "5519999999999@c.us" }),
    envia: async () => ({ externalId: "confirmacao" }),
  }),
}));
vi.mock("@/lib/agent-engine/pacing/ledger-supabase", () => ({
  criarPacingDoCanal: async () => ({
    decide: async () => ({ liberado: true }),
    registraEnvio: async () => undefined,
  }),
}));

import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";
import { limparCacheDoNumeroInterno } from "@/lib/escalacao/numero-interno-de-aviso";

/**
 * A RESPOSTA QUE CITA O AVISO DE CASO, PELO CAMINHO DE PRODUÇÃO (#5257, #5288).
 *
 * Os testes de `resposta-whatsapp-ao-caso` entregam a citação já pronta. Este
 * entra por `dispatchWahaEvent` com o payload do WAHA, porque o que pode quebrar
 * aqui é a LIGAÇÃO: o `replyTo.id` precisa virar os candidatos de
 * `wahaEchoExternalIds` e chegar à busca em `entregas_de_aviso_de_caso`. Trocar
 * a citação por `null` em `handleInbound` deixava todos os outros verdes.
 */

const ORG = "org-1";
const SESSAO = "sessao-1";
const CASO = "02920000-5555-4000-8000-000000000001";
const NUMERO_DO_AVISO = "+5519999999999";
const CHAT_DO_AVISO = "5519999999999@c.us";
/** O id que o envio do aviso devolveu e a entrega gravou (o bare do NOWEB). */
const ID_DO_AVISO = "3EB0A1B2C3D4E5F6A7B8C9";

interface Duplo {
  admin: unknown;
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
  /** Os candidatos que a busca da entrega recebeu em `.in("external_id", …)`. */
  buscas: unknown[][];
}

function banco(): Duplo {
  const rpcs: Duplo["rpcs"] = [];
  const buscas: unknown[][] = [];

  const consulta = (tabela: string) => {
    let casou = false;
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      is: () => q,
      neq: () => q,
      gte: () => q,
      order: () => q,
      limit: () => q,
      in: (coluna: string, valores: unknown[]) => {
        if (tabela === "entregas_de_aviso_de_caso" && coluna === "external_id") {
          buscas.push(valores);
          casou = valores.includes(ID_DO_AVISO);
        }
        return q;
      },
      maybeSingle: async () => {
        if (tabela === "config_aviso_de_caso") {
          return {
            data: {
              telefone_destino: NUMERO_DO_AVISO,
              destino_jid: null,
              resposta_whatsapp_habilitada: true,
              channel_session_id: SESSAO,
            },
            error: null,
          };
        }
        if (tabela === "entregas_de_aviso_de_caso" && casou) {
          return { data: { case_id: CASO, update_event_id: null }, error: null };
        }
        return { data: null, error: null };
      },
      then: (ok: (v: unknown) => unknown) => Promise.resolve(ok({ data: [], error: null })),
    };
    return q;
  };

  const admin = {
    from(tabela: string) {
      const q = consulta(tabela);
      return {
        ...q,
        insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "x" }, error: null }) }) }),
        update: () => q,
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === "fn_responder_caso_por_whatsapp") return { data: "accepted", error: null };
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
  };
  return { admin, rpcs, buscas };
}

const sessao = { id: SESSAO, organization_id: ORG };
const envelope = (payload: WahaPayload): WahaEnvelope => ({ event: "message", session: "default", payload });
const respostas = (rpcs: Duplo["rpcs"]) => rpcs.filter((c) => c.fn === "fn_responder_caso_por_whatsapp");

function resposta(replyToId: string | null, extra: Partial<WahaPayload> = {}): WahaPayload {
  return {
    id: `false_${CHAT_DO_AVISO}_3EB0RESPOSTA000000001`,
    from: CHAT_DO_AVISO,
    fromMe: false,
    body: "Pode vir amanhã às 15h",
    timestamp: 1_760_000_000,
    ...(replyToId ? { replyTo: { id: replyToId, body: "🔔 Acme: novo caso esperando você" } } : {}),
    ...extra,
  } as WahaPayload;
}

beforeEach(() => limparCacheDoNumeroInterno());

describe("resposta citando o aviso de caso, entrando pelo webhook do WAHA", () => {
  it("o id citado chega à busca da entrega e a resposta vai para o caso do aviso", async () => {
    const { admin, rpcs, buscas } = banco();
    await dispatchWahaEvent(admin as never, sessao as never, envelope(resposta(ID_DO_AVISO)), "req-1");

    expect(buscas).toHaveLength(1);
    expect(buscas[0]).toContain(ID_DO_AVISO);
    expect(respostas(rpcs)).toHaveLength(1);
    expect(respostas(rpcs)[0]?.args).toMatchObject({
      p_org: ORG,
      p_case: CASO,
      p_session: SESSAO,
      p_action: "resolved",
      p_body: "Pode vir amanhã às 15h",
    });
    expect(rpcs.some((c) => c.fn === "fn_upsert_wa_contact"), "a resposta da equipe não vira cliente").toBe(false);
  });

  it("o id citado no formato composto (`true_<chat>_<bare>`) também acha a entrega gravada com o bare", async () => {
    const { admin, rpcs, buscas } = banco();
    const composto = `true_${CHAT_DO_AVISO}_${ID_DO_AVISO}`;
    await dispatchWahaEvent(admin as never, sessao as never, envelope(resposta(composto)), "req-1");

    expect(buscas[0]).toEqual(expect.arrayContaining([composto, ID_DO_AVISO]));
    expect(respostas(rpcs)[0]?.args).toMatchObject({ p_case: CASO });
  });

  it("CONTROLE: a mesma mensagem SEM citação não responde caso nenhum", async () => {
    const { admin, rpcs, buscas } = banco();
    await dispatchWahaEvent(admin as never, sessao as never, envelope(resposta(null)), "req-1");

    expect(buscas).toHaveLength(0);
    expect(respostas(rpcs)).toHaveLength(0);
  });

  it("o eco do celular (`fromMe`) não procura entrega, mesmo citando o aviso", async () => {
    const { admin, rpcs, buscas } = banco();
    const eco = resposta(ID_DO_AVISO, { fromMe: true, id: `true_${CHAT_DO_AVISO}_3EB0ECO0000000000001`, to: CHAT_DO_AVISO });
    await dispatchWahaEvent(admin as never, sessao as never, envelope(eco), "req-1");

    expect(buscas).toHaveLength(0);
    expect(respostas(rpcs)).toHaveLength(0);
  });

  it("mensagem de grupo não procura entrega, mesmo citando o aviso", async () => {
    const { admin, rpcs, buscas } = banco();
    const grupo = resposta(ID_DO_AVISO, {
      from: "120363000000000000@g.us",
      id: "false_120363000000000000@g.us_3EB0GRUPO00000000001",
      participant: CHAT_DO_AVISO,
    } as Partial<WahaPayload>);
    await dispatchWahaEvent(admin as never, sessao as never, envelope(grupo), "req-1");

    expect(buscas).toHaveLength(0);
    expect(respostas(rpcs)).toHaveLength(0);
  });
});
