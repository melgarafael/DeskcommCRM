import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { auditarSites } from "@/lib/prospecting/site-fetch";
import { enriquecerSitesPendentes } from "@/lib/prospecting/site-enrich";

vi.mock("@/lib/prospecting/site-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prospecting/site-fetch")>()),
  auditarSites: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

const AGORA = "2026-10-10T12:00:00.000Z";

function veredito(classe: string) {
  return {
    ver: 1,
    classe,
    problemas: [],
    checklist: { tem: [], falta: [] },
    final_url: null,
    http_status: null,
    tempo_ms: 10,
    conteudo_resumo: null,
    pagespeed: null,
    verificado_em: AGORA,
  };
}

function bancoFake(linhas: Array<{ id: string; website: string }>, quebraUpdate = false) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  return {
    updates,
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("from prospecting_candidates")) return { rows: linhas };
        if (sql.startsWith("update prospecting_candidates")) {
          if (quebraUpdate) throw new Error("banco fora");
          updates.push({ sql, params });
          return { rowCount: 1 };
        }
        return { rows: [] };
      },
    } as never,
  };
}

describe("enriquecerSitesPendentes", () => {
  beforeEach(() => {
    vi.mocked(auditarSites).mockReset();
    vi.mocked(audit).mockReset();
  });

  it("enriquece, conta por classe e audita uma vez", async () => {
    vi.mocked(auditarSites).mockResolvedValue([veredito("site-ok"), veredito("agregador")] as never);
    const { pool, updates } = bancoFake([
      { id: "a", website: "https://a.com" },
      { id: "b", website: "https://instagram.com/x" },
    ]);
    const resumo = await enriquecerSitesPendentes(pool, "org", "req", Date.now() + 60000);
    expect(resumo).toEqual({ enriquecidos: 2, classes: { "site-ok": 1, agregador: 1 } });
    expect(updates).toHaveLength(2);
    expect(updates[0]!.sql).toContain("data || jsonb_build_object('site'");
    // A fiação da reverificação: o tick passa as tentativas acumuladas para o lote.
    expect(vi.mocked(auditarSites)).toHaveBeenCalledWith(
      ["https://a.com", "https://instagram.com/x"],
      expect.any(String),
      6,
      expect.anything(),
      undefined,
      [0, 0],
    );
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "prospecting.site_enriched" }),
    );
  });

  it("fila vazia não audita nem busca", async () => {
    const { pool } = bancoFake([]);
    const resumo = await enriquecerSitesPendentes(pool, "org", "req", Date.now() + 60000);
    expect(resumo).toEqual({ enriquecidos: 0, classes: {} });
    expect(vi.mocked(auditarSites)).not.toHaveBeenCalled();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("deadline estourado não busca", async () => {
    const { pool } = bancoFake([{ id: "a", website: "https://a.com" }]);
    const resumo = await enriquecerSitesPendentes(pool, "org", "req", Date.now() - 1);
    expect(resumo).toEqual({ enriquecidos: 0, classes: {} });
    expect(vi.mocked(auditarSites)).not.toHaveBeenCalled();
  });

  it("falha por candidato não derruba o lote (fail-open)", async () => {
    vi.mocked(auditarSites).mockResolvedValue([veredito("site-ok")] as never);
    const { pool, updates } = bancoFake([{ id: "a", website: "https://a.com" }], true);
    const resumo = await enriquecerSitesPendentes(pool, "org", "req", Date.now() + 60000);
    expect(resumo).toEqual({ enriquecidos: 0, classes: {} });
    expect(updates).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});
