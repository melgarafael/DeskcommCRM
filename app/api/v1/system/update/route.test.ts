import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertError: { code: "", message: "" },
  insertData: null as { id: string } | null,
  insertPayload: null as Record<string, unknown> | null,
  versao: { current_version: "1.0.0", latest_version: "1.1.0", updated_at: "2026-01-01T00:00:00.000Z" },
  // O run mais recente, lido sem filtro (é o que a tela também lê). O check de
  // run em andamento vem COM `.eq("status")`, e por isso devolve null aqui.
  runAnterior: null as Record<string, unknown> | null,
  audit: vi.fn(),
  escrita: vi.fn(async () => ({ user: { id: "owner" }, platformAdmin: { user_id: "owner", scope: "full", mfa_required: false } })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "owner", is_platform_admin: true }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdminEscrita: mocks.escrita,
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      let comEq = false;
      const query = {
        select: () => query,
        eq: () => {
          comEq = true;
          return query;
        },
        order: () => query,
        limit: () => query,
        insert: (payload: Record<string, unknown>) => {
          mocks.insertPayload = payload;
          return query;
        },
        maybeSingle: async () => ({
          data:
            table === "system_version"
              ? { ...mocks.versao }
              : comEq
                ? null
                : mocks.runAnterior,
          error: null,
        }),
        single: async () => ({
          data: mocks.insertData,
          error: mocks.insertError.code ? mocks.insertError : null,
        }),
      };
      return query;
    },
  }),
}));

import { POST } from "./route";

function pedido(corpo?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/system/update", {
    method: "POST",
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertError = { code: "", message: "" };
  mocks.insertData = null;
  mocks.insertPayload = null;
  mocks.versao = { current_version: "1.0.0", latest_version: "1.1.0", updated_at: "2026-01-01T00:00:00.000Z" };
  mocks.runAnterior = null;
  // A derivação compara o alvo do run com a versão EM EXECUÇÃO; sem fixar isto
  // o resultado depende do ambiente de quem roda a suíte.
  process.env.APP_VERSION = "0.0.0-nenhuma";
});

it("explica a preparação de extensão que bloqueia a atualização sem despachar um run", async () => {
  mocks.insertError = { code: "P0001", message: "extension_preparation_in_progress" };
  const response = await POST(
    new NextRequest("http://localhost/api/v1/system/update", { method: "POST" }),
  );
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body.error.code).toBe("state_conflict");
  expect(body.error.message).toContain("Abra Extensões");
  expect(mocks.audit).not.toHaveBeenCalled();
});

it("a recusa nomeia as duas saídas da preparação: quem pediu retoma, qualquer responsável cancela", async () => {
  // O mesmo par de saídas que a gestão de extensões oferece (`SQL_ERRORS`): uma recusa que só
  // dissesse "há uma extensão em preparação" deixaria quem opera a VPS sem o que fazer.
  mocks.insertError = { code: "P0001", message: "extension_preparation_in_progress" };
  const response = await POST(
    new NextRequest("http://localhost/api/v1/system/update", { method: "POST" }),
  );
  const { error } = await response.json();
  expect(error.message).toContain("Atividade recente");
  expect(error.message).toContain("quem pediu pode retomar o pedido");
  expect(error.message).toContain("qualquer responsável pela instalação pode cancelá-lo");
});

it("não disfarça falha de infraestrutura como conflito de extensão", async () => {
  mocks.insertError = { code: "08006", message: "connection failed" };
  const response = await POST(
    new NextRequest("http://localhost/api/v1/system/update", { method: "POST" }),
  );
  expect(response.status).toBe(500);
  expect((await response.json()).error.message).not.toContain("Abra Extensões");
});

it("support_readonly não dispara atualização: 403 forbidden_scope, nada gravado", async () => {
  const { EscritaDePlatformAdminNegada } = await import("@/lib/auth/requirePlatformAdmin");
  mocks.escrita.mockRejectedValueOnce(new EscritaDePlatformAdminNegada("forbidden_scope", "somente leitura"));
  const response = await POST(new NextRequest("http://localhost/api/v1/system/update", { method: "POST" }));
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("forbidden_scope");
  expect(mocks.audit).not.toHaveBeenCalled();
});

// ── O clique de força (#2756) ────────────────────────────────────────────────
//
// O estado de falha é o caso em que `current` e `latest` coincidem (o checkout
// deu certo; o container é que não subiu). O botão normal morre exatamente
// aí, de propósito — é o falso sucesso. O de força atravessa, e atravessa com
// um alvo que o SERVIDOR deriva do mesmo run que a tela está mostrando.

