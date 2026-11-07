import { describe, expect, it } from "vitest";
import { escritaCabeNoTurno } from "./escopo-das-escritas";
const ORG = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
function database(fail = false) {
  const tables: Record<string, Record<string, unknown>[]> = {
    amigo_connections: [{ id: "current", organization_id: ORG, active: true }],
    amigo_patient_links: [
      { organization_id: ORG, connection_id: "current", contact_id: CONTACT, patient_id: 12 },
      { organization_id: ORG, connection_id: "current", contact_id: OTHER, patient_id: 13 },
      { organization_id: ORG, connection_id: "old", contact_id: CONTACT, patient_id: 14 },
      { organization_id: OTHER, connection_id: "current", contact_id: CONTACT, patient_id: 15 },
    ],
    amigo_appointment_links: [
      { organization_id: ORG, connection_id: "current", attendance_id: 71, patient_id: 12 },
      { organization_id: ORG, connection_id: "current", attendance_id: 72, patient_id: 13 },
    ],
    crm_leads: [{ id: "lead-other", organization_id: ORG, contact_id: OTHER }],
  };
  return { from: (table: string) => {
    let rows = tables[table] ?? [];
    const chain = { select: () => chain, eq: (key: string, value: unknown) => { rows = rows.filter(r => r[key] === value); return chain; }, maybeSingle: async () => ({ data: rows[0] ?? null, error: fail ? { message: "offline" } : null }) };
    return chain;
  } } as never;
}
async function check(tool: string, args: Record<string, unknown>, db = database()) { return escritaCabeNoTurno(db, ORG, CONTACT, `crm_amigo_${tool}`, args); }
describe("escopo de escritas Amigo", () => {
  it("aceita IDs numéricos legítimos sem abrir o bypass de escrita delegada", async () => {
    expect(await check("attendance_create", { contact_id: CONTACT, patient_id: 12, event_id: 3, user_id: 4, place_id: 5 })).toEqual({ permitido: true });
  });
  it.each([13, 14, 15, 999, "12", [12], -1, 1.5])("recusa paciente alheio, conexão antiga ou ID inválido: %j", async patient_id => {
    expect(await check("patient_update", { contact_id: CONTACT, patientId: patient_id })).toMatchObject({ permitido: false });
  });
  it.each([72, 999])("consulta alheia ou inexistente: %s", async id => {
    expect(await check("attendance_cancel", { contact_id: CONTACT, patient_id: 12, id })).toMatchObject({ permitido: false });
  });
  it("permite consulta própria apenas com o paciente explicitamente selecionado", async () => {
    expect(await check("attendance_cancel", { contact_id: CONTACT, patient_id: 12, id: 71 })).toEqual({ permitido: true });
    expect(await check("attendance_cancel", { contact_id: CONTACT, patient_id: 13, id: 71 })).toMatchObject({ permitido: false });
  });
  it.each([{}, { contact_id: OTHER }, { contact_id: null }])("nova escrita exige contato explícito do turno: %j", async args => {
    expect(await check("patient_create", args)).toMatchObject({ permitido: false });
  });
  it("a escolha de um novo paciente chega ao domínio, que verifica telefone; não exige vínculo prévio", async () => {
    expect(await check("link_patient", { contact_id: CONTACT, patient_id: 99 })).toEqual({ permitido: true });
  });
  it("o negócio do vínculo também deve pertencer ao contato", async () => {
    expect(await check("link_patient", { contact_id: CONTACT, patient_id: 99, lead_id: "lead-other" })).toMatchObject({ permitido: false });
  });
  it("falha na conferência não libera escrita", async () => {
    expect(await check("patient_update", { contact_id: CONTACT, patientId: 12 }, database(true))).toMatchObject({ permitido: false, motivo: "indisponivel" });
  });
});

describe("contexto Amigo nas escritas de agenda existentes", () => {
  it.each(["crm_book_appointment", "crm_find_and_book_appointment"])("%s aceita seleção do paciente deste contato e recusa outro", async tool => {
    const base = { contact_id: CONTACT, amigo: { patient_id: 12, user_id: 3, place_id: 4 } };
    expect(await escritaCabeNoTurno(database(), ORG, CONTACT, tool, base)).toEqual({ permitido: true });
    expect(await escritaCabeNoTurno(database(), ORG, CONTACT, tool, { ...base, amigo: { ...base.amigo, patient_id: 13 } })).toMatchObject({ permitido: false });
    expect(await escritaCabeNoTurno(database(), ORG, CONTACT, tool, { ...base, amigo: { ...base.amigo, patient_id: 14 } })).toMatchObject({ permitido: false });
  });
  it("contexto aninhado não aceita alvos arbitrários nem campos extras", async () => {
    for (const amigo of [{ patient_id: "12", user_id: 3, place_id: 4 }, { patient_id: 12 }, { patient_id: 12, user_id: 3, place_id: 4, contact_id: OTHER }]) {
      expect(await escritaCabeNoTurno(database(), ORG, CONTACT, "crm_book_appointment", { contact_id: CONTACT, amigo })).toMatchObject({ permitido: false });
    }
  });
});
