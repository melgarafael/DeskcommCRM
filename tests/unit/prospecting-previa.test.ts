/**
 * A PRÉVIA GUARDADA (B1): a copy que a tela gerou é gravada no candidato e
 * reusada no envio — mas ela vale só enquanto a MEDIÇÃO que a produziu valer.
 *
 * O teste mora em dois eixos, e os dois são o defeito de amanhã se ficarem de fora:
 *
 *  1. A CHAVE DA AUDITORIA. A prévia precisa saber SOBRE QUAL veredito foi
 *     escrita. Ancorar em "agora" faria a prévia nascer inválida no segundo
 *     seguinte (o timestamp derivado muda a cada leitura) — por isso derivado
 *     ancora na CLASSE, e gravado ancora na MEDIÇÃO (`verificado_em`).
 *  2. O FILTRO DE ORGANIZAÇÃO na gravação. Sem ele, um `update` por id sem
 *     filtro de tenant escreveria na prévia de OUTRA empresa.
 */
import { describe, expect, it } from "vitest";
import {
  chaveDaAuditoria,
  gravarPrevia,
  previaValida,
  type PreviaSalva,
} from "@/lib/prospecting/previa";
import type { SiteEnrichment } from "@/lib/prospecting/site-classify";

const ORG = "99999999-9999-4999-8999-999999999999";
const CAMPANHA = "22222222-2222-4222-8222-222222222222";
const CANDIDATO = "33333333-3333-4333-8333-333333333333";

const SITE_DEFINITIVO: SiteEnrichment = {
  ver: 1,
  classe: "fora-do-ar",
  problemas: ["fora-do-ar"],
  checklist: { tem: [], falta: [] },
  final_url: null,
  http_status: null,
  tempo_ms: 120,
  conteudo_resumo: null,
  pagespeed: null,
  verificado_em: "2026-10-10T12:00:00.000Z",
  provisorio: false,
  tentativas: 0,
};

function previa(baseada_em: string, texto = "Olá, tudo bem?"): PreviaSalva {
  return { texto, baseada_em, gerada_em: "2026-10-11T09:00:00.000Z", agente_id: "11111111-1111-4111-8111-111111111111" };
}

describe("prévia guardada: a chave da auditoria é estável", () => {
  it("A) o veredito GRAVADO ancora a chave na medição, nunca no instante da leitura", () => {
    const chave = chaveDaAuditoria({ website: "https://vitta.test", site: SITE_DEFINITIVO });
    expect(chave).toContain(SITE_DEFINITIVO.verificado_em);
    expect(chave).toContain("fora-do-ar");
  });

  it("A) o veredito DERIVADO ancora na CLASSE — nunca no instante da leitura", () => {
    const chave = chaveDaAuditoria({ website: null, site: null });
    expect(chave).toContain("sem-site");
    // "agora" como chave faria a prévia nascer inválida no segundo seguinte.
    expect(chave, "a chave derivada não pode carregar um timestamp volátil").not.toMatch(
      /\d{4}-\d{2}-\d{2}T/,
    );
    expect(chaveDaAuditoria({ website: null, site: null })).toBe(chave);
  });

  it("A) sem site próprio na web e sem website, não há chave (ainda espera auditoria)", () => {
    expect(chaveDaAuditoria({ website: "https://vitta.test", site: null })).toBeNull();
  });

  it("A) prévia de uma medição ANTIGA é inválida (o site foi reauditado)", () => {
    const data = { website: "https://vitta.test", site: SITE_DEFINITIVO };
    const atual = chaveDaAuditoria(data)!;
    expect(previaValida({ ...data, previa: previa(atual) })).not.toBeNull();
    expect(
      previaValida({ ...data, previa: previa("fora-do-ar@2020-01-01T00:00:00.000Z") }),
    ).toBeNull();
  });

  it("A) sem prévia, ou com prévia malformada, nada é devolvido", () => {
    expect(previaValida({ website: "https://x.test", site: SITE_DEFINITIVO })).toBeNull();
    expect(
      previaValida({
        website: "https://x.test",
        site: SITE_DEFINITIVO,
        previa: { texto: "" } as never,
      }),
    ).toBeNull();
  });
});

describe("gravarPrevia: merge de UMA chave, com filtro de organização", () => {
  it("B) filtra por organização e NÃO toma o lock da organização", async () => {
    const chamadas: Array<{ sql: string; params?: unknown[] }> = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        chamadas.push({ sql, params });
        return { rows: [] };
      },
    };
    await gravarPrevia(db as never, {
      organizationId: ORG,
      campaignId: CAMPANHA,
      candidateId: CANDIDATO,
      previa: previa("fora-do-ar@2026-10-10T12:00:00.000Z"),
    });

    const { sql, params } = chamadas[0]!;
    expect(sql).toMatch(/update prospecting_candidates/);
    expect(sql, "o filtro de organização é obrigatório").toMatch(/organization_id\s*=\s*\$\d/);
    expect(sql, "filtra também pela campanha").toMatch(/campaign_id\s*=\s*\$\d/);
    expect(sql, "merge de UMA chave (data || jsonb_build_object)").toMatch(
      /\|\|\s*jsonb_build_object\(/,
    );
    expect(sql, "a prévia não toma o lock da organização").not.toMatch(
      /for update|pg_advisory|withProspectingLock/i,
    );
    expect(params).toContain(ORG);
    expect(params).toContain(CAMPANHA);
    expect(params).toContain(CANDIDATO);
    expect(
      params?.some((p) => typeof p === "string" && p.includes('"baseada_em"')),
      "a prévia vai serializada como jsonb",
    ).toBe(true);
  });
});
