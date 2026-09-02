import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extrairRegua } from "@/lib/branding/contraste";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";

const RAIZ = process.cwd();
const CSS = fs.readFileSync(path.join(RAIZ, "app/globals.css"), "utf8");

describe("régua congelada em módulo", () => {
  it("é exatamente o que `extrairRegua` tira do globals.css de hoje", () => {
    // POR QUE A RÉGUA É UM MÓDULO E NÃO UM `readFileSync`: a imagem de produção
    // é `output: "standalone"` e o Dockerfile copia só `.next/standalone`,
    // `.next/static` e `public/`. `app/globals.css` NÃO existe no contêiner do
    // self-hoster — ler o arquivo no caminho de render do layout daria ENOENT,
    // ou seja 500 em todas as telas, verde em dev, em teste e na Vercel.
    //
    // O preço é uma segunda cópia, e este teste é o que impede que ela envelheça
    // em silêncio: mexeu na paleta, reprova aqui e a mensagem entrega o literal
    // novo para colar em `lib/branding/regua-do-produto.ts`.
    const doArquivo = extrairRegua(CSS);
    expect(
      REGUA_DO_PRODUTO,
      "a régua congelada divergiu do globals.css. Substitua o objeto de " +
        "lib/branding/regua-do-produto.ts por:\n\n" +
        JSON.stringify(doArquivo, null, 2),
    ).toEqual(doArquivo);
  });

  it("não está vazia (guarda de vacuidade)", () => {
    // Um `extrairRegua` que devolvesse a estrutura vazia passaria no teste
    // acima contra um módulo igualmente vazio, e a derivação inteira mediria
    // nada. Os números vêm do mesmo commit que `branding-contraste.test.ts`.
    expect(REGUA_DO_PRODUTO.rampaDoProduto).toHaveLength(11);
    // 8 e nao 6 desde que `--color-link`/`--color-link-hover` entraram com a
    // superficie clara do conteudo (`[data-superficie="clara"]`). Eles apontam
    // para paradas da rampa, entao `extrairRegua` os colhe sozinha.
    expect(REGUA_DO_PRODUTO.claro.papeis).toHaveLength(8);
    expect(REGUA_DO_PRODUTO.escuro.papeis).toHaveLength(8);
    expect(REGUA_DO_PRODUTO.claro.base).toHaveLength(3);
    expect(REGUA_DO_PRODUTO.escuro.semanticas).toHaveLength(4);
  });
});
