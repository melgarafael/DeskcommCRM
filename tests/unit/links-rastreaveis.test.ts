import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  destinoDoLink,
  listarLinks,
  metricasLinks,
} from "@/lib/plataformas-de-anuncio/rastreio/links";
import {
  linkSchema,
  mensagemComRef,
  utmsDoLink,
  type LinkRastreavel,
} from "@/lib/plataformas-de-anuncio/rastreio/contrato";
import { isPublicPath } from "@/lib/auth/public-paths";
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
const link: LinkRastreavel = {
  id: "11223344-1111-4111-8111-112233445566",
  organization_id: "org-a",
  name: "Campanha",
  whatsapp_e164: "+5511999999999",
  message_template: "Quero saber mais [ref:ANTIGO]",
  use_case: "site",
  utm: { utm_source: "instagram" },
  enabled: true,
};
const make = (error: unknown = null) => {
  const insert = vi.fn().mockResolvedValue({ error });
  const from = vi.fn(() => ({ insert }));
  return { admin: { from } as unknown as SupabaseClient, from, insert };
};
describe("links rastreáveis", () => {
  it("o nome do link não vira campanha nem site vira origem explícita do Google", async () => {
    const { admin, insert } = make();
    await destinoDoLink(admin, { ...link, utm: {} }, new URLSearchParams({ gclid: "clique" }));
    expect(insert.mock.calls[0]![0].query_raw).toEqual({ gclid: "clique" });
  });
  it("o link nomeado guarda os rótulos da URL e IDs sem substituí-los pelo nome do link", async () => {
    const { admin, insert } = make();
    await destinoDoLink(admin, link, new URLSearchParams({
      gclid: "clique",
      utm_campaign: "Pesquisa Rio",
      utm_adset: "Grupo Barra",
      utm_ad: "Criativo A",
      campaignid: "90071992547409930001",
      adgroupid: "456",
      creative: "789",
      google_customer_id: "1234567890",
      private_token: "nao-guardar",
    }));
    expect(insert.mock.calls[0]![0].query_raw).toEqual({
      gclid: "clique",
      utm_source: "instagram",
      utm_campaign: "Pesquisa Rio",
      utm_adset: "Grupo Barra",
      utm_ad: "Criativo A",
      google_campaign_id: "90071992547409930001",
      google_adgroup_id: "456",
      google_ad_id: "789",
      google_customer_id: "1234567890",
    });
  });
  it.each(["gclid", "gbraid", "wbraid"])(
    "guarda %s com tenant/link e transporta o token para o WhatsApp",
    async (key) => {
      const { admin, from, insert } = make();
      const dest = new URL(
        await destinoDoLink(
          admin,
          link,
          new URLSearchParams({ [key]: "clique-real", email: "privado", utm_source: "google" }),
        ),
      );
      expect(from).toHaveBeenCalledWith("google_ads_click_refs");
      const row = insert.mock.calls[0]![0];
      expect(row.organization_id).toBe("org-a");
      expect(row.tracking_link_id).toBe(link.id);
      expect(row[key]).toBe("clique-real");
      expect(row.query_raw).not.toHaveProperty("email");
      expect(dest.origin + dest.pathname).toBe("https://wa.me/5511999999999");
      expect(dest.searchParams.get("text")).toBe(`Quero saber mais [ref:${row.token}]`);
    },
  );
  it("macro não vira identificador pago; tráfego orgânico recebe apenas UTMs", async () => {
    const { admin, from, insert } = make();
    await destinoDoLink(
      admin,
      { ...link, use_case: "organico", utm: {} },
      new URLSearchParams("gclid={gclid}&utm_source={source}&password=abc"),
    );
    expect(from).toHaveBeenCalledWith("meta_ads_click_refs");
    expect(insert.mock.calls[0]![0].query_raw).toEqual({
      utm_source: "organico",
      utm_campaign: "Campanha",
    });
  });
  it.each(["resposta", "excecao"])(
    "preserva atendimento sem código falso quando gravação falha: %s",
    async (mode) => {
      const { admin, insert } = make({ code: "503", message: "indisponível" });
      if (mode === "excecao") insert.mockRejectedValue(new Error("rede"));
      const dest = new URL(await destinoDoLink(admin, link, new URLSearchParams("gclid=real")));
      expect(dest.searchParams.get("text")).toBe("Quero saber mais");
    },
  );
  it("elimina marcadores antigos e mantém só um ref", () =>
    expect(mensagemComRef("Olá [ref:AAAAAA] [ref:{token}] {token}")).toBe("Olá [ref:{token}]"));
  it("rejeita telefone inválido e aplica lista permitida de UTMs", () => {
    expect(linkSchema.safeParse({ ...link, whatsapp_e164: "5511" }).success).toBe(false);
    expect(utmsDoLink(link, new URLSearchParams("email=privado&utm_campaign=nova"))).toEqual({
      utm_source: "instagram",
      utm_campaign: "nova",
    });
  });
  it("leituras e métricas recebem a organização resolvida", async () => {
    const q = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const admin = { from: vi.fn(() => q), rpc } as unknown as SupabaseClient;
    await listarLinks(admin, "org-a");
    await metricasLinks(admin, "org-a");
    expect(q.eq).toHaveBeenCalledWith("organization_id", "org-a");
    expect(rpc).toHaveBeenCalledWith("fn_metricas_links_rastreaveis", { p_org: "org-a" });
    rpc.mockResolvedValue({ data: null, error: { message: "erro" } });
    await expect(metricasLinks(admin, "org-a")).rejects.toThrow();
  });
  it("a liberação pública só alcança um UUID, nunca subrotas", () => {
    expect(isPublicPath(`/api/v1/rastreio/${link.id}`)).toBe(true);
    expect(isPublicPath(`/api/v1/rastreio/${link.id}/editar`)).toBe(false);
    expect(isPublicPath("/api/v1/rastreio/admin")).toBe(false);
  });
});
