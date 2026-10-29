import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, orgAtivaSemPortao } from "@/lib/auth/server";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { STATUS_OPERANTE } from "@/lib/organizacao/operante";
import { createClient } from "@/lib/supabase/server";

import { DELETE, GET, POST } from "./route";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
// `requireRole` é dublado (POST/DELETE dependem do retorno), mas `orgAtivaDaApi`
// fica REAL — é ela que o GET usa para resolver a organização.
vi.mock("@/lib/auth/require-role", async () => ({
  ...(await vi.importActual<typeof import("@/lib/auth/require-role")>("@/lib/auth/require-role")),
  requireRole: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

/**
 * /api/v1/conversations/[id]/participants (issue #2542) — a PORTA do convite e a
 * LEITURA da lista.
 *
 * O duplê do banco é dominado pelas queries da rota: `conversations`,
 * `user_organizations` (o alvo tem de ser membro ativo `agent`+) e
 * `conversation_participants` (o vínculo).
 *
 * ─── O que este arquivo mede (e o que ele NÃO mede) ────────────────────────
 *
 * Mede QUEM pode chamar (dono ou gestor no convite) e — o caso desta issue —
 * QUEM pode LER a lista. O GET lê a conversa pelo cliente de SESSÃO: a decisão é
 * a RLS de `conversations`, e por isso o duplê de sessão aplica a RLS (`visiveis`)
 * em vez de devolver tudo. O acesso do convidado à conversa, no banco de
 * verdade, é medido no invariante de banco (test:db).
 *
 * O `autoriza()` reproduz o EFEITO da porta real: o `requireRole` de produção
 * grava `authz.denied` quando nega (`lib/auth/require-role.ts`). Sem esse efeito,
 * uma rota que voltasse a passar pela porta auditada ficaria verde.
 */
const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const CONV_A = "aaaaaaaa-1111-4000-8000-000000000001";
const CONV_B = "bbbbbbbb-1111-4000-8000-000000000002";
const DONO = "aaaaaaaa-3333-4000-8000-000000000003";
const COLEGA = "aaaaaaaa-3333-4000-8000-000000000004";
const VIEWER = "aaaaaaaa-3333-4000-8000-000000000005";

type Linha = Record<string, unknown>;

let conversas: Linha[] = [];
let membros: Linha[] = [];
let participantes: Linha[] = [];
/** O que a RLS de `conversations` deixa ESTA sessão ver (via cliente de sessão). */
let visiveis: Set<string>;
let atualizacoesDeConversa: number;
let idSeq: number;

const tabelaDe = (t: string): Linha[] =>
  t === "conversations" ? conversas : t === "user_organizations" ? membros : participantes;

/** O duplê do service role: filtros encadeáveis + `maybeSingle`/`then`. SEM RLS. */
function clienteFake() {
  function builder(tabela: string) {
    const filtros: Array<[string, unknown]> = [];
    let payload: Linha | null = null;
    let upserte = false;
    let patch: Linha | null = null;
    const casa = (l: Linha) => filtros.every(([c, v]) => l[c] === v);
    const q = {
      select: () => q,
      insert: (v: Linha) => {
        payload = v;
        return q;
      },
      upsert: (v: Linha, _opts?: unknown) => {
        payload = v;
        upserte = true;
        return q;
      },
      update: (v: Linha) => {
        patch = v;
        if (tabela === "conversations") atualizacoesDeConversa += 1;
        return q;
      },
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return q;
      },
      is: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return q;
      },
      order: () => q,
      maybeSingle: async () => {
        if (payload) {
          if (upserte) {
            const chave = (l: Linha) =>
              l["conversation_id"] === payload?.["conversation_id"] &&
              l["user_id"] === payload?.["user_id"];
            const existente = tabelaDe(tabela).find(chave);
            if (existente) {
              Object.assign(existente, payload);
              return { data: { id: existente["id"], ...payload }, error: null };
            }
            const nova = { id: `00000000-0000-4000-8000-${String(idSeq++).padStart(12, "0")}`, ...payload };
            tabelaDe(tabela).push(nova);
            return { data: nova, error: null };
          }
          const nova = { id: `00000000-0000-4000-8000-${String(idSeq++).padStart(12, "0")}`, ...payload };
          tabelaDe(tabela).push(nova);
          return { data: nova, error: null };
        }
        return { data: tabelaDe(tabela).find(casa) ?? null, error: null };
      },
      // `await` da query: aplica o patch (update) ou devolve as linhas (select).
      then: (comOk: (v: unknown) => unknown, comErro: (e: unknown) => unknown) => {
        if (patch) {
          const casadas = tabelaDe(tabela).filter(casa);
          for (const l of casadas) Object.assign(l, patch);
          return Promise.resolve({ data: casadas.map((l) => ({ id: l["id"] })), error: null }).then(
            comOk,
            comErro,
          );
        }
        return Promise.resolve({ data: tabelaDe(tabela).filter(casa), error: null }).then(
          comOk,
          comErro,
        );
      },
    };
    return q;
  }
  return { from: builder } as unknown as SupabaseClient;
}

/**
 * O cliente de SESSÃO — é daqui que o GET lê a conversa, então é AQUI que a RLS
 * de `conversations` vive no teste: só a conversa em `visiveis` volta. É o ponto
 * do conserto — o GET deixou de decidir por papel e passou a decidir pela RLS.
 */
function sessaoFake() {
  function builder(tabela: string) {
    const filtros: Array<[string, unknown]> = [];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return q;
      },
      maybeSingle: async () => {
        const linha = tabelaDe(tabela).find((l) => filtros.every(([c, v]) => l[c] === v));
        const visivel = linha !== undefined && visiveis.has(String(linha["id"]));
        return { data: visivel ? linha : null, error: null };
      },
    };
    return q;
  }
  return { from: builder } as unknown as SupabaseClient;
}

