/**
 * O `test:db` APLICA O BASELINE NUM LUGAR SÓ, E ESSE LUGAR CONTA AS APLICAÇÕES.
 *
 * ## Por que este arquivo existe
 *
 * `scripts/test-db.sh` tira um molde entre o install e o update
 * (`$TEST_DB_TEMPLATE_UMA_APLICACAO`), e um invariante que precisa medir a
 * instalação nova confere, lendo `test_db.aplicacoes_do_baseline`, que esse molde
 * recebeu de fato UMA aplicação. A contagem é gravada por `aplicar_baseline`, e só
 * por ela.
 *
 * Então a contagem só diz a verdade se toda aplicação do arquivo passar por essa
 * função. Uma aplicação escrita fora dela — um `psql_install < "$BASELINE"` solto
 * antes do molde — não deixa linha: o molde recebe duas passadas, a segunda esconde
 * o que a primeira deixou de fazer por ordem dentro do arquivo, a tabela segue
 * dizendo "1", e o invariante fica verde sobre um baseline defeituoso. O invariante
 * não tem como ver isso de dentro do banco; quem vê é a leitura do script.
 *
 * ## O que conta como "aplicar"
 *
 * Duas varreduras sobre o shell (comentários e corpos de heredoc fora), e as duas
 * têm de apontar para a MESMA linha, dentro de `aplicar_baseline`:
 *
 *  - **pelo nome:** toda linha que cita o arquivo (`$BASELINE` ou `baseline.sql`)
 *    é aplicação, a menos que seja uma das formas que não entregam o arquivo a
 *    ninguém — a definição da variável, o `[ -f ]` que confere que ele existe, a
 *    lista `MEDIDOS` do carimbo e o texto de um `echo`. A regra falha fechada:
 *    forma nova que cite o arquivo reprova até alguém decidir, por escrito aqui,
 *    que ela não o aplica. Um apelido (`B="$BASELINE"`) cai nela.
 *  - **pela forma:** toda linha que alimenta um processo com arquivo — `<` de
 *    entrada que não seja heredoc, ou pipe para `psql`/`docker exec` — é
 *    aplicação, cite ela o baseline pelo nome ou não.
 *
 * ## O que este teste NÃO cobre
 *
 * Ele lê texto. Um caminho que não passe por stdin do host — copiar o arquivo para
 * o container e incluí-lo de lá, ou chamar outro script que o aplique — não é
 * reconhecido por nenhuma das duas varreduras. Que a contagem gravada bate com o
 * molde é medido pelo invariante, no `test:db`, e não aqui.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const SCRIPT = "scripts/test-db.sh";
const FUNCAO = "aplicar_baseline";
const TABELA_DA_CONTAGEM = "test_db.aplicacoes_do_baseline";

type Linha = { numero: number; texto: string };

/** Linhas de shell do script: sem comentário de linha inteira e sem corpo de heredoc. */
function linhasDeShell(fonte: string): Linha[] {
  const saida: Linha[] = [];
  let delimitador: string | null = null;
  fonte.split("\n").forEach((texto, i) => {
    if (delimitador !== null) {
      if (texto.trim() === delimitador) delimitador = null;
      return;
    }
    if (/^\s*#/.test(texto)) return;
    saida.push({ numero: i + 1, texto });
    const aberto = texto.match(/<<-?\s*['"]?(\w+)['"]?/)?.[1];
    if (aberto !== undefined && !/<<</.test(texto)) delimitador = aberto;
  });
  return saida;
}

const CITA_O_BASELINE = /\$\{?BASELINE\b|baseline\.sql/;

/** Formas que citam o arquivo sem entregá-lo a processo nenhum. */
function semFormasInertes(texto: string): string {
  return texto
    .replace(/\becho\s+"(?:[^"\\]|\\.)*"/g, 'echo ""')
    .replace(/^BASELINE="[^"]*"\s*$/, "")
    .replace(/\[\s+-f\s+"\$BASELINE"\s+\]/g, "")
    .replace(/^MEDIDOS=\(.*\)\s*$/, "");
}

const ALIMENTA_COM_ARQUIVO = /(^|[^<])<\s*[^<(\s]|\|\s*(psql\w*|docker\s+exec)\b/;

function corpoDaFuncao(linhas: string[]): { inicio: number; fim: number } {
  const inicio = linhas.findIndex((l) => new RegExp(`^${FUNCAO}\\(\\)\\s*\\{`).test(l));
  const fim = inicio < 0 ? -1 : linhas.findIndex((l, i) => i > inicio && /^\}\s*$/.test(l));
  return { inicio: inicio + 1, fim: fim + 1 };
}

describe("o test:db aplica o baseline num lugar só, e esse lugar conta as aplicações", () => {
  const fonte = readFileSync(join(RAIZ, SCRIPT), "utf8");
  const shell = linhasDeShell(fonte);
  const corpo = corpoDaFuncao(fonte.split("\n"));
  const dentroDaFuncao = (n: number) => n > corpo.inicio && n < corpo.fim;
  const descreve = (ls: Linha[]) =>
    ls.map((l) => `  ${SCRIPT}:${l.numero}: ${l.texto.trim()}`).join("\n");

  const pelaCitacao = shell.filter((l) => CITA_O_BASELINE.test(semFormasInertes(l.texto)));
  const pelaForma = shell.filter((l) => ALIMENTA_COM_ARQUIVO.test(l.texto));

  it(`existe a função ${FUNCAO}, e é ela que aplica o arquivo`, () => {
    expect(corpo.inicio, `${SCRIPT} não define mais ${FUNCAO}() { … }`).toBeGreaterThan(0);
    expect(corpo.fim, `${SCRIPT}: ${FUNCAO} sem o fecho '}' em coluna zero`).toBeGreaterThan(
      corpo.inicio,
    );
  });

  it("toda linha que cita o baseline e o entrega a um processo está dentro da função, e é uma só", () => {
    const unica = pelaCitacao.length === 1 ? pelaCitacao[0] : undefined;
    expect(
      unica !== undefined && dentroDaFuncao(unica.numero),
      `o baseline tem de ser aplicado num lugar só, dentro de ${FUNCAO} (linhas ${corpo.inicio}-${corpo.fim}), ` +
        `porque é ela que grava a contagem que o invariante lê. Achei ${pelaCitacao.length}:\n${descreve(pelaCitacao)}\n` +
        "Se uma dessas linhas cita o arquivo sem aplicá-lo, declare a forma em semFormasInertes, com o motivo.",
    ).toBe(true);
  });

  it("toda linha que alimenta um processo com arquivo é essa mesma linha", () => {
    expect(
      pelaForma.map((l) => l.numero),
      `só ${FUNCAO} pode alimentar psql com arquivo; outra entrada por '<' ou pipe é uma aplicação ` +
        `que não conta. Achei:\n${descreve(pelaForma)}`,
    ).toEqual(pelaCitacao.map((l) => l.numero));
  });

  it("esse lugar grava a contagem depois de aplicar, e um invariante a lê", () => {
    const aplica = pelaCitacao[0]?.numero ?? corpo.fim;
    const corpoTexto = fonte
      .split("\n")
      .slice(aplica, corpo.fim - 1)
      .join("\n");
    expect(
      corpoTexto,
      `${FUNCAO} deixou de gravar uma linha em ${TABELA_DA_CONTAGEM} DEPOIS de aplicar o arquivo`,
    ).toMatch(new RegExp(`insert into ${TABELA_DA_CONTAGEM.replace(".", "\\.")}\\b`));

    const leitores = readdirSync(join(RAIZ, "tests/invariants"))
      .filter((f) => f.endsWith(".test.ts"))
      .filter((f) =>
        readFileSync(join(RAIZ, "tests/invariants", f), "utf8").includes(TABELA_DA_CONTAGEM),
      );
    expect(
      leitores.length,
      `nenhum invariante lê ${TABELA_DA_CONTAGEM}: a contagem é gravada e ninguém a confere`,
    ).toBeGreaterThan(0);
  });
});
