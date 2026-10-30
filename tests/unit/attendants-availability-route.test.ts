/**
 * A REDE DE SEGURANÇA QUE NÃO EXISTIA.
 *
 * A doutrina de extração (briefing IA 360, Decisão 4) diz "o teste existente da
 * rota é a rede de segurança". `GET /api/v1/attendants/availability` **não tinha
 * teste nenhum** — nem unitário nem invariante. A extração do roster para
 * `lib/escalacao/atendentes.ts` foi feita mesmo assim (a capacidade do agente
 * precisa da MESMA regra), então a rede vem agora, junto.
 *
 * O que ela prende é o CONTRATO que a tela consome (`hooks/team/useAttendants.ts`
 * → `AttendantAvailability`): renomear um campo aqui quebraria o painel de
 * atendimento em silêncio — a tabela renderiza `undefined` sem erro nenhum.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  isServiceRoleConfigured: vi.fn(() => true),
  audit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const BRUNO = "99999999-9999-4999-8999-999999999999";
const VIEWER = "77777777-7777-4777-8777-777777777777";
const CARLA = "33333333-3333-4333-8333-333333333333";

function sessao(papel: Role) {
  const user: AuthUser = {
    id: ANA,
    email: "ana@example.com",
    full_name: "Ana",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: papel }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

/** Dublê do admin client: responde por tabela e serve o auth.admin do nome. */
function fazerAdmin(porTabela: Record<string, unknown[]>) {
  const from = (tabela: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: porTabela[tabela] ?? [], error: null }).then(res),
    };
    return chain;
  };
  return {
    from,
    auth: {
      admin: {
        getUserById: (id: string) =>
          Promise.resolve({
            data: {
              user: {
                id,
                email: `${id.slice(0, 4)}@example.com`,
                user_metadata: { full_name: `Nome ${id.slice(0, 4)}` },
              },
            },
          }),
      },
    },
  };
}

const EQUIPE = {
  user_organizations: [
    { user_id: ANA, role: "agent" },
    { user_id: BRUNO, role: "manager" },
    { user_id: CARLA, role: "agent" },
    { user_id: VIEWER, role: "viewer" },
  ],
  attendant_availability: [
    {
      user_id: ANA,
      is_available: true,
      capacity: 5,
      schedule: { timezone: "America/Sao_Paulo", windows: [] },
      updated_at: "2026-08-04T12:00:00Z",
      // Sinal de presença FRESCO: a Ana tem a tela aberta agora.
      last_heartbeat_at: new Date().toISOString(),
    },
    {
      // O Bruno está de plantão, mas sem sinal de tela — a linha que a issue
      // #996 existe para o operador poder ver (as duas coisas na mesma linha,
      // sem uma apagar a outra).
      user_id: BRUNO,
      is_available: true,
      capacity: 5,
      schedule: { timezone: "America/Sao_Paulo", windows: [] },
      updated_at: "2026-08-04T12:00:00Z",
      last_heartbeat_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    },
  ],
  conversations: [{ assigned_to_user_id: ANA }, { assigned_to_user_id: ANA }],
};

async function chamar() {
  const { GET } = await import("@/app/api/v1/attendants/availability/route");
  return GET(new NextRequest("http://localhost/api/v1/attendants/availability"));
}

