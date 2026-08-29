import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  coresDaBarraDoNavegador,
  type CorDaBarra,
} from "@/lib/branding/barra-do-navegador";
import type { Regua, TemaDaRegua } from "@/lib/branding/contraste";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";

const RAIZ = process.cwd();

/**
 * A barra do navegador é a única cor do produto que aparece ANTES de o HTML
 * pintar — e a que nenhuma tela mostra, então ninguém a olha. Estes casos
 * existem por dois motivos distintos:
 *
 *  1. os dois hexes viviam em TRÊS arquivos sem nada os sincronizando. Este
 *     teste é o que passa a reprovar a quarta cópia;
 *  2. a leitura errada ("a barra fica com a cor do produto em todo clone — é
 *     defeito de white-label!") é convidativa e FALSA: `cssDaMarca` nunca emite
 *     `--color-bg`. Sem um caso que registre isso, alguém troca `viewport` por
 *     `generateViewport()` e paga uma leitura de banco por requisição para
 *     devolver sempre a mesma constante.
 */
describe("cor da barra do navegador", () => {
  const bg = (tema: TemaDaRegua) =>
    tema.base.find((t) => t.chave === "--color-bg")?.hex;

  it("as duas entradas saem da régua, não de literal digitado", () => {
    const cores = coresDaBarraDoNavegador(REGUA_DO_PRODUTO);
    expect(cores).toEqual<CorDaBarra[]>([
      {
        media: "(prefers-color-scheme: light)",
        // Sem `!`: se a régua perder o token, `toEqual` compara com `undefined`
        // e o caso reprova — que é o desfecho certo.
        color: bg(REGUA_DO_PRODUTO.claro) as string,
      },
      {
        media: "(prefers-color-scheme: dark)",
        color: bg(REGUA_DO_PRODUTO.escuro) as string,
      },
    ]);
  });

  it("a régua de hoje tem os dois fundos — senão o caso acima seria vazio", () => {
    // Guarda de vacuidade: sem ela, uma régua sem `--color-bg` faria o teste
    // acima comparar `[]` com `[]` e passar como se estivesse vigiando.
    expect(bg(REGUA_DO_PRODUTO.claro)).toMatch(/^#[0-9a-f]{6}$/);
    expect(bg(REGUA_DO_PRODUTO.escuro)).toMatch(/^#[0-9a-f]{6}$/);
    // Tema único, sempre escuro (paleta Ink): os dois fundos são DELIBERADAMENTE
    // iguais agora — a barra do navegador deve ficar na mesma cor Ink
    // independente do `prefers-color-scheme` do sistema, já que o produto não
    // tem mais aparência clara. Ver comentário no topo do `app/globals.css`.
    expect(bg(REGUA_DO_PRODUTO.claro)).toBe(bg(REGUA_DO_PRODUTO.escuro));
  });

  it("tema sem `--color-bg` some da lista em vez de derrubar toda tela", () => {
    // `viewport` roda no layout raiz: lançar aqui é 500 em TODA página, para
    // todo mundo, por causa de um token de cor. Degradar é a escolha certa —
    // e é o caso acima que impede que a degradação passe despercebida.
    const semFundo: Regua = {
      ...REGUA_DO_PRODUTO,
      escuro: { ...REGUA_DO_PRODUTO.escuro, base: [] },
    };
    const cores = coresDaBarraDoNavegador(semFundo);
    expect(cores).toHaveLength(1);
    expect(cores[0]?.media).toBe("(prefers-color-scheme: light)");
  });

  it("o layout não redigita os hexes de fundo — a quarta cópia reprova aqui", () => {
    // O teste acima continuaria verde se alguém escrevesse
    // `themeColor: [{ media: "…", color: "#faf9f6" }]` de volta no layout: o
    // valor seria o mesmo. O que fecha esse buraco é olhar o TEXTO do arquivo.
    const layout = fs.readFileSync(path.join(RAIZ, "app/layout.tsx"), "utf8");
    for (const tema of [REGUA_DO_PRODUTO.claro, REGUA_DO_PRODUTO.escuro]) {
      const hex = bg(tema);
      expect(hex).toBeTruthy();
      expect(
        layout.includes(hex as string),
        `app/layout.tsx voltou a escrever ${hex} à mão. A cor da barra tem UMA ` +
          `fonte: REGUA_DO_PRODUTO, via coresDaBarraDoNavegador().`,
      ).toBe(false);
    }
  });
});
