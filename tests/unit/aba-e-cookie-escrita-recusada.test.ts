/**
 * #2335, metade 2 — A ESCRITA NÃO VAI PARA A ORGANIZAÇÃO ERRADA.
 *
 * O cenário real é UM cookie e DUAS abas: alguém troca de organização no
 * seletor (só aquela aba recarrega), e a outra segue com as props antigas.
 * Aqui as duas metades do servidor, no mesmo contexto:
 *
 *   - o `apiClient` DECLARA a organização da aba em toda mutação, no header
 *     `X-Org-Da-Aba` (a leitura/GET não declara nada);
 *   - o `requireRole` — o gate que toda rota /api/v1 atravessa — COMPARA esse
 *     header com o cookie e recusa com o código próprio `org_divergente`
 *     (409), cujos `details` trazem o nome da organização da sessão;
 *   - a tela traduz o código no MESMO aviso da metade 1 (leitura).
 *
 * Tudo isto é NOVO: na main o header não existe e a divergência passa em
 * branco — a escrita cai na organização do cookie, que é a que ninguém na
 * tela pediu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import {
  CODIGO_ORG_DIVERGENTE,
  HEADER_ORG_DA_ABA,
  definirOrgDaAba,
} from "@/lib/auth/org-da-aba";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, orgAtivaSemPortao } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser, Role } from "@/lib/auth/types";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  loadAuthUser: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn() } }));

/** Duas organizações do MESMO usuário — só o cookie muda de uma para a outra. */
const ORG_DA_ABA = "org-A";
const ORG_DO_COOKIE = "org-B";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "user@example.com",
  full_name: null,
  avatar_url: null,
  is_platform_admin: false,
  platform_admin_scope: null,
  idioma: "pt-BR" as const,
  organizations: [
    { organization_id: ORG_DA_ABA, organization_name: "A", role: "admin" as Role, org_status: "active" },
    { organization_id: ORG_DO_COOKIE, organization_name: "B", role: "admin" as Role, org_status: "active" },
  ],
} as unknown as AuthUser;

/** O que a REQUISIÇÃO traz: cookie `active_org` já resolvido + header da aba. */
function requisicao(opts: { cookie: string | null; aba?: string | null }) {
  vi.mocked(orgAtivaSemPortao).mockResolvedValue(
    opts.cookie
      ? {
          orgId: opts.cookie,
          name: opts.cookie === ORG_DO_COOKIE ? "B" : "A",
          role: "admin",
          org_status: "active",
        }
      : null,
  );
  vi.mocked(headers).mockResolvedValue({
    get: (chave: string) =>
      chave === HEADER_ORG_DA_ABA && opts.aba ? opts.aba : null,
  } as never);
}

function resposta(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  definirOrgDaAba({ orgId: ORG_DA_ABA, nome: "A", idioma: "pt-BR" });
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(createClient).mockResolvedValue({
    rpc: vi.fn(async () => ({ data: "admin", error: null })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

afterEach(() => {
  definirOrgDaAba(null);
  vi.unstubAllGlobals();
});

describe("apiClient — a aba declara a própria organização na escrita", () => {
  it("carimba o header X-Org-Da-Aba em toda mutação", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => resposta(200, { ok: true }));
    vi.stubGlobal("fetch", fetcher);

    await apiClient.post("/api/v1/contatos", { nome: "Ana" });

    const init = fetcher.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)[HEADER_ORG_DA_ABA]).toBe(ORG_DA_ABA);
  });

  it("leitura não carrega o header — a recusa é sobre escrita", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => resposta(200, { ok: true }));
    vi.stubGlobal("fetch", fetcher);

    await apiClient.get("/api/v1/contatos");

    const init = fetcher.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)[HEADER_ORG_DA_ABA]).toBeUndefined();
  });

  it("a recusa do servidor vira o MESMO aviso da leitura (#2335, metade 1)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        resposta(409, {
          error: {
            code: CODIGO_ORG_DIVERGENTE,
            message: "Esta aba está numa organização diferente da sessão. Recarregar?",
            details: { organization_id: ORG_DO_COOKIE, organization_name: "B" },
          },
        }),
      ),
    );

    await expect(apiClient.post("/api/v1/contatos", { nome: "Ana" })).rejects.toBeInstanceOf(
      ApiError,
    );

    expect(toast.warning).toHaveBeenCalledOnce();
    const [mensagem] = vi.mocked(toast.warning).mock.calls[0]!;
    expect(mensagem).toContain("organização diferente da sessão");
    expect(mensagem).toContain("(A → B)");
    const opcoes = vi.mocked(toast.warning).mock.calls[0]![1] as { action: { label: string } };
    expect(opcoes.action.label).toBe("Recarregar");
  });
});

describe("requireRole — o gate único recusa a divergência", () => {
  it("409 org_divergente quando a aba está em outra organização do cookie", async () => {
    requisicao({ cookie: ORG_DO_COOKIE, aba: ORG_DA_ABA });

    const res = await requireRole("viewer", { requestId: "req-1" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.response.status).toBe(409);
    const body = await res.response.json();
    expect(body.error.code).toBe(CODIGO_ORG_DIVERGENTE);
    // Os detalhes são o que a tela põe no aviso — nada de uuid cru sozinho.
    expect(body.error.details).toEqual({ organization_id: ORG_DO_COOKIE, organization_name: "B" });
  });

  it("aba e cookie na mesma organização segue passando", async () => {
    requisicao({ cookie: ORG_DO_COOKIE, aba: ORG_DO_COOKIE });

    const res = await requireRole("viewer");

    expect(res.ok).toBe(true);
  });

  it("sem header (leitura, ou quem não usa o apiClient) nada muda", async () => {
    requisicao({ cookie: ORG_DO_COOKIE, aba: null });

    const res = await requireRole("viewer");

    expect(res.ok).toBe(true);
  });

  it("com organizationId (org do RECURSO) a régua continua sendo o cookie", async () => {
    // LGPD anonymize escreve na org do CONTATO: o override é esperado e não
    // pode ser confundido com a divergência aba × cookie.
    requisicao({ cookie: ORG_DO_COOKIE, aba: ORG_DO_COOKIE });

    const res = await requireRole("viewer", { organizationId: ORG_DA_ABA });

    expect(res.ok).toBe(true);
  });
});

describe("requireRole — o header só RECUSA, nunca escolhe a organização", () => {
  function rpcEspiao() {
    const rpc = vi.fn(async () => ({ data: "admin", error: null }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(createClient).mockResolvedValue({ rpc } as any);
    return rpc;
  }

  it("header com organização da qual a pessoa NÃO é membro → 409, papel nunca resolvido", async () => {
    const rpc = rpcEspiao();
    requisicao({ cookie: ORG_DO_COOKIE, aba: "org-alheia" });

    const res = await requireRole("viewer");

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.response.status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("membro das duas, header numa e cookie na outra → 409, e o papel nunca é lido na org do header", async () => {
    const rpc = rpcEspiao();
    requisicao({ cookie: ORG_DO_COOKIE, aba: ORG_DA_ABA });

    const res = await requireRole("viewer");

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.response.status).toBe(409);
    expect(rpc).not.toHaveBeenCalledWith("fn_user_role_in_org", { p_org: ORG_DA_ABA });
  });

  it("headers() lançando (fora de requisição) não recusa nada", async () => {
    requisicao({ cookie: ORG_DO_COOKIE });
    vi.mocked(headers).mockRejectedValue(new Error("fora de requisição"));

    const res = await requireRole("viewer");

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.org.orgId).toBe(ORG_DO_COOKIE);
  });
});