function req(url: string, metodo: string, body?: unknown) {
  // GET/HEAD não pode levar corpo — o NextRequest rejeita antes da rota rodar.
  // O `body` vai no literal (e não num `RequestInit` mutado em dois tempos): o
  // `RequestInit` do DOM tem `signal?: AbortSignal | null`, que NÃO casa com o do
  // `NextRequest` (`signal?: AbortSignal`) — anotar explicitamente reprovava o
  // `typecheck`. Sem anotação, o literal é tipado pelo próprio construtor.
  return new NextRequest(`http://localhost${url}`, {
    method: metodo,
    headers: { "content-type": "application/json" },
    body: metodo === "GET" || metodo === "HEAD" ? undefined : JSON.stringify(body ?? {}),
  });
}

const contexto = (id = CONV_A) => ({ params: Promise.resolve({ id }) });

/** A sessão logada (o idioma vem daqui) e o papel dela na organização. */
function sessao(chamador = DONO, role = "agent") {
  vi.mocked(loadAuthUser).mockResolvedValue({ id: chamador, idioma: "pt-BR" } as never);
  vi.mocked(orgAtivaSemPortao).mockResolvedValue({
    orgId: ORG_A,
    name: "Org A",
    role,
    org_status: STATUS_OPERANTE,
  } as never);
}

/**
 * A autorização FIEL à porta real: decide pelo RANK do papel efetivo e, quando
 * NEGA, grava `authz.denied` (`lib/auth/require-role.ts`). Sem esse efeito, uma
 * rota que voltasse a passar pela porta auditada passaria verde — é o par
 * (i)/(ii) deste arquivo que tem de cair quando a negação volta a ser gravada.
 *
 * `chamador` é quem está logado — é ele, e não o dono da conversa, que decide
 * se o caminho "dono OU gestor" passa.
 */
