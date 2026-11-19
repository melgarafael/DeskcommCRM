/**
 * GET/PUT /api/v1/ai/pacing/teto-de-respostas — o padrão que a rota mostra é o
 * mesmo que o turno aplica (#4590).
 *
 * O turno usa como base `TETO_DE_RESPOSTAS_POR_CONVERSA` / `TETO_DE_RESPOSTAS_JANELA_MIN`
 * (`turnKnobsFromEnv`), e o serviço `app` recebe o mesmo `.env` que o worker.
 * Uma constante na rota faria a tela dizer 20/60 numa instalação cujo turno
 * aplica 30/90.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { requireRole } from "@/lib/auth/require-role";

import { GET, PUT } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";

function bancoQueDevolve(teto: unknown) {
  const query = vi.fn<(sql: string, params: unknown[]) => Promise<{ rows: Array<{ teto: unknown }> }>>(
    async () => ({ rows: [{ teto }] }),
  );
  vi.mocked(getRequestPool).mockReturnValue({ query } as unknown as ReturnType<typeof getRequestPool>);
  return query;
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function corpo(res: Response) {
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

describe("o padrão da rota é o da INSTALAÇÃO", () => {
  it("com o env ajustado (30/90), organização sem configuração lê 30/90 no efetivo e no padrão", async () => {
    vi.stubEnv("TETO_DE_RESPOSTAS_POR_CONVERSA", "30");
    vi.stubEnv("TETO_DE_RESPOSTAS_JANELA_MIN", "90");
    bancoQueDevolve(null);

    const dados = await corpo(await GET());

    const esperado = { por_conversa: 30, janela_minutos: 90, silenciar_minutos: 60 };
    expect(dados.efetivo).toEqual(esperado);
    expect(dados.padrao).toEqual(esperado);
    expect(dados.configurado).toBe(false);
  });

  it("sem env, vale o padrão do arquivo (20 em 60, silêncio de 60)", async () => {
    vi.stubEnv("TETO_DE_RESPOSTAS_POR_CONVERSA", "");
    vi.stubEnv("TETO_DE_RESPOSTAS_JANELA_MIN", "");
    bancoQueDevolve(null);

    const dados = await corpo(await GET());

    expect(dados.padrao).toEqual({ por_conversa: 20, janela_minutos: 60, silenciar_minutos: 60 });
  });

  it("o PUT devolve o padrão da instalação ao lado do que gravou", async () => {
    vi.stubEnv("TETO_DE_RESPOSTAS_POR_CONVERSA", "30");
    vi.stubEnv("TETO_DE_RESPOSTAS_JANELA_MIN", "90");
    const gravado = { por_conversa: 5, janela_minutos: 10, silenciar_minutos: 0 };
    const query = bancoQueDevolve(gravado);

    const res = await PUT(
      new NextRequest("http://localhost/api/v1/ai/pacing/teto-de-respostas", {
        method: "PUT",
        body: JSON.stringify(gravado),
      }),
    );
    const dados = await corpo(res);

    expect(res.status).toBe(200);
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(ORG);
    expect(dados.efetivo).toEqual(gravado);
    expect(dados.padrao).toEqual({ por_conversa: 30, janela_minutos: 90, silenciar_minutos: 60 });
  });
});
