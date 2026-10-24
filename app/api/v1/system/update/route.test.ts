import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // `null` (e não `{ code: "", message: "" }`) porque a rota checa `if (error)`:
  // um objeto vazio é truthy e viraria 500 "não consegui registrar o pedido"
  // em TODO caminho de sucesso — o mock antigo só passava porque nenhum caso
  // original chegava ao insert.
  insertError: null as { code: string; message: string } | null,
  audit: vi.fn(),
  escrita: vi.fn(async () => ({ user: { id: "owner" }, platformAdmin: { user_id: "owner", scope: "full", mfa_required: false } })),
  /**
   * Fila de respostas por tabela: cada `maybeSingle()` consome a próxima da
   * fila; esgotada, vale o padrão (system_version com 1.0.0 → 1.1.0; o resto,
   * sem linha). Preciso de fila — e não de "a última chamada" — porque a volta
   * (#2757) consulta `system_update_runs` DUAS vezes na mesma requisição: o
   * último run (o alvo) e o run em andamento (a cerca).
   */
  respostas: {} as Record<string, Array<{ data: unknown; error: { code: string; message: string } | null }>>,
  /** Linha devolvida pelo `single()` do insert quando não há `insertError`. */
  runInserido: { id: "run-novo", status: "dispatched" } as Record<string, unknown> | null,
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
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        insert: () => query,
        maybeSingle: async () => {
          const fila = mocks.respostas[table] ?? [];
          if (fila.length > 0) return fila.shift()!;
          return {
            data:
              table === "system_version"
                ? { current_version: "1.0.0", latest_version: "1.1.0" }
                : null,
            error: null,
          };
        },
        single: async () => ({ data: mocks.runInserido, error: mocks.insertError }),
      };
      return query;
    },
  }),
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertError = null;
  mocks.respostas = {};
  mocks.runInserido = { id: "run-novo", status: "dispatched" };
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

// ── O pedido de volta (#2757) ──────────────────────────────────────────────
//
// O botão "Voltar para a versão anterior" manda o MESMO pedido que a tela já
// mostrava em forma de comando — e o alvo é a versão de onde a última
// tentativa SAIU (`from_version` do último run), nunca a última release:
// instalar a publicada seria reinstalar a release que acabou de quebrar.
// O `--force` é assunto do agente do host (é ele que tem o git na mão);
// aqui só se registra a ordem, como em todo pedido.

function reqDeVolta() {
  return new NextRequest("http://localhost/api/v1/system/update", {
    method: "POST",
    body: JSON.stringify({ rollback: true }),
  });
}

/** O que a rota lê de `system_update_runs`: primeiro o último run, depois a cerca. */
function comRuns(ultimaTentativa: unknown, emAndamento: unknown = null) {
  mocks.respostas.system_update_runs = [
    { data: ultimaTentativa, error: null },
    { data: emAndamento, error: null },
  ];
}

it("registra a volta com alvo na versão de onde se saiu, e não na última publicada", async () => {
  comRuns({ id: "run-quebrado", status: "failed", from_version: "1.0.0" });
  const res = await POST(reqDeVolta());
  expect(res.status).toBe(200);
  const body = await res.json();
  // O run pedido é uma volta para 1.0.0 — enquanto o ambiente está em
  // 1.1.0, que é a release publicada. Se o alvo viesse do ambiente, a tela
  // mostraria um "voltar" que reinstalaria a release ruim.
  expect(body.data.to_version).toBe("v1.0.0");
  expect(body.data.run_id).toBe("run-novo");
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "system.update_requested",
      metadata: expect.objectContaining({ from_version: "1.0.0", to_version: "v1.0.0", rollback: true }),
    }),
  );
});

it("uma volta também serve quando o sistema está em dia — a recusa 'você já está na mais recente' é só do caminho de atualizar", async () => {
  // O caso que a tela encontra depois de uma volta do agente: o sistema já
  // voltou para a versão antiga (current = from = 1.0.0) e o dono quer
  // completar a volta no CÓDIGO. Um `latest === current` barrando tudo
  // transformaria este botão em 409 perpétuo.
  mocks.respostas.system_version = [
    { data: { current_version: "1.1.0", latest_version: "1.1.0" }, error: null },
  ];
  comRuns({ id: "run-quebrado", status: "failed_rolled_back", from_version: "1.0.0" });
  const res = await POST(reqDeVolta());
  expect(res.status).toBe(200);
  expect((await res.json()).data.to_version).toBe("v1.0.0");
});

it("recusa a volta quando o último run não é uma falha — sucesso não tem o que desfazer", async () => {
  comRuns({ id: "run-bom", status: "success", from_version: "1.0.0" });
  const res = await POST(reqDeVolta());
  expect(res.status).toBe(409);
  expect((await res.json()).error.message).toContain("Não há nenhuma atualização com falha");
  expect(mocks.audit).not.toHaveBeenCalled();
});

it("recusa a volta quando a versão de onde se saiu não é publicada — e aponta o plano B", async () => {
  // Instalação fora de release não tem imagem publicada com esse nome para
  // puxar para trás: `update.sh --to <marca de dev>` terminaria em "não
  // consegui puxar". A saída é o comando de refazer, que a tela mantém.
  comRuns({ id: "run-dev", status: "failed", from_version: "dev-abc1234" });
  const res = await POST(reqDeVolta());
  expect(res.status).toBe(409);
  const { error } = await res.json();
  expect(error.message).toContain("Não sei para qual versão voltar");
  expect(error.message).toContain("o comando que a tela mostra");
  expect(mocks.audit).not.toHaveBeenCalled();
});

it("a volta também obedece a cerca de atualização em andamento", async () => {
  comRuns(
    { id: "run-quebrado", status: "failed", from_version: "1.0.0" },
    {
      id: "run-em-curso",
      status: "dispatched",
      dispatched_at: new Date().toISOString(),
    },
  );
  const res = await POST(reqDeVolta());
  expect(res.status).toBe(409);
  expect((await res.json()).error.message).toContain("Já existe uma atualização em andamento.");
  expect(mocks.audit).not.toHaveBeenCalled();
});

it("o caminho de atualizar continua registrando o pedido antigo sem corpo", async () => {
  // O clique antigo da tela manda `{}` (e versões mais antigas, corpo nenhum):
  // recusar corpo malformado aqui quebraria o "Atualizar agora" para consertar
  // o "Voltar".
  const res = await POST(new NextRequest("http://localhost/api/v1/system/update", { method: "POST" }));
  expect(res.status).toBe(200);
  // `to_version` é o que está gravado em `latest_version` — a rota devolve o
  // valor cru, sem normalizar; é a tela que tira o "v" na hora de mostrar.
  expect((await res.json()).data.to_version).toBe("1.1.0");
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      metadata: expect.objectContaining({ from_version: "1.0.0", to_version: "1.1.0", rollback: false }),
    }),
  );
});
