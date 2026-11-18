import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type pg from "pg";

import { loadPublishedAgentConfigById, type PublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import { agenteDaCampanhaDaConversa } from "@/lib/agent-engine/agent/agente-da-campanha";
import { loadActiveRouter, type LoadedRouter } from "@/lib/agent-engine/agent/router-config";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

// A rota inteira depende de cinco portas externas. Todas dubladas: o que se
// mede aqui é a DECISÃO da rota (autoriza → valida → lê visível → age), não o
// banco nem o Supabase.
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/agent/router-config", () => ({ loadActiveRouter: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/agente-da-campanha", () => ({ agenteDaCampanhaDaConversa: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({ loadPublishedAgentConfigById: vi.fn() }));

/**
 * POST /api/v1/conversations/[id]/transferir-agente — a passagem EXPLÍCITA de
 * um agente de IA para outro (#3770).
 *
 * O que este arquivo mede:
 *  - 403: sem permissão de escrita (viewer), NADA é lido e NADA é escrito — a
 *    primeira coisa que a rota faz é autorizar, antes até de validar o id;
 *  - o motivo não vem do corpo: a rota grava `pedido_do_operador`;
 *  - 200: com permissão, o sticky da conversa vira o agente de destino e a
 *    linha de `ai_router_decisions` nasce com `transferred` + `origem = 'acao'`;
 *  - 404/422/409 das recusas da ação (inclusive número sem roteador), sem
 *    escrita quando recusa.
 *
 * O que NÃO mede: o banco real (o statement atômico é provado pelo próprio SQL,
 * em `lib/agent-engine/agent/transferir-agente.test.ts`) e a policy de RLS — o
 * cliente da sessão é dublado aqui.
 */

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "aaaaaaaa-3333-4000-8000-000000000003";
const CONVERSA = "aaaaaaaa-1111-4000-8000-000000000001";
const SESSAO = "aaaaaaaa-8888-4000-8000-000000000001";
const AGENTE_ANTERIOR = "aaaaaaaa-2222-4000-8000-000000000001";
const AGENTE_DESTINO = "aaaaaaaa-2222-4000-8000-000000000002";
const ROUTER = "aaaaaaaa-4444-4000-8000-000000000001";

const authzOk = {
  ok: true as const,
  user: { id: USER, idioma: "pt-BR" },
  org: { orgId: ORG },
};

function clienteDeSessao(conversaVisivel: boolean) {
  const filtros: Array<[string, unknown]> = [];
  const builder = {
    select: () => builder,
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return builder;
    },
    maybeSingle: async () => ({
      data: conversaVisivel ? { id: CONVERSA } : null,
      error: null,
    }),
  };
  return {
    client: { from: () => builder },
    filtros,
  };
}

interface Escrita {
  sql: string;
  params: unknown[];
}

function poolFake(opcoes: {
  conversa?: { channel_session_id: string | null; active_ai_agent_id: string | null } | null;
  destinoPublicado?: boolean;
  roteador?: LoadedRouter | null;
} = {}) {
  const conversa =
    opcoes.conversa === undefined
      ? { channel_session_id: SESSAO, active_ai_agent_id: AGENTE_ANTERIOR }
      : opcoes.conversa;
  const roteador =
    opcoes.roteador === undefined
      ? {
          id: ROUTER,
          name: "Roteador",
          classifierModel: null,
          classifierProvider: null,
          sticky: true,
          minConfidence: 0.6,
          fallbackAgentId: null,
          members: [
            { agentId: AGENTE_ANTERIOR, intentName: "vendas", intentDescription: "quer comprar", examples: [] },
            { agentId: AGENTE_DESTINO, intentName: "automacao", intentDescription: "quer automatizar", examples: [] },
          ],
        }
      : opcoes.roteador;
  vi.mocked(loadActiveRouter).mockResolvedValue(roteador);
  vi.mocked(agenteDaCampanhaDaConversa).mockResolvedValue(null);
  const publicado: Partial<PublishedAgentConfig> = { agentId: AGENTE_DESTINO, pausedAt: null };
  vi.mocked(loadPublishedAgentConfigById).mockResolvedValue(
    opcoes.destinoPublicado === false ? null : (publicado as PublishedAgentConfig),
  );
  const escritas: Escrita[] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/insert into ai_router_decisions/i.test(sql)) {
        escritas.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      if (/from conversations\s+where organization_id = \$1 and id = \$2/i.test(sql)) {
        return { rows: conversa === null ? [] : [conversa], rowCount: 0 };
      }
      throw new Error(`pool dublê sem resposta para: ${sql.slice(0, 80)}`);
    },
  } as unknown as pg.Pool;
  return { db, escritas };
}

