/**
 * O SELETOR DA JANELA FECHADA NÃO NASCE VAZIO PARA QUEM ATENDE (#2328).
 *
 * ─── O defeito ───────────────────────────────────────────────────────────────
 *
 * `JanelaFechadaAviso` pede `GET /api/v1/channels/templates` e filtra o que
 * voltou por `status === "APPROVED"`. Essa rota é a ÚNICA fonte das definições
 * do canal oficial para a tela (ver `lib/channels/templates-fonte.ts`), e ela
 * pedia `requireRole("admin")` para TODOS os métodos. Um usuário convidado com
 * papel `agent` levava `403 forbidden_role`, o `useQuery` ficava sem `data`, a
 * lista filtrada virava `[]` e o seletor aparecia vazio — o operador que atende
 * não tinha por onde reabrir a conversa com a janela de 24 h fechada.
 *
 * ─── A causa medida ──────────────────────────────────────────────────────────
 *
 * Mesma conta, mesmo usuário, mesmo pedido — só o PAPEL muda. As duas saídas
 * saem literais no stdout da suíte:
 *
 *   AGENT → GET /api/v1/channels/templates → 403 {"error":{"code":"forbidden_role",…}}
 *   ADMIN → GET /api/v1/channels/templates → 200 {"data":{"templates":[…APPROVED]}}
 *
 * O gate é o `requireRole` de produção (a decisão de rank NÃO está mockada;
 * só a sessão e o Supabase é que estão, como em `rbac-matrix.test.ts`).
 *
 * ─── O que fica preso aqui ───────────────────────────────────────────────────
 *
 * 1. `agent` lê a MESMA lista que `admin` lê (200 + a definição aprovada),
 *    então o seletor do painel tem o que oferecer;
 * 2. `viewer` continua barrado — o leitor mínimo desta lista é `agent`;
 * 3. a ESCRITA continua de `admin`: sincronizar modelos (POST) e gravar o link
 *    da mídia (PATCH) escrevem na configuração do canal, e ninguém que só
 *    atende mexe nela.
 *
 * ─── Medir ───────────────────────────────────────────────────────────────────
 *
 *   pnpm exec vitest run tests/unit/modelos-oficiais-papel-agent.test.ts
 *
 * Para ver morder, volte o `requireRole("admin")` do GET em
 * `app/api/v1/channels/templates/route.ts`: o primeiro caso reprova com 403.
 */
import { readFileSync } from "node:fs";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, PATCH, POST } from "@/app/api/v1/channels/templates/route";
import { loadAuthUser, orgAtivaSemPortao, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser, Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
  // Sessão sem dívida de MFA: o que se mede aqui é RBAC, não o segundo fator.
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/channels/meta/session", () => ({
  metaSessionForOrg: vi.fn(async () => ({ wabaId: "WABA-2328", phoneNumberId: "PN-2328" })),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/**
 * O espelho local de uma conta real: definições aprovadas da Graph API +
 * uma que ainda está em revisão (a tela da janela fechada filtra por
 * `APPROVED`; lista sem filtro nenhum aqui seria um espelho de mentira).
 */
const FIXTURE = JSON.parse(
  readFileSync("tests/fixtures/meta/message-templates.json", "utf8"),
) as { data: Array<{ name: string; language: string; status: string; category: string; components: unknown[] }> };

const LINHAS = [
  ...FIXTURE.data
    .filter((t) => t.status === "APPROVED")
    .slice(0, 2)
    .map((t) => ({
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      rejected_reason: null,
      quality_score: "GREEN",
      parameter_format: "POSITIONAL",
      contract_hash: "hash-2328",
      components: t.components,
      synced_at: "2026-10-01T00:00:00.000Z",
      saved_values: {},
    })),
  {
    name: "pedido_em_revisao_v1",
    language: "pt_BR",
    status: "PENDING",
    category: "UTILITY",
    rejected_reason: null,
    quality_score: null,
    parameter_format: "POSITIONAL",
    contract_hash: "hash-2328-pending",
    components: [{ type: "BODY", text: "Ainda em revisão na plataforma." }],
    synced_at: "2026-10-01T00:00:00.000Z",
    saved_values: {},
  },
];

/** Cadeia PostgREST thenável: `.select().eq().order()…` resolve em `{data,error}`. */
function cadeiaEspelho() {
  const alvo: Record<string, unknown> = {};
  const encadear = () => alvo;
  alvo.select = encadear;
  alvo.eq = encadear;
  alvo.order = encadear;
  alvo.limit = encadear;
  Object.defineProperty(alvo, "then", {
    configurable: true,
    value: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: LINHAS, error: null }).then(resolve, reject),
  });
  return alvo;
}

