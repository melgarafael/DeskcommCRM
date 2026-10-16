import type { Page } from "@playwright/test";

/**
 * Quais métodos de navegação a espera da revelação DEVE envolver — e o embrulho
 * que os envolve, em função pura, para o `verify` provar o embrulho REAL sem
 * navegador (no mesmo padrão de `caixa-ssr.ts` e `instrumento-da-pagina.ts`).
 *
 * ═══ O defeito que este arquivo existe para fechar (issue #884) ═════════════
 *
 * `tests/e2e/helpers/test.ts` embrulha `page.goto` e `page.reload` para que
 * só devolvam quando o streaming SSR terminou de revelar a página
 * (issue #1374). O cenário da #884 é, palavra por palavra, "depois de navegar
 * para a Agenda e voltar" — e "voltar" em Playwright é `page.goBack()`, que
 * NÃO era embrulhado. A spec que volta por ali lia o documento no meio da
 * revelação e o `getByTestId("tela-agenda")` casava com DOIS elementos
 * (`strict mode violation`), o vermelho INTERMITENTE do PR #873.
 *
 * A tela da Agenda não era a culpada: medida em jsdom, `AgendaClient` monta 1,
 * desmonta para 0 e remonta para 1. A cópia é a caixa do streaming SSR
 * (`<div hidden id="S:N">`) do servidor, que o React esvazia no cliente.
 *
 * ─── Por que uma LISTA, e não o embrulho em si ═════════════════════════════
 *
 * A lista é o que se prova, e o embrulho sai dela. A falha anterior foi a
 * mesma deste arquivo: a cobertura vivia espalhada dentro do `page.goto`, e a
 * cobertura esquecida (`goBack`) não tinha onde aparecer. Com a lista aqui, a
 * omissão de um método vira uma linha a mais nesta constante — e um teste que
 * a lê.
 *
 * ⚠️ `reload` e `goForward` entram pelo mesmo motivo de `goBack`: são navegação
 * de verdade, e uma spec que volta pela barra do navegador ou pelo botão
 * "avançar" tem o mesmo defeito. `goForward` não é usado hoje — e é por isso
 * que ele precisa entrar: a próxima spec que usar vai herdar a espera, em vez
 * de descobrir a lacuna.
 *
 * ⚠️ `setContent` NÃO entra: ele troca o documento inteiro e não produz caixa
 * de streaming. Incluí-lo seria uma espera que nunca passa, e um teste que
 * estufa a cobertura sem medir nada.
 */
export const METODOS_DE_NAVEGACAO_REVELADOS: readonly string[] = [
  "goto",
  "reload",
  "goBack",
  "goForward",
];

/**
 * Embrulha em `pagina` cada método de `METODOS_DE_NAVEGACAO_REVELADOS` para só
 * devolver depois de `esperar()`. É o que `test.ts` chama; o teste unit chama a
 * MESMA função com um dublê — e a cerca de texto de lá reprova `test.ts` que
 * volte a embrulhar algum método à mão, fora desta função.
 */
export function embrulharANavegacao(pagina: Page, esperar: () => Promise<void>): void {
  const alvo = pagina as unknown as Record<string, unknown>;
  for (const metodo of METODOS_DE_NAVEGACAO_REVELADOS) {
    const original = alvo[metodo];
    if (typeof original !== "function") continue;
    const ligado = (original as (...args: unknown[]) => unknown).bind(pagina);
    alvo[metodo] = async (...args: unknown[]): Promise<unknown> => {
      const resposta = await ligado(...args);
      // `commit` pede de propósito a página antes de ela existir — esperar a
      // revelação ali seria esperar por uma caixa que ninguém vai fechar.
      // `goBack`/`goForward` também aceitam `waitUntil`; o guarda é sobre o
      // ARGUMENTO e não sobre o método, e por isso vale para os quatro.
      const opcoes = args[args.length - 1];
      const pediuCommit =
        typeof opcoes === "object" && opcoes !== null && (opcoes as { waitUntil?: string }).waitUntil === "commit";
      if (!pediuCommit) await esperar();
      return resposta;
    };
  }
}

