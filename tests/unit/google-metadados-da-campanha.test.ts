import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizarMetadadosGoogle } from "@/lib/plataformas-de-anuncio/google/metadados-da-campanha";
import { criarClickRef } from "@/lib/plataformas-de-anuncio/google/captura-de-clique";
import { extrairEEstamparAtribuicaoGoogle } from "@/lib/plataformas-de-anuncio/google/atribuicao";
import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";
import { lerAtribuicao } from "@/lib/conversoes/leitura-da-atribuicao";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/campanhas/origem-do-lead", () => ({
  origemDeCampanhaDaConversa: vi.fn(async () => null),
  marcaDaOrigem: vi.fn(),
}));
vi.mock("@/lib/leads/reabrir-perdido", () => ({ reabrirPerdidoRecente: vi.fn(async () => null) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));

const ORG = "org-1";
type Linha = Record<string, unknown>;
const CAMPANHA = {
  utm_source: "google",
  utm_campaign: "Pesquisa Rio",
  utm_adset: "Grupo Barra",
  utm_ad: "Criativo A",
  utm_term: "consulta",
  utm_content: "texto",
  google_campaign_id: "90071992547409930001",
  google_adgroup_id: "456",
  google_ad_id: "789",
  google_customer_id: "1234567890",
};
let contatos: Linha[];
let cliques: Linha[];
let leads: Linha[];
let nascimentos: Linha[];

const admin = {
  from(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    let patch: Linha | null = null;
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => (filtros.push((l) => l[k] === v), q),
      is: (k: string, v: unknown) => (filtros.push((l) => (l[k] ?? null) === v), q),
      order: () => q,
      limit: () => q,
      update: (v: Linha) => ((patch = v), q),
      insert: async (v: Linha) => {
        if (tabela !== "google_ads_click_refs") throw new Error(tabela);
        cliques.push({ ...structuredClone(v), matched_at: null, contact_id: null });
        return { error: null };
      },
      maybeSingle: async () => {
        const rows =
          tabela === "contacts"
            ? contatos
            : tabela === "google_ads_click_refs"
              ? cliques
              : tabela === "crm_leads"
                ? leads
                : tabela === "organizations"
                  ? [{ id: ORG, settings: {} }]
                  : tabela === "crm_pipelines"
                    ? [{ id: "funil", settings: {} }]
                    : tabela === "crm_stages"
                      ? [{ id: "etapa" }]
                      : [];
        // Fixtures das tabelas de destino só fornecem o resultado validado;
        // filtros tenant/contato/clique são efetivos nas tabelas sob teste.
        const linha = ["contacts", "google_ads_click_refs", "crm_leads"].includes(tabela)
          ? rows.find((l) => filtros.every((f) => f(l)))
          : rows[0];
        if (linha && patch) Object.assign(linha, structuredClone(patch));
        return { data: linha ? structuredClone(linha) : null, error: null };
      },
    };
    return q;
  },
  async rpc(nome: string, args: Linha) {
    if (nome === "fn_estampar_atribuicao_de_anuncio") {
      const c = contatos.find((l) => l.organization_id === args.p_org && l.id === args.p_contact);
      if (c && !(c.source_metadata as Linha).ad_platform) {
        c.source = args.p_platform;
        c.source_metadata = { ...(c.source_metadata as Linha), ...(args.p_metadata as Linha) };
      }
      return { error: null };
    }
    if (nome === "fn_nascer_lead_da_mensagem") {
      nascimentos.push(args);
      return { data: "lead-novo", error: null };
    }
    return { error: null, data: null };
  },
} as never;

beforeEach(() => {
  contatos = ["a", "b"].map((id) => ({
    id,
    organization_id: ORG,
    source: "whatsapp",
    source_metadata: { importado: true },
    is_blocked: false,
    is_personal: false,
    display_name: "Pessoa fictícia",
    tags: [],
  }));
  cliques = [];
  leads = [];
  nascimentos = [];
});

const nascer = (contactId = "a") =>
  garantirLeadDaConversa(admin, {
    organizationId: ORG,
    contactId,
    conversationId: "conversa",
    messageId: "mensagem",
    nomeDoContato: null,
  });

