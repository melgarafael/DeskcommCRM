import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { GET, POST } from "./route";

/**
 * POST /api/v1/conversations/[id]/transfer — e o negócio ABERTO do contato?
 *
 * A resposta mudou de lugar no #4019. Até então a ROTA chamava
 * `sincronizarNegocioAbertoDoContato` com o cliente da SESSÃO; por isso a
 * transferência fora da tela (MCP/`crm_assign_conversation`, automação,
 * chamada direta de `fn_conversation_assign`) ficava sem régua. A régua desceu
 * para a `fn_conversation_assign`, na MESMA transação da troca de dono, e com
 * sessão continua dentro da permissão de quem clicou.
 *
 * Este arquivo mede, então, o CONTRÁRIO do que media antes: a rota não toca no
 * funil, não depende dele, e manda o pedido de atribuição sem o 8º argumento
 * (`'transfer'` é o motivo que leva o card). Quem prova que o card
 * efetivamente muda de dono é Postgres de verdade:
 * `tests/invariants/negocio-aberto-acompanha-o-dono.test.ts`.
 */

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "aaaaaaaa-3333-4000-8000-000000000003";
const DESTINO = "aaaaaaaa-4444-4000-8000-000000000004";
const CONV_A = "aaaaaaaa-1111-4000-8000-000000000001";
const CONTATO_A = "aaaaaaaa-5555-4000-8000-000000000009";
const NUMERO_ANTIGO = "aaaaaaaa-8888-4000-8000-000000000001";
const NUMERO_NOVO = "aaaaaaaa-8888-4000-8000-000000000002";

type Linha = Record<string, unknown>;

interface Estado {
  conversas: Linha[];
  membros: Linha[];
  /** Toda RPC chamada pela rota, na ordem. */
  rpcs: Array<{ nome: string; params: Linha }>;
  /** Tabelas tocadas por cada cliente — é assim que se prova quem escreveu. */
  tabelas: { sessao: string[]; admin: string[] };
  /**
   * #3642: o número para onde a troca leva a conversa (o que
   * `fn_numero_da_transferencia` responderia). `null` = ela fica onde está.
   */
  numeroNovo: string | null;
  sessoes: Linha[];
}

function conversa(extra: Linha = {}): Linha {
  return {
    id: CONV_A,
    organization_id: ORG_A,
    contact_id: CONTATO_A,
    status: "open",
    assigned_to_user_id: USER,
    assignee_kind: "user",
    channel_session_id: NUMERO_ANTIGO,
    ...extra,
  };
}

/** Dublê com PREDICADO (mesmo das rotas irmãs): a linha só aparece quando TODO filtro bate. */
function clienteFalso(estado: Estado, rotulo: "sessao" | "admin") {
  function builder(tabela: string) {
    estado.tabelas[rotulo].push(tabela);
    const filtros: Array<[string, unknown]> = [];
    const linhas = () =>
      tabela === "conversations"
        ? estado.conversas
        : tabela === "user_organizations"
          ? estado.membros
          : tabela === "channel_sessions"
            ? estado.sessoes
            : [];
    const casa = (l: Linha) => filtros.every(([c, v]) => l[c] === v);
    const q = {
      select: () => q,
      update: () => q,
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return q;
      },
      is: () => q,
      in: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: linhas().find(casa) ?? null, error: null }),
      then: (comOk: (v: unknown) => unknown, comErro: (e: unknown) => unknown) =>
        Promise.resolve({ data: linhas().filter(casa), error: null }).then(comOk, comErro),
    };
    return q;
  }
  return {
    from: builder,
    rpc: async (nome: string, params: Linha) => {
      estado.rpcs.push({ nome, params });
      if (nome === "fn_conversation_assign") {
        const conv = estado.conversas.find((c) => c.id === params.p_conversation_id);
        if (!conv) return { data: [], error: null };
        conv.assigned_to_user_id = params.p_to_user_id as string;
        if (estado.numeroNovo) conv.channel_session_id = estado.numeroNovo;
        return { data: [conv], error: null };
      }
      if (nome === "fn_numero_da_transferencia") {
        return { data: estado.numeroNovo, error: null };
      }
      return { data: null, error: null };
    },
  };
}