/** O `rpc fn_user_role_in_org` que o `requireRole` lê do banco. */
function clienteDoUsuario(role: Role | null) {
  return {
    auth: {
      getUser: async () =>
        role ? { data: { user: { id: USER_ID } }, error: null } : { data: { user: null }, error: null },
    },
    from: () => ({}) as never,
    rpc: async (fn: string) =>
      fn === "fn_user_role_in_org" ? { data: role, error: null } : { data: null, error: null },
  };
}

/** Sessão autenticada na MESMA conta, com o papel que o caso pede. */
function session(role: Role | null) {
  const user: AuthUser | null = role
    ? {
        id: USER_ID,
        email: "atendente@example.com",
        full_name: null,
        avatar_url: null,
        is_platform_admin: false,
        idioma: "pt-BR" as const,
        organizations: [{ organization_id: ORG_ID, organization_name: "Conta 2328", role }],
      }
    : null;
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue(role ? { orgId: ORG_ID, name: "Conta 2328", role } : null);
  vi.mocked(orgAtivaSemPortao).mockResolvedValue(
    role ? { orgId: ORG_ID, name: "Conta 2328", role, org_status: "active" } : null,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(clienteDoUsuario(role) as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createAdminClient).mockReturnValue({ from: () => cadeiaEspelho() } as any);
}

const req = (method?: string, body?: unknown) =>
  new NextRequest("http://localhost/api/v1/channels/templates", {
    method: method ?? "GET",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A saída LITERAL da rota, para o registro da medição no PR. */
async function medir(papel: Role): Promise<{ status: number; corpo: string }> {
  session(papel);
  const res = await GET();
  return { status: res.status, corpo: await res.text() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/channels/templates — mesma conta, papel diferente", () => {
  it("agent recebe a lista completa: o seletor aprovado não nasce vazio", async () => {
    const { status, corpo } = await medir("agent");
    console.info(`AGENT → GET /api/v1/channels/templates → ${status} ${corpo}`);

    expect(status).toBe(200);
    const { data } = JSON.parse(corpo) as {
      data: { waba: string | null; templates: Array<{ name: string; status: string; components: unknown[] }> };
    };
    // O mesmo filtro que `JanelaFechadaAviso` faz no cliente.
    const aprovados = data.templates.filter((t) => t.status?.toUpperCase() === "APPROVED");
    expect(aprovados.length).toBeGreaterThan(0);
    // Com corpo derivado da definição aprovada, sem cair no nome técnico.
    expect(aprovados[0]!.components.length).toBeGreaterThan(0);
    // E a definição em revisão continua fora da lista do seletor.
    expect(data.templates.some((t) => t.name === "pedido_em_revisao_v1")).toBe(true);
    expect(aprovados.some((t) => t.name === "pedido_em_revisao_v1")).toBe(false);
    expect(data.waba).toBe("WABA-2328");
  });

  it("admin da MESMA conta recebe a MESMA lista", async () => {
    const { status, corpo } = await medir("admin");
    console.info(`ADMIN → GET /api/v1/channels/templates → ${status} ${corpo}`);

    expect(status).toBe(200);
    const { data } = JSON.parse(corpo) as { data: { templates: Array<{ name: string }> } };
    expect(data.templates.map((t) => t.name)).toContain("pedido_em_revisao_v1");
  });

  it("viewer continua barrado: o leitor mínimo desta lista é agent", async () => {
    const { status, corpo } = await medir("viewer");
    console.info(`VIEWER → GET /api/v1/channels/templates → ${status} ${corpo}`);

    expect(status).toBe(403);
    expect(JSON.parse(corpo)).toMatchObject({ error: { code: "forbidden_role" } });
  });
});

describe("a escrita continua de admin", () => {
  it("agent não sincroniza modelos (POST 403)", async () => {
    session("agent");
    const res = await POST(req("POST"));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "forbidden_role" } });
  });

  it("agent não grava link de mídia no modelo (PATCH 403)", async () => {
    session("agent");
    const res = await PATCH(
      req("PATCH", { name: "hello_world", language: "en_US", values: { "1": "https://x/y.png" } }),
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "forbidden_role" } });
  });
});
