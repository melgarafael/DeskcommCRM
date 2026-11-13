/**
 * A identidade de canal do aviso de mensagem nova (#4094).
 *
 * Três coisas que este arquivo prende:
 *
 *  1. cada rede tem marca própria (ícone + token de cor), e o Telegram — o
 *     exemplo da issue — sai azul;
 *  2. canal desconhecido, rede nova e ausência de canal NÃO quebram nada: caem
 *     no fallback neutro, sem ícone, sem exigir mudança em quem chama;
 *  3. a cor vem de token declarado nos DOIS temas e passa no piso de componente
 *     da WCAG (3:1) contra o fundo do próprio tema — é a prova de "legível no
 *     claro e no escuro" sem pixel, porque o valor é lido do CSS de verdade.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PISOS, razaoDeContraste } from "@/lib/branding/contraste";
import { marcaDoCanal, rotuloAcessivelDoCanal } from "@/lib/channels/marca-do-canal";
import { channelBrand } from "@/lib/channels/presentation";

const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

const CANAIS = ["whatsapp", "instagram", "messenger", "telegram", "sms"] as const;

/** Lê o bloco cujo seletor está SOZINHO na linha — `includes` pegaria variantes. */
function blocoDe(seletor: string): Map<string, string> {
  const linhas = CSS.split("\n");
  const inicio = linhas.findIndex((l) => l.trim() === `${seletor} {`);
  if (inicio === -1) throw new Error(`não achei o bloco \`${seletor} {\` no globals.css`);
  const decls = new Map<string, string>();
  for (let i = inicio + 1; i < linhas.length; i += 1) {
    const linha = (linhas[i] ?? "").trim();
    if (linha === "}") return decls;
    if (!linha.startsWith("--")) continue;
    const corte = linha.indexOf(":");
    decls.set(linha.slice(0, corte).trim(), linha.slice(corte + 1).replace(/;$/, "").trim());
  }
  throw new Error(`o bloco \`${seletor}\` não fecha`);
}

describe("marcaDoCanal", () => {
  it("cada rede tem ícone, nome e o próprio token de cor", () => {
    for (const canal of CANAIS) {
      const marca = marcaDoCanal(canal);
      expect(marca.id, canal).toBe(canal);
      expect(marca.Icone, `${canal} sem ícone`).not.toBeNull();
      expect(marca.cor).toBe(`var(--color-canal-${canal})`);
    }
  });

  it("o Telegram (o exemplo da issue) sai azul, com logo próprio", () => {
    expect(marcaDoCanal("telegram").cor).toBe("var(--color-canal-telegram)");
    expect(marcaDoCanal("telegram").rotulo).toBe("Telegram");
  });

  it("canal desconhecido não quebra: neutro e SEM ícone", () => {
    const marca = marcaDoCanal("orkut");
    expect(marca.id).toBe("unknown");
    expect(marca.Icone).toBeNull();
    expect(marca.cor).toBe("var(--color-text-muted)");
  });

  it("rede nova no futuro cai no fallback sem exigir mudança em quem chama", () => {
    // O mapa é fechado; o que o aviso recebe é uma string qualquer vinda do
    // banco. Nenhuma delas pode lançar.
    for (const nome of ["tiktok", "", "WHATSAPP", "__proto__", "constructor"]) {
      expect(() => marcaDoCanal(nome)).not.toThrow();
      expect(marcaDoCanal(nome).Icone).toBeNull();
    }
    expect(marcaDoCanal(undefined).id).toBe("unknown");
    expect(marcaDoCanal(null).id).toBe("unknown");
  });

  it("channelBrand traduz a rede do Telegram, e não o transporte", () => {
    expect(channelBrand({ provider: "zernio_social", social_platform: "telegram" })).toBe(
      "telegram",
    );
    expect(channelBrand({ provider: "zernio_social", social_platform: "tiktok" })).toBe("unknown");
  });
});

describe("rotuloAcessivelDoCanal", () => {
  it("diz o canal em TEXTO (não só por cor), em pt-BR e em espanhol", () => {
    const whatsapp = marcaDoCanal("whatsapp");
    expect(rotuloAcessivelDoCanal(whatsapp, "pt-BR")).toBe("Canal: WhatsApp");
    expect(rotuloAcessivelDoCanal(whatsapp, "es")).toBe("Canal: WhatsApp");
  });

  it("sem canal conhecido, o rótulo é o genérico — não 'Canal: Canal'", () => {
    expect(rotuloAcessivelDoCanal(marcaDoCanal("orkut"), "pt-BR")).toBe("Canal");
    expect(rotuloAcessivelDoCanal(marcaDoCanal("orkut"), "es")).toBe("Canal");
  });
});

describe("tokens de cor do canal no globals.css", () => {
  it("existem no :root, no escopo claro e no escuro — mesma lista nos três", () => {
    const raiz = blocoDe(":root");
    const claro = blocoDe('[data-theme="light"]');
    const escuro = blocoDe('[data-theme="dark"]');
    for (const canal of CANAIS) {
      const token = `--color-canal-${canal}`;
      expect(raiz.get(token), `${token} ausente no :root`).toMatch(/^#[0-9a-f]{6}$/i);
      // O espelho do tema claro é obrigatório: uma subárvore clara dentro de
      // página escura herdaria o tom escuro.
      expect(claro.get(token)).toBe(raiz.get(token));
      expect(escuro.get(token), `${token} ausente no escuro`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("cada cor é legível no fundo do PRÓPRIO tema (piso de componente, 3:1)", () => {
    for (const [seletor, tema] of [
      [":root", "claro"],
      ['[data-theme="dark"]', "escuro"],
    ] as const) {
      const bloco = blocoDe(seletor);
      const fundo = bloco.get("--color-bg");
      expect(fundo, `${seletor} sem --color-bg`).toMatch(/^#[0-9a-f]{6}$/i);
      for (const canal of CANAIS) {
        const cor = bloco.get(`--color-canal-${canal}`)!;
        const razao = razaoDeContraste(cor, fundo!);
        expect(razao, `${canal} no tema ${tema}: ${cor} sobre ${fundo} = ${razao.toFixed(2)}:1`).
          toBeGreaterThanOrEqual(PISOS.componente);
      }
    }
  });

  it("o escuro não é o claro copiado: cada canal tem tom desenhado para o tema", () => {
    const claro = blocoDe(":root");
    const escuro = blocoDe('[data-theme="dark"]');
    for (const canal of CANAIS) {
      expect(escuro.get(`--color-canal-${canal}`)).not.toBe(claro.get(`--color-canal-${canal}`));
    }
  });
});