describe("metadados de campanha do Google", () => {
  it("preserva rótulos e IDs separadamente, inclusive IDs além da precisão de number", () => {
    expect(
      normalizarMetadadosGoogle({
        " UTM_CAMPAIGN ": " Pesquisa Rio ",
        utm_adset: "Grupo Barra",
        utm_ad: "Criativo A",
        utm_term: "consulta",
        utm_content: "texto",
        utm_source: "google",
        campaignid: "90071992547409930001",
        adgroupid: "456",
        ad_id: "789",
        customerid: "1234567890",
      }),
    ).toEqual(CAMPANHA);
  });

  it("uma UTM numérica, o clique e a conexão não inventam IDs ou conta", () => {
    expect(
      normalizarMetadadosGoogle({
        utm_campaign: "123",
        utm_content: "456",
        gclid: "789",
        google_login_customer_id: "1234567890",
      }),
    ).toEqual({ utm_campaign: "123", utm_content: "456" });
  });

  it("aceita só campos string permitidos; macros, URLs e valores malformados são descartados", () => {
    expect(
      normalizarMetadadosGoogle({
        utm_campaign: "{campaignid}",
        utm_adset: "<script>",
        utm_ad: "https://site.example/privado",
        utm_term: ["consulta"],
        utm_content: "linha\nquebrada",
        utm_medium: "x".repeat(201),
        campaignid: 123,
        adgroupid: "1e5",
        creative: "9".repeat(31),
        google_customer_id: "conta",
        email: "privado",
        phone: "privado",
        access_token: "segredo",
      }),
    ).toEqual({});
    expect(normalizarMetadadosGoogle(null)).toEqual({});
    expect(normalizarMetadadosGoogle([])).toEqual({});
  });

  it("ID canônico válido ganha de alias e rótulos não entram em campos de ID", () => {
    expect(
      normalizarMetadadosGoogle({
        google_campaign_id: "00123",
        campaignid: "999",
        adgroupid: "Grupo Barra",
      }),
    ).toEqual({ google_campaign_id: "00123" });
    expect(normalizarMetadadosGoogle({
      utm_campaign: null, UTM_CAMPAIGN: "Antiga", google_ad_id: null, creative: "999",
    })).toEqual({});
  });

  it("conta tem dez dígitos e aceita somente a formatação conhecida", () => {
    expect(normalizarMetadadosGoogle({ google_customer_id: "123-456-7890" })).toEqual({
      google_customer_id: "1234567890",
    });
    for (const valor of ["123", "12345678901", "+1234567890", "123 456 7890"])
      expect(normalizarMetadadosGoogle({ google_customer_id: valor })).toEqual({});
  });
});

