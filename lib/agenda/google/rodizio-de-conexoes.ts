/**
 * O RODÍZIO das conexões do sync do Google — sem carimbar a linha (#3695).
 *
 * ─── O defeito que isto fecha ───────────────────────────────────────────────
 *
 * A rodada de `agenda-google-sync` lê 25 conexões por minuto, e para não varrer
 * sempre as mesmas 25 ela lia `order=updated_at.asc` e carimbava `updated_at` em
 * CADA conexão do lote ao fim da rodada, sincronizando ou não. O carimbo era o
 * cursor: quem acabou de ser lido vai para o fim da fila.
 *
 * O preço disso é medido numa instalação OCIOSA: um `UPDATE` por conexão por
 * minuto, para sempre — WAL, tupla morta e IO exatamente para escrever o mesmo
 * estado (`updated_at` novo é a única coluna que muda). Ninguém está usando o
 * produto e o banco escreve 1440 linhas por dia por conexão.
 *
 * ─── O que substitui o carimbo ──────────────────────────────────────────────
 *
 * Páginas sobre a ordem ESTÁVEL `id`: com `total` conexões elegíveis existem
 * `ceil(total / lote)` páginas, e cada rodada lê UMA delas. A rodada de agora lê
 * a página 0, a seguinte a página 1, e assim por diante até voltar ao começo. O
 * avanço vem do relógio (uma rodada por minuto, ver
 * `docker/scheduler/entrypoint.sh`), não de uma escrita.
 *
 * Duas propriedades precisam valer, e são o que os testes medem:
 *
 *   1. RODÍZIO. Duas rodadas seguidas, com mais conexões do que o lote, leem
 *      conjuntos diferentes — senão o rodízio morreu junto com o carimbo e o
 *      cron passa a olhar sempre as mesmas 25.
 *   2. COBERTURA. Em `ceil(total / lote)` rodadas TODA conexão foi lida. Isso é
 *      exato porque as páginas TILEHAM a lista: `[0, lote-1]`, `[lote, 2*lote-1]`
 *      …, com a última cortada no fim. Um deslocamento que não fosse múltiplo do
 *      lote deixaria buraco — ou, pior, devolveria páginas curtas perto do fim
 *      (foi o que a primeira versão desta função fazia, e o teste de cobertura
 *      pegou: com 26 conexões, só 13 eram visitadas em três rodadas).
 *
 * ─── Por que aqui, e não dentro da rota ─────────────────────────────────────
 *
 * É aritmética pura sobre dois números (quantas existem, que horas são). Fora da
 * rota ela é testável com instante injetado, sem banco e sem mock de rede — e a
 * rota fica sendo só o I/O.
 */

/** Quantas conexões UMA rodada lê. O mesmo teto de antes (`limit(25)`). */
export const LOTE_DE_CONEXOES = 25;

/**
 * O passo do relógio. A rodada do cron é de um minuto
 * (`* * * * *` em `docker/scheduler/entrypoint.sh`); declarado aqui para o
 * teste poder apertar o passo sem mexer no resto.
 */
export const BUCKET_DO_RODIZIO_MS = 60_000;

export type JanelaDaRodada = {
  /** Primeiro índice da página, na ordem `id`. */
  inicio: number;
  /** Último índice, INCLUSIVO — o `range` do PostgREST é fechado nas duas pontas. */
  fim: number;
};

/**
 * A página que ESTA rodada lê.
 *
 * `null` = tudo cabe numa página só: não há rodízio a fazer e a leitura não
 * precisa de deslocamento (o caso comum de uma instalação com uma conexão por
 * pessoa). `total` desconhecido (`null`, `undefined`, `NaN` — uma contagem que
 * falhou) também devolve `null`, e por um motivo específico: sem saber quantas
 * existem não há como enumerar as páginas, e um deslocamento qualquer poderia
 * passar do fim e a rodada leria ZERO conexões. Na dúvida, lê o começo da fila.
 */
export function janelaDaRodada(
  total: number | null | undefined,
  agora: Date,
  lote: number = LOTE_DE_CONEXOES,
  bucketMs: number = BUCKET_DO_RODIZIO_MS,
): JanelaDaRodada | null {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(lote) || lote <= 0 || !Number.isFinite(bucketMs) || bucketMs <= 0) return null;
  if (total <= lote) return null;

  const paginas = Math.ceil(total / lote);
  const bucket = Math.floor(agora.getTime() / bucketMs);
  // `((x % n) + n) % n`: instante anterior à época (relógio torto, teste com
  // data negativa) não pode virar página negativa.
  const pagina = ((bucket % paginas) + paginas) % paginas;
  const inicio = pagina * lote;
  return { inicio, fim: Math.min(inicio + lote - 1, total - 1) };
}
