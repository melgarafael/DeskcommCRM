import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { valoresDoCheckNoBaseline } from "@/tests/helpers/baseline-check";

import { NUVEMSHOP_CLASSIFICACAO, type HealthStatus } from "./route";

/**
 * GET /api/v1/admin/tenants/[id]/health — o painel de saúde do tenant.
 *
 * O predicado de Nuvemshop comparava com `active`, valor que não existe em
 * `tenant_integrations_status_check` (connecting/healthy/token_expired/
 * scope_missing/disconnected/rate_limited/error). Quem escreve a linha
 * conectada é o callback do OAuth, com `healthy`: integração perfeita aparecia
 * como "Não conectado", e o ramo crítico de token vencido era inalcançável.
 *
 * Dois níveis de guarda, os mesmos que `TenantOverview.test.tsx` — a TELA que
 * esta rota alimenta tinha a cobertura e a rota não, e é a rota que decide o
 * que a tela recebe:
 *  - os casos nomeados, que fixam a saúde de cada estado que importa;
 *  - a cobertura contra o CHECK do `supabase/baseline.sql`. Status novo que uma
 *    migration acrescente ao banco sem entrar na classificação da rota reprova
 *    aqui, que é o modo de falha que produziu este bug (o TypeScript não
 *    enxerga o CHECK).
 */

vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdmin: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const DIA = 24 * 60 * 60 * 1000;

function thenable(value: unknown) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) {
    builder[m] = () => builder;
  }
  builder.maybeSingle = async () => value;
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(value).then(resolve);
  return builder;
}

function makeAdminStub(nuvemshop: { status: string; expires_at: string | null } | null) {
  return {
    from: (table: string) => {
      if (table === "channel_sessions") return thenable({ data: [], error: null });
      if (table === "tenant_integrations") {
        return thenable({
          data: nuvemshop
            ? [
                {
                  id: "int-1",
                  status: nuvemshop.status,
                  expires_at: nuvemshop.expires_at,
                  last_sync_at: "2026-08-01T10:00:00Z",
                  updated_at: "2026-08-01T10:00:00Z",
                },
              ]
            : [],
          error: null,
        });
      }
      if (table === "ai_budgets") return thenable({ data: [], error: null });
      if (table === "api_audit_log") return thenable({ data: null, error: null });
      throw new Error(`unexpected table ${table}`);
    },
    // `fn_gasto_de_ia_do_mes` (migration 0159) — a régua ÚNICA de gasto, a mesma
    // que o gate consulta antes de recusar uma chamada de LLM. O painel a chama
    // porque a coluna materializada soma sem olhar a data e nunca zera.
    rpc: async (fn: string) => {
      if (fn !== "fn_gasto_de_ia_do_mes") throw new Error(`unexpected rpc ${fn}`);
      return { data: 0, error: null };
    },
  };
}

async function chamar(
  nuvemshop: { status: string; expires_at: string | null } | null,
) {
  vi.mocked(createAdminClient).mockReturnValue(makeAdminStub(nuvemshop) as never);
  const { GET } = await import("./route");
  const res = await GET(
    new NextRequest(`http://localhost/api/v1/admin/tenants/${ORG_ID}/health`),
    { params: Promise.resolve({ id: ORG_ID }) },
  );
  const body = (await res.json()) as {
    data: { nuvemshop: { connected: boolean; status: HealthStatus } };
  };
  return body.data.nuvemshop;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    user: { id: ADMIN_ID },
    platformAdmin: { user_id: ADMIN_ID, scope: "full", mfa_required: true },
  } as never);
});

describe("GET /api/v1/admin/tenants/[id]/health — Nuvemshop", () => {
  it("`healthy` (o que o callback do OAuth grava) conta como conectado", async () => {
    const nu = await chamar({
      status: "healthy",
      expires_at: new Date(Date.now() + 90 * DIA).toISOString(),
    });
    expect(nu.connected).toBe(true);
    expect(nu.status).toBe("ok");
  });

  it("token vencido é crítico, não um genérico 'não conectado'", async () => {
    const nu = await chamar({
      status: "token_expired",
      expires_at: new Date(Date.now() - DIA).toISOString(),
    });
    expect(nu.status).toBe("critical");
  });

  it("`disconnected` e ausência de integração continuam como não conectado", async () => {
    const desligado = await chamar({ status: "disconnected", expires_at: null });
    expect(desligado.connected).toBe(false);
    expect(desligado.status).toBe("warning");

    const semLinha = await chamar(null);
    expect(semLinha.connected).toBe(false);
    expect(semLinha.status).toBe("warning");
  });
});

describe("GET /api/v1/admin/tenants/[id]/health — cobertura do vocabulário", () => {
  const STATUS_NO_BANCO = valoresDoCheckNoBaseline(
    "tenant_integrations_status_check",
  );

  it("todo status que o banco aceita está classificado na rota", () => {
    for (const status of STATUS_NO_BANCO) {
      expect(
        Object.keys(NUVEMSHOP_CLASSIFICACAO),
        `status '${status}' sem classificação em NUVEMSHOP_CLASSIFICACAO`,
      ).toContain(status);
    }
  });

  it("a classificação declarada é a que a rota entrega, status a status", async () => {
    // Token com 90 dias de folga de propósito: é o cenário em que o ramo final
    // devolvia `ok` para qualquer status que a cadeia de `===` não enumerasse.
    // Exercitar a rota INTEIRA (e não só ler a tabela) é o que impede a tabela
    // de existir sem ser consultada.
    const validade = new Date(Date.now() + 90 * DIA).toISOString();
    for (const status of STATUS_NO_BANCO) {
      const classe = NUVEMSHOP_CLASSIFICACAO[status];
      expect(classe, `status '${status}' sem classificação`).toBeDefined();
      if (!classe) continue;

      const nu = await chamar({ status, expires_at: validade });
      expect(nu.status, `saúde de '${status}'`).toBe(classe.saude ?? "ok");
      expect(nu.connected, `vínculo de '${status}'`).toBe(classe.vinculada);
    }
  });

  it("status fora do vocabulário não passa por saudável", async () => {
    // Para valor que o banco aceita este ramo é inalcançável — quem garante é o
    // teste de cobertura acima. O que ele não pode é ler como "tudo certo", e
    // era exatamente assim que a rota tratava todo status não enumerado.
    const nu = await chamar({
      status: "quota_exceeded",
      expires_at: new Date(Date.now() + 90 * DIA).toISOString(),
    });
    expect(STATUS_NO_BANCO).not.toContain("quota_exceeded");
    expect(nu.status).toBe("warning");
    expect(nu.connected).toBe(false);
  });
});

// A função de saúde das SESSÕES de canal, logo acima na rota, enumera o
// `channel_sessions_status_check` à mão do mesmo jeito e também não tem guarda.
// Ela fica de fora daqui de propósito: o campo da resposta e a função levam o
// nome do provider, e um teste sobre eles teria de escrevê-lo — o que
// `scripts/lint-channels.ts` (invariante 1 da restrição de canal) reprova em
// arquivo novo. Medido: com o caso escrito, `pnpm lint:channels` saía EXIT 1
// apontando este arquivo. A própria rota já está no KNOWN_DEBT do lint por esse
// mesmo motivo ("nome de campo de resposta de API pública"), com saída prevista
// na Fase 3a; a guarda entra junto com a renomeação. Enquanto isso o risco é
// menor que o da Nuvemshop, e por uma razão medível: o default daquele ramo
// é `warning`, não `ok` — status novo não vira verde silencioso.