function autoriza(papelEfetivo: Role = "manager", chamador = DONO) {
  vi.mocked(requireRole).mockImplementation(async (role: string) => {
    if (ROLE_RANK[papelEfetivo] >= ROLE_RANK[role as Role]) {
      return {
        ok: true,
        user: { id: chamador, idioma: "pt-BR" },
        org: { orgId: ORG_A, role: papelEfetivo },
      } as never;
    }
    void audit({
      action: "authz.denied",
      actorUserId: chamador,
      organizationId: ORG_A,
      resourceType: "conversations",
      metadata: { required_role: role, effective_role: papelEfetivo },
    });
    return { ok: false, response: fail("forbidden_role", "negado", 403) } as never;
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  conversas = [{ id: CONV_A, organization_id: ORG_A, assigned_to_user_id: DONO }];
  membros = [{ user_id: COLEGA, organization_id: ORG_A, role: "agent", revoked_at: null }];
  participantes = [];
  visiveis = new Set([CONV_A]);
  atualizacoesDeConversa = 0;
  idSeq = 1;
  vi.mocked(requireSupportWrite).mockResolvedValue(
    null as unknown as Awaited<ReturnType<typeof requireSupportWrite>>,
  );
  vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
  vi.mocked(createClient).mockResolvedValue(sessaoFake() as never);
  const admin = clienteFake();
  const { createAdminClient } = await import("@/lib/supabase/admin");
  vi.mocked(createAdminClient).mockReturnValue(admin as never);
  sessao();
  autoriza("manager");
});

describe("leitura e efeito são autoridades distintas", () => {
  it("id externo inválido responde como ausente, sem consultar UUID inválido no banco", async () => {
    for (const metodo of [GET, POST, DELETE]) {
      const resposta = await metodo(req("/api/v1/conversations/undefined/participants", metodo === GET ? "GET" : "POST", { user_id: COLEGA }), contexto("undefined"));
      expect(resposta.status).toBe(404);
    }
    expect(participantes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
  it("conversa pessoal segue ausente também na porta de participantes", async () => {
    conversas[0]!["contacts"] = { is_personal: true };
    for (const metodo of [GET, POST, DELETE]) {
      const resposta = await metodo(req(`/api/v1/conversations/${CONV_A}/participants`, metodo === GET ? "GET" : "POST", { user_id: COLEGA }), contexto());
      expect(resposta.status).toBe(404);
    }
    expect(participantes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
  it("suporte somente leitura continua lendo a lista que a RLS admite", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(fail("forbidden", "somente leitura", 403));
    const resposta = await GET(req(`/api/v1/conversations/${CONV_A}/participants`, "GET"), contexto());
    expect(resposta.status).toBe(200);
    expect(requireSupportWrite).not.toHaveBeenCalled();
  });

  it("o mesmo suporte não convida nem remove e não grava auditoria de efeito", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(fail("forbidden", "somente leitura", 403));
    for (const metodo of [POST, DELETE]) {
      const resposta = await metodo(req(`/api/v1/conversations/${CONV_A}/participants`, "POST", { user_id: COLEGA }), contexto());
      expect(resposta.status).toBe(403);
    }
    expect(participantes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/conversations/[id]/participants — convidar", () => {
  it("o DONO convida um colega: 201, o vínculo nasce e o DONO não muda", async () => {
    const resposta = await POST(
      req(`/api/v1/conversations/${CONV_A}/participants`, "POST", { user_id: COLEGA }),
      contexto(),
    );

    expect(resposta.status).toBe(201);
    const corpo = (await resposta.json()) as { data: { participante: { user_id: string } } };
    expect(corpo.data.participante.user_id).toBe(COLEGA);
    expect(participantes).toHaveLength(1);
    expect(participantes[0]).toMatchObject({ user_id: COLEGA, invited_by: DONO, left_at: null });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "conversation.invited", resourceId: CONV_A }),
    );
    // O CASO DA ISSUE: entrar não é assumir. Nada escreveu a conversa.
    expect(atualizacoesDeConversa).toBe(0);
    expect(conversas[0]?.["assigned_to_user_id"]).toBe(DONO);
  });

  it("um agent que NÃO é o dono e NÃO é gestor recebe 403 e nada é convidado", async () => {
    autoriza("agent", COLEGA);
    const resposta = await POST(
      req(`/api/v1/conversations/${CONV_A}/participants`, "POST", { user_id: COLEGA }),
      contexto(),
    );

    expect(resposta.status).toBe(403);
    expect(participantes).toHaveLength(0);
    // A negação de ESCRITA é de verdade e a porta a audita — o que não pode haver
    // é o `conversation.invited` (nada foi convidado).
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "authz.denied" }));
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "conversation.invited" }),
    );
  });

  it("422 quando o alvo não é membro ativo agent+ desta organização", async () => {
    membros = [{ user_id: VIEWER, organization_id: ORG_A, role: "viewer", revoked_at: null }];
    const resposta = await POST(
      req(`/api/v1/conversations/${CONV_A}/participants`, "POST", { user_id: VIEWER }),
      contexto(),
    );

    expect(resposta.status).toBe(422);
    expect(participantes).toHaveLength(0);
  });

  it("404 quando a conversa é de OUTRA organização — e nada é convidado", async () => {
    conversas = [{ id: CONV_B, organization_id: ORG_B, assigned_to_user_id: DONO }];
    const resposta = await POST(
      req(`/api/v1/conversations/${CONV_B}/participants`, "POST", { user_id: COLEGA }),
      contexto(CONV_B),
    );

    expect(resposta.status).toBe(404);
    expect(participantes).toHaveLength(0);
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "conversation.invited" }),
    );
  });

  it("422 quando o corpo não traz um user_id UUID", async () => {
    const resposta = await POST(
      req(`/api/v1/conversations/${CONV_A}/participants`, "POST", { user_id: "nao-e-uuid" }),
      contexto(),
    );

    expect(resposta.status).toBe(422);
    expect(participantes).toHaveLength(0);
  });
});

