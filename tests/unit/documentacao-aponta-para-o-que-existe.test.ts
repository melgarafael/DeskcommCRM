import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Gate contra a classe de defeito mais silenciosa da documentação: a afirmação
 * que envelheceu sem ninguém voltar.
 *
 * Ela tem duas formas, e as duas foram medidas neste repo em 2026-08-14:
 *
 * 1. **Ponteiro para o vazio.** `CLAUDE.md` e `AGENTS.md` mandavam procurar o job
 *    `imagens-ok` em `.github/workflows/imagens.yml` — arquivo que nunca existiu;
 *    o job vive em `publish-image.yml`. Um path citado em documento de autoridade
 *    se lê como prova, e quem o segue conclui que a coisa não existe.
 *
 * 2. **Nota de pendência que sobreviveu à pendência.** O mesmo parágrafo da
 *    doutrina de packaging mentiu DUAS vezes sobre o mesmo fato, em sentidos
 *    opostos: primeiro afirmou no presente que `imagens-ok` era obrigatório
 *    quando não era; depois, corrigido para "ainda não está", continuou dizendo
 *    isso depois da ativação — que aconteceu no mesmo dia. Ninguém volta para
 *    trocar um "ainda não" por um "já": nota de pendência é dívida com data de
 *    vencimento e sem cobrador.
 *
 * Escopo deliberado: só os documentos de AUTORIDADE — aqueles que alguém lê para
 * decidir. `docs/stories/`, `docs/handoffs/` e `docs/specs/` ficam de fora de
 * propósito: são planejamento e histórico, cheios de paths que descrevem o que
 * seria construído, e incluí-los faria o gate nascer com 384 violações e ser
 * desligado na primeira semana. Dívida congelada, defeito novo reprovado.
 */

const RAIZ = path.resolve(__dirname, "../..");

/** Documentos que alguém lê para DECIDIR. Ampliar esta lista é sempre bem-vindo. */
const AUTORIDADE = [
  "CLAUDE.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "ARCHITECTURE.md",
  "README.md",
  "SECURITY.md",
  "docs/index.md",
  "docs/current-state.md",
  "docs/harness-audit.md",
  "docs/threat-model.md",
  "docs/DEPLOY-CHECKLIST.md",
  "docs/SETUP.md",
  "docs/doctrine",
  "docs/runbooks",
  "docs/adr",
  "triagem",
];

/**
 * Um único ponteiro morto conhecido, e ele é HONESTO: o runbook cita o script e,
 * na mesma frase, declara que ele ainda não existe. Congelado com justificativa
 * em vez de silenciado — se um dia o script nascer, esta entrada sai.
 */
const PONTEIROS_MORTOS_ACEITOS = new Set([
  "docs/runbooks/ai-credentials-rotation.md::scripts/rotate-ai-cred-aes-key.ts",
]);

/**
 * Nomes ilustrativos: `lib/foo/bar.ts` não é ponteiro, é exemplo.
 *
 * O segmento tem que terminar ali — `(?=\/|\.|$)`. Sem essa âncora, a alternativa
 * `bar` casava o começo de `barra-do-navegador`, e `lib/branding/barra-do-navegador.ts`
 * (arquivo REAL, existe hoje) ficava invisível ao gate: se alguém o renomeasse, o
 * documento continuaria apontando para o vazio com o gate verde. Uma isenção
 * larga demais é pior que isenção nenhuma, porque parece cobertura.
 *
 * `...`, `<` e `NNNN` seguem sem âncora de propósito: são marcas de reticência e de
 * placeholder de template (`<timestamp>`, `NNNN_slug.sql`), não nomes de segmento.
 */
const EH_PLACEHOLDER =
  /(^|\/)(?:(?:foo|bar|baz|exemplo|caminho|nome-da-nota)(?=\/|\.|$)|NNNN|\.\.\.|<)/;