function requisicao(corpo: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/conversations/${CONVERSA}/transferir-agente`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const ctx = { params: Promise.resolve({ id: CONVERSA }) };

describe("POST /api/v1/conversations/[id]/transferir-agente", () => {
  beforeEach(() => {
    vi.mocked(requireRole).mockReset();
    vi.mocked(createClient).mockReset();
    vi.mocked(getRequestPool).mockReset();
    vi.mocked(audit).mockReset();
    process.env.SUPABASE_DB_URL = "postgres://dubl/e";
  });

  it("403: viewer (sem escrita) não transfere nada — nem lê, nem escreve", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: { code: "forbidden_role" } }, { status: 403 }),
    } as never);
    const pool = poolFake();
    vi.mocked(getRequestPool).mockReturnValue(pool.db);

    const res = await POST(requisicao({ agente_id: AGENTE_DESTINO }), ctx);

    expect(res.status).toBe(403);
    expect(pool.escritas).toHaveLength(0);
    expect(createClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("403 antes de 400: sem permissão, o id inválido nem é olhado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: { code: "forbidden_role" } }, { status: 403 }),
    } as never);

    const res = await POST(requisicao({ agente_id: AGENTE_DESTINO }), {
      params: Promise.resolve({ id: "nao-e-uuid" }),
    });

    expect(res.status).toBe(403);
  });

  it("400: id inválido, com permissão", async () => {
    vi.mocked(requireRole).mockResolvedValue(authzOk as never);

    const res = await POST(requisicao({ agente_id: AGENTE_DESTINO }), {
      params: Promise.resolve({ id: "nao-e-uuid" }),
    });

    expect(res.status).toBe(400);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("200: a conversa passa para o agente X e a decisão é registrada com origem ação", async () => {
    vi.mocked(requireRole).mockResolvedValue(authzOk as never);
    const sessao = clienteDeSessao(true);
    vi.mocked(createClient).mockResolvedValue(sessao.client as never);
    const pool = poolFake();
    vi.mocked(getRequestPool).mockReturnValue(pool.db);

    const res = await POST(requisicao({ agente_id: AGENTE_DESTINO }), ctx);
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data).toEqual({
      agente_anterior_id: AGENTE_ANTERIOR,
      agente_id: AGENTE_DESTINO,
      intent_name: "automacao",
      router_id: ROUTER,
    });
    // A conversa lida é a da organização da sessão — nunca a do corpo.
    expect(sessao.filtros).toEqual([
      ["id", CONVERSA],
      ["organization_id", ORG],
    ]);
    expect(pool.escritas).toHaveLength(1);
    expect(pool.escritas[0]!.sql).toContain("'transferred'");
    expect(pool.escritas[0]!.sql).toContain("'acao'");
    expect(pool.escritas[0]!.params[2]).toBe(AGENTE_DESTINO);
    expect(pool.escritas[0]!.params[6]).toBe(AGENTE_ANTERIOR);
    expect(pool.escritas[0]!.params[7]).toBe("pedido_do_operador");
    expect(pool.escritas[0]!.params[8]).toBe(USER);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "conversation.ai_agent_transferred", resourceId: CONVERSA }),
    );
  });

  it("404: conversa fora do alcance de quem pede — nada é escrito", async () => {
    vi.mocked(requireRole).mockResolvedValue(authzOk as never);
    vi.mocked(createClient).mockResolvedValue(clienteDeSessao(false).client as never);
    const pool = poolFake();
    vi.mocked(getRequestPool).mockReturnValue(pool.db);

    const res = await POST(requisicao({ agente_id: AGENTE_DESTINO }), ctx);

    expect(res.status).toBe(404);
    expect(pool.escritas).toHaveLength(0);
  });

  it("409: número sem roteador — recusa com código próprio e NADA muda", async () => {
    vi.mocked(requireRole).mockResolvedValue(authzOk as never);
    vi.mocked(createClient).mockResolvedValue(clienteDeSessao(true).client as never);
    const pool = poolFake({ roteador: null });
    vi.mocked(getRequestPool).mockReturnValue(pool.db);

    const res = await POST(requisicao({ agente_id: AGENTE_DESTINO }), ctx);
    const corpo = await res.json();

    expect(res.status).toBe(409);
    expect(corpo.error.code).toBe("sem_roteador");
    expect(pool.escritas).toHaveLength(0);
  });

  it("422: agente inexistente/fora da organização — recusa e NADA muda", async () => {
    vi.mocked(requireRole).mockResolvedValue(authzOk as never);
    vi.mocked(createClient).mockResolvedValue(clienteDeSessao(true).client as never);
    const pool = poolFake({ destinoPublicado: false });
    vi.mocked(getRequestPool).mockReturnValue(pool.db);

    const res = await POST(requisicao({ agente_id: AGENTE_DESTINO }), ctx);
    const corpo = await res.json();

    expect(res.status).toBe(422);
    expect(corpo.error.code).toBe("agente_inexistente");
    expect(pool.escritas).toHaveLength(0);
  });

  it("422: o corpo não escolhe o motivo — nem um do vocabulário, nem pedido_do_agente", async () => {
    vi.mocked(requireRole).mockResolvedValue(authzOk as never);
    vi.mocked(createClient).mockResolvedValue(clienteDeSessao(true).client as never);
    const pool = poolFake();
    vi.mocked(getRequestPool).mockReturnValue(pool.db);

    for (const motivo of ["pedido_do_agente", "pedido_do_operador", "porque eu quis"]) {
      const res = await POST(requisicao({ agente_id: AGENTE_DESTINO, motivo }), ctx);
      expect(res.status).toBe(422);
    }
    expect(pool.escritas).toHaveLength(0);
  });
});