describe("DELETE /api/v1/conversations/[id]/participants — remover / sair", () => {
  it("o DONO remove o participante: 200, left_at preenchido e o dono intacto", async () => {
    participantes = [
      { id: "00000000-0000-4000-8000-0000000000aa", conversation_id: CONV_A, user_id: COLEGA, organization_id: ORG_A, left_at: null },
    ];
    const resposta = await DELETE(
      req(`/api/v1/conversations/${CONV_A}/participants`, "DELETE", { user_id: COLEGA }),
      contexto(),
    );

    expect(resposta.status).toBe(200);
    expect((await resposta.json()) as { data: { removidos: number } }).toMatchObject({
      data: { removidos: 1 },
    });
    expect(participantes[0]?.["left_at"]).not.toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "conversation.participant_removed" }),
    );
    expect(atualizacoesDeConversa).toBe(0);
  });

  it("um participante pode SAIR sem ser dono nem gestor", async () => {
    // `user_id` do corpo igual ao do chamador: o caso "sair da conversa".
    participantes = [
      { id: "00000000-0000-4000-8000-0000000000bb", conversation_id: CONV_A, user_id: DONO, organization_id: ORG_A, left_at: null },
    ];
    autoriza("agent");
    const resposta = await DELETE(
      req(`/api/v1/conversations/${CONV_A}/participants`, "DELETE", { user_id: DONO }),
      contexto(),
    );

    expect(resposta.status).toBe(200);
    expect(participantes[0]?.["left_at"]).not.toBeNull();
  });
});

