import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import {
  auditarSites,
  INTERVALO_MINIMO_ENTRE_TENTATIVAS_MIN,
  LIMITE_TENTATIVAS,
} from "@/lib/prospecting/site-fetch";
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
  const curas: Array<{ sql: string; params: unknown[] }> = [];
  const selects: Array<{ sql: string; params: unknown[] }> = [];
  return {
    updates,
    curas,
    selects,
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("from prospecting_candidates")) {
          if (sql.startsWith("select")) selects.push({ sql, params });
          return { rows: linhas };
        }
        if (sql.startsWith("update prospecting_candidates")) {
          if (quebraUpdate) throw new Error("banco fora");
          // Cura em LOTE (sem `id = $X`) x update POR candidato: coisas
          // diferentes, com contadores diferentes.
          const porCandidato = sql.includes(" and id = $2 ");
          (porCandidato ? updates : curas).push({ sql, params });
          return { rowCount: porCandidato ? 1 : 0 };
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

  it("caso A: provisório só volta depois do intervalo mínimo (parâmetro, não número)", async () => {
    const { pool, selects } = bancoFake([]);
    await enriquecerSitesPendentes(pool, "org", "req", Date.now() + 60000, "camp-1");
    expect(selects).toHaveLength(1);
    const selecao = selects[0]!;
    expect(selecao.sql).toContain("verificado_em");
    expect(selecao.sql).toContain("$4");
    // O botão é POR CAMPANHA: o filtro vai como parâmetro, nunca concatenado.
    expect(selecao.sql).toContain("campaign_id = $5");
    expect(selecao.params[3]).toBe(INTERVALO_MINIMO_ENTRE_TENTATIVAS_MIN);
    expect(selecao.params[4]).toBe("camp-1");
  });

  it("caso B: primeira tentativa continua imediata (sem condição de tempo)", async () => {
    const { pool, selects } = bancoFake([]);
    await enriquecerSitesPendentes(pool, "org", "req", Date.now() + 60000);
    const sql = selects[0]!.sql;
    expect(sql).toContain("data->'site' is null");
    const [antes, depois] = sql.split("data->'site' is null");
    expect(antes).not.toContain("verificado_em");
    expect(depois).toContain("verificado_em");
  });

  it("caso C: intervalo cobre período de verdade, não 3 minutos", () => {
    expect(INTERVALO_MINIMO_ENTRE_TENTATIVAS_MIN).toBeGreaterThan(1);
    expect(INTERVALO_MINIMO_ENTRE_TENTATIVAS_MIN * (LIMITE_TENTATIVAS - 1)).toBeGreaterThanOrEqual(
      60,
    );
  });

  it("caso D: sem URL e sem veredito ganha 'sem-site' em lote, sem rede", async () => {
    const { pool, curas } = bancoFake([]);
    vi.mocked(auditarSites).mockResolvedValue([] as never);
    await enriquecerSitesPendentes(pool, "org", "req", Date.now() + 60000, "camp-1");
    // O UPDATE em lote cura as linhas órfãs (sem website): medidas 116 na org —
    // sem ele, a tela mostra "A verificar" para sempre (o select de rede exige
    // `website` não-nulo, então essas linhas nunca chegavam ao veredito puro).
    const cura = curas.find(
      (u) => u.sql.includes("data->'site' is null") && u.sql.includes("data || jsonb_build_object('site'"),
    );
    expect(cura, "sem o UPDATE puro, a linha sem URL fica eterna em A verificar").toBeDefined();
    expect(cura!.sql).toContain("nullif(trim(data->>'website'), '') is null");
    // A campanha também delimita o lote puro.
    expect(cura!.sql).toContain("campaign_id = $2");
    expect(cura!.params[1]).toBe("camp-1");
  });

  it("caso E: cura sem linhas de rede ainda aparece no resumo", async () => {
    // A campanha pode ter SO linha órfã (sem URL): a cura roda e o botão
    // precisa mostrar o número — o early return antigo devolvia 0.
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("from prospecting_candidates")) return { rows: [] };
        if (sql.startsWith("update prospecting_candidates")) {
          updates.push({ sql, params });
          return { rowCount: sql.includes(" and id = $2 ") ? 1 : 3 };
        }
        return { rows: [] };
      },
    } as never;
    const resumo = await enriquecerSitesPendentes(pool, "org", "req", Date.now() + 60000, "camp-1");
    expect(resumo).toEqual({ enriquecidos: 3, classes: { "sem-site": 3 } });
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
  });
});