const LINK_RELATIVO = /\[[^\]]*\]\((?!https?:|#|mailto:)([^)#\s]+)/g;
const PATH_EM_CRASE =
  /`((?:app|lib|components|workers|scripts|tests|supabase|hooks|docs|self-host-kit|triagem|\.github)\/[A-Za-z0-9_./[\]-]+\.(?:ts|tsx|sql|sh|yml|yaml|json|md))`/g;

function markdownsRastreados(): string[] {
  const saida = execFileSync("git", ["ls-files", "*.md"], { cwd: RAIZ, encoding: "utf8" });
  return saida.split("\n").filter(Boolean);
}

function ehAutoridade(arquivo: string): boolean {
  return AUTORIDADE.some((a) => arquivo === a || arquivo.startsWith(`${a}/`));
}

describe("documentação — o que ela aponta existe", () => {
  const docs = markdownsRastreados().filter(ehAutoridade);

  it("a lista de documentos de autoridade não está vazia", () => {
    // Sem esta asserção o teste passaria com um glob quebrado, varrendo zero
    // arquivos e devolvendo verde — o modo de falha mais barato de todos.
    expect(docs.length, "nenhum documento de autoridade encontrado").toBeGreaterThan(20);
    expect(docs, "CLAUDE.md saiu do escopo").toContain("CLAUDE.md");
    expect(docs.some((d) => d.startsWith("docs/doctrine/"))).toBe(true);
  });

  it("nenhum link relativo aponta para arquivo que não existe", () => {
    const mortos: string[] = [];

    for (const doc of docs) {
      const base = path.dirname(path.join(RAIZ, doc));
      const texto = fs.readFileSync(path.join(RAIZ, doc), "utf8");

      for (const [, alvo] of texto.matchAll(LINK_RELATIVO)) {
        if (!alvo || EH_PLACEHOLDER.test(alvo)) continue;
        if (fs.existsSync(path.resolve(base, alvo))) continue;
        if (PONTEIROS_MORTOS_ACEITOS.has(`${doc}::${alvo}`)) continue;
        mortos.push(`${doc} → ${alvo}`);
      }
    }

    expect(mortos, `link(s) para arquivo inexistente:\n${mortos.join("\n")}`).toEqual([]);
  });

  it("nenhum path citado em crase aponta para arquivo que não existe", () => {
    const mortos: string[] = [];

    for (const doc of docs) {
      const texto = fs.readFileSync(path.join(RAIZ, doc), "utf8");

      for (const [, alvo] of texto.matchAll(PATH_EM_CRASE)) {
        if (!alvo || EH_PLACEHOLDER.test(alvo)) continue;
        if (fs.existsSync(path.join(RAIZ, alvo))) continue;
        if (PONTEIROS_MORTOS_ACEITOS.has(`${doc}::${alvo}`)) continue;
        mortos.push(`${doc} → ${alvo}`);
      }
    }

    expect(mortos, `path(s) citados que não existem:\n${mortos.join("\n")}`).toEqual([]);
  });

  it("nenhuma nota de pendência sobre gates já ativados sobreviveu", () => {
    // Frases LITERAIS que este repo já carregou depois de a pendência ser
    // resolvida. Não é lista de palavras proibidas: é o registro de uma dívida
    // que apodreceu — cada entrada aqui foi um texto real que enganou alguém.
    const FRASES_MORTAS = [
      "assim que o check entrar na branch protection",
      "imagem quebrada ainda não bloqueia merge",
      "`imagens-ok` ainda não está",
      "imagens-ok` ainda não é obrigatório",
    ];

    const violacoes: string[] = [];

    /**
     * A isenção olha o que vem ANTES da frase, não a linha inteira.
     *
     * A primeira versão filtrava a linha toda com `!l.includes("dizia")`, e isso
     * abria um buraco medido: `Nota: o \`imagens-ok\` ainda não é obrigatório, ao
     * contrário do que a doc dizia.` passava verde — afirmação FALSA e EM VIGOR,
     * isenta porque a palavra aparecia depois dela. Em prosa pt-br, "dizia" é
     * palavra comum; vetar a linha por contê-la é vetar quase qualquer parágrafo.
     *
     * A distinção que sobrevive é posicional: quem CITA o erro passado põe a marca
     * antes ("o arquivo dizia \`…\`"); quem AFIRMA põe a frase primeiro. 60
     * caracteres cobrem a introdução típica sem alcançar a oração seguinte.
     */
    const CITA = /(já disse|dizia|dizendo|afirmava|carregou|carregava|["“«])[^"“«]{0,60}$/;

    for (const doc of docs) {
      const linhas = fs.readFileSync(path.join(RAIZ, doc), "utf8").split("\n");

      for (const linha of linhas) {
        if (linha.trimStart().startsWith(">")) continue; // bloco de nota
        for (const frase of FRASES_MORTAS) {
          const i = linha.indexOf(frase);
          if (i === -1) continue;
          if (CITA.test(linha.slice(0, i))) continue;
          violacoes.push(`${doc}: "${frase}"`);
        }
      }
    }

    expect(
      violacoes,
      `nota de pendência sobrevivente — o gate citado JÁ está ativo:\n${violacoes.join("\n")}\n` +
        `confira a régua real: gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts'`,
    ).toEqual([]);
  });
});
