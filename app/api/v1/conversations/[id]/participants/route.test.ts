import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";

import { DELETE, GET, POST } from "./route";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

/**
 * /api/v1/conversations/[id]/participants (issue #2542) — a PORTA do convite.
 *
 * O duplê do banco é dominado pelas queries da rota: `conversations` (a
 * conversa com dono), `user_organizations` (o alvo tem de ser membro ativo
 * `agent`+) e `conversation_participants` (o vínculo). O que se mede aqui é o
 * que a RLS não pode medir: QUEM pode chamar (dono ou gestor), o alvo barrado e
 * — o caso da issue — o convite NÃO escrever `assigned_to_user_id`. O acesso do
 * convidado à conversa é medido no invariante de banco (test:db).
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
let atualizacoesDeConversa: number;
let idSeq: number;

/** O duplê genérico: filtros encadeáveis + `maybeSingle`/`then` que resolvem. */
function clienteFake() {
  const tabelaDe = (t: string): Linha[] =>
    t === "conversations" ? conversas : t === "user_organizations" ? membros : participantes;

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

/**
 * A autorização: `agent` sempre OK (org A), e `manager` conforme o caso.
 * `chamador` é quem está logado — é ele, e não o dono da conversa, que decide
 * se o caminho "dono OU gestor" passa.
 */
function autoriza(gestorOk: boolean, chamador = DONO) {
  vi.mocked(requireRole).mockImplementation(async (role: string) => {
    if (role === "manager") {
      return gestorOk
        ? ({ ok: true, user: { id: chamador, idioma: "pt-BR" }, org: { orgId: ORG_A, role: "manager" } } as never)
        : ({ ok: false, response: fail("forbidden_role", "negado", 403) } as never);
    }
    return {
      ok: true,
      user: { id: chamador, idioma: "pt-BR" },
      org: { orgId: ORG_A, role: "agent" },
    } as never;
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  conversas = [{ id: CONV_A, organization_id: ORG_A, assigned_to_user_id: DONO }];
  membros = [{ user_id: COLEGA, organization_id: ORG_A, role: "agent", revoked_at: null }];
  participantes = [];
  atualizacoesDeConversa = 0;
  idSeq = 1;
  vi.mocked(requireSupportWrite).mockResolvedValue(
    null as unknown as Awaited<ReturnType<typeof requireSupportWrite>>,
  );
  vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
  const admin = clienteFake();
  const { createAdminClient } = await import("@/lib/supabase/admin");
  vi.mocked(createAdminClient).mockReturnValue(admin as never);
  autoriza(true);
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

  it("um agent que NÃO é o dono e NÃO é gestor recebe 403 e nada é gravado", async () => {
    autoriza(false, COLEGA);
    const resposta = await POST(
      req(`/api/v1/conversations/${CONV_A}/participants`, "POST", { user_id: COLEGA }),
      contexto(),
    );

    expect(resposta.status).toBe(403);
    expect(participantes).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
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

  it("404 quando a conversa é de OUTRA organização — e nada é gravado", async () => {
    conversas = [{ id: CONV_B, organization_id: ORG_B, assigned_to_user_id: DONO }];
    const resposta = await POST(
      req(`/api/v1/conversations/${CONV_B}/participants`, "POST", { user_id: COLEGA }),
      contexto(CONV_B),
    );

    expect(resposta.status).toBe(404);
    expect(participantes).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
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
    autoriza(false);
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

  it("um PARTICIPANTE lê a lista sem passar pela checagem de gestor (que auditaria um authz.denied falso)", async () => {
    participantes = [
      { id: "00000000-0000-4000-8000-0000000000dd", conversation_id: CONV_A, user_id: COLEGA, organization_id: ORG_A, invited_by: DONO, joined_at: "2026-10-14T00:00:00Z", left_at: null },
    ];
    autoriza(false, COLEGA);
    const resposta = await GET(
      req(`/api/v1/conversations/${CONV_A}/participants`, "GET", {}),
      contexto(),
    );

    expect(resposta.status).toBe(200);
    // `requireRole("manager")` audita a negação: chamá-lo para quem já participa
    // gravava `authz.denied` em todo GET legítimo.
    expect(vi.mocked(requireRole).mock.calls.map((c) => c[0])).not.toContain("manager");
  });

  it("quem não é dono, nem participante, nem gestor recebe 404", async () => {
    autoriza(false, COLEGA);
    const resposta = await GET(
      req(`/api/v1/conversations/${CONV_A}/participants`, "GET", {}),
      contexto(),
    );

    expect(resposta.status).toBe(404);
  });
});