/** Mutável por teste, lido de dentro do mock (hoisted: nasce antes dos imports). */
const auth = vi.hoisted(() => ({ negar: false }));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(() =>
    auth.negar
      ? {
          ok: false,
          response: NextResponse.json(
            { error: { code: "forbidden_role", message: "Sem permissão." } },
            { status: 403 },
          ),
        }
      : {
          ok: true,
          user: { id: "aaaaaaaa-3333-4000-8000-000000000003", idioma: "pt-BR" },
          org: { orgId: "aaaaaaaa-0000-4000-8000-000000000001", role: "agent" },
        },
  ),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => {}),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({
  registrarTrocaDeComando: vi.fn(async () => {}),
}));

let estado: Estado;

beforeEach(() => {
  vi.clearAllMocks();
  auth.negar = false;
  estado = {
    conversas: [conversa()],
    membros: [
      { organization_id: ORG_A, user_id: DESTINO, role: "agent", revoked_at: null },
    ],
    rpcs: [],
    tabelas: { sessao: [], admin: [] },
    numeroNovo: null,
    sessoes: [],
  };
  vi.mocked(createClient).mockResolvedValue(clienteFalso(estado, "sessao") as unknown as SupabaseClient);
  vi.mocked(createAdminClient).mockReturnValue(
    clienteFalso(estado, "admin") as unknown as SupabaseClient,
  );
  vi.mocked(requireSupportWrite).mockResolvedValue(
    null as unknown as Awaited<ReturnType<typeof requireSupportWrite>>,
  );
});

function req(corpo: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/conversations/${CONV_A}/transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const params = { params: Promise.resolve({ id: CONV_A }) };

function transferir() {
  return POST(req({ to_user_id: DESTINO, reason: "cliente pediu o financeiro" }), params);
}

/** O metadata da auditoria de transferência. */
function metadataDaTransferencia(): Record<string, unknown> {
  const entrada = vi
    .mocked(audit)
    .mock.calls.map(([e]) => e)
    .find((e) => e.action === "conversation.transferred");
  return (entrada?.metadata ?? {}) as Record<string, unknown>;
}

describe("POST /api/v1/conversations/[id]/transfer — a régua do negócio é do banco (#4019)", () => {
  it("a rota não escreve no funil: o pedido de atribuição é que leva o card", async () => {
    const res = await transferir();

    expect(res.status).toBe(200);
    // A conversa mudou de dono, como sempre.
    expect(estado.conversas[0]?.assigned_to_user_id).toBe(DESTINO);
    // O pedido é o de SEMPRE — sem 8º argumento. O default `false` é a régua
    // do #4019: transferir leva o card, inclusive de outro responsável.
    expect(estado.rpcs.find((r) => r.nome === "fn_conversation_assign")?.params).toEqual({
      p_organization_id: ORG_A,
      p_conversation_id: CONV_A,
      p_to_user_id: DESTINO,
      p_reason: "transfer",
      p_enforce_expected: false,
    });
    // Nenhuma tabela de funil passa pela rota: quem leva o card é a RPC, na
    // mesma transação.
    expect(estado.tabelas.sessao).not.toContain("crm_leads");
    expect(estado.tabelas.admin).toEqual(["user_organizations"]);
    expect(metadataDaTransferencia()).not.toHaveProperty("negocio_aberto");
  });

  it("a rota não depende do funil: conversa órfã e falha de leitura não mudam nada", async () => {
    estado.conversas = [conversa({ contact_id: null })];

    const res = await transferir();

    expect(res.status).toBe(200);
    expect(estado.rpcs.filter((r) => r.nome === "fn_conversation_assign")).toHaveLength(1);
    expect(estado.tabelas.sessao.filter((t) => t === "crm_leads")).toHaveLength(0);
  });

  it("nenhum gatilho de automação novo: a rota só emite os eventos que já emitia", async () => {
    const res = await transferir();

    expect(res.status).toBe(200);
    const eventos = estado.rpcs
      .filter((r) => r.nome === "emit_event")
      .map((r) => r.params.p_event_type);
    expect(eventos).toEqual(["conversation.transferred"]);
    expect(eventos).not.toContain("conversation.assigned");
    expect(registrarTrocaDeComando).toHaveBeenCalledTimes(1);
  });

  it("a auditoria continua a mesma entrada", async () => {
    await transferir();

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.transferred",
        actorUserId: USER,
        organizationId: ORG_A,
        resourceId: CONV_A,
        metadata: expect.objectContaining({
          to_user_id: DESTINO,
          note: "cliente pediu o financeiro",
        }),
      }),
    );
  });
});