it("o clique de sempre num servidor já na versão alvo continua 409: o desligado não afrouxou", async () => {
  mocks.versao = { current_version: "1.0.0", latest_version: "1.0.0", updated_at: "2026-01-01T00:00:00.000Z" };

  const response = await POST(pedido());

  expect(response.status).toBe(409);
  expect((await response.json()).error.message).toContain("mais recente");
  expect(mocks.insertPayload).toBeNull();
});

it("a força atravessa esse mesmo 409 e registra o run com a intenção", async () => {
  mocks.versao = { current_version: "1.0.0", latest_version: "1.0.0", updated_at: "2026-01-01T00:00:00.000Z" };
  mocks.insertData = { id: "run-forcado" };

  const response = await POST(pedido({ force: true }));

  expect(response.status).toBe(200);
  expect(mocks.insertPayload).toMatchObject({
    status: "dispatched",
    requested_by: "owner",
    from_version: "1.0.0",
    force_requested: true,
    // Sem falha anterior que valha a pena, não há `--to` a prometer.
    force_target: "",
  });
});

it("o alvo da força vem do run de falha — o mesmo --to que a tela mostra ao lado do botão", async () => {
  // A tela lê `run.from_version` e monta `update.sh --to v1.0.0 --force`; o
  // servidor lê a MESMA coluna do MESMO run e guarda o MESMO alvo.
  mocks.versao = { current_version: "1.1.0", latest_version: "", updated_at: "2026-01-01T00:00:00.000Z" };
  mocks.runAnterior = {
    from_version: "1.0.0",
    to_version: "1.1.0",
    status: "failed",
    finished_at: "2026-01-02T00:00:00.000Z",
  };
  mocks.insertData = { id: "run-forcado" };

  const response = await POST(pedido({ force: true }));

  expect(response.status).toBe(200);
  expect(mocks.insertPayload).toMatchObject({
    force_requested: true,
    force_target: "v1.0.0",
    // O que ESTE run vai instalar é o alvo dele, não o `latest` anunciado —
    // numa falha o host costuma nem anunciar tag, e o `just_updated` diria
    // "atualização para a versão " com o nome vazio.
    to_version: "v1.0.0",
  });
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({ metadata: expect.objectContaining({ force: true, force_target: "v1.0.0" }) }),
  );
});

it("falha JÁ SUPERADA não vira alvo: um clique velho não arrasta o servidor para trás", async () => {
  // O deploy novo já passou da tentativa que falhou (o host reporta uma versão
  // que o run não descreve). A tela não mostra mais o botão nesse estado; se o
  // pedido chegar mesmo assim, ele força a versão publicada, sem `--to`.
  mocks.versao = { current_version: "2.0.0", latest_version: "2.1.0", updated_at: "2026-01-05T00:00:00.000Z" };
  mocks.runAnterior = {
    from_version: "1.0.0",
    to_version: "1.1.0",
    status: "failed",
    finished_at: "2026-01-02T00:00:00.000Z",
  };
  mocks.insertData = { id: "run-forcado" };

  await POST(pedido({ force: true }));

  expect(mocks.insertPayload).toMatchObject({ force_target: "", to_version: "2.1.0" });
});

it("rodada limpa: a força não arruma alvo nenhum, e o próprio update.sh resolve o que instalar", async () => {
  mocks.runAnterior = {
    from_version: "0.9.0",
    to_version: "1.0.0",
    status: "success",
    finished_at: "2026-01-02T00:00:00.000Z",
  };
  mocks.insertData = { id: "run-forcado" };

  await POST(pedido({ force: true }));

  expect(mocks.insertPayload).toMatchObject({ force_target: "", to_version: "1.1.0" });
});

it("corpo que não é booleano é 422 — força silenciosa não existe", async () => {
  const response = await POST(pedido({ force: "sim" }));

  expect(response.status).toBe(422);
  expect(mocks.insertPayload).toBeNull();
});

it("sem corrida com o botão normal: o pedido de sempre segue sem `force` no run", async () => {
  mocks.insertData = { id: "run-normal" };

  const response = await POST(pedido({}));

  expect(response.status).toBe(200);
  expect(mocks.insertPayload).toMatchObject({ force_requested: false, force_target: "", to_version: "1.1.0" });
});
