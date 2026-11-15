/** Keep executeAmigo/linkAmigoPatient real; replace only external IO. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpContext } from "../types";
const io = vi.hoisted(() => ({ request: vi.fn(), load: vi.fn(), db: vi.fn() }));
vi.mock("@/lib/amigo/transport", () => ({ requestAmigo: io.request }));
vi.mock("@/lib/amigo/store", () => ({ loadAmigoConnection: io.load }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: io.db }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
import { amigoTools } from "./amigo";
const ORG = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
function db() {
  const writes: unknown[] = [];
  const tables: Record<string, Record<string, unknown>[]> = {
    contacts: [{ id: CONTACT, organization_id: ORG, phone_number: "+5511988887777", is_anonymized: false }],
    amigo_patient_links: [{ organization_id: ORG, connection_id: "current", patient_id: 12, contact_id: CONTACT }, { organization_id: ORG, connection_id: "current", patient_id: 13, contact_id: OTHER }, { organization_id: ORG, connection_id: "old", patient_id: 14, contact_id: CONTACT }],
  };
  return { writes, from: (table: string) => {
    let rows = tables[table] ?? [];
    const q = { select: () => q, eq: (key: string, value: unknown) => { rows = rows.filter(r => r[key] === value); return q; }, maybeSingle: async () => ({ data: rows[0] ?? null, error: null }), upsert: async (row: unknown) => { writes.push(row); return { error: null }; } };
    return q;
  } };
}
function context(): McpContext { return { organizationId: ORG, role: "ai_operator", actor: { type: "ai_agent", id: "run", role: "ai_operator" }, requestId: "request", apiTokenId: "api", contatoDoTurno: CONTACT, supabase: {} as never }; }
async function call(op: string, args: Record<string, unknown>) { return amigoTools.find(t => t.name === `crm_amigo_${op}`)!.handler({connection_id:"current",...args}, context()); }
beforeEach(() => { vi.clearAllMocks(); io.db.mockReturnValue(db()); io.load.mockResolvedValue({ id: "current", token: "fixture-token-only", active: true, timezone: "America/Fortaleza" }); });
describe("tools Amigo com domínio real", () => {
  it.each([13, 14, 999])("leitura e alteração de paciente alheio/conexão antiga %s não chegam ao provedor", async patientId => {
    for (const op of ["patient_get", "patient_update"]) {
      expect(await call(op, { contact_id: CONTACT, patientId, ...(op === "patient_update" ? { name: "Pessoa teste" } : {}) })).toMatchObject({ permitido: false });
    }
    expect(io.request).not.toHaveBeenCalled();
  });
  it("ID numérico próprio é autorizado no backend e não revela a credencial", async () => {
    io.request.mockResolvedValue({ data: { id: 12, name: "Pessoa teste" }, status: "success" });
    const result = await call("patient_get", { contact_id: CONTACT, patientId: 12 });
    expect(result).toMatchObject({ data: { id: 12 } });
    expect(io.request).toHaveBeenCalledWith("fixture-token-only", "patient_get", { patientId: 12 });
    expect(JSON.stringify(result)).not.toContain("fixture-token-only");
  });
  it("busca substitui o filtro do modelo pelo telefone verificado e não vincula candidatos", async () => {
    const database = db(); io.db.mockReturnValue(database);
    io.request.mockResolvedValue({ data: [{ id: 12 }, { id: 16 }], status: "success" });
    expect(await call("patient_search", { contact_id: CONTACT, cpf: "12345678900" })).toMatchObject({ exige_selecao_explicita: true, data: [{ id: 12 }, { id: 16 }] });
    expect(io.request).toHaveBeenCalledWith("fixture-token-only", "patient_search", { contact_cellphone: "11988887777" });
    expect(database.writes).toEqual([]);
  });
  it("seleção explícita não cria vínculo para paciente que não pertence ao telefone do responsável", async () => {
    const database = db(); io.db.mockReturnValue(database);
    io.request.mockImplementation(async (_token, op) => ({ data: op === "patient_get" ? { id: 99 } : op === "patient_search" ? [{ id: 12 }, { id: 16 }] : [], status: "success" }));
    expect(await call("link_patient", { contact_id: CONTACT, patient_id: 99 })).toMatchObject({ permitido: false });
    expect(database.writes).toEqual([]);
  });
  it("vincula a segunda escolha explicitamente validada em vez de assumir o primeiro resultado", async () => {
    const database = db(); io.db.mockReturnValue(database);
    io.request.mockImplementation(async (_token, op) => ({ data: op === "patient_get" ? { id: 16 } : op === "patient_search" ? [{ id: 12 }, { id: 16 }] : [], status: "success" }));
    expect(await call("link_patient", { contact_id: CONTACT, patient_id: 16 })).toMatchObject({ patient: { id: 16 }, contact_id: CONTACT });
    expect(database.writes).toEqual([{ organization_id: ORG, connection_id: "current", patient_id: 16, contact_id: CONTACT, lead_id: null }]);
  });
});
