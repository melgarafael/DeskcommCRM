/**
 * O CHANGELOG é TELA DE PRODUTO, e a tela tem um teto em BYTES.
 *
 * O agente que roda por cron na VPS não manda "a seção da versão nova" para o
 * app: ele manda o `CHANGELOG.md` INTEIRO cortado em N bytes crus
 * (`git show <tag>:CHANGELOG.md | awk '<para na instalada>' | head -c N`), e é
 * o app que extrai a seção do texto recebido. Como o arquivo é lido de cima
 * para baixo e a versão mais nova fica no topo, isso funciona — até a seção
 * mais nova sozinha passar de N.
 *
 * ─── POR QUE ISTO MORA EM `lib/` E NÃO DENTRO DO TESTE ──────────────────────
 *
 * A medição tem DOIS consumidores, com atores e remédios diferentes:
 *
 *   - `tests/unit/changelog-cabe-na-tela-da-vps.test.ts`, que cobra o que o
 *     AUTOR DO PR pode consertar (a seção já publicada e o `[Não lançado]`);
 *   - `scripts/acervo-cabe-na-tela.ts`, que cobra o ACERVO de `.changes/` —
 *     dívida da casa, cujo remédio é cortar release. Ele roda fora de
 *     `pull_request`, onde quem vê o vermelho é quem pode pagá-lo.
 *
 * A separação existe porque o gate único reprovava o PR de quem não podia
 * consertá-lo: medido em 20/09/2026, com 43 fragmentos acumulados, os PRs
 * #1377 e #1363 ficaram vermelhos por `A seção termina no byte 32686` sem que
 * nenhum dos dois tocasse `.changes/`. Uma cópia da medição em cada lugar
 * resolveria o vermelho e criaria o defeito seguinte: duas réguas, e a que
 * envelhece é sempre a cópia. Então a régua é uma só, e o que difere é quem a
 * lê e com que palavras.
 *
 * Módulo PURO: recebe texto, devolve dado. Quem toca disco é o teste e o CLI.
 */
import type { Fragmento } from "./fragmento";
import { montarSecao } from "./montar-secao";
import { extractChangelogRange, extractChangelogSection } from "../system/changelog";

/** Número que nenhuma release vai usar — marca a seção simulada. */
const VERSAO_SIMULADA = "9.9.9";

/**
 * O teto real, lido de onde ele é APLICADO.
 *
 * Um número digitado aqui viraria segunda fonte da verdade, e a que envelhece
 * primeiro é sempre a cópia. (Isso tem um custo declarado: subir o `head -c` do
 * `agent.sh` silencia esta medição. Não conserta ninguém — quem corta é o
 * script que JÁ está instalado na VPS do cliente —, então subir o número para
 * calar o CI é trocar um vermelho honesto por um cliente sem aviso.)
 */
export function tetoDoAgente(agentSh: string): number {
  const m = /git show\s+"?\$\{?LATEST_TAG\}?"?:CHANGELOG\.md[^\n]*head -c (\d+)/.exec(agentSh);
  if (!m) {
    throw new Error(
      "não achei o corte do CHANGELOG em agent.sh — se o mecanismo mudou, esta medição precisa " +
        "acompanhar em vez de ser apagada: o contrato de tamanho continua existindo.",
    );
  }
  return Number(m[1]);
}

/**
 * O rótulo que o `awk` do agente procura para PARAR de imprimir, lido do
 * próprio `agent.sh` pelo mesmo motivo que o teto é. O que se extrai é o valor
 * de `-v cur=`, com `${CURRENT#v}` no lugar da versão instalada.
 */
export function rotuloDeParadaDoAgente(agentSh: string): (versao: string) => string {
  const m = /awk -v cur="([^"]*)"/.exec(agentSh);
  if (!m?.[1]?.includes("${CURRENT#v}")) {
    throw new Error(
      "não achei o `-v cur=` do awk em agent.sh — se o corte deixou de parar no cabeçalho da " +
        "versão instalada, esta medição precisa acompanhar em vez de ser apagada.",
    );
  }
  return (versao: string) => m[1]!.replace("${CURRENT#v}", versao);
}

