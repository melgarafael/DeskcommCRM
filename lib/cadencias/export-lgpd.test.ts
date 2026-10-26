import { beforeEach, describe, expect, it, vi } from "vitest";
const estado = vi.hoisted(() => ({ instalado: false, falha: false, lidas: [] as string[] }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://synthetic.test" } }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: async () => ({ valor: "" }) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({
  from: (tabela: string) => {
    estado.lidas.push(tabela);
    const objeto = tabela === "organizations" ? { legal_name: "Empresa Sintética", country: "BR", timezone: "America/Sao_Paulo" }
      : tabela === "contacts" ? { id: "contato-a", name: "Pessoa Sintética", custom_fields: {}, tags: [], source_metadata: {} }
      : tabela === "modulos_instalados" && estado.instalado ? { modulo: "cadencias" } : null;
    const linhas = tabela === "email_cadence_enrollments" ? [{ id: "inscricao-a", status: "parada", motivo_parada: "descadastro", rastreio_consentido: false }]
      : tabela === "email_cadence_events" ? [{ id: "evento-a", enrollment_id: "inscricao-a", tipo: "descadastrou" }] : [];
    const error = tabela === "email_cadence_enrollments" && estado.falha ? { code: "42P01", message: "tabela faltou" } : null;
    const q: unknown = new Proxy({}, { get: (_, prop) => {
      if (prop === "then") return (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) => Promise.resolve({ data: error ? null : linhas, error, count: 0 }).then(ok, falha);
      if (prop === "maybeSingle" || prop === "single") return async () => ({ data: objeto, error: null });
      return () => q;
    } });
    return q;
  }, rpc: async () => ({ data: null, error: null }),
}) }));
import { collectExportData } from "@/lib/lgpd/export-collector";
const args = { organizationId: "org-sintetica", requestId: "pedido-sintetico", contactId: "contato-a", externalCustomerId: null };
beforeEach(() => { estado.instalado = false; estado.falha = false; estado.lidas = []; });
describe("export de cadências preserva o contrato de quem não instalou", () => {
  it("módulo ausente não inventa chaves nem consulta suas tabelas", async () => {
    const data = await collectExportData(args);
    expect(data).not.toHaveProperty("cadencias_inscricoes"); expect(data).not.toHaveProperty("cadencias_eventos");
    expect(estado.lidas.some((t) => t.startsWith("email_cadence"))).toBe(false);
  });
  it("registro instalado exporta inscrições e eventos reais devolvidos pelo transporte", async () => {
    estado.instalado = true;
    const data = await collectExportData(args);
    expect(data.cadencias_inscricoes).toEqual([expect.objectContaining({ id: "inscricao-a", motivo_parada: "descadastro" })]);
    expect(data.cadencias_eventos).toEqual([expect.objectContaining({ enrollment_id: "inscricao-a", tipo: "descadastrou" })]);
    expect(estado.lidas).toContain("email_cadence_events");
  });
  it("módulo instalado com falha de leitura aborta a coleta", async () => {
    estado.instalado = true; estado.falha = true;
    await expect(collectExportData(args)).rejects.toThrow("cadencias_export_load_failed");
  });
});
