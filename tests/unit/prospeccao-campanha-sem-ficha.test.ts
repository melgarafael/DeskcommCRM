/**
 * #4829 (Discussion 4828, itens 1 e 2) — CAMPANHA SEM FICHA DIGITAL.
 *
 * Quem prospecta para vender consórcio, crédito, seguro, contabilidade ou consultoria
 * não vende presença digital. Para esse público a abertura por "vi que vocês têm nota
 * 4,9" soa fora de contexto — e o contorno de hoje é limpar a ficha das empresas da
 * fila por fora.
 *
 * O que este teste fixa é o MATERIAL e a REGRA que chegam ao modelo (o texto varia
 * com temperatura; o material e a ordem, não):
 *
 *   (a) com `usar_ficha_digital: false`, `Ficha do Google`, `Redes`, `Auditoria`,
 *       `Detalhe` e `Site` NÃO entram nos dados, e a regra do motivo deixa de mandar
 *       citá-los — inclusive a exceção da `Auditoria`;
 *   (b) sem a chave (o de sempre), os dados e o prompt saem byte a byte iguais, com
 *       `site` como oferta padrão.
 */
import { describe, expect, it } from "vitest";

import { blocoDeModo, formatarDados } from "@/lib/agent-engine/agent/abordagem-de-formulario";
import {
  instrucaoDeAbordagemFria,
  montarDadosDeAbordagem,
} from "@/lib/prospecting/estrategia-site";
import {
  campaignConfigSchema,
  ofertasDaCampanhaSchema,
  prospectingInputSchema,
  usaFichaDigital,
  type Prospect,
} from "@/lib/prospecting/schema";

const BASE = { key: "k", maps_url: null, emails: [] as string[] };

/** O caso da issue: empresa com reputação digital, para quem a ficha "tem o que citar". */
const COM_REPUTACAO: Prospect = {
  ...BASE,
  name: "Consórcio Vale",
  phone: "+5511999997777",
  website: "https://consorciovale.example",
  category: "Consórcio",
  address: "Av. Central, 200",
  rating: 4.9,
  reviews: 37,
  socials: ["https://instagram.com/consorciovale", "https://facebook.com/consorciovale"],
  whatsapp: { existe: true, verificado_em: "2026-11-03T09:00:00.000Z" },
};

/** O recorte de veredito que `montarDadosDeAbordagem` lê (não o `SiteEnrichment` inteiro). */
const SITE_MEDIDO = {
  classe: "site-ruim" as const,
  problemas: ["falta-tel", "sem-https"],
  conteudo_resumo: "Página inicial com um parágrafo e um formulário de contato.",
  provisorio: false,
  verificado_em: "2026-11-12T10:00:00.000Z",
};

const INSTRUCAO = "Ofereça consórcio de imóvel para quem já pensou em comprar sem juros.";

function dadosSemFicha() {
  return montarDadosDeAbordagem(COM_REPUTACAO, SITE_MEDIDO, null, { semFichaDigital: true });
}

function dadosComFicha() {
  return montarDadosDeAbordagem(COM_REPUTACAO, SITE_MEDIDO, null);
}

describe("campanha sem ficha digital: o que chega ao prompt", () => {
  it("não leva nota, avaliações, redes, site nem auditoria aos dados", () => {
    const dados = dadosSemFicha();
    expect(Object.keys(dados).sort()).toEqual([
      "Empresa",
      "Endereço",
      "Segmento",
      "Telefone",
    ]);
    const ficha = formatarDados(dados);
    // Falha se o sinal digital voltar: nota, número de avaliações, URL de rede,
    // endereço do site ou o veredito da auditoria.
    expect(ficha).not.toMatch(/4[.,]9/);
    expect(ficha).not.toMatch(/\b37\b/);
    expect(ficha).not.toMatch(/instagram|facebook/i);
    expect(ficha).not.toMatch(/consorciovale\.example/);
    expect(ficha).not.toMatch(/Ficha do Google|Redes|Auditoria|Detalhe|Site/);
    // O que a empresa É continua indo: nome, ramo, endereço e como se chega nela.
    expect(ficha).toContain("Consórcio Vale");
    expect(ficha).toContain("Consórcio");
    expect(ficha).toContain("Av. Central, 200");
    expect(ficha).toContain("Telefone");
  });

  it("troca a regra do motivo: abre pelo que a empresa é, e não pela ficha", () => {
    const system = blocoDeModo("prospeccao_fria", "n0nce", INSTRUCAO, { semFichaDigital: true });
    // A regra nova está lá…
    expect(system).toContain("abra pelo que a empresa É");
    expect(system).toContain("ficha digital");
    // …e as três linhas que mandavam citar a ficha saíram, inclusive a exceção da
    // `Auditoria` — que autorizaria justamente o motivo que esta campanha não vende.
    expect(system).not.toContain("escolha UM fato da ficha");
    expect(system).not.toContain("Se a ficha não trouxer `Ficha do Google`");
    expect(system).not.toContain("EXCEÇÃO: o campo `Auditoria`");
    expect(system).not.toContain("Ficha do Google");
  });

  it("não pede o que os dados não trazem: o que ela vende, para quem", () => {
    const system = blocoDeModo("prospeccao_fria", "n0nce", INSTRUCAO, { semFichaDigital: true });
    expect(system).toContain("o ramo (`Segmento`) e a região (`Endereço`)");
    expect(system).toContain("sem fingir que pesquisou");
    expect(system).not.toContain("o que ela vende, para quem");
  });

  it("com contexto da equipe, a indicação continua sendo o motivo", () => {
    const system = blocoDeModo("prospeccao_fria", "n0nce", INSTRUCAO, {
      semFichaDigital: true,
      comContextoDaEquipe: true,
    });
    expect(system).toContain("Indicação, encontro ou conversa anterior do `Contexto da equipe` É o motivo");
    // …e a frase só existe nesse caso: sem contexto não há indicação nenhuma a citar.
    expect(blocoDeModo("prospeccao_fria", "n0nce", INSTRUCAO, { semFichaDigital: true })).not.toContain(
      "conversa anterior do `Contexto da equipe` É o motivo",
    );
  });

  it("a instrução não leva o bloco de estratégia (o ângulo é de site)", () => {
    const semEstrategia = instrucaoDeAbordagemFria(INSTRUCAO, "Quem decide a compra.", undefined, null);
    expect(semEstrategia).toBe(instrucaoDeAbordagemFria(INSTRUCAO, "Quem decide a compra."));
  });
});

