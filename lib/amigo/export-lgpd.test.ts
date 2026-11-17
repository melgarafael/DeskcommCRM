/**
 * EXPORTAÇÃO LGPD — o vínculo contato ↔ paciente do módulo `amigo` entra na
 * cópia do titular pelo mesmo caminho de cadências: com o módulo instalado, a
 * chave `amigo_vinculos`; sem ele, o export é idêntico ao de antes e a tabela
 * nem é consultada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
const estado = vi.hoisted(() => ({ instalados: [] as string[], falha: false, lidas: [] as string[] }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://synthetic.test" } }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: async () => ({ valor: "" }) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({
  from: (tabela: string) => {
    estado.lidas.push(tabela);
    let modulo: string | null = null;
    const linhas = tabela === "amigo_patient_links"
      ? [{ connection_id: "conexao-a", patient_id: 12, lead_id: null }] : [];
    const error = tabela === "amigo_patient_links" && estado.falha ? { code: "42P01", message: "tabela faltou" } : null;
    const q: unknown = new Proxy({}, { get: (_, prop) => {
      if (prop === "then") return (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) => Promise.resolve({ data: error ? null : linhas, error, count: 0 }).then(ok, falha);
      if (prop === "maybeSingle" || prop === "single") return async () => ({
        data: tabela === "organizations" ? { legal_name: "Empresa Sintética", country: "BR", timezone: "America/Sao_Paulo" }
          : tabela === "contacts" ? { id: "contato-a", name: "Pessoa Sintética", custom_fields: {}, tags: [], source_metadata: {} }
          : tabela === "modulos_instalados" && modulo && estado.instalados.includes(modulo) ? { modulo } : null,
        error: null,
      });
      if (prop === "eq") return (coluna: string, valor: unknown) => { if (coluna === "modulo") modulo = String(valor); return q; };
      return () => q;
    } });
    return q;
  }, rpc: async () => ({ data: null, error: null }),
}) }));
import { collectExportData } from "@/lib/lgpd/export-collector";
const args = { organizationId: "org-sintetica", requestId: "pedido-sintetico", contactId: "contato-a", externalCustomerId: null };
beforeEach(() => { estado.instalados = []; estado.falha = false; estado.lidas = []; });
describe("export LGPD do módulo amigo", () => {
  it("sem o módulo, o export continua idêntico: nenhuma chave nova e a tabela nem é lida", async () => {
    const sem = await collectExportData(args);
    expect(sem).not.toHaveProperty("amigo_vinculos");
    expect(estado.lidas).not.toContain("amigo_patient_links");
    // Controle: o mesmo export com o módulo instalado só difere pela chave nova.
    estado.instalados = ["amigo"];
    const com = await collectExportData(args);
    const { amigo_vinculos: _vinculos, generated_at: _a, ...resto } = com;
    const { generated_at: _b, ...antes } = sem;
    expect(resto).toEqual(antes);
  });
  it("com o módulo instalado, o export traz o vínculo do titular — só os ids", async () => {
    estado.instalados = ["amigo"];
    const data = await collectExportData(args);
    expect(data.amigo_vinculos).toEqual([{ connection_id: "conexao-a", patient_id: 12, lead_id: null }]);
  });
  it("módulo instalado com falha de leitura aborta a coleta, nunca exporta pela metade", async () => {
    estado.instalados = ["amigo"]; estado.falha = true;
    await expect(collectExportData(args)).rejects.toThrow("amigo_export_load_failed");
  });
});
