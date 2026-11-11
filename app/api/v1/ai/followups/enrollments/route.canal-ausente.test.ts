/**
 * SEM NÚMERO CONECTADO, A INSCRIÇÃO NO FOLLOW-UP É UM ERRO TRATADO (#3923).
 *
 * ─── O defeito, como a issue o reproduziu ────────────────────────────────────
 *
 * Instalação fresca (`baseline.sql` + bootstrap-owner), nenhum canal de WhatsApp
 * pareado. Ao inscrever um contato num fluxo de follow-up, a rota devolvia
 * **500 sem corpo**. A causa não estava no banco: `fn_service_begin` levanta
 * `service_channel_not_found` (SQLSTATE `P0002`) de propósito — sem canal não há
 * onde abrir o atendimento, e a exceção é a resposta certa. Quem não tratava era
 * o caminho da inscrição: `beginServiceAtOrigin` faz `throw error`, e o `POST`
 * não convertia esse erro em resposta.
 *
 * ─── O que este arquivo mede, e por que na ROTA ──────────────────────────────
 *
 * `route.test.ts` dubla `enrollFollowupFlow`, então por lá o erro cru nem
 * existiria: o dublê nunca lança. Aqui o módulo de inscrição é o DE VERDADE,
 * com o cliente Supabase falso respondendo como o PostgREST responderia — a RPC
 * devolve `{ code: "P0002", message: "service_channel_not_found" }`. É o único
 * jeito de provar o que a issue mediu: o status e o CORPO da resposta HTTP.
 *
 * O contraste é o mesmo teste nos dois lados da correção:
 *
 *   antes  → 500, corpo vazio (`await res.text()` === "")
 *   depois → 4xx com `{ error: { code, message } }`
 *
 * O terceiro caso é o CONTROLE POSITIVO: com canal conectado a RPC devolve a
 * fronteira e a inscrição acontece — a correção não pode transformar sucesso em
 * erro.
 */
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.auth }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { flowGraphSchema } from "@/lib/followup/graph-schema";

import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "c0000000-0000-4000-8000-000000000001";
const CONVERSA = "c0000000-0000-4000-8000-0000000000c1";
const FLUXO = "f0000000-0000-4000-8000-0000000000aa";
const VERSAO = "f0000000-0000-4000-8000-0000000000vv";
const ATENDENTE = "33333333-3333-4333-8333-333333333333";

const GRAFO = flowGraphSchema.parse({
  nodes: [
    { id: "t1", type: "trigger", label: "t1", position: { x: 0, y: 0 }, config: {} },
    { id: "e1", type: "end", label: "e1", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
  ],
  edges: [{ id: "edge1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
});

type Linha = Record<string, unknown>;
type Resposta = { data: unknown; error: unknown };

/**
 * O Supabase falso. `rpc` é o que decide o caso: a RPC `fn_service_begin` é o
 * único lugar do fluxo que depende de existir canal pareado.
 */
function banco(erroDaRpc: { code: string; message: string } | null) {
  const tabelas: Record<string, Linha[]> = {
    contacts: [{ id: CONTATO, organization_id: ORG, carteira_user_id: null }],
    conversations: [{ id: CONVERSA, organization_id: ORG, contact_id: CONTATO, assigned_to_user_id: ATENDENTE }],
    followup_flow_pointers: [
      {
        id: FLUXO,
        organization_id: ORG,
        status: "active",
        active_version_id: VERSAO,
        surface: "relogio",
      },
    ],
    followup_flow_versions: [{ id: VERSAO, organization_id: ORG, graph: GRAFO }],
    ai_agent_versions: [],
    followup_enrollments: [],
  };

  return {
    rpc: async () =>
      erroDaRpc
        ? { data: null, error: erroDaRpc }
        : {
            data: {
              organization_id: ORG,
              contact_id: CONTATO,
              conversation_id: CONVERSA,
              service_revision: 1,
              demanda_id: null,
              demanda_revision: null,
              status: "open",
              demanda_fechada_em: null,
            },
            error: null,
          },
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      let modo: "select" | "insert" = "select";
      let payload: Linha | undefined;
      const linhas = () => (tabelas[tabela] ?? []).filter((l) => filtros.every(([k, v]) => l[k] === v));

      const cadeia = {
        select: () => cadeia,
        insert: (obj: Linha) => {
          modo = "insert";
          payload = obj;
          return cadeia;
        },
        eq: (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          return cadeia;
        },
        maybeSingle: async (): Promise<Resposta> => ({ data: linhas()[0] ?? null, error: null }),
        single: async (): Promise<Resposta> => {
          if (modo === "insert") {
            const criada = { id: "e-1", ...payload };
            (tabelas[tabela] ??= []).push(criada);
            return { data: criada, error: null };
          }
          return { data: linhas()[0] ?? null, error: null };
        },
        // O `ai_agent_versions` é lido como LISTA (o gate do follow-up agrega
        // agentes publicados), então a cadeia precisa ser `await`-ável.
        then: (ok: (v: Resposta) => unknown, falha: (e: unknown) => unknown) =>
          Promise.resolve({ data: linhas(), error: null }).then(ok, falha),
      };
      return cadeia;
    },
  };
}

let erroDaRpc: { code: string; message: string } | null = null;

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco(erroDaRpc) }));

function inscricao() {
  return new NextRequest("http://localhost/api/v1/ai/followups/enrollments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pointer_id: FLUXO, contact_id: CONTATO, conversation_id: CONVERSA }),
  });
}

beforeEach(() => {
  erroDaRpc = null;
  mocks.auth.mockResolvedValue({
    ok: true,
    user: { id: ATENDENTE, idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: "manager" },
  });
});

describe("#3923 — instalação sem número conectado", () => {
  it("⭐ a RPC recusa por falta de canal: a resposta é 4xx com o envelope, nunca 500 vazio", async () => {
    erroDaRpc = { code: "P0002", message: "service_channel_not_found" };

    const resposta = await POST(inscricao());
    const corpo = await resposta.text();

    // O corpo é o que a issue mediu: um 500 do Next sem handler sai VAZIO.
    expect(corpo).not.toBe("");
    // 409 — "conflito com o estado atual": o corpo do pedido está correto, quem
    // não está pronto é a instalação. 422 mandaria o cliente mexer no payload,
    // que é justamente o que não resolve (a rota já usa 422 para `validation_failed`).
    expect(resposta.status).toBe(409);

    const { error } = JSON.parse(corpo) as { error: { code: string; message: string } };
    expect(error.code).toBe("service_channel_not_found");
    expect(error.message).toMatch(/conecte um número/i);
  });

  it("CONTROLE POSITIVO: com canal conectado a inscrição continua nascendo (201)", async () => {
    // `erroDaRpc` nulo = a RPC devolveu a fronteira, como numa instalação com
    // número pareado. A correção não pode tocar neste caminho.
    const resposta = await POST(inscricao());

    expect(resposta.status).toBe(201);
    const { data } = (await resposta.json()) as { data: { id: string } };
    expect(data.id).toBe("e-1");
  });
});
