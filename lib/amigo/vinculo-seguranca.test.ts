/**
 * O VÍNCULO CONTATO ↔ PACIENTE e a leitura por id vindo do chamador.
 *
 * Regra: o paciente precisa aparecer na busca do Amigo pelo telefone do contato,
 * para pessoa e para a IA; o vínculo manual é só da gestão; a resposta do
 * vínculo não traz o cadastro do paciente; e paciente ou consulta escolhidos
 * pelo id do chamador, sem o contato do atendimento, só a gestão alcança.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ProjectionModule from "./projection";

const g = vi.hoisted(() => ({
  load: vi.fn(),
  request: vi.fn(),
  project: vi.fn(),
  audit: vi.fn(),
  upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));
vi.mock("./store", () => ({ loadAmigoConnection: g.load }));
vi.mock("./transport", () => ({ requestAmigo: g.request }));
vi.mock("./projection", async (original) => ({
  ...(await original<typeof ProjectionModule>()),
  projectAttendance: g.project,
}));
vi.mock("@/lib/audit", () => ({ audit: g.audit }));

let tables: Record<string, Record<string, unknown>[]>;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      let rows = tables[table] ?? [];
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => {
          rows = rows.filter((r) => r[key] === value);
          return q;
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        upsert: async (row: Record<string, unknown>) => {
          g.upserts.push({ table, row });
          return { error: null };
        },
      };
      return q;
    },
  }),
}));

import { executeAmigo, linkAmigoPatient } from "./service";

const PACIENTE_DO_TELEFONE = 12;
const OUTRO_PACIENTE = 99;
const cadastro = { id: OUTRO_PACIENTE, name: "Paciente Fictícia", cpf: "00000000000" };

// Como a rota monta o contexto: o contato escolhido na tela vira `contactId`.
const humano = (role: string, contactId = "contato-a") => ({
  contactId,
  organizationId: "org-a",
  actor: { type: "user" as const, id: "pessoa", role },
  role,
  requestId: "req",
  expectedConnectionId: "conexao-a",
});

beforeEach(() => {
  vi.clearAllMocks();
  g.upserts = [];
  tables = {
    contacts: [
      { id: "contato-a", organization_id: "org-a", phone_number: "5585999991234", is_anonymized: false },
      { id: "contato-b", organization_id: "org-b", phone_number: "5585999995678", is_anonymized: false },
    ],
    amigo_patient_links: [],
  };
  g.load.mockResolvedValue({
    id: "conexao-a",
    token: "token-privado",
    active: true,
    timezone: "America/Fortaleza",
    last_sync_at: null,
  });
  g.request.mockImplementation(async (_token: string, operation: string) => {
    if (operation === "patient_search") return { data: [{ id: PACIENTE_DO_TELEFONE }], status: "success" };
    if (operation === "patient_get") return { data: cadastro, status: "success" };
    return { data: [], status: "success" };
  });
});

describe("vínculo contato ↔ paciente", () => {
  it("um atendente (agent) não vincula paciente que não aparece pelo telefone do contato", async () => {
    await expect(
      linkAmigoPatient(humano("agent"), { patient_id: OUTRO_PACIENTE, contact_id: "contato-a" }),
    ).rejects.toMatchObject({ code: "amigo_scope_denied", status: 403 });
    expect(g.upserts).toHaveLength(0);
    expect(g.request).not.toHaveBeenCalledWith(expect.anything(), "patient_get", expect.anything());
  });

  it("o paciente que aparece pelo telefone vincula, e a resposta traz só os ids — nunca o cadastro", async () => {
    const r = await linkAmigoPatient(humano("agent"), {
      patient_id: PACIENTE_DO_TELEFONE,
      contact_id: "contato-a",
    });
    expect(r).toEqual({
      linked: true,
      patient_id: PACIENTE_DO_TELEFONE,
      contact_id: "contato-a",
      lead_id: null,
      connection_id: "conexao-a",
    });
    expect(JSON.stringify(r)).not.toContain("Fictícia");
    expect(g.upserts).toHaveLength(1);
  });

  it("vínculo manual é só da gestão: agent é recusado, manager vincula e fica auditado como manual", async () => {
    await expect(
      linkAmigoPatient(humano("agent"), { patient_id: OUTRO_PACIENTE, contact_id: "contato-a", manual: true }),
    ).rejects.toMatchObject({ code: "amigo_scope_denied" });
    expect(g.upserts).toHaveLength(0);

    const r = await linkAmigoPatient(humano("manager"), {
      patient_id: OUTRO_PACIENTE,
      contact_id: "contato-a",
      manual: true,
    });
    expect(JSON.stringify(r)).not.toContain("Fictícia");
    expect(g.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "amigo.patient_linked",
        metadata: expect.objectContaining({ manual: true, patient_id: OUTRO_PACIENTE }),
      }),
    );
  });

  it("uma organização não alcança o contato da outra, nem com o paciente do telefone dele", async () => {
    await expect(
      linkAmigoPatient(humano("admin", "contato-b"), {
        patient_id: PACIENTE_DO_TELEFONE,
        contact_id: "contato-b",
      }),
    ).rejects.toMatchObject({ code: "amigo_scope_denied" });
    expect(g.upserts).toHaveLength(0);
    expect(g.request).not.toHaveBeenCalled();
  });
});

describe("leitura por id vindo do chamador", () => {
  it.each([
    ["patient_get", { patientId: OUTRO_PACIENTE }],
    ["patient_attendances", { patient_id: OUTRO_PACIENTE }],
    ["attendance_cancel", { id: 71 }],
  ] as const)("agent sem o contato do atendimento não alcança %s por id", async (operation, input) => {
    await expect(
      executeAmigo({ ...humano("agent"), contactId: undefined }, operation, input),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(g.request).not.toHaveBeenCalled();
  });
});
