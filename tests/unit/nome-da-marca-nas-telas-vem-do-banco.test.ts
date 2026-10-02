/**
 * O NOME DA MARCA EM TEXTO, NO ONBOARDING/WELCOME/GET-STARTED, VEM DO BANCO.
 *
 * ── O DEFEITO QUE ESTE ARQUIVO IMPEDE (issue #1944) ──────────────────────────
 *
 * `branding()` (`lib/branding.ts`) lê só o `.env` (`process.env.APP_NAME`). As
 * telas da primeira jornada — onboarding, welcome, get-started — escreviam o
 * nome da marca em texto a partir dela, então uma marca configurada na tela
 * Administração › Marca (banco) não aparecia ali: o valor do `.env` (semente
 * da instalação) continuava no lugar. Divergência observável: banco com nome X
 * e `.env` com Y ⇒ os cabeçalhos dessas telas mostravam Y.
 *
 * A regra do produto já existe em `lib/branding/saida.ts` — `marcaDaSaida`
 * resolve banco ACIMA do `.env` (o `.env` é só o piso). As telas devem chamar
 * ESSE resolvedor, nunca duplicar fallback, e nunca voltar a `branding()`
 * para o nome em texto.
 *
 * ⚠️ Não é teste de render: renderizá-las exigiria mock da cadeia de
 * autenticação/organização inteira. O contrato aqui é de FONTE — a mesma
 * disciplina da catraca de `marca-sem-divergencia-de-hidratacao.test.tsx`,
 * que também decide por leitura do arquivo porque o erro que ele impede é
 * compilável mas sem teste.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/** As telas que escrevem o nome da marca em texto, fora da árvore de `/app`. */
const TELAS = [
  "app/onboarding/layout.tsx",
  "app/onboarding/welcome/page.tsx",
  "app/get-started/page.tsx",
];

/** O resolvedor do banco é quem decide — banco acima, `.env` como piso. */
const RESOLVEDOR = "marcaDaSaida";

describe("o nome em texto do onboarding/welcome/get-started vem do BANCO", () => {
  it("cada tela chama o resolvedor do banco (`marcaDaSaida`) para o nome", () => {
    for (const tela of TELAS) {
      const fonte = fs.readFileSync(path.join(process.cwd(), tela), "utf8");
      expect(
        fonte.includes(`import { ${RESOLVEDOR} } from "@/lib/branding/saida"`),
        `${tela} deve importar ${RESOLVEDOR} de lib/branding/saida para o nome em texto`,
      ).toBe(true);
    }
  });

  it("nenhuma delas volta a ler o nome de `branding()` (só `.env`)", () => {
    for (const tela of TELAS) {
      const fonte = fs.readFileSync(path.join(process.cwd(), tela), "utf8");
      // Sem comentários: os arquivos documentam a decisão e dentre elas a citação
      // do `branding()` num comentário NÃO é o defeito.
      const semComentarios = fonte
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((linha) => !linha.trimStart().startsWith("//"))
        .join("\n");
      expect(
        /\bbranding\(\)/.test(semComentarios),
        `${tela} voltou a usar branding() para o nome — só lê o .env, não o banco`,
      ).toBe(false);
    }
  });

  it("o onboarding (connect-nuvemshop), que é client, lê do CONTEXTO do banco", () => {
    // O `_client.tsx` não pode chamar `marcaDaSaida` (server-only); o caminho
    // certo lá é `useMarcaDaInstalacao()` do contexto que o layout raiz monta a
    // partir da marca RESOLVIDA — banco incluído.
    const fonte = fs.readFileSync(
      path.join(process.cwd(), "app/onboarding/connect-nuvemshop/_client.tsx"),
      "utf8",
    );
    expect(fonte).toContain("useMarcaDaInstalacao()");
    // Comentário não conta: o arquivo documenta POR QUE não usa `branding()`.
    const semComentarios = fonte
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((linha) => !linha.trimStart().startsWith("//"))
      .join("\n");
    expect(semComentarios).not.toContain("branding()");
  });
});