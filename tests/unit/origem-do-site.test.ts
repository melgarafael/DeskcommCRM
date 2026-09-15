import { describe, expect, it, vi } from "vitest";

import {
  CHAVES_DE_UTM,
  estamparOrigemDaPagina,
  extrairOrigemDaPagina,
  montarCodigoDeOrigemDoSite,
} from "@/lib/leads/origem-do-site";

/**
 * A ORIGEM DA PÁGINA NÃO TEM POR ONDE ENTRAR NO WHATSAPP.
 *
 * A atribuição de anúncio (`lib/leads/atribuicao-de-anuncio.ts`) grava plataforma
 * e id do anúncio a partir do `referral`/contexto de anúncio. A origem de SITE não
 * tem esse transporte: o `wa.me/<numero>?text=...` abre o WhatsApp pelo sistema
 * operacional, sem cookie, sem referrer e sem sessão — a UTM morre na página.
 *
 * O único fio que atravessa essa fronteira é o TEXTO que a pessoa manda. É por ele
 * que a página embute um código curto, e é por ele que a ingestão o reconhece.
 *
 * ─── O que este módulo NÃO faz, de propósito ────────────────────────────────
 *
 * O código chega pelo texto do cliente: qualquer pessoa pode digitar, copiar,
 * encaminhar, editar ou repetir o marcador de outra. Ele é tratado como ENTRADA
 * NÃO CONFIÁVEL — só a primeira mensagem vale, o primeiro toque nunca é
 * sobrescrito, e nada disso é autorização de nada: é rótulo de origem.
 */
describe("o código que a página embute", () => {
  it("monta e extrai de volta, campo a campo", () => {
    const utm = {
      utm_source: "instagram",
      utm_medium: "social",
      utm_campaign: "pesquisa-preco",
      gclid: "Cj0KCQjw",
    };
    const codigo = montarCodigoDeOrigemDoSite(utm);
    expect(codigo).toMatch(/^\[dk1:[A-Za-z0-9_-]+\]$/);
    expect(extrairOrigemDaPagina(codigo)?.utm).toEqual(utm);
  });

  it("sobrevive ao texto pré-preenchido do wa.me, que vai URL-encoded", () => {
    const codigo = montarCodigoDeOrigemDoSite({ utm_source: "google", gclid: "abc" });
    const link = `https://wa.me/5511999999999?text=${encodeURIComponent(`ola, vi o site ${codigo}`)}`;
    const textoComoChega = decodeURIComponent(new URL(link).searchParams.get("text") ?? "");
    expect(extrairOrigemDaPagina(textoComoChega)?.utm).toMatchObject({
      utm_source: "google",
      gclid: "abc",
    });
  });

  it("é achado no meio de uma frase, sem exigir mensagem exclusiva", () => {
    const codigo = montarCodigoDeOrigemDoSite({ utm_source: "site" });
    expect(extrairOrigemDaPagina(`bom dia!! ${codigo} queria saber o preco`)).not.toBeNull();
  });

  it("é estável: o mesmo mapa rende o mesmo código", () => {
    const a = { utm_campaign: "x", utm_source: "y" };
    const b = { utm_source: "y", utm_campaign: "x" };
    expect(montarCodigoDeOrigemDoSite(a)).toBe(montarCodigoDeOrigemDoSite(b));
  });
});

describe("o que NÃO vale como origem", () => {
  it("texto sem código não rende origem", () => {
    expect(extrairOrigemDaPagina("oi, tudo bem?")).toBeNull();
    expect(extrairOrigemDaPagina(null)).toBeNull();
  });

  it("marcador de versão desconhecida é ignorado", () => {
    expect(extrairOrigemDaPagina("[dk2:eyJ1dG1fc291cmNlIjoiaWcifQ]")).toBeNull();
  });

  it("carga ilegível não derruba a ingestão", () => {
    // base64url válido, JSON inválido: é o caso de um marcador truncado pelo
    // teclado de alguém. A ingestão tem de continuar, sem exceção.
    expect(() => extrairOrigemDaPagina("[dk1:aaaaaaaa]")).not.toThrow();
    expect(extrairOrigemDaPagina("[dk1:aaaaaaaa]")).toBeNull();
  });

  it("chave fora da lista conhecida é descartada", () => {
    const codigo = montarCodigoDeOrigemDoSite({
      utm_source: "instagram",
      // A chave fora da lista não é erro de tipo: `montarCodigoDeOrigemDoSite`
      // recebe `Record<string, string>` e quem descarta o que não é UTM conhecida
      // é o filtro em tempo de execução — que é o que este caso prova.
      telefone_do_cliente: "5511999999999",
    });
    const origem = extrairOrigemDaPagina(codigo);
    expect(origem?.utm).toEqual({ utm_source: "instagram" });
    expect(CHAVES_DE_UTM).toContain("utm_source");
  });

  it("valor vazio é descartado e, sem nada válido, não há origem", () => {
    const codigo = montarCodigoDeOrigemDoSite({ utm_source: "   ", utm_medium: "" });
    expect(extrairOrigemDaPagina(codigo)).toBeNull();
  });

  it("normaliza a caixa da chave e tira espaços do valor", () => {
    const carga = JSON.stringify({ "  UTM_SOURCE  ": "  instagram  " });
    const b64 = Buffer.from(carga, "utf8").toString("base64url");
    expect(extrairOrigemDaPagina(`[dk1:${b64}]`)?.utm).toEqual({ utm_source: "instagram" });
  });
});

describe("a estampagem no contato", () => {
  function bancoDeMentira(erro: { message: string } | null = null) {
    const chamadas: Record<string, unknown>[] = [];
    const admin = {
      async rpc(_nome: string, args: Record<string, unknown>) {
        chamadas.push(args);
        return { error: erro };
      },
    } as never;
    return { admin, chamadas };
  }

  it("grava pela fn_estampar_atribuicao_de_anuncio com a marca de primeiro toque", async () => {
    const { admin, chamadas } = bancoDeMentira();
    const ok = await estamparOrigemDaPagina(admin, "contato-1", {
      utm: { utm_source: "instagram", gclid: "Cj0KCQjw" },
      capturadaEm: "2026-09-14T10:00:00.000Z",
    });
    expect(ok).toBe(true);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({
      p_contact: "contato-1",
      p_platform: "site",
      p_metadata: {
        ad_platform: "site",
        utm_source: "instagram",
        gclid: "Cj0KCQjw",
        origem_capturada_em: "2026-09-14T10:00:00.000Z",
      },
    });
  });

  it("devolve false e não lança quando o banco recusa", async () => {
    const { admin } = bancoDeMentira({ message: "permission denied" });
    await expect(
      estamparOrigemDaPagina(admin, "contato-1", { utm: { utm_source: "ig" }, capturadaEm: null }),
    ).resolves.toBe(false);
  });
});
