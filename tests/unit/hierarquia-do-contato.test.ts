import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolverHierarquiaDoContato } from "@/lib/plataformas-de-anuncio/hierarquia-do-contato";

/**
 * A pergunta que este arquivo responde: QUANDO se gasta cota.
 *
 * A conta opera no degrau mais baixo da plataforma, e um anúncio que presta
 * gera centenas de contatos. Cada decisão aqui — servir do cache, reperguntar,
 * ou devolver o vencido — é a diferença entre a feature durar o dia ou a cota
 * acabar antes do almoço.
 */

const { leitura, credencial } = vi.hoisted(() => ({
  leitura: vi.fn(),
  credencial: vi.fn(),
}));

vi.mock("@/lib/plataformas-de-anuncio/meta/hierarquia-do-anuncio", () => ({
  lerHierarquiaDoAnuncio: leitura,
}));
vi.mock("@/lib/plataformas-de-anuncio/credenciais-de-leitura", () => ({
  lerCredencialDeLeitura: credencial,
}));

const ORG = "org-1";
const AD = "120210000000000";

const HA_UM_DIA = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const HA_UM_MES = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

const LINHA = {
  ad_name: "Criativo 07",
  adset_id: "6123",
  adset_name: "Lookalike 1%",
  campaign_id: "2345",
  campaign_name: "Leads Setembro",
};

/** Um admin client falso: devolve a linha pedida e registra o upsert. */
function adminFalso(linha: Record<string, unknown> | null) {
  const upserts: Record<string, unknown>[] = [];
  const filtros: Record<string, unknown> = {};
  const cadeia: Record<string, unknown> = {
    select: () => cadeia,
    eq: (coluna: string, valor: unknown) => {
      filtros[coluna] = valor;
      return cadeia;
    },
    maybeSingle: async () => ({ data: linha, error: null }),
  };
  const admin = {
    from: () => ({
      ...cadeia,
      upsert: async (linhaNova: Record<string, unknown>) => {
        upserts.push(linhaNova);
        return { error: null };
      },
    }),
  } as unknown as SupabaseClient;
  return { admin, upserts, filtros };
}

const comToken = () =>
  credencial.mockResolvedValue({ ok: true, credencial: { accessToken: "tok" } });

beforeEach(() => {
  leitura.mockReset();
  credencial.mockReset();
});

describe("quando NÃO se gasta cota", () => {
  it("linha fresca no cache: a plataforma nem é chamada", async () => {
    comToken();
    const { admin } = adminFalso({ ...LINHA, fetched_at: HA_UM_DIA });

    const r = await resolverHierarquiaDoContato(admin, ORG, AD);

    expect(leitura).not.toHaveBeenCalled();
    expect(r).toEqual({
      adId: AD,
      adName: "Criativo 07",
      adsetId: "6123",
      adsetName: "Lookalike 1%",
      campaignId: "2345",
      campaignName: "Leads Setembro",
    });
  });

  it("sem conexão de leitura não há a quem perguntar", async () => {
    credencial.mockResolvedValue({ ok: false, motivo: "sem_conexao" });
    const { admin } = adminFalso(null);

    expect(await resolverHierarquiaDoContato(admin, ORG, AD)).toBeNull();
    expect(leitura).not.toHaveBeenCalled();
  });
});

describe("quando a linha venceu", () => {
  it("repergunta e regrava, com a data nova", async () => {
    comToken();
    leitura.mockResolvedValue({
      ok: true,
      dados: {
        adId: AD,
        adName: "Criativo 09",
        adsetId: "6123",
        adsetName: "Lookalike 1%",
        campaignId: "2345",
        campaignName: "Leads Outubro",
      },
    });
    const { admin, upserts } = adminFalso({ ...LINHA, fetched_at: HA_UM_MES });

    const r = await resolverHierarquiaDoContato(admin, ORG, AD);

    expect(r?.campaignName).toBe("Leads Outubro");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      organization_id: ORG,
      platform: "meta_ads",
      ad_id: AD,
      campaign_name: "Leads Outubro",
    });
  });

  it("COTA devolve o nome velho, e NUNCA grava vazio", async () => {
    // A distinção que sustenta a feature: 613 é espera, não ausência. Gravar um
    // vazio aqui faria a ficha mentir para sempre sobre um anúncio no ar.
    comToken();
    leitura.mockResolvedValue({
      ok: false,
      falha: "limite_de_chamadas",
      detalhe: "rate limit",
    });
    const { admin, upserts } = adminFalso({ ...LINHA, fetched_at: HA_UM_MES });

    const r = await resolverHierarquiaDoContato(admin, ORG, AD);

    expect(r?.campaignName).toBe("Leads Setembro");
    expect(upserts).toHaveLength(0);
  });

  it("token inválido também devolve o velho, sem apagar nada", async () => {
    comToken();
    leitura.mockResolvedValue({ ok: false, falha: "token_invalido", detalhe: "x" });
    const { admin, upserts } = adminFalso({ ...LINHA, fetched_at: HA_UM_MES });

    expect((await resolverHierarquiaDoContato(admin, ORG, AD))?.adName).toBe("Criativo 07");
    expect(upserts).toHaveLength(0);
  });
});

describe("quando não há nada guardado", () => {
  it("resolve, grava e devolve", async () => {
    comToken();
    leitura.mockResolvedValue({
      ok: true,
      dados: {
        adId: AD,
        adName: "Criativo 07",
        adsetId: "6123",
        adsetName: "Lookalike 1%",
        campaignId: "2345",
        campaignName: "Leads Setembro",
      },
    });
    const { admin, upserts, filtros } = adminFalso(null);

    const r = await resolverHierarquiaDoContato(admin, ORG, AD);

    expect(r?.campaignName).toBe("Leads Setembro");
    expect(upserts).toHaveLength(1);
    // O id do anúncio é da PLATAFORMA: duas organizações podem alcançar a mesma
    // conta, e ler sem a organização mostraria, na ficha de uma, o nome que a
    // outra deu ao anúncio.
    expect(filtros.organization_id).toBe(ORG);
  });

  it("falha de rede devolve null em vez de derrubar a ficha", async () => {
    comToken();
    leitura.mockResolvedValue({ ok: false, falha: "transitorio", detalhe: "ECONNRESET" });
    const { admin } = adminFalso(null);

    expect(await resolverHierarquiaDoContato(admin, ORG, AD)).toBeNull();
  });
});
