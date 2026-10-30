import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { createClient } from "@/lib/supabase/server";

import { POST, TETO_DO_LOTE } from "./route";

/**
 * POST /api/v1/conversations/bulk (#2484, fatia F1) — a camada de lote.
 *
 * O banco é o MESMO dublê com predicado dos testes das rotas irmãs: a linha da
 * conversa só aparece quando `organization_id` casa. É por isso que o caso
 * cross-tenant mede a ROTA (o handler por item recusando), e não o mock — a
 * conversa de ORG_B existe no dublê, e só não é alcançável por quem está na
 * sessão de ORG_A.
 *
 * Os handlers por item NÃO são mockados: são os POST/PATCH reais de
 * `../[id]/…`, importados pela rota de lote. Quem é mockado é o que eles
 * precisam para rodar sem banco (auth, client, audit) — o mesmo recorte dos
 * testes co-localizados das irmãs.
 */
const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const USER = "aaaaaaaa-3333-4000-8000-000000000003";
const DESTINATARIO = "aaaaaaaa-4444-4000-8000-000000000004";
const CONV_A = "aaaaaaaa-1111-4000-8000-000000000001";
const CONV_A2 = "aaaaaaaa-1111-4000-8000-000000000005";
const CONV_B = "bbbbbbbb-1111-4000-8000-000000000002";
const CONV_FANTASMA = "cccccccc-1111-4000-8000-000000000003";
const OUTRO_CONTATO = "aaaaaaaa-5555-4000-8000-000000000010";
const LEAD_DA_CONV_A = "aaaaaaaa-7777-4000-8000-000000000001";
const LEAD_DA_CONV_A2 = "aaaaaaaa-7777-4000-8000-000000000002";
const LEAD_DE_TERCEIRO = "aaaaaaaa-7777-4000-8000-000000000003";

type Linha = Record<string, unknown>;

/**
 * A linha do dublê por id — `linhas[0]` é opcional para o compilador
 * (`noUncheckedIndexedAccess`) e um `?.` transformaria linha ausente em asserção
 * fraca. Aqui, linha que falta estoura.
 */
function linhaDe(linhas: Linha[], id: string): Linha {
  const achada = linhas.find((l) => l.id === id);
  if (!achada) throw new Error(`dublê sem a linha ${id}`);
  return achada;
}


/** Estado mutável do dublê, recriado a cada teste. */
interface Estado {
  conversas: Linha[];
  membros: Linha[];
  /**
   * Os negócios do funil (#3177). Vazio por padrão: os testes que NÃO falam do
   * funil medem o lote sem negócio aberto nenhum — a sincronia da conversa é
   * um no-op neles, como seria num tenant sem card.
   */
  leads: Linha[];
  /** Os patches que chegaram ao `crm_leads` — a conta exata do #3177. */
  escritasDeLead: Linha[];
  rpcs: Array<{ nome: string; params: Linha }>;
  /** Id cuja escrita no banco ESTOURA — simula o handler que morre sem responder. */
  explodirEm: string | null;
}

function conversa(id: string, organizationId: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: organizationId,
    contact_id: "aaaaaaaa-5555-4000-8000-000000000009",
    status: "open",
    service_revision: 3,
    assigned_to_user_id: USER,
    assigned_to_user_name: "Ana",
    assignee_kind: "user",
    bot_silenced_until: null,
    unread_count_for_assignee: 2,
    tags: [],
    ...extra,
  };
}

/**
 * Um negócio do funil (#3177) — o mínimo que a régua lê: contato, status e dono.
 * `contact_id` é o que decide QUAL card cada conversa do lote leva.
 */
function negocioDoFunil(id: string, contactId: string, owner: string | null): Linha {
  return {
    id,
    organization_id: ORG_A,
    contact_id: contactId,
    status: "open",
    owner_user_id: owner,
    owner_agent_id: null,
    owner_kind: owner ? "user" : null,
    assigned_at: null,
  };
}

