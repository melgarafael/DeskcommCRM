import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseFragmento } from "@/lib/release/fragmento";
import { montarSecao } from "@/lib/release/montar-secao";
import { extractChangelogRange, extractChangelogSection } from "@/lib/system/changelog";

/**
 * A seção mais nova do CHANGELOG é TELA DE PRODUTO, e ela tem um teto.
 *
 * O agente que roda por cron na VPS não manda "a seção da versão nova" para o
 * app: ele manda o CHANGELOG.md INTEIRO cortado em N bytes crus
 * (`git show <tag>:CHANGELOG.md | head -c N`), e é o app que extrai a seção do
 * texto recebido. Como o arquivo é lido de cima para baixo e a versão mais nova
 * fica no topo, isso funciona — até a seção mais nova sozinha passar de N.
 *
 * Medido ao cortar a v1.4.0 (2026-08-24): a seção tinha 39.899 bytes contra um
 * teto de 30.000. O texto chegava DECAPITADO no meio de uma frase e — pior — o
 * bloco `### ⚠️ Requer atenção` ficava inteiro do lado de fora do corte:
 * `extractChangelogSection()` sobre o texto truncado devolvia
 * `requiresAttention: null`. Os dois avisos daquela versão simplesmente não
 * existiriam para quem fosse atualizar.
 *
 * ─── O QUE SE MEDE, e por que não é o arquivo do disco ─────────────────────
 *
 * O que chega à VPS é `git show <TAG>:CHANGELOG.md`, e num arquivo TAGUEADO o
 * bloco `## [Não lançado]` está VAZIO — o conteúdo dele virou a seção numerada
 * no ato de cortar a release. Medido nas cinco tags do origin: 20 bytes, sempre.
 *
 * A primeira versão deste teste somava o offset ABSOLUTO do fim da seção mais
 * nova no working tree, o que embute o `[Não lançado]` do momento. Essas duas
 * coisas nunca coexistem num arquivo tagueado, e o efeito é datado: com 720
 * bytes de folga depois da v1.4.0, o primeiro ciclo normal de desenvolvimento
 * deixaria o `verify` — status check OBRIGATÓRIO — vermelho na `main` por uma
 * condição que nenhum cliente enxerga. Reproduzido antes do conserto: 3.645
 * bytes em `[Não lançado]` (o repo já teve 3.632 dois dias depois da v1.3.0)
 * davam `AssertionError: A seção [1.4.0] termina no byte 34288`, mandando
 * enxugar uma seção JÁ LANÇADA cuja cópia taggeada está correta.
 *
 * Então aqui se mede o arquivo **como ele estará na tag**, e as duas seções que
 * podem estourar são cobradas separadamente:
 *
 *   1. a seção numerada mais nova — o que já foi lançado (guarda retroativa);
 *   2. o `[Não lançado]` de agora — o que a PRÓXIMA release vai publicar, que é
 *      a única das duas que ainda dá para consertar enxugando.
 *
 * E cada candidata é cobrada por DUAS réguas, porque a conta de bytes é um
 * proxy e o proxy tem faixa cega: `comoOAgenteEmite()` reproduz o pipeline do
 * `agent.sh` (o `awk` que para no cabeçalho da versão instalada, depois o
 * `head -c`) e cobra o desfecho que o operador vê — `completa: true`. O
 * cabeçalho da versão instalada é o último a entrar no corte e é ele que
 * decide esse campo, então a conta fica verde numa faixa da largura desse
 * cabeçalho (27 B hoje) em que a tela já degradou. Medido: com a seção
 * terminando no byte 29.991 a conta passa e `completa` vem `false`.
 *
 * O teto NÃO é digitado aqui — é lido do próprio `agent.sh`. Um número copiado
 * para cá viraria uma segunda fonte da verdade, e a que envelhece primeiro é
 * sempre a cópia. (Isso tem um custo declarado: subir o `head -c` do `agent.sh`
 * silencia este teste. Não conserta ninguém — quem corta é o script que JÁ está
 * instalado na VPS do cliente —, então subir o número para calar o CI é trocar
 * um vermelho honesto por um cliente sem aviso.)
 *
 * CONSERTOS POSSÍVEIS quando este teste ficar vermelho, em ordem de preferência:
 *   1. enxugar a seção (quase sempre certo — item de changelog longo costuma ser
 *      explicação que só interessa a quem escreveu o código);
 *   2. mover `### ⚠️ Requer atenção` para logo depois do parágrafo de abertura —
 *      `findAttentionRange()` acha o bloco em qualquer posição da seção, então o
 *      aviso passa a sobreviver ao corte mesmo se o corpo for truncado.
 */

