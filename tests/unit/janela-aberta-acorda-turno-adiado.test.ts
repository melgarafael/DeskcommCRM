/**
 * O SALVAR DA JANELA SOLTA QUEM JÁ ESTAVA NA FILA (#3383).
 *
 * O cenário medido na issue: contato adiado às 22h11 para as 7h, administrador
 * muda `resposta_start_hour=0, resposta_end_hour=24` em
 * `PUT /api/v1/ai/pacing`, e NADA acontece com o job que já dormia — a mudança
 * só era vista no próximo contato. Aqui o PUT em si é provado: com a janela
 * aberta ele acorda os turnos adiados da conexão; sem mexer nos knobs, ninguém
 * é acordado.
 *
 * Harness copiado de `janela-no-fuso-da-organizacao.rotas.test.ts` (a rota é a
 * mesma), com o pool do agent-engine mockado para capturar o update.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, orgAtivaSemPortao } from "@/lib/auth/server";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  requireRole: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), orgAtivaSemPortao: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));

import { PUT as putPacing } from "@/app/api/v1/ai/pacing/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

/** Cliente que responde por TABELA; toda cadeia devolve a si mesma. */
function cliente(porTabela: Record<string, unknown>) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u" } }, error: null }) },
    from: (tabela: string) => {
      const resposta = { data: porTabela[tabela] ?? null, error: null };
      const cadeia: unknown = new Proxy(
        {},
        {
          get: (_alvo, chave) =>
            chave === "then"
              ? (ok: (v: unknown) => unknown) => Promise.resolve(resposta).then(ok)
              : chave === "maybeSingle"
                ? async () => resposta
                : () => cadeia,
        },
      );
      return cadeia;
    },
  } as never;
}

/** Pool falso: leitura de knobs (`k.resposta_start_hour`) e escrita na fila. */
function poolFalso(row: unknown) {
  const chamadas: { sql: string; values?: unknown[] }[] = [];
  const query = vi.fn().mockImplementation((sql: string, values?: unknown[]) => {
    chamadas.push({ sql, values });
    if (sql.includes("k.resposta_start_hour")) return { rows: row === null ? [] : [row], rowCount: 1 };
    if (sql.includes("update job_queue")) return { rows: [{ id: "job-adiado" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as never, chamadas };
}

const KNOBS_COM_JANELA_ABERTA = {
  throttle_ms: null,
  jitter_max_ms: null,
  window_start_hour: null,
  window_end_hour: null,
  resposta_start_hour: 0,
  resposta_end_hour: 24,
  atraso_notar_ms: null,
  ms_por_caractere: null,
  atraso_minimo_ms: null,
  atraso_maximo_ms: null,
  allow_sunday: null,
  prospeccao_dias: null,
  timezone: null,
  warmup_daily_caps: null,
  number_activated_at: null,
  org_timezone: "America/Sao_Paulo",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u", idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: "admin" },
  } as never);
  vi.mocked(loadAuthUser).mockResolvedValue({ idioma: "pt-BR" } as never);
  vi.mocked(orgAtivaSemPortao).mockResolvedValue({ orgId: ORG, org_status: "active" } as never);
  vi.mocked(createAdminClient).mockReturnValue(
    cliente({
      channel_sessions: { id: CANAL },
      channel_knobs: KNOBS_COM_JANELA_ABERTA,
      organizations: { timezone: "America/Sao_Paulo" },
    }),
  );
});

describe("PUT /api/v1/ai/pacing — a janela muda agora, não no próximo contato", () => {
  it("abrir para 0h–24h acorda os turnos já adiados da conexão (cenário C)", async () => {
    const { pool, chamadas } = poolFalso(KNOBS_COM_JANELA_ABERTA);
    vi.mocked(getRequestPool).mockReturnValue(pool as never);

    const res = await putPacing(
      new NextRequest("http://localhost/api/v1/ai/pacing", {
        method: "PUT",
        body: JSON.stringify({
          channel_session_id: CANAL,
          resposta_start_hour: 0,
          resposta_end_hour: 24,
        }),
      }),
    );

    expect(res.status).toBe(200);

    const update = chamadas.find((c) => c.sql.includes("update job_queue"));
    expect(update, "sem o update o job adiado continua dormindo até as 7h").toBeTruthy();
    expect(update?.sql).toContain("run_after = now()");
    expect(update?.sql).toContain("status = 'pending'");
    expect(update?.sql).toContain("adiado_por_janela");
    expect(update?.values).toEqual([ORG, CANAL]);
    // O MESMO job é reagendado — nunca um insert, que seria um segundo turno.
    expect(update?.sql).not.toContain("insert");
    // A janela é LIDA aqui (o par que o PUT acabou de gravar) antes de mexer.
    expect(chamadas.findIndex((c) => c.sql.includes("k.resposta_start_hour"))).toBeLessThan(
      chamadas.findIndex((c) => c.sql.includes("update job_queue")),
    );
  });

  it("PUT sem campo de janela (só teto diário) não reavalia nada", async () => {
    const { pool, chamadas } = poolFalso(KNOBS_COM_JANELA_ABERTA);
    vi.mocked(getRequestPool).mockReturnValue(pool as never);

    const res = await putPacing(
      new NextRequest("http://localhost/api/v1/ai/pacing", {
        method: "PUT",
        body: JSON.stringify({ channel_session_id: CANAL, daily_message_limit: 200 }),
      }),
    );

    expect(res.status).toBe(200);
    expect(chamadas.some((c) => c.sql.includes("update job_queue"))).toBe(false);
  });

  it("pool indisponível não derruba o PUT — knobs salvos, aviso no log", async () => {
    vi.mocked(getRequestPool).mockImplementation(() => {
      throw new Error("SUPABASE_DB_URL ausente");
    });

    const res = await putPacing(
      new NextRequest("http://localhost/api/v1/ai/pacing", {
        method: "PUT",
        body: JSON.stringify({
          channel_session_id: CANAL,
          resposta_start_hour: 0,
          resposta_end_hour: 24,
        }),
      }),
    );

    expect(res.status).toBe(200);
  });
});