describe("recibo Google → contato → nascimento nativo", () => {
  it("leva a projeção da URL ao contato e ao card, sem depender do payload de um canal", async () => {
    const criado = await criarClickRef(
      admin,
      ORG,
      { gclid: "clique-real" },
      {
        ...CAMPANHA,
        email: "nao-persistir",
        ad_raw: "nao-persistir",
      },
    );
    expect(cliques[0]!.query_raw).toEqual({ ...CAMPANHA, gclid: "clique-real" });
    const atribuicao = await extrairEEstamparAtribuicaoGoogle(
      admin,
      ORG,
      "a",
      `Olá [ref:${criado!.token}]`,
    );
    expect(atribuicao).not.toBeNull();
    expect(contatos[0]!.source_metadata).toMatchObject({
      ...CAMPANHA,
      ad_platform: "google_ads",
      ad_source_id: "clique-real",
      ad_id: null,
    });
    expect(
      await garantirLeadDaConversa(admin, {
        organizationId: ORG,
        contactId: "a",
        conversationId: "conversa",
        messageId: "mensagem",
        nomeDoContato: null,
        atribuicaoDaMensagem: atribuicao!,
      }),
    ).toMatchObject({ criado: true });
    expect(nascimentos[0]!.p_source).toBe("google_ads");
    expect(nascimentos[0]!.p_source_metadata).toMatchObject(CAMPANHA);
    expect(nascimentos[0]!.p_tags).toEqual(["Google_ads"]);
    expect(JSON.stringify(nascimentos)).not.toContain("nao-persistir");
  });

  it("ref de outra organização e replay por outro contato não compartilham o clique", async () => {
    const criado = await criarClickRef(admin, ORG, "clique", CAMPANHA);
    const texto = `[ref:${criado!.token}]`;
    expect(await extrairEEstamparAtribuicaoGoogle(admin, "outra-org", "a", texto)).toBeNull();
    expect(cliques[0]!.matched_at).toBeNull();
    expect(await extrairEEstamparAtribuicaoGoogle(admin, ORG, "a", texto)).not.toBeNull();
    expect(await extrairEEstamparAtribuicaoGoogle(admin, ORG, "b", texto)).toBeNull();
    expect(contatos[1]!.source_metadata).toEqual({ importado: true });
    expect(cliques[0]!.contact_id).toBe("a");
  });

  it("não reescreve o primeiro toque, mesmo que o contato envie outro ref", async () => {
    contatos[0]!.source = "site";
    contatos[0]!.source_metadata = { ad_platform: "site", utm_campaign: "Primeira" };
    const criado = await criarClickRef(admin, ORG, "clique-novo", CAMPANHA);
    await extrairEEstamparAtribuicaoGoogle(admin, ORG, "a", `[ref:${criado!.token}]`);
    expect(contatos[0]!.source_metadata).toEqual({ ad_platform: "site", utm_campaign: "Primeira" });
    await nascer();
    expect(nascimentos[0]!.p_source).toBe("site");
    expect(nascimentos[0]!.p_source_metadata).toEqual({
      ad_platform: "site",
      utm_campaign: "Primeira",
    });
  });

  it("novo negócio usa o clique novo e o contato conserva a campanha original", async () => {
    contatos[0]!.source = "google_ads";
    contatos[0]!.source_metadata = {
      ad_platform: "google_ads",
      utm_campaign: "Primeira",
      ad_source_id: "antigo",
    };
    const criado = await criarClickRef(admin, ORG, "clique-novo", CAMPANHA);
    const atribuicao = await extrairEEstamparAtribuicaoGoogle(
      admin,
      ORG,
      "a",
      `[ref:${criado!.token}]`,
    );
    await garantirLeadDaConversa(admin, {
      organizationId: ORG,
      contactId: "a",
      conversationId: "conversa",
      messageId: "mensagem",
      nomeDoContato: null,
      atribuicaoDaMensagem: atribuicao!,
    });
    expect(contatos[0]!.source_metadata).toMatchObject({
      utm_campaign: "Primeira",
      ad_source_id: "antigo",
    });
    expect(nascimentos[0]!.p_source_metadata).toMatchObject({
      ...CAMPANHA,
      ad_source_id: "clique-novo",
    });
  });

  it("recibo antigo é reprojetado e sem campanha continua atribuindo só o clique", async () => {
    cliques.push({
      organization_id: ORG,
      token: "K7M2P9",
      matched_at: null,
      gclid: "clique-antigo",
      query_raw: {
        utm_campaign: "Real",
        campaignid: "123",
        access_token: "nao-atravessa",
        utm_ad: {},
      },
    });
    await extrairEEstamparAtribuicaoGoogle(admin, ORG, "a", "[ref:K7M2P9]");
    expect(contatos[0]!.source_metadata).toMatchObject({
      utm_campaign: "Real",
      google_campaign_id: "123",
    });
    expect(JSON.stringify(contatos[0]!.source_metadata)).not.toContain("nao-atravessa");
    const criado = await criarClickRef(admin, ORG, "so-clique", {});
    await extrairEEstamparAtribuicaoGoogle(admin, ORG, "b", `[ref:${criado!.token}]`);
    expect(contatos[1]!.source_metadata).toMatchObject({
      ad_platform: "google_ads",
      ad_source_id: "so-clique",
    });
    expect(contatos[1]!.source_metadata).toHaveProperty("google_customer_id", null);
  });

  it("primeiro Google parcial limpa campos antigos e não envia a conversão como Meta", async () => {
    contatos[0]!.source_metadata = {
      importado: true,
      campo_do_integrador: "preservar",
      utm_source: "facebook",
      utm_campaign: "Campanha antiga",
      utm_adset: "Grupo antigo",
      utm_ad: "Anúncio antigo",
      utm_content: "Texto antigo",
      google_campaign_id: "999",
      google_customer_id: "9999999999",
      ad_click_source: "site",
      fbc: "fb.1.antigo",
      fbp: "fb.1.antigo",
    };
    const criado = await criarClickRef(admin, ORG, "clique-atual", {
      utm_term: "consulta atual",
      google_adgroup_id: "456",
    });
    const atribuicao = await extrairEEstamparAtribuicaoGoogle(
      admin,
      ORG,
      "a",
      `[ref:${criado!.token}]`,
    );
    expect(contatos[0]!.source_metadata).toMatchObject({
      importado: true,
      campo_do_integrador: "preservar",
      utm_source: null,
      utm_campaign: null,
      utm_adset: null,
      utm_ad: null,
      utm_content: null,
      google_campaign_id: null,
      google_customer_id: null,
      utm_term: "consulta atual",
      google_adgroup_id: "456",
      ad_click_source: null,
      fbc: null,
      fbp: null,
    });
    expect(await lerAtribuicao(admin, ORG, "a")).toEqual({
      temAtribuicao: true,
      atribuicao: {
        plataforma: "google_ads",
        cliqueDeOrigem: "clique-atual",
        identificadoresGoogle: { gclid: "clique-atual" },
        telefone: null,
      },
    });
    await garantirLeadDaConversa(admin, {
      organizationId: ORG,
      contactId: "a",
      conversationId: "conversa",
      messageId: "mensagem",
      nomeDoContato: null,
      atribuicaoDaMensagem: atribuicao!,
    });
    expect(nascimentos[0]!.p_source_metadata).toMatchObject({
      utm_campaign: null,
      google_campaign_id: null,
      google_customer_id: null,
      google_adgroup_id: "456",
      utm_term: "consulta atual",
    });
  });

  it("contato importado ganha origem; negócio já aberto mantém o retrato histórico", async () => {
    leads.push({
      id: "lead-anterior",
      organization_id: ORG,
      contact_id: "a",
      status: "open",
      source_metadata: {},
    });
    const criado = await criarClickRef(admin, ORG, "clique", CAMPANHA);
    await extrairEEstamparAtribuicaoGoogle(admin, ORG, "a", `[ref:${criado!.token}]`);
    expect(await nascer()).toMatchObject({ criado: false, motivo: "ja_existe" });
    expect(contatos[0]!.source_metadata).toMatchObject(CAMPANHA);
    expect(nascimentos).toEqual([]);
    expect(leads[0]!.source_metadata).toEqual({});
  });
});