const RAIZ = process.cwd();
const CHANGELOG = path.join(RAIZ, "CHANGELOG.md");
const AGENT_SH = path.join(RAIZ, "hostgator-setup-kit", "agent.sh");

/** O teto real, lido de onde ele é aplicado. */
function tetoDoAgente(): number {
  const sh = fs.readFileSync(AGENT_SH, "utf8");
  const m = /git show\s+"?\$\{?LATEST_TAG\}?"?:CHANGELOG\.md[^\n]*head -c (\d+)/.exec(sh);
  if (!m) {
    throw new Error(
      "não achei o corte do CHANGELOG em agent.sh — se o mecanismo mudou, este teste precisa " +
        "acompanhar em vez de ser apagado: o contrato de tamanho continua existindo.",
    );
  }
  return Number(m[1]);
}

/**
 * O rótulo que o `awk` do agente procura para PARAR de imprimir.
 *
 * Lido do próprio `agent.sh` pelo mesmo motivo que o teto é: um `## [` digitado
 * aqui viraria segunda fonte da verdade, e a cópia é sempre a que envelhece.
 * O que se extrai é o valor de `-v cur=`, com `${CURRENT#v}` no lugar da versão.
 */
function rotuloDeParadaDoAgente(): (versao: string) => string {
  const sh = fs.readFileSync(AGENT_SH, "utf8");
  const m = /awk -v cur="([^"]*)"/.exec(sh);
  if (!m?.[1]?.includes("${CURRENT#v}")) {
    throw new Error(
      "não achei o `-v cur=` do awk em agent.sh — se o corte deixou de parar no cabeçalho da " +
        "versão instalada, este teste precisa acompanhar em vez de ser apagado.",
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
  const corpo = naoLancado
    ? naoLancado.texto.split("\n").slice(1).join("\n").replace(/^\n+/, "")
    : "";
  return (
    cabecalho +
    "## [Não lançado]\n\n" +
    `## [${versaoFutura}] — 2099-01-01\n\n` +
    corpo +
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
 * Por que isto existe ao lado da conta de bytes acima: a conta é um PROXY. Ela
 * mede até o FIM da seção nova, e o que o agente manda vai um pouco além — até
 * o cabeçalho da versão instalada, INCLUSIVE. Esse cabeçalho não é enfeite: é
 * ele que faz `extractChangelogRange` devolver `completa: true`. Sem ele, a
 * tela do operador troca o histórico por "este histórico pode não alcançar a
 * sua versão" — degradação honesta, mas degradação, e o proxy fica verde nela.
 *
 * A faixa cega tem a largura do cabeçalho (`## [1.13.0] — 2026-09-04` = 27 B
 * hoje). É estreita, e é justamente por ser estreita que ninguém a acha lendo:
 * quem estoura por 900 bytes vê o vermelho da conta, quem estoura por 10 não vê
 * nada. Medido com um fragmento inflado até o fim da seção cair no byte 29.991:
 * a conta passava e `completa` vinha `false`.
 *
 * E o proxy tem um segundo modo de erro que este não tem: ele reproduz o
 * mecanismo do `awk` de cabeça. Se o corte do agente mudar de lugar de novo —
 * já mudou uma vez, quando deixou de ser cego —, a conta continua verde
 * medindo a régua antiga. Esta função lê o `-v cur=` do próprio script.
 */
function comoOAgenteEmite(tagueado: string, instalada: string, teto: number): string {
  const parada = rotuloDeParadaDoAgente()(instalada);
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

/**
 * Os fragmentos de `.changes/`, já validados. Um fragmento malformado é erro de
 * quem o escreveu e reprova em `fragmentos-de-release.test.ts` — aqui ele é
 * pulado para a mensagem de falha não trocar "seção grande demais" por um erro
 * de parse que confundiria o conserto.
 */
function fragmentosDeChanges(): ReturnType<typeof parseFragmento>[] {
  const dir = path.join(RAIZ, ".changes");
  if (!fs.existsSync(dir)) return [];
  const lidos = [];
  for (const arquivo of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    try {
      lidos.push(parseFragmento(arquivo, fs.readFileSync(path.join(dir, arquivo), "utf8")));
    } catch {
      continue;
    }
  }
  return lidos;
}

/** O arquivo como ele ficará na TAG: `[Não lançado]` vazio, a seção nova abaixo. */
function comSecaoMontada(raw: string, fragmentos: ReturnType<typeof parseFragmento>[]): string {
  const { cabecalho, secoes } = fatiar(raw);
  const numeradas = secoes.filter((s) => s.versao !== null);
  return (
    cabecalho +
    "## [Não lançado]\n\n" +
    montarSecao(fragmentos, "9.9.9", "2099-01-01").texto +
    "\n\n" +
    numeradas.map((s) => s.texto).join("")
  );
}

const RAW = fs.readFileSync(CHANGELOG, "utf8");
const TETO = tetoDoAgente();

/** As duas seções que podem estourar, cada uma no arquivo em que ela é publicada. */
const CANDIDATAS: Array<{ nome: string; versao: string; texto: string; conserto: string }> = [];
{
  const { secoes } = fatiar(RAW);
  const maisNova = secoes.find((s) => s.versao !== null);
  if (maisNova) {
    CANDIDATAS.push({
      nome: `a seção numerada mais nova [${maisNova.versao}]`,
      versao: maisNova.versao!,
      texto: RAW,
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
    naoLancado !== undefined &&
    naoLancado.texto.split("\n").slice(1).join("").trim().length > 0;
  if (temConteudo) {
    CANDIDATAS.push({
      nome: "o [Não lançado], como ele sairá na PRÓXIMA release",
      versao: "9.9.9",
      texto: comoFicaNaTag(RAW, "9.9.9"),
      conserto: "Enxugue os itens de [Não lançado] (veja o cabeçalho deste arquivo).",
    });
  }

  // A partir de `docs/doctrine/versionamento.md`, o texto da próxima release
  // não mora mais em `[Não lançado]` — ele chega em fragmentos, um por PR, e
  // `[Não lançado]` fica PERMANENTEMENTE vazio. Sem esta candidata, a guarda
  // acima passaria a nunca ter o que medir antes de uma release: continuaria
  // verde por vacuidade, que é o modo de falha que o cabeçalho deste arquivo
  // existe para evitar.
  const fragmentos = fragmentosDeChanges();
  if (fragmentos.length > 0) {
    CANDIDATAS.push({
      nome: `a seção que os ${fragmentos.length} fragmento(s) de .changes/ vão produzir`,
      versao: "9.9.9",
      texto: comSecaoMontada(RAW, fragmentos),
      conserto:
        "Enxugue o corpo dos fragmentos em `.changes/` — item de changelog longo costuma ser " +
        "explicação que só interessa a quem escreveu o código.",
    });
  }
}

describe("o CHANGELOG da versão nova cabe no que a VPS recebe", () => {
  it("há o que medir — o arquivo tem ao menos uma seção candidata", () => {
    // Guarda de vacuidade: se `fatiar()` quebrar, os `it.each` abaixo somem e a
    // suíte fica verde por não haver caso — o modo de falha mais silencioso que
    // um gate tem.
    expect(CANDIDATAS.length, "nenhuma seção candidata: o parser deste teste quebrou").toBeGreaterThan(0);
  });

  it.each(CANDIDATAS)("$nome termina antes do corte do agente", ({ versao, texto, conserto }) => {
    const fim = fimDaSecao(texto, versao);
    expect(
      fim,
      `A seção termina no byte ${fim}, além do corte de ${TETO} bytes que o agent.sh aplica ` +
        `sobre o arquivo TAGUEADO. O dono da VPS receberia o texto cortado no meio. ${conserto}`,
    ).toBeLessThanOrEqual(TETO);
  });

  it.each(CANDIDATAS)("$nome chega inteira ao app, do jeito que o agente a emite", ({ versao, texto, conserto }) => {
    const instalada = versaoSeguinte(texto, versao);
    // Sem uma versão abaixo não há "instalada" a simular — é o primeiro corte
    // do repositório, e aí não existe ninguém para receber texto truncado.
    if (instalada === null) return;

    const faixa = extractChangelogRange(comoOAgenteEmite(texto, instalada, TETO), versao, instalada);
    expect(
      faixa.completa,
      `Quem está na [${instalada}] recebe o texto cortado ANTES do cabeçalho da própria versão: ` +
        `a tela troca o histórico por "este histórico pode não alcançar a sua versão". ${conserto}`,
    ).toBe(true);
  });

  it.each(CANDIDATAS)("o aviso de ação manual de $nome sobrevive ao corte", ({ versao, texto, conserto }) => {
    const inteiro = extractChangelogSection(texto, versao);
    expect(inteiro, `a seção [${versao}] não foi extraída do arquivo completo`).not.toBeNull();

    // Só cobra o que existe: versão sem ação manual não precisa do bloco.
    if (inteiro!.requiresAttention === null) return;

    const cortado = extractChangelogSection(comoChegaNaVps(texto, TETO), versao);
    expect(
      cortado?.requiresAttention,
      `A seção tem "⚠️ Requer atenção", mas o bloco fica FORA dos ${TETO} bytes que chegam à ` +
        `VPS — o aviso não apareceria para quem vai atualizar. ${conserto} Ou mova o bloco ` +
        `para logo depois do parágrafo de abertura.`,
    ).not.toBeNull();
  });
});
