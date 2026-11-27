/**
 * #3067 — "Quem conduz" na rota do detalhe do compromisso: o GET devolve o
 * principal, os adicionais e `equipe_travada` (sessão coletiva), lendo o tipo
 * SEMPRE dentro da organização da sessão.
 *
 * Banco, sessão e Google são dublês: nada aqui prova RLS.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/v1/agenda/agendamentos/[id]/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

const estado = vi.hoisted(() => ({
  compromisso: {} as Record<string, unknown>,
  tipo: null as Record<string, unknown> | null,
  erroDoTipo: null as { message: string } | null,
  consultas: [] as Array<{ tabela: string; filtros: Record<string, unknown> }>,
}));

function banco() {
  return {
    from(tabela: string) {
      const consulta = { tabela, filtros: {} as Record<string, unknown> };
      estado.consultas.push(consulta);
      const resposta = () => {
        if (tabela === "calendar_appointments") return { data: estado.compromisso, error: null };
        if (tabela === "calendar_event_types") return { data: estado.tipo, error: estado.erroDoTipo };
        return { data: null, error: null };
      };
      const q: Record<string, unknown> = {
        maybeSingle: async () => resposta(),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
      };
      for (const m of ["select", "not", "gte", "order", "limit", "in"]) q[m] = () => q;
      q.eq = (coluna: string, valor: unknown) => {
        consulta.filtros[coluna] = valor;
        return q;
      };
      return q;
    },
  };
}

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, org: { orgId: ORG }, user: { id: "u1" } }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => banco() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco() }));
vi.mock("@/lib/agenda/google/sync-store", () => ({ googleRpc: async () => false }));

async function pedir() {
  const r = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: ID }) });
  return { status: r.status, corpo: await r.json() };
}

const consultasDoTipo = () => estado.consultas.filter((c) => c.tabela === "calendar_event_types");

beforeEach(() => {
  estado.consultas.length = 0;
  estado.erroDoTipo = null;
  estado.tipo = { service_enabled: true, booking_mode: "group" };
  estado.compromisso = {
    id: ID,
    owner_user_id: "dono",
    calendar_appointment_responsibles: [{ user_id: "ana" }],
    service_occurrence_id: "ocorrencia",
    event_type_id: "tipo",
    revision: 1,
    revision_started_at: "2026-09-16T12:00:00.000Z",
    contact_id: null,
    google_local_revision: "0",
    google_synced_local_revision: "0",
  };
});

describe("detalhe do compromisso — quem conduz (#3067)", () => {
  it("devolve o principal e os adicionais", async () => {
    const { status, corpo } = await pedir();
    expect(status).toBe(200);
    expect(corpo.data.principal_user_id).toBe("dono");
    expect(corpo.data.responsaveis).toEqual(["ana"]);
  });

  it("sessão coletiva trava a equipe, lendo o tipo dentro da organização", async () => {
    const { corpo } = await pedir();
    expect(corpo.data.equipe_travada).toBe(true);
    expect(consultasDoTipo()[0]?.filtros).toEqual({ id: "tipo", organization_id: ORG });
  });

  it("serviço individual não trava", async () => {
    estado.tipo = { service_enabled: true, booking_mode: "individual" };
    expect((await pedir()).corpo.data.equipe_travada).toBe(false);
  });

  it("sem ocorrência não trava nem consulta o tipo", async () => {
    estado.compromisso = { ...estado.compromisso, service_occurrence_id: null };
    expect((await pedir()).corpo.data.equipe_travada).toBe(false);
    expect(consultasDoTipo()).toHaveLength(0);
  });

  it("falha ao ler o tipo vira erro, sem vazar a mensagem do banco", async () => {
    estado.erroDoTipo = { message: "relation x does not exist" };
    const { status, corpo } = await pedir();
    expect(status).toBe(500);
    expect(JSON.stringify(corpo)).not.toContain("relation x");
  });
});