describe("GET /api/v1/attendants/availability", () => {
  it("devolve exatamente os campos que o painel de atendimento consome", async () => {
    sessao("agent");
    vi.mocked(createAdminClient).mockReturnValue(
      fazerAdmin(EQUIPE) as unknown as ReturnType<typeof createAdminClient>,
    );

    const res = await chamar();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };

    // O contrato de `AttendantAvailability` (hooks/team/useAttendants.ts). Um
    // campo a menos aqui é uma coluna vazia na tela, sem erro nenhum.
    //
    // ⚠️ `last_heartbeat_at` e `present` ENTRARAM (issue #996). A coluna tinha
    // saído do fio por não ter leitor do outro lado — não havia emissor de
    // presença nenhum, então entregá-la à tela era campo sem sentido. Agora há
    // emissor (`POST /api/v1/attendants/presence`), há leitor (o selo de
    // presença na tela Equipe) e há leitor não-tela
    // (`crm_list_available_attendants`), e o que a tela consome é `present` —
    // derivado no SERVIDOR com o prazo de `lib/atendimento/presenca.ts`.
    //
    // `sector_id` ENTROU com os setores (migration 0801): a coluna "Setor" e o
    // filtro da aba Atendimento leem daqui, sem uma chamada por linha.
    expect(Object.keys(body.data[0] ?? {}).sort()).toEqual(
      [
        "capacity",
        "current_load",
        "email",
        "is_available",
        "last_heartbeat_at",
        "name",
        "present",
        "role",
        "schedule",
        "sector_id",
        "updated_at",
        "user_id",
      ].sort(),
    );
  });

  it("presença é derivada na leitura, e NÃO mexe na decisão de plantão", async () => {
    sessao("agent");
    vi.mocked(createAdminClient).mockReturnValue(
      fazerAdmin(EQUIPE) as unknown as ReturnType<typeof createAdminClient>,
    );

    const body = (await (await chamar()).json()) as {
      data: Array<{
        user_id: string;
        present: boolean;
        is_available: boolean;
        last_heartbeat_at: string | null;
      }>;
    };

    const ana = body.data.find((r) => r.user_id === ANA);
    const bruno = body.data.find((r) => r.user_id === BRUNO);
    const carla = body.data.find((r) => r.user_id === CARLA);

    // Sinal fresco ⇒ presente; sinal de uma hora atrás ⇒ não presente. O prazo
    // mora num lugar só (`lib/atendimento/presenca.ts`), e é o servidor que o
    // aplica: a tela lê o booleano, não recalcula a conta.
    expect(ana?.present).toBe(true);
    expect(bruno?.present).toBe(false);

    // E as duas metades convivem: estar de plantão não é ter sinal, e ter sinal
    // não é estar de plantão. O Bruno está de plantão sem sinal de tela; a Ana
    // tem sinal e plantão. Nenhum dos dois vira um do outro aqui.
    expect(bruno?.is_available).toBe(true);
    expect(ana?.is_available).toBe(true);

    // Quem nunca abriu a tela logado não tem carimbo nenhum: `null`, e não uma
    // data inventada. A tela mostra isso como "sem sinal de tela".
    expect(carla?.last_heartbeat_at).toBeNull();
    expect(carla?.present).toBe(false);
  });

  it("viewer não é atendente e some do roster; a carga é contada por dono", async () => {
    sessao("agent");
    vi.mocked(createAdminClient).mockReturnValue(
      fazerAdmin(EQUIPE) as unknown as ReturnType<typeof createAdminClient>,
    );

    const body = (await (await chamar()).json()) as {
      data: Array<{ user_id: string; current_load: number; capacity: number | null }>;
    };
    expect(body.data.map((r) => r.user_id).sort()).toEqual([ANA, BRUNO, CARLA].sort());

    const ana = body.data.find((r) => r.user_id === ANA);
    expect(ana?.current_load).toBe(2);
    // Quem nunca configurou disponibilidade vem com capacidade null — é "não
    // configurado", não "capacidade zero", e a tela mostra os dois diferente.
    expect(body.data.find((r) => r.user_id === CARLA)?.capacity).toBeNull();
  });

  it("viewer é barrado antes de qualquer consulta", async () => {
    sessao("viewer");
    const admin = fazerAdmin(EQUIPE);
    vi.mocked(createAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof createAdminClient>,
    );
    const res = await chamar();
    expect(res.status).toBe(403);
  });

  it("sem service role em dev, degrada em vez de estourar", async () => {
    sessao("agent");
    vi.mocked(isServiceRoleConfigured).mockReturnValueOnce(false);
    const { createClient } = await import("@/lib/supabase/server");
    vi.mocked(createClient).mockResolvedValue(
      fazerAdmin({
        attendant_availability: EQUIPE.attendant_availability,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );

    const res = await chamar();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string | null }> };
    // Degrada com nome nulo — o painel mostra a linha sem nome em vez de sumir.
    expect(body.data[0]?.name).toBeNull();
  });
});
