/**
 * GET /api/v1/metrics/channels — o relatório por canal (issue #2390).
 *
 * Sem banco: a RPC é mockada e a rota é medida no que É DELA — org do cookie,
 * janela, teto declarado, `null` que não vira 0, marcador de arquivado e a
 * recusa sem papel. A régua da conta mora em `lib/metrics/canais.test.ts`.
 *
 * A quarta parte é a doutrina: read-only ⇒ NENHUM evento de audit (a rota nem
 * importa `lib/audit`), provado lendo o próprio código-fonte do handler.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OWNER = "33333333-3333-4333-8333-333333333333";
const JANELA = "?from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z";
const URL = `http://localhost/api/v1/metrics/channels${JANELA}`;

function usuario(): AuthUser {
  return {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
  } as AuthUser;
}

type Resposta = { data: unknown; error: { message: string } | null };

function fakeSupabase(rpc: Resposta) {
  const chamadas: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(nome: string, args: Record<string, unknown>) {
      chamadas.push({ nome, args });
      return Promise.resolve(rpc);
    },
  };
  return { chamadas, client };
}

function canal(parcial: Record<string, unknown>): Record<string, unknown> {
  return {
    channel_session_id: "aaaaaaaa-0000-4000-8000-000000000001",
    channel_name: "11 99999-0001",
    channel: "whatsapp",
    is_archived: false,
    conversations_handled: 2,
    avg_first_response_seconds: 120,
    sem_resposta: 0,
    ...parcial,
  };
}

async function chamar(url = URL): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new NextRequest(url));
}

function permitido(): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: usuario(),
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/metrics/channels", () => {
  it("devolve uma linha por canal, com a janela e o recorte da própria RLS", async () => {
    permitido();
    const { chamadas, client } = fakeSupabase({
      data: {
        channels: [
          canal({ channel_session_id: "aaaa", conversations_handled: 2, sem_resposta: 1 }),
          canal({
            channel_session_id: "bbbb",
            channel_name: "22 99999-0002",
            conversations_handled: 1,
          }),
        ],
      },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar(`${URL}&owner_user_id=${OWNER}`);
    expect(res.status).toBe(200);
    const corpo = ((await res.json()) as { data: Record<string, unknown> }).data;

    // Critério 1: as 3 conversas estão nas DUAS linhas — nada engolido.
    const channels = corpo.channels as Array<{ conversations_handled: number }>;
    expect(channels).toHaveLength(2);
    expect(channels.map((c) => c.conversations_handled)).toEqual([2, 1]);
    expect((corpo.window as { from: string }).from).toBe("2026-09-01T00:00:00.000Z");
    expect(corpo.owner_user_id).toBe(OWNER);

    // A org vem do COOKIE validado (requireRole), nunca da query.
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.nome).toBe("fn_channel_metrics");
    expect(chamadas[0]?.args).toMatchObject({
      p_org: ORG_ID,
      p_from: "2026-09-01T00:00:00.000Z",
      p_to: "2026-10-01T00:00:00.000Z",
      p_owner: OWNER,
    });
  });

  it("sem `from`/`to` a janela é de 30 dias, semiaberta", async () => {
    permitido();
    const { chamadas, client } = fakeSupabase({ data: { channels: [] }, error: null });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar("http://localhost/api/v1/metrics/channels");
    expect(res.status).toBe(200);
    const args = chamadas[0]?.args as { p_from: string; p_to: string; p_owner: unknown };
    const dias = (Date.parse(args.p_to) - Date.parse(args.p_from)) / 86_400_000;
    expect(dias).toBe(30);
    expect(args.p_owner).toBeUndefined();
  });

  it("janela acima do teto de 90 dias é recusada COM o motivo (critério 9)", async () => {
    permitido();
    const { client } = fakeSupabase({ data: { channels: [] }, error: null });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar(
      "http://localhost/api/v1/metrics/channels?from=2026-01-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z",
    );
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { message: string } };
    expect(corpo.error.message).toContain("no máximo 90 dias");
    // Recusou, não cortou: a RPC nem foi chamada.
    expect(createClient).not.toHaveBeenCalled();
  });

  it("`from` depois de `to` é 422, e a leitura não acontece", async () => {
    permitido();
    vi.mocked(createClient).mockResolvedValue({ rpc: vi.fn() } as never);

    const res = await chamar(
      "http://localhost/api/v1/metrics/channels?from=2026-10-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z",
    );
    expect(res.status).toBe(422);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("média não medida chega como null — null ≠ 0 (critério 5)", async () => {
    permitido();
    const { client } = fakeSupabase({
      data: {
        channels: [
          canal({
            channel_session_id: "vazando",
            conversations_handled: 3,
            sem_resposta: 3,
            avg_first_response_seconds: null,
          }),
        ],
      },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(200);
    const [linha] = ((await res.json()) as { data: { channels: Array<Record<string, unknown>> } })
      .data.channels;
    expect(linha?.avg_first_response_seconds).toBeNull();
    expect(linha?.sem_resposta).toBe(3);
  });

  it("canal arquivado chega marcado (a conversa existiu)", async () => {
    permitido();
    const { client } = fakeSupabase({
      data: { channels: [canal({ channel_session_id: "morto", is_archived: true })] },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    const [linha] = ((await res.json()) as { data: { channels: Array<Record<string, unknown>> } })
      .data.channels;
    expect(linha?.is_archived).toBe(true);
  });

  it("sem dado nenhum devolve `[]`, não uma fila de zeros", async () => {
    permitido();
    const { client } = fakeSupabase({ data: { channels: [] }, error: null });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { channels: unknown[] } };
    expect(corpo.data.channels).toEqual([]);
  });

  it("falha na RPC vira 500 com a razão, nunca dado pela metade", async () => {
    permitido();
    const { client } = fakeSupabase({ data: null, error: { message: "RPC indisponível" } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(500);
  });

  it("leitura recusada para quem não é agent (critério 7)", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Papel insuficiente.", 403, {}),
    } as never);

    const res = await chamar();
    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("read-only: o handler não emite NENHUM evento de audit (critério 8)", async () => {
    const fonte = readFileSync(
      join(process.cwd(), "app", "api", "v1", "metrics", "channels", "route.ts"),
      "utf8",
    );
    // Sem `import ... lib/audit`, sem `audit(` e sem admin client: a doutrina
    // cobre POST/PATCH/DELETE, e este caminho não escreve nada.
    expect(fonte).not.toContain("@/lib/audit");
    expect(fonte).not.toMatch(/\baudit\s*\(/);
    expect(fonte).not.toContain("supabase/admin");
  });
});