interface Secao {
  /** `1.4.0`, ou `null` para o bloco `[Não lançado]`. */
  versao: string | null;
  /** O texto da seção, do `## [` até o `## [` seguinte (exclusive). */
  texto: string;
}

/** Quebra o arquivo em cabeçalho + seções, na ordem em que aparecem. */
function fatiar(raw: string): { cabecalho: string; secoes: Secao[] } {
  const linhas = raw.split("\n");
  const cortes: number[] = [];
  linhas.forEach((linha, i) => {
    if (/^##\s+\[/.test(linha)) cortes.push(i);
  });
  if (cortes.length === 0) throw new Error("nenhuma seção `## [...]` no CHANGELOG.md");

  const cabecalho = linhas.slice(0, cortes[0]!).join("\n") + "\n";
  const secoes: Secao[] = cortes.map((inicio, i) => {
    const fim = cortes[i + 1] ?? linhas.length;
    const m = /^##\s+\[([^\]]+)\]/.exec(linhas[inicio]!);
    const rotulo = m?.[1] ?? "";
    return {
      versao: /^\d+\.\d+\.\d+$/.test(rotulo) ? rotulo : null,
      texto: linhas.slice(inicio, fim).join("\n") + (fim < linhas.length ? "\n" : ""),
    };
  });
  return { cabecalho, secoes };
}

/**
 * O arquivo como ele fica DEPOIS de cortar a release — que é a única forma em
 * que a VPS o vê. O `[Não lançado]` esvazia e o conteúdo dele vira a seção
 * numerada nova, no mesmo lugar.
 */
function comoFicaNaTag(raw: string, versaoFutura: string): string {
  const { cabecalho, secoes } = fatiar(raw);
  const naoLancado = secoes.find((s) => s.versao === null);
  const numeradas = secoes.filter((s) => s.versao !== null);
  const corpo = naoLancado ? naoLancado.texto.split("\n").slice(1).join("\n").replace(/^\n+/, "") : "";
  return (
    cabecalho +
    "## [Não lançado]\n\n" +
    `## [${versaoFutura}] — 2099-01-01\n\n` +
    corpo +
    numeradas.map((s) => s.texto).join("")
  );
}

/** O arquivo como ele ficará na TAG, com a seção que os fragmentos produzem. */
function comSecaoMontada(raw: string, fragmentos: readonly Fragmento[]): string {
  const { cabecalho, secoes } = fatiar(raw);
  const numeradas = secoes.filter((s) => s.versao !== null);
  return (
    cabecalho +
    "## [Não lançado]\n\n" +
    montarSecao(fragmentos, VERSAO_SIMULADA, "2099-01-01").texto +
    "\n\n" +
    numeradas.map((s) => s.texto).join("")
  );
}

/** Exatamente o que o agente manda: os primeiros N bytes do arquivo. */
function comoChegaNaVps(texto: string, teto: number): string {
  return Buffer.from(texto, "utf8").subarray(0, teto).toString("utf8");
}

/**
 * A versão logo ABAIXO de `versao` no arquivo — a que o dono da VPS tem
 * instalada no caso comum (uma release de atraso), e onde o `awk` do agente
 * para de imprimir.
 */
function versaoSeguinte(texto: string, versao: string): string | null {
  const { secoes } = fatiar(texto);
  const i = secoes.findIndex((s) => s.versao === versao);
  if (i === -1) return null;
  return secoes[i + 1]?.versao ?? null;
}

/**
 * O payload EXATO do agente, derivado do `agent.sh` em vez de somado à mão:
 *
 *   git show <tag>:CHANGELOG.md | awk '<para no cabeçalho da instalada>' | head -c TETO
 *
 * Por que isto existe ao lado da conta de bytes: a conta é um PROXY. Ela mede
 * até o FIM da seção nova, e o que o agente manda vai um pouco além — até o
 * cabeçalho da versão instalada, INCLUSIVE. Esse cabeçalho não é enfeite: é ele
 * que faz `extractChangelogRange` devolver `completa: true`. Sem ele, a tela do
 * operador troca o histórico por "este histórico pode não alcançar a sua
 * versão" — degradação honesta, mas degradação, e o proxy fica verde nela.
 *
 * A faixa cega tem a largura do cabeçalho (`## [1.13.0] — 2026-09-04` = 27 B).
 * É estreita, e é por ser estreita que ninguém a acha lendo: quem estoura por
 * 900 bytes vê o vermelho da conta, quem estoura por 10 não vê nada. Medido com
 * um fragmento inflado até o fim da seção cair no byte 29.991: a conta passava
 * e `completa` vinha `false`.
 */
function comoOAgenteEmite(tagueado: string, instalada: string, teto: number, agentSh: string): string {
  const parada = rotuloDeParadaDoAgente(agentSh)(instalada);
  const saida: string[] = [];
  for (const linha of tagueado.split("\n")) {
    saida.push(linha);
    // `index($0, cur) == 1 { print; exit }`: imprime a linha do cabeçalho e para.
    if (linha.startsWith(parada)) break;
  }
  // `awk` termina TODO registro com `\n`, inclusive o último.
  return Buffer.from(saida.join("\n") + "\n", "utf8").subarray(0, teto).toString("utf8");
}

/** Onde a seção `versao` termina, em bytes, dentro de `texto`. */
function fimDaSecao(texto: string, versao: string): number {
  const { cabecalho, secoes } = fatiar(texto);
  let offset = Buffer.byteLength(cabecalho, "utf8");
  for (const s of secoes) {
    const tam = Buffer.byteLength(s.texto, "utf8");
    if (s.versao === versao) return offset + tam;
    offset += tam;
  }
  throw new Error(`seção [${versao}] não encontrada`);
}

export interface Candidata {
  /** Aparece no nome do caso de teste e na mensagem de falha. */
  nome: string;
  /** A versão cuja seção se mede dentro de `texto`. */
  versao: string;
  /** O arquivo inteiro, na forma em que a VPS o veria. */
  texto: string;
  /** O que fazer quando esta candidata estourar — depende de QUEM pode pagar. */
  conserto: string;
}

/**
 * As candidatas que o AUTOR DO PR responde por — as duas que ele pode enxugar
 * sozinho, sem depender de release nem de fragmento de terceiro.
 */
export function candidatasDoPr(raw: string): Candidata[] {
  const candidatas: Candidata[] = [];
  const { secoes } = fatiar(raw);

  const maisNova = secoes.find((s) => s.versao !== null);
  if (maisNova) {
    candidatas.push({
      nome: `a seção numerada mais nova [${maisNova.versao}]`,
      versao: maisNova.versao!,
      texto: raw,
      // A mensagem não afirma se esta seção já foi taggeada — ela não sabe, e o
      // conserto certo depende disso: antes da tag, enxugar resolve; depois, o
      // texto já congelou e só uma versão nova alcança quem leu.
      conserto:
        "Se a tag desta versão ainda NÃO foi cortada, enxugue a seção. Se já foi, o texto " +
        "congelou na tag e o conserto é uma versão nova — editar aqui não alcança quem já leu.",
    });
  }

  const naoLancado = secoes.find((s) => s.versao === null);
  const temConteudo =
    naoLancado !== undefined && naoLancado.texto.split("\n").slice(1).join("").trim().length > 0;
  if (temConteudo) {
    candidatas.push({
      nome: "o [Não lançado], como ele sairá na PRÓXIMA release",
      versao: VERSAO_SIMULADA,
      texto: comoFicaNaTag(raw, VERSAO_SIMULADA),
      conserto: "Enxugue os itens de [Não lançado].",
    });
  }

  return candidatas;
}

/**
 * A candidata da CASA: a seção que os fragmentos acumulados em `.changes/` vão
 * produzir na próxima release.
 *
 * Ela não é do PR e por isso não é cobrada nele. O acervo é dívida coletiva —
 * o 43º fragmento não é mais culpado que o 1º —, e o único remédio é cortar
 * release, ato do mantenedor. Devolve `null` quando não há fragmento: aí não há
 * seção a medir, e o silêncio é honesto porque o acervo vazio é o estado logo
 * depois de uma release.
 */
export function candidataDoAcervo(raw: string, fragmentos: readonly Fragmento[]): Candidata | null {
  if (fragmentos.length === 0) return null;
  return {
    nome: `a seção que os ${fragmentos.length} fragmento(s) de .changes/ vão produzir`,
    versao: VERSAO_SIMULADA,
    texto: comSecaoMontada(raw, fragmentos),
    conserto:
      "O acervo é dívida da casa, não do PR: o conserto é CORTAR RELEASE (`pnpm release:cortar`), " +
      "que consome os fragmentos. Enxugar fragmento de terceiro é trabalho de quem não o escreveu.",
  };
}

export interface Medida {
  nome: string;
  conserto: string;
  /** O `head -c` do `agent.sh`. */
  teto: number;
  /** Byte em que a seção termina dentro do arquivo tagueado. */
  fim: number;
  /** `teto - fim`: o que ainda cabe antes do corte. Pode ser negativo. */
  folga: number;
  /** Bytes da seção em si — a régua do aviso, derivada do próprio texto. */
  tamanhoDaSecao: number;
  cabe: boolean;
  /**
   * `extractChangelogRange().completa` sobre o payload exato do agente.
   * `null` quando não há versão abaixo a simular — é o primeiro corte do
   * repositório, e aí não existe ninguém para receber texto truncado.
   */
  completa: boolean | null;
  /**
   * O bloco `### ⚠️ Requer atenção` ainda existe depois do corte.
   * `null` quando a seção não tem aviso — versão sem ação manual não precisa.
   */
  avisoSobrevive: boolean | null;
}

/** Uma passada só sobre a candidata; quem julga são os chamadores. */
export function medir(candidata: Candidata, agentSh: string): Medida {
  const { nome, conserto, versao, texto } = candidata;
  const teto = tetoDoAgente(agentSh);
  const fim = fimDaSecao(texto, versao);

  const { secoes } = fatiar(texto);
  const secao = secoes.find((s) => s.versao === versao);
  const tamanhoDaSecao = Buffer.byteLength(secao?.texto ?? "", "utf8");

  const instalada = versaoSeguinte(texto, versao);
  const completa =
    instalada === null
      ? null
      : extractChangelogRange(comoOAgenteEmite(texto, instalada, teto, agentSh), versao, instalada)
          .completa;

  const inteiro = extractChangelogSection(texto, versao);
  if (inteiro === null) throw new Error(`a seção [${versao}] não foi extraída do arquivo completo`);
  const avisoSobrevive =
    inteiro.requiresAttention === null
      ? null
      : extractChangelogSection(comoChegaNaVps(texto, teto), versao)?.requiresAttention != null;

  return {
    nome,
    conserto,
    teto,
    fim,
    folga: teto - fim,
    tamanhoDaSecao,
    cabe: fim <= teto,
    completa,
    avisoSobrevive,
  };
}

export interface VereditoDoAcervo {
  /** Alguma das três réguas já degradou a tela do operador. */
  reprova: boolean;
  /**
   * Ainda cabe, mas outro ciclo igual a este não caberia.
   *
   * A régua é DERIVADA, nunca digitada: ela é o tamanho da própria seção que o
   * acervo produz hoje. "Dobrar o acervo estoura" dispara por volta da metade
   * do que cabe — folga que ainda dá para cortar release com calma —, cresce
   * junto com o texto e some sozinha quando `.changes/` esvazia. Um número
   * copiado para cá seria uma segunda fonte da verdade, com a mesma doença do
   * teto: a cópia envelhece.
   */
  avisa: boolean;
}

export function vereditoDoAcervo(m: Medida): VereditoDoAcervo {
  const reprova = !m.cabe || m.completa === false || m.avisoSobrevive === false;
  return { reprova, avisa: !reprova && m.folga < m.tamanhoDaSecao };
}
