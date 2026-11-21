/**
 * `GET/PATCH /api/v1/settings/proposals` com a camada POR EMPRESA (#4871, F2 do
 * #3868).
 *
 * A rota decidia o 404 só pela instalação. Agora ela passa a organização do
 * request (`authz.organizationId`, resolvido por `resolveAuthDual`), e o teste NÃO dubla `moduloLigado`: o dublê de
 * banco aplica os filtros de verdade, então perder o `organization_id` é o que
 * fica vermelho.
 *
 * As combinações da fatia, no lado da rota:
 *
 *  - instalação LIGADA + empresa DESLIGADA  → 404 nas DUAS mãos, e o PATCH não
 *    escreve nada;
 *  - instalação LIGADA + empresa LIGADA/sem linha → 200;
 *  - instalação DESLIGADA + empresa LIGADA  → 404 (o piso não cai).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAVE_DO_MODULO } from "@/lib/instalacao/modulos";
import { bancoDeDuasEmpresas } from "@/tests/helpers/postgrest-de-duas-empresas";

const ORG_A = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  banco: { cliente: {} as unknown },
  requireRole: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.banco.cliente }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => mocks.banco.cliente) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));

import { GET, PATCH } from "@/app/api/v1/settings/proposals/route";

function mundo(opcoes: { instalacaoLigada: boolean; linhaDaEmpresa?: "ligado" | "desligado" }) {
  const banco = bancoDeDuasEmpresas({
    platform_config: opcoes.instalacaoLigada
      ? [{ chave: CHAVE_DO_MODULO.propostas, valor: "ligado" }]
      : [{ chave: CHAVE_DO_MODULO.propostas, valor: "desligado" }],
    organization_modules:
      opcoes.linhaDaEmpresa === undefined
        ? []
        : [{ organization_id: ORG_A, modulo: "propostas", estado: opcoes.linhaDaEmpresa }],
    organizations: [{ id: ORG_A, settings: { proposals: { enabled: true, default_valid_days: 15 } } }],
  });
  mocks.banco.cliente = banco.cliente;
  mocks.requireRole.mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_A },
  } as never);
  return banco;
}

function ler() {
  // Sem `Authorization`, `resolveAuthDual` segue pela sessão de navegador (`requireRole`).
  return GET(new Request("http://localhost/api/v1/settings/proposals") as never);
}

async function patch(corpo: unknown) {
  const req = new Request("http://localhost/api/v1/settings/proposals", {
    method: "PATCH",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
  // A rota tipa `NextRequest`; o que ela usa do request é `req.json()`.
  return PATCH(req as never);
}

describe("a rota de Propostas consulta a empresa, não só a instalação", () => {
  beforeEach(() => {
    mocks.requireRole.mockReset();
  });

  it("instalação ligada + empresa desligada: GET e PATCH respondem 404, e o PATCH não escreve", async () => {
    const banco = mundo({ instalacaoLigada: true, linhaDaEmpresa: "desligado" });

    const leitura = await ler();
    expect(leitura.status).toBe(404);

    const escrita = await patch({ enabled: true, default_valid_days: 15, default_conditions: null });
    expect(escrita.status).toBe(404);
    expect(banco.escritas()).toEqual([]);

    // A prova de que a organização chegou ao gate: a leitura foi filtrada por ela.
    expect(banco.chamadas.some((c) => c.tabela === "organization_modules" && c.filtros.some(([col, v]) => col === "organization_id" && v === ORG_A))).toBe(true);
  });

  it("instalação ligada + empresa ligada: GET 200 e PATCH 200", async () => {
    mundo({ instalacaoLigada: true, linhaDaEmpresa: "ligado" });
    expect((await ler()).status).toBe(200);
    const escrita = await patch({ enabled: true, default_valid_days: 15, default_conditions: null });
    expect(escrita.status).toBe(200);
  });

  it("instalação ligada + empresa sem linha: herda a instalação (controle)", async () => {
    mundo({ instalacaoLigada: true });
    expect((await ler()).status).toBe(200);
  });

  it("instalação DESLIGADA + empresa ligada: 404 — a instalação continua sendo o teto", async () => {
    mundo({ instalacaoLigada: false, linhaDaEmpresa: "ligado" });
    expect((await ler()).status).toBe(404);
    expect((await patch({ enabled: true, default_valid_days: 15, default_conditions: null })).status).toBe(404);
  });
});