describe("#3642 (doc 237, 2-A) — o número na transferência", () => {
  it("a auditoria registra o número antigo e o novo quando a conversa troca de número", async () => {
    estado.numeroNovo = NUMERO_NOVO;

    const res = await transferir();

    expect(res.status).toBe(200);
    expect(metadataDaTransferencia()).toMatchObject({
      numero_anterior: NUMERO_ANTIGO,
      numero_novo: NUMERO_NOVO,
    });
  });

  it("CONTROLE: a conversa que fica no mesmo número registra o mesmo número dos dois lados", async () => {
    await transferir();

    expect(metadataDaTransferencia()).toMatchObject({
      numero_anterior: NUMERO_ANTIGO,
      numero_novo: NUMERO_ANTIGO,
    });
  });

  function previa(toUserId: string) {
    return GET(
      new NextRequest(
        `http://localhost/api/v1/conversations/${CONV_A}/transfer?to_user_id=${toUserId}`,
      ),
      params,
    );
  }

  it("a prévia do diálogo devolve o número para onde a conversa vai", async () => {
    estado.numeroNovo = NUMERO_NOVO;
    estado.sessoes = [
      { id: NUMERO_NOVO, organization_id: ORG_A, display_name: "Vendas B", phone_number: "+5511988887777" },
    ];

    const res = await previa(DESTINO);

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { numero: Record<string, unknown> | null } };
    expect(corpo.data.numero).toEqual({
      channel_session_id: NUMERO_NOVO,
      display_name: "Vendas B",
      phone_number: "+5511988887777",
    });
    expect(estado.rpcs.find((r) => r.nome === "fn_numero_da_transferencia")?.params).toEqual({
      p_organization_id: ORG_A,
      p_conversation_id: CONV_A,
      p_to_user_id: DESTINO,
    });
    // Só leitura: ninguém mudou de dono.
    expect(estado.rpcs.some((r) => r.nome === "fn_conversation_assign")).toBe(false);
  });

  it("CONTROLE: quando a conversa fica onde está, a prévia diz `null`", async () => {
    const res = await previa(DESTINO);
    const corpo = (await res.json()) as { data: { numero: unknown } };
    expect(corpo.data.numero).toBeNull();
  });

  it("conversa que quem pergunta não enxerga: 404, e a regra nem é consultada", async () => {
    estado.conversas = [];

    const res = await previa(DESTINO);

    expect(res.status).toBe(404);
    expect(estado.rpcs).toHaveLength(0);
  });

  it("destino que não é um id: 400", async () => {
    const res = await previa("nao-e-uuid");
    expect(res.status).toBe(400);
  });
});

/**
 * #3732 — a troca de número vira LINHA DO TEMPO, não só auditoria.
 *
 * O #3658 gravava o par antigo/novo no `metadata` da auditoria (lido por
 * `admin`), e a linha do tempo da conversa — onde quem atende olha — não dizia
 * nada. Aqui a atividade da troca passa a dizer por qual número a conversa
 * continua, com o nome de quem atende, e o par vai no payload.
 */
describe("#3732 — o número que mudou entra na linha do tempo", () => {
  /** A atividade da troca de comando, como a rota a escreveu. */
  function atividadeDaTroca(): { motivo?: string; payload?: Record<string, unknown> } {
    const chamada = vi.mocked(registrarTrocaDeComando).mock.calls.at(-1);
    return (chamada?.[0] ?? {}) as { motivo?: string; payload?: Record<string, unknown> };
  }

  it("quando a conversa troca de número, a linha diz por qual número ela continua", async () => {
    estado.conversas = [conversa({ assigned_to_user_name: "Bruno Vendedor" })];
    estado.numeroNovo = NUMERO_NOVO;

    const res = await transferir();

    expect(res.status).toBe(200);
    expect(atividadeDaTroca().motivo).toContain("Continua pelo número de Bruno Vendedor");
    expect(atividadeDaTroca().payload).toMatchObject({
      to_user_id: DESTINO,
      numero_anterior: NUMERO_ANTIGO,
      numero_novo: NUMERO_NOVO,
    });
  });

  it("CONTROLE: no mesmo número, a linha não promete troca nenhuma", async () => {
    await transferir();

    expect(atividadeDaTroca().motivo).not.toContain("Continua pelo número de");
    expect(atividadeDaTroca().payload).not.toHaveProperty("numero_novo");
  });
});