describe("campanha com ficha digital: o de sempre, byte a byte", () => {
  it("sem a chave, os dados são idênticos aos de antes, com os sinais todos", () => {
    // `semFichaDigital: false` e a ausência da opção têm de produzir o MESMO objeto.
    expect(montarDadosDeAbordagem(COM_REPUTACAO, SITE_MEDIDO, null, { semFichaDigital: false })).toEqual(
      dadosComFicha(),
    );
    const dados = dadosComFicha();
    expect(Object.keys(dados)).toEqual([
      "Empresa",
      "Segmento",
      "Endereço",
      "Site",
      "Ficha do Google",
      "Redes",
      "Telefone",
      "Auditoria",
      "Detalhe",
    ]);
    expect(dados["Ficha do Google"]).toContain("4,9");
    expect(dados["Ficha do Google"]).toContain("37");
    expect(dados.Redes).toContain("instagram.com/consorciovale");
    expect(dados.Site).toBe("https://consorciovale.example");
    expect(dados.Auditoria).toContain("verificado em 12/11/2026");
  });

  it("sem a chave, o prompt do ramo frio é o de antes", () => {
    const antes = blocoDeModo("prospeccao_fria", "n0nce", INSTRUCAO);
    expect(blocoDeModo("prospeccao_fria", "n0nce", INSTRUCAO, { semFichaDigital: false })).toBe(antes);
    expect(antes).toContain("escolha UM fato da ficha");
    expect(antes).toContain("EXCEÇÃO: o campo `Auditoria`");
  });

  it("a oferta padrão continua `site` para quem não escolhe nada", () => {
    expect(ofertasDaCampanhaSchema.parse(undefined)).toEqual(["site"]);
    expect(usaFichaDigital({})).toBe(true);
    expect(usaFichaDigital({ usar_ficha_digital: undefined })).toBe(true);
    expect(usaFichaDigital({ usar_ficha_digital: true })).toBe(true);
    expect(usaFichaDigital({ usar_ficha_digital: false })).toBe(false);
  });
});

describe("configuração da campanha", () => {
  const CONFIG = {
    agent_id: "11111111-1111-4111-8111-111111111111",
    channel_session_id: "22222222-2222-4222-8222-222222222222",
    pipeline_id: "33333333-3333-4333-8333-333333333333",
    stage_id: "44444444-4444-4444-8444-444444444444",
    qualified_stage_id: "55555555-5555-4555-8555-555555555555",
    instruction: "Ofereça consórcio de imóvel, sem juros, para quem quer comprar.",
    qualification: "Quem decide a compra e já pensou em financiar.",
    legal_basis_ref: "legítimo interesse",
  };

  it("configuração gravada antes da chave existir continua válida e com a ficha ligada", () => {
    const cfg = campaignConfigSchema.parse(CONFIG);
    expect(cfg.usar_ficha_digital).toBeUndefined();
    expect(usaFichaDigital(cfg)).toBe(true);
    expect(cfg.ofertas).toEqual(["site"]);
  });

  it("a chave é aceita e chega como `false` — sem default que a reverta", () => {
    const cfg = campaignConfigSchema.parse({ ...CONFIG, usar_ficha_digital: false });
    expect(usaFichaDigital(cfg)).toBe(false);
  });

  it("`edit_briefing` aceita a edição sem a chave (cliente antigo) e com ela", () => {
    const base = {
      action: "edit_briefing" as const,
      id: "66666666-6666-4666-8666-666666666666",
      instruction: CONFIG.instruction,
      qualification: CONFIG.qualification,
      ofertas: ["site" as const],
    };
    const semChave = prospectingInputSchema.safeParse(base);
    expect(semChave.success).toBe(true);
    if (semChave.success && semChave.data.action === "edit_briefing")
      expect(semChave.data.usar_ficha_digital).toBeUndefined();
    const comChave = prospectingInputSchema.safeParse({ ...base, usar_ficha_digital: false });
    expect(comChave.success).toBe(true);
    if (comChave.success && comChave.data.action === "edit_briefing")
      expect(comChave.data.usar_ficha_digital).toBe(false);
  });
});