/**
 * ═══ O DIAGNÓSTICO DO BOUNDARY QUE TERMINOU EM ERRO DE SERVIDOR ═════════════
 *
 * `test.ts` lança "caixa órfã de verdade" quando `div[hidden][id^="S:"]` não é
 * revelada dentro do teto. Nem toda caixa que não revela é órfã: quando o
 * boundary termina em ERRO DE SERVIDOR, o servidor não o revela — ele manda o
 * cliente renderizar aquele boundary do zero, e é isso que a caixa escondida
 * na página registra. O caso medido é o do PR #2351: a consulta do catálogo
 * estourou o `statement_timeout`, `app/app/products/page.tsx:95` lançou, e a
 * espera acusou caixa órfã onde havia erro de servidor.
 *
 * O que o react-dom 19.3 de fato entrega nesse caso — lido no fonte instalado
 * (`node_modules/react-dom/cjs/react-dom-server.node.production.js`) e medido
 * por EXECUÇÃO no teste unitário deste arquivo:
 *
 *   · o stream fecha com `<script>$RX("B:N","<digest>")</script>`. O digest é o
 *     segundo argumento, e é o valor que o `onError` do servidor DEVOLVE
 *     (`logRecoverableError` faz `errorDigest = request.onError(error, info)`) —
 *     é assim que o Next entrega o digest do erro de servidor ao stream;
 *   · o `$RX` roda no cliente e escreve esse MESMO digest no dataset do
 *     marcador: `a.dataset.dgst = c` → o marcador ganha `data-dgst` (e
 *     `data-msg`/`data-stck`/`data-cstck`, quando vêm preenchidos).
 *
 * Ou seja: no ponto em que a espera desiste, o digest está à mão em DOIS
 * lugares da página — o `data-dgst` do marcador e o texto do script cru. É o
 * que as funções puras abaixo leem, para o teste unit provar os dois ramos sem
 * navegador; `test.ts` só coleta os dois e chama.
 */

/** O que `test.ts` coleta da página quando a espera desiste. */
export type EvidenciaDoErroDeServidor = {
  /** Valores de `data-dgst` — o que o `$RX` escreveu no marcador do boundary. */
  readonly digestsDoMarcador: readonly string[];
  /** Valores de `data-msg` do mesmo marcador, quando o servidor mandou a mensagem. */
  readonly mensagensDoMarcador: readonly string[];
  /** Textos dos scripts da página — inclui o `$RX("B:N","<digest>")` cru. */
  readonly scripts: readonly string[];
};

/** Coleta que não achou nada — a página foi lida, e não havia erro de servidor. */
export const EVIDENCIA_DE_ERRO_VAZIA: EvidenciaDoErroDeServidor = {
  digestsDoMarcador: [],
  mensagensDoMarcador: [],
  scripts: [],
};

/**
 * O `$RX` de erro do stream: `$RX("B:N","<digest>")`. SEM a barra `g` de
 * propósito: regex com estado (`lastIndex`) reprovaria o segundo script lido.
 */
export const SCRIPT_DE_ERRO_DE_BOUNDARY = /\$RX\("([^"]*)"\s*,\s*"((?:[^"\\]|\\.)*)"/;

/**
 * O digest do erro de servidor, se esta página tiver um. O `data-dgst` vem
 * primeiro por ser o que o próprio navegador já resolveu; o script é a reserva,
 * para quando o marcador já saiu da página. `null` = não houve erro de
 * servidor: a caixa não revelou sozinha, e o diagnóstico de sempre continua
 * certo.
 */
export function digestDoErroDeServidor(evidencia: EvidenciaDoErroDeServidor): string | null {
  const noMarcador = evidencia.digestsDoMarcador.find((digest) => digest.length > 0);
  if (noMarcador !== undefined) return noMarcador;
  for (const script of evidencia.scripts) {
    const achado = script.match(SCRIPT_DE_ERRO_DE_BOUNDARY);
    if (achado?.[2]) return achado[2];
  }
  return null;
}

/**
 * A mensagem que `test.ts` lança quando a caixa não revelou. Sem digest, é a
 * mensagem de sempre, palavra por palavra: o comportamento do helper não muda
 * (segue reprovando), muda só o diagnóstico de quem TEM digest.
 */
export function mensagemDaCaixaNaoRevelada(entrada: {
  readonly caixaPendente: string;
  readonly tetoMs: number;
  readonly url: string;
  readonly evidencia: EvidenciaDoErroDeServidor;
}): string {
  const semRevelacao =
    `a caixa do streaming SSR (${entrada.caixaPendente}) não foi revelada em ${entrada.tetoMs} ms ` +
    `depois da carga de ${entrada.url}`;
  const digest = digestDoErroDeServidor(entrada.evidencia);
  if (digest === null) return `${semRevelacao} — caixa órfã de verdade (issue #1374).`;
  const mensagemDoServidor = entrada.evidencia.mensagensDoMarcador.find((m) => m.length > 0);
  return (
    `${semRevelacao} — o boundary NÃO é caixa órfã: ele terminou em ERRO DE SERVIDOR ` +
    `(digest ${digest}${mensagemDoServidor ? `, "${mensagemDoServidor}"` : ""}). O servidor manda o ` +
    `cliente renderizar o boundary do zero e a caixa escondida fica na página; o defeito é de ` +
    `SERVIDOR, não da revelação (issue #1374).`
  );
}
