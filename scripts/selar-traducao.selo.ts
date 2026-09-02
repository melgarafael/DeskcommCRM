/**
 * O SELO DE TRADUÇÃO — manifesto, hash e leitura, sem I/O e sem `process.exit`.
 *
 * ## O problema que o selo resolve
 *
 * Documento traduzido não tem catraca nenhuma. O original é corrigido, as
 * cópias ficam para trás, e ninguém percebe: markdown errado compila, e uma
 * tradução defasada parece exatamente igual a uma tradução em dia. O rodapé de
 * `docs/white-label.md` chegou a declarar isso como dívida — *"sem um gate que
 * reprove tradução defasada, três cópias divergem no primeiro conserto
 * seguinte"* — e declarar não conserta.
 *
 * O selo é o hash do original gravado na primeira linha da tradução. Editar o
 * original muda o hash; a tradução ainda carrega o antigo; `pnpm test:unit`
 * reprova nomeando o comando de re-selar. É a mesma disciplina de
 * `tests/unit/manifest-x-migrations.test.ts` (texto que precisa de catraca) e de
 * `lib/channels/meta/contract-hash.ts` (hash como âncora de obsolescência).
 *
 * ## Por que é um módulo separado do script
 *
 * Precedente medido no repo: `scripts/inventario-de-telas.leitura.ts` e
 * `scripts/lint-channels.pattern.ts` existem porque os scripts deles varrem o
 * disco e chamam `process.exit` no topo do módulo — importá-los de um teste
 * rodaria o script. Mesma restrição aqui: `tests/unit/traducao-nao-defasa.test.ts`
 * precisa do MESMO manifesto e do MESMO hash que `scripts/selar-traducao.ts`
 * usa. Duas listas em sincronia seriam o defeito que o selo existe para pegar.
 *
 * ## Por que só o par `white-label`, e não os READMEs
 *
 * Decisão declarada, com razão medida. Os três READMEs são o arquivo mais
 * editado do repositório (~30 KB cada, ~490 linhas): selá-los transformaria
 * cada conserto de README num PR bloqueado até duas re-traduções completas. O
 * desfecho realista disso não é "traduções em dia" — é alguém rodar
 * `selar-traducao.ts --todas` sem traduzir, que é o único jeito de o selo
 * morrer. Um gate que desenha o próprio mecanismo de derrota é pior que gate
 * nenhum, porque ainda parece proteção. `docs/white-label.md` tem 197 linhas e
 * baixa rotatividade: aqui o custo cabe.
 *
 * Acrescentar par a esta lista é decisão de quem vai pagar o custo, não zelo de
 * completude.
 */

import { createHash } from "node:crypto";

/** Um par original → tradução, sob selo. */
export type ParTraduzido = {
  /** Caminho do original, a partir da raiz do repo. É o que vai DENTRO do selo. */
  readonly original: string;
  /** Caminho da tradução, a partir da raiz do repo. */
  readonly traducao: string;
  /** Só para a mensagem de falha ficar legível. */
  readonly idioma: string;
};

export const TRADUCOES: readonly ParTraduzido[] = [
  { original: "docs/white-label.md", traducao: "docs/white-label.en.md", idioma: "inglês" },
];

/** O comando que conserta — a mensagem de falha SEMPRE o nomeia. */
export const COMANDO_DE_RESELO = "pnpm exec tsx scripts/selar-traducao.ts --todas";

/**
 * A primeira linha de toda tradução.
 *
 * O caminho do original entra no selo de propósito: sem ele, um selo copiado de
 * OUTRO arquivo passaria por todas as outras conferências (existe, casa a
 * regex, e o hash é de um original de verdade). É o modo de falha que a
 * asserção 3 do teste guarda.
 *
 * Comentário HTML porque o GitHub não renderiza nada — o leitor da tradução não
 * vê o selo, e quem edita o arquivo vê na primeira linha.
 */
export const SELO = /^<!-- traduzido-de: (\S+)@([0-9a-f]{12}) -->$/;

/** Monta a linha do selo. Fonte única: o script grava o que a regex lê. */
export function linhaDoSelo(original: string, hash: string): string {
  return `<!-- traduzido-de: ${original}@${hash} -->`;
}

/** Lê a linha 1 de uma tradução. `null` = não é um selo. */
export function lerSelo(conteudo: string): { original: string; hash: string } | null {
  const primeira = conteudo.split("\n", 1)[0] ?? "";
  const m = SELO.exec(primeira.trimEnd());
  return m?.[1] && m[2] ? { original: m[1], hash: m[2] } : null;
}

/**
 * O hash do original — 12 hex de um SHA-256 do conteúdo NORMALIZADO.
 *
 * A normalização não é enfeite: sem ela, um editor configurado com CRLF ou um
 * `format` que apara espaço à direita reprova as duas traduções sem que uma
 * palavra do texto tenha mudado. Gate que acende sem defeito é gate que se
 * aprende a re-selar no automático — exatamente o que este arquivo evita.
 *
 * Normaliza o que NÃO muda o texto lido: fim de linha, espaço à direita de cada
 * linha e linhas em branco no fim do arquivo. Qualquer outra diferença — uma
 * vírgula, uma palavra, um parágrafo novo — muda o hash, que é o ponto.
 *
 * 12 hex (48 bits) porque o selo é lido por humano na primeira linha do arquivo
 * e o adversário aqui é o esquecimento, não a colisão adversarial.
 */
export function hashDoOriginal(conteudo: string): string {
  const normalizado = conteudo
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((linha) => linha.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "\n");
  return createHash("sha256").update(normalizado, "utf8").digest("hex").slice(0, 12);
}

/**
 * Controle positivo: o manifesto tem de estar vivo antes de a ausência de
 * achado valer alguma coisa.
 *
 * Lista vazia devolveria "nenhuma tradução defasada" — indistinguível de "não
 * há tradução nenhuma sob gate". É o mesmo modo de falha de `conferirVacuidade`
 * em `inventario-de-telas.leitura.ts`, e por isso LANÇA em vez de devolver
 * `false`: quem esquecer de chamar não fica verde por omissão.
 */
export function conferirVacuidade(pares: readonly ParTraduzido[]): void {
  if (pares.length === 0) {
    throw new Error(
      "TRADUCOES está vazio — o gate de tradução não está medindo nada. " +
        "Se a intenção foi remover um par, remova também o teste que o cita.",
    );
  }
}