/**
 * O dublê de client `.from(...).eq(...).maybeSingle()` com PREDICADO: só casa a
 * linha quando TODO filtro bate, `organization_id` inclusive. `rpc` grava as
 * chamadas em `estado.rpcs` — é assim que o teste prova que `to_user_id` chegou
 * ao handler da conversa.
 */
function clienteFalso(estado: Estado) {
  function builder(tabela: string) {
    const filtros: Array<[string, unknown]> = [];
    let patch: Linha | null = null;
    const linhas = () =>
      tabela === "conversations"
        ? estado.conversas
        : tabela === "user_organizations"
          ? estado.membros
          : tabela === "crm_leads"
            ? estado.leads
            : [];
    const casa = (l: Linha) => filtros.every(([c, v]) => l[c] === v);
    const q = {
      select: () => q,
      update: (v: Linha) => {
        patch = v;
        return q;
      },
      insert: (v: Linha) => {
        linhas().push(v);
        return q;
      },
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return q;
      },
      is: () => q,
      in: () => q,
      limit: () => q,
      maybeSingle: async () => {
        if (patch) {
          const alvos = linhas().filter(casa);
          if (alvos.length > 0) estado.escritasDeLead.push({ ...patch });
          for (const l of alvos) Object.assign(l, patch);
          patch = null;
          return { data: alvos[0] ?? null, error: null };
        }
        return { data: linhas().find(casa) ?? null, error: null };
      },
      then: (comOk: (v: unknown) => unknown, comErro: (e: unknown) => unknown) =>
        Promise.resolve({ data: linhas().filter(casa), error: null }).then(comOk, comErro),
    };
    return q;
  }
  return {
    from: builder,
    rpc: async (nome: string, params: Linha) => {
      estado.rpcs.push({ nome, params });
      // As RPCs da família nomeiam o id da conversa de dois jeitos
      // (`p_conversation` em fn_service_status, `p_conversation_id` em
      // fn_conversation_assign) — o dublê aceita os dois.
      const idDaConversa = (params.p_conversation ?? params.p_conversation_id) as
        | string
        | undefined;
      if (estado.explodirEm !== null && idDaConversa === estado.explodirEm) {
        throw new Error("banco caiu no meio da escrita");
      }
      if (nome === "fn_service_status") {
        const conv = estado.conversas.find((c) => c.id === idDaConversa);
        if (!conv) return { data: null, error: { code: "P0002", message: "not found" } };
        conv.status = params.p_status as string;
        conv.service_revision = (conv.service_revision as number) + 1;
        return { data: conv, error: null };
      }
      if (nome === "fn_conversation_assign") {
        const conv = estado.conversas.find((c) => c.id === idDaConversa);
        if (!conv) return { data: [], error: null };
        conv.assigned_to_user_id = params.p_to_user_id as string;
        conv.assignee_kind = "user";
        return { data: [conv], error: null };
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
vi.mock("@/lib/escalacao/retomada", () => ({ devolverAtendimentoAoAgente: vi.fn() }));

let estado: Estado;

beforeEach(() => {
  vi.clearAllMocks();
  auth.negar = false;
  estado = {
    conversas: [
      conversa(CONV_A, ORG_A),
      conversa(CONV_A2, ORG_A),
      conversa(CONV_B, ORG_B),
    ],
    membros: [
      {
        organization_id: ORG_A,
        user_id: DESTINATARIO,
        role: "agent",
        revoked_at: null,
      },
    ],
    leads: [],
    escritasDeLead: [],
    rpcs: [],
    explodirEm: null,
  };
  vi.mocked(createClient).mockResolvedValue(
    clienteFalso(estado) as unknown as SupabaseClient,
  );
  vi.mocked(createAdminClient).mockReturnValue(
    clienteFalso(estado) as unknown as SupabaseClient,
  );
  vi.mocked(requireSupportWrite).mockResolvedValue(
    null as unknown as Awaited<ReturnType<typeof requireSupportWrite>>,
  );
  vi.mocked(devolverAtendimentoAoAgente).mockResolvedValue({
    ok: true,
    continuidade: {
      houveAtendimentoHumano: false,
      resumo: "",
      decisoes: [],
      notas: [],
    },
  } as unknown as Awaited<ReturnType<typeof devolverAtendimentoAoAgente>>);
});

function req(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/conversations/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

async function corpoDe(res: Response): Promise<{
  status: number;
  data: {
    acao?: string;
    teto?: number;
    total?: number;
    feitos?: number;
    recusados?: number;
    resultados?: Array<{
      id: string;
      feito: boolean;
      codigo?: string;
      motivo?: string;
      request_id?: string;
    }>;
  };
  error?: { code: string; message: string };
}> {
  const json = (await res.json()) as {
    data?: {
      acao?: string;
      teto?: number;
      total?: number;
      feitos?: number;
      recusados?: number;
      resultados?: Array<{
        id: string;
        feito: boolean;
        codigo?: string;
        motivo?: string;
        request_id?: string;
      }>;
    };
    error?: { code: string; message: string };
  };
  return { status: res.status, data: json.data ?? {}, error: json.error };
}

describe("POST /api/v1/conversations/bulk", () => {
  it("ids MISTOS: o de outra organização é recusado NO ITEM e não derruba os demais", async () => {
    const res = await POST(
      req({ action: "close", ids: [CONV_A, CONV_B, CONV_FANTASMA] }),
    );

    expect(res.status).toBe(200);
    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(1);
    expect(corpo.data.recusados).toBe(2);
    expect(corpo.data.resultados).toEqual([
      { id: CONV_A, feito: true, request_id: expect.any(String) },
      {
        id: CONV_B,
        feito: false,
        codigo: "not_found",
        motivo: "Conversa não encontrada.",
        request_id: expect.any(String),
      },
      {
        id: CONV_FANTASMA,
        feito: false,
        codigo: "not_found",
        motivo: "Conversa não encontrada.",
        request_id: expect.any(String),
      },
    ]);
    // O item bom foi de verdade fechado; o da outra organização segue intacto.
    expect(estado.conversas.find((c) => c.id === CONV_A)?.status).toBe("closed");
    expect(estado.conversas.find((c) => c.id === CONV_B)?.status).toBe("open");
    // Uma auditoria só — a da conversa que existia para esta sessão.
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.closed",
        resourceId: CONV_A,
        organizationId: ORG_A,
        actorUserId: USER,
      }),
    );
  });

  it("organização do CORPO é ignorada: a conversa da outra org segue recusada", async () => {
    // O atacante manda a org dele no corpo esperando que o lote a use. O schema
    // descarta a chave e o handler por item filtra pela org da SESSÃO — a
    // conversa de ORG_B continua inalcançável para a sessão de ORG_A.
    const res = await POST(
      req({
        action: "close",
        ids: [CONV_B],
        organization_id: ORG_B,
      }),
    );

    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(0);
    expect(corpo.data.resultados?.[0]).toMatchObject({
      id: CONV_B,
      feito: false,
      codigo: "not_found",
    });
    expect(estado.conversas.find((c) => c.id === CONV_B)?.status).toBe("open");
    expect(audit).not.toHaveBeenCalled();
  });

  it("auditoria POR ITEM: uma entrada por conversa, nunca uma para o lote", async () => {
    const res = await POST(req({ action: "close", ids: [CONV_A, CONV_A2] }));

    expect(res.status).toBe(200);
    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(2);
    // Duas entradas, cada uma com o resourceId da sua conversa.
    expect(audit).toHaveBeenCalledTimes(2);
    const recursos = vi
      .mocked(audit)
      .mock.calls.map((c) => (c[0] as { resourceId: string }).resourceId);
    expect(recursos).toEqual([CONV_A, CONV_A2]);
    // Nenhuma entrada agregada (resourceId null) passa por aqui.
    expect(recursos).not.toContain(null);
    // Cada item carrega o request_id da própria subchamada, para correlacionar.
    expect(corpo.data.resultados?.[0]?.request_id).toBeTruthy();
    expect(corpo.data.resultados?.[1]?.request_id).toBeTruthy();
  });

  it("acima do teto: 422 bulk_too_large, e nenhuma subchamada é feita", async () => {
    const ids = Array.from(
      { length: TETO_DO_LOTE + 1 },
      (_, i) => `aaaaaaaa-1111-4000-8000-${String(i).padStart(12, "0")}`,
    );

    const res = await POST(req({ action: "close", ids }));

    expect(res.status).toBe(422);
    const corpo = await corpoDe(res);
    expect(corpo.error?.code).toBe("bulk_too_large");
    expect(corpo.error?.message).toContain(String(TETO_DO_LOTE));
    expect(createClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("o relatório devolve o teto, os totais e a ação", async () => {
    const res = await POST(req({ action: "mark-read", ids: [CONV_A, CONV_B] }));
    const corpo = await corpoDe(res);
    expect(corpo.data).toMatchObject({
      acao: "mark-read",
      teto: TETO_DO_LOTE,
      total: 2,
      feitos: 1,
      recusados: 1,
    });
  });

  it("viewer: 403 na CHAMADA, com zero subchamadas", async () => {
    auth.negar = true;

    const res = await POST(req({ action: "close", ids: [CONV_A] }));

    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("transfer leva to_user_id e motivo ao handler da conversa, por item", async () => {
    const res = await POST(
      req({
        action: "transfer",
        ids: [CONV_A, CONV_A2],
        to_user_id: DESTINATARIO,
        reason: "plantão da noite",
      }),
    );

    expect(res.status).toBe(200);
    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(2);
    const assigns = estado.rpcs.filter((r) => r.nome === "fn_conversation_assign");
    expect(assigns).toHaveLength(2);
    expect(
      assigns.map((r) => r.params.p_conversation_id ?? r.params.p_conversation),
    ).toEqual([CONV_A, CONV_A2]);
    expect(assigns.every((r) => r.params.p_to_user_id === DESTINATARIO)).toBe(true);
    // Auditoria por item, com o destino no metadata.
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.transferred",
        resourceId: CONV_A,
        metadata: expect.objectContaining({ to_user_id: DESTINATARIO, note: "plantão da noite" }),
      }),
    );
  });

  it("transfer em lote: cada conversa leva o negócio aberto do SEU contato — e só o dele (#3177)", async () => {
    // A2 é de OUTRO contato: o lote transfere duas conversas, mas o funil só
    // recebe o dono em quem é daquele contato. O negócio de terceiro (nem da
    // conversa, nem do contato) fica intacto — "sem transferir a mais".
    estado.conversas = [conversa(CONV_A, ORG_A), conversa(CONV_A2, ORG_A, { contact_id: OUTRO_CONTATO })];
    estado.leads = [
      negocioDoFunil(LEAD_DA_CONV_A, "aaaaaaaa-5555-4000-8000-000000000009", USER),
      negocioDoFunil(LEAD_DA_CONV_A2, OUTRO_CONTATO, USER),
      negocioDoFunil(LEAD_DE_TERCEIRO, "aaaaaaaa-5555-4000-8000-000000000011", null),
    ];

    const res = await POST(
      req({ action: "transfer", ids: [CONV_A, CONV_A2], to_user_id: DESTINATARIO }),
    );

    expect(res.status).toBe(200);
    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(2);
    expect(estado.leads.map((l) => l.owner_user_id)).toEqual([
      DESTINATARIO,
      DESTINATARIO,
      null,
    ]);
    expect(estado.escritasDeLead).toHaveLength(2);
    // A sincronia é da ROTA de uma; o lote não a repete por conta própria.
    expect(estado.rpcs.filter((r) => r.nome === "fn_conversation_assign")).toHaveLength(2);
  });

  it("duas conversas do MESMO contato: o card é escrito UMA vez (#3177)", async () => {
    // Idempotência medida: o segundo item já encontra o responsável certo e não
    // regrava (regravar emitiria um `lead.assigned` que não houve).
    estado.leads = [
      negocioDoFunil(LEAD_DA_CONV_A, "aaaaaaaa-5555-4000-8000-000000000009", USER),
    ];

    const res = await POST(
      req({ action: "transfer", ids: [CONV_A, CONV_A2], to_user_id: DESTINATARIO }),
    );

    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(2);
    expect(estado.escritasDeLead).toHaveLength(1);
    expect(linhaDe(estado.leads, LEAD_DA_CONV_A).owner_user_id).toBe(DESTINATARIO);
  });

  it("archive vai pelo PATCH de status (#923) e audita conversation.archived", async () => {
    const res = await POST(req({ action: "archive", ids: [CONV_A, CONV_FANTASMA] }));

    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(1);
    expect(corpo.data.resultados?.[0]?.feito).toBe(true);
    expect(corpo.data.resultados?.[1]).toMatchObject({ feito: false, codigo: "not_found" });
    expect(estado.conversas.find((c) => c.id === CONV_A)?.status).toBe("archived");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "conversation.archived", resourceId: CONV_A }),
    );
  });

  it("mark-read zera o não lido só de quem é da sessão", async () => {
    const res = await POST(req({ action: "mark-read", ids: [CONV_A, CONV_B] }));

    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(1);
    expect(estado.conversas.find((c) => c.id === CONV_A)?.unread_count_for_assignee).toBe(0);
    expect(estado.conversas.find((c) => c.id === CONV_B)?.unread_count_for_assignee).toBe(2);
  });

  it("pause-ai audita conversation.ai_paused por conversa", async () => {
    const res = await POST(req({ action: "pause-ai", ids: [CONV_A] }));

    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(1);
    expect(estado.conversas.find((c) => c.id === CONV_A)?.bot_silenced_until).toBe("infinity");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "conversation.ai_paused", resourceId: CONV_A }),
    );
  });

  it("reactivate-bot chama a regra de devolução por id", async () => {
    const res = await POST(req({ action: "reactivate-bot", ids: [CONV_A, CONV_A2] }));

    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(2);
    expect(devolverAtendimentoAoAgente).toHaveBeenCalledTimes(2);
    expect(devolverAtendimentoAoAgente).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_A }),
      { conversationId: CONV_A, expectedAssignee: USER },
    );
    expect(devolverAtendimentoAoAgente).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_A }),
      { conversationId: CONV_A2, expectedAssignee: USER },
    );
  });

  it("reactivate-bot: conversa inexistente é recusada no item pelo próprio handler", async () => {
    vi.mocked(devolverAtendimentoAoAgente).mockResolvedValue({
      ok: false,
      erro: "conversation_not_found",
    } as unknown as Awaited<ReturnType<typeof devolverAtendimentoAoAgente>>);

    const res = await POST(req({ action: "reactivate-bot", ids: [CONV_FANTASMA] }));

    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(0);
    expect(corpo.data.resultados?.[0]).toMatchObject({
      feito: false,
      codigo: "not_found",
      motivo: "Conversa não encontrada.",
    });
  });

  it("item cujo handler ESTOURO recusa só aquele item — o lote segue", async () => {
    estado.explodirEm = CONV_A2;

    const res = await POST(req({ action: "close", ids: [CONV_A, CONV_A2, CONV_B] }));

    expect(res.status).toBe(200);
    const corpo = await corpoDe(res);
    expect(corpo.data.resultados?.[0]).toMatchObject({ id: CONV_A, feito: true });
    expect(corpo.data.resultados?.[1]).toMatchObject({
      id: CONV_A2,
      feito: false,
      codigo: "internal_error",
      motivo: "banco caiu no meio da escrita",
    });
    expect(corpo.data.resultados?.[2]).toMatchObject({ id: CONV_B, feito: false });
    expect(corpo.data.feitos).toBe(1);
  });

  it("ação desconhecida e ids vazios: 422 antes de qualquer subchamada", async () => {
    const res = await POST(req({ action: "destruir-tudo", ids: [CONV_A] }));
    expect(res.status).toBe(422);
    expect(createClient).not.toHaveBeenCalled();

    const vazio = await POST(req({ action: "close", ids: [] }));
    expect(vazio.status).toBe(422);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("requireRole é chamado com agent e resource conversations — a permissão de sempre", async () => {
    await POST(req({ action: "close", ids: [CONV_A] }));
    expect(requireRole).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({ resource: "conversations" }),
    );
  });
});
