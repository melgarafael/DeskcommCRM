/**
 * GET /api/v1/metrics/attendants — a mediana da 1ª resposta e o recorte por
 * etiqueta do contato (issue #3212, fatia 1).
 *
 * Sem banco: a RPC é mockada e a rota é medida no que É DELA — a org do cookie
 * validado, a janela, a etiqueta normalizada, o campo novo que NÃO pode virar 0
 * quando ninguém mediu, o total de conversas excluídas declarado e a recusa sem
 * papel. A régua da mediana e do predicado de recorte mora em
 * `lib/metrics/mediana-e-recorte-por-etiqueta.test.ts` (código puro) e a prova
 * contra o banco de verdade em
 * `tests/invariants/mediana-e-recorte-por-etiqueta.test.ts` (`pnpm test:db`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
// O enriquecimento com nome/e-mail é do service role; aqui ele está desligado
// para a rota ser medida no que é dela (a agregação), sem rede.
vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: () => false }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OWNER = "33333333-3333-4333-8333-333333333333";
const JANELA = "?from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z";
const URL = `http://localhost/api/v1/metrics/attendants${JANELA}`;

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

/** A linha do atendente como a RPC (0754) devolve — média E mediana. */
function atendente(parcial: Record<string, unknown>): Record<string, unknown> {
  return {
    user_id: OWNER,
    won: 0,
    lost: 0,
    conversations_handled: 3,
    // A média é a de sempre; a mediana é o campo NOVO, com valor PRÓPRIO.
    avg_first_response_seconds: 900,
    median_first_response_seconds: 120,
    calls_answered: 0,
    call_seconds: 0,
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

describe("GET /api/v1/metrics/attendants — mediana e recorte por etiqueta", () => {
  it("a MEDIANA chega ao lado da média, e a resposta declara a etiqueta usada e o total excluído", async () => {
    permitido();
    const { chamadas, client } = fakeSupabase({
      data: {
        excluded_tag: "fornecedor",
        excluded_conversations: 2,
        attendants: [atendente({ avg_first_response_seconds: 900, median_first_response_seconds: 120 })],
      },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar(`${URL}&excluir_etiqueta=fornecedor`);
    expect(res.status).toBe(200);
    const corpo = ((await res.json()) as { data: Record<string, unknown> }).data;

    const [linha] = corpo.attendants as Array<Record<string, unknown>>;
    // O campo NOVO existe e NÃO é a média: é o que a tela pinta ao lado dela.
    expect(linha?.median_first_response_seconds).toBe(120);
    expect(linha?.median_first_response_seconds).not.toBe(linha?.avg_first_response_seconds);
    // A média continua saindo, intacta, no mesmo payload.
    expect(linha?.avg_first_response_seconds).toBe(900);
    // O recorte é DECLARADO: qual etiqueta, e quantas conversas ela tirou.
    expect(corpo.excluded_tag).toBe("fornecedor");
    expect(corpo.excluded_conversations).toBe(2);

    // A org vem do COOKIE validado (requireRole), nunca da query — e a etiqueta
    // chega à RPC como argumento próprio.
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.nome).toBe("fn_attendant_metrics");
    expect(chamadas[0]?.args).toMatchObject({
      p_org: ORG_ID,
      p_from: "2026-09-01T00:00:00.000Z",
      p_to: "2026-10-01T00:00:00.000Z",
      p_excluir_etiqueta: "fornecedor",
    });
  });

  it("SEM etiqueta o recorte vai desligado (null) e a resposta declara 0 — nada foi tirado", async () => {
    permitido();
    const { chamadas, client } = fakeSupabase({
      data: { attendants: [atendente({})] },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(corpo.excluded_tag).toBeNull();
    expect(corpo.excluded_conversations).toBe(0);
    expect((chamadas[0]?.args as { p_excluir_etiqueta: unknown }).p_excluir_etiqueta).toBeNull();
  });

  it("etiqueta com espaços chega NORMALIZADA à RPC (a mesma régua do `btrim` do banco)", async () => {
    permitido();
    const { chamadas, client } = fakeSupabase({ data: { attendants: [] }, error: null });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar(`${URL}&excluir_etiqueta=%20Fornecedor%20`);
    expect(res.status).toBe(200);
    expect((chamadas[0]?.args as { p_excluir_etiqueta: unknown }).p_excluir_etiqueta).toBe(
      "Fornecedor",
    );
  });

  it("etiqueta só com espaços é AUSÊNCIA: o recorte não liga", async () => {
    permitido();
    const { chamadas, client } = fakeSupabase({ data: { attendants: [] }, error: null });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar(`${URL}&excluir_etiqueta=%20%20%20`);
    expect(res.status).toBe(200);
    expect((chamadas[0]?.args as { p_excluir_etiqueta: unknown }).p_excluir_etiqueta).toBeNull();
  });

  it("mediana não medida chega como null — null ≠ 0 (a leitura gentil do vazamento)", async () => {
    permitido();
    const { client } = fakeSupabase({
      data: { attendants: [atendente({ median_first_response_seconds: null })] },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    const [linha] = ((await res.json()) as { data: { attendants: Array<Record<string, unknown>> } })
      .data.attendants;
    expect(linha?.median_first_response_seconds).toBeNull();
    expect(linha?.median_first_response_seconds).not.toBe(0);
  });

  it("sem `from`/`to` a janela é de 30 dias, semiaberta", async () => {
    permitido();
    const { chamadas, client } = fakeSupabase({ data: { attendants: [] }, error: null });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar("http://localhost/api/v1/metrics/attendants");
    expect(res.status).toBe(200);
    const args = chamadas[0]?.args as { p_from: string; p_to: string; p_owner: unknown };
    const dias = (Date.parse(args.p_to) - Date.parse(args.p_from)) / 86_400_000;
    expect(dias).toBe(30);
    expect(args.p_owner).toBeUndefined();
  });

  it("`from` depois de `to` é 422, e a leitura não acontece", async () => {
    permitido();
    vi.mocked(createClient).mockResolvedValue({ rpc: vi.fn() } as never);

    const res = await chamar(
      "http://localhost/api/v1/metrics/attendants?from=2026-10-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z",
    );
    expect(res.status).toBe(422);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("falha na RPC vira 500 com a razão, nunca dado pela metade", async () => {
    permitido();
    const { client } = fakeSupabase({ data: null, error: { message: "RPC indisponível" } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(500);
  });

  it("leitura recusada para quem não é agent", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Papel insuficiente.", 403, {}),
    } as never);

    const res = await chamar();
    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });
});