describe("GET /api/v1/conversations/[id]/participants — listar", () => {
  it("o DONO lê a lista de participantes ativos", async () => {
    autoriza("agent");
    participantes = [
      { id: "00000000-0000-4000-8000-0000000000cc", conversation_id: CONV_A, user_id: COLEGA, organization_id: ORG_A, invited_by: DONO, joined_at: "2026-10-14T00:00:00Z", left_at: null },
    ];
    const resposta = await GET(
      req(`/api/v1/conversations/${CONV_A}/participants`, "GET", {}),
      contexto(),
    );

    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { data: { participantes: Array<{ user_id: string }> } };
    expect(corpo.data.participantes).toHaveLength(1);
    expect(corpo.data.participantes[0]?.user_id).toBe(COLEGA);
  });

  it("(i) um agent que abre a conversa da FILA (sem dono, sem ser participante) NÃO grava authz.denied", async () => {
    // `visibility_mode` default (`own_and_unassigned`): a RLS mostra a fila sem
    // dono a QUALQUER agent — e ele via a conversa, mas a porta auditada recusava
    // a lista e gravava um `authz.denied` falso a cada abertura.
    conversas = [{ id: CONV_A, organization_id: ORG_A, assigned_to_user_id: null }];
    // Nem dono, nem gestor: se a porta auditada voltar ao caminho, ela NEGA.
    autoriza("agent");
    participantes = [
      { id: "00000000-0000-4000-8000-0000000000dd", conversation_id: CONV_A, user_id: VIEWER, organization_id: ORG_A, invited_by: DONO, joined_at: "2026-10-14T00:00:00Z", left_at: null },
    ];
    const resposta = await GET(
      req(`/api/v1/conversations/${CONV_A}/participants`, "GET", {}),
      contexto(),
    );

    // Nada de `authz.denied` — e, por consequência, nada da porta que o grava.
    expect(audit).not.toHaveBeenCalled();
    expect(requireRole).not.toHaveBeenCalled();
    expect(resposta.status).toBe(200);
  });

  it("(ii) um viewer que abre a conversa NÃO grava authz.denied", async () => {
    // `fn_can_view_conversation` dá leitura org-wide a viewer/manager/admin.
    // E o `viewer` NÃO alcança o `agent` do topo: se a porta voltar, ela nega.
    sessao(VIEWER, "viewer");
    autoriza("viewer", VIEWER);
    const resposta = await GET(
      req(`/api/v1/conversations/${CONV_A}/participants`, "GET", {}),
      contexto(),
    );

    expect(audit).not.toHaveBeenCalled();
    expect(requireRole).not.toHaveBeenCalled();
    expect(resposta.status).toBe(200);
  });

  it("(iii) o PARTICIPANTE convidado continua vendo a LISTA (o ramo da RLS)", async () => {
    // A RLS de `conversations` já tem o ramo do participante (migration 0661):
    // ele vê a conversa, então vê quem participa. O caso não pode ficar verde só
    // porque o GET deixou de sair — aqui a lista CHEGA.
    sessao(COLEGA);
    autoriza("agent", COLEGA);
    participantes = [
      { id: "00000000-0000-4000-8000-0000000000ee", conversation_id: CONV_A, user_id: COLEGA, organization_id: ORG_A, invited_by: DONO, joined_at: "2026-10-14T00:00:00Z", left_at: null },
    ];
    const resposta = await GET(
      req(`/api/v1/conversations/${CONV_A}/participants`, "GET", {}),
      contexto(),
    );

    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { data: { participantes: Array<{ user_id: string }> } };
    expect(corpo.data.participantes).toHaveLength(1);
    expect(corpo.data.participantes[0]?.user_id).toBe(COLEGA);
    expect(audit).not.toHaveBeenCalled();
  });

  it("quem a RLS NÃO deixa ver recebe 404 — e nada é auditado", async () => {
    autoriza("agent");
    visiveis = new Set();
    const resposta = await GET(
      req(`/api/v1/conversations/${CONV_A}/participants`, "GET", {}),
      contexto(),
    );

    expect(resposta.status).toBe(404);
    expect(requireRole).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
