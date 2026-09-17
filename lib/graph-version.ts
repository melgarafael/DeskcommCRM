/**
 * A VERSÃO DA GRAPH API TEM UM LUGAR SÓ.
 *
 * O número estava escrito à mão em dez arquivos de produção, sempre com o mesmo
 * `"v22.0"` copiado. A cópia é o defeito: no dia do bump, quem sobe a versão
 * edita dez lugares e esquece um — o esquecido não falha, ele responde. A
 * instalação passa a falar duas versões da mesma plataforma, e o sintoma chega
 * como "o template aprovado não envia" numa tela só.
 *
 * O número mora aqui. Quem cobra é
 * `tests/unit/versao-da-graph-num-lugar-so.test.ts`: literal de versão da Graph
 * fora deste arquivo reprova a suíte.
 *
 * NÃO SUBIU DE VERSÃO AQUI — de propósito. A v26.0 saiu em 29/07/2026, e subir
 * é decisão de manutenção, com reconferência de campo a campo antes (a lição
 * medida em `lib/plataformas-de-anuncio/meta/insights.ts`: campo válido some
 * entre versões, sem aviso). Esta mudança só diz ONDE o número mora; o número
 * continua o mesmo de hoje.
 *
 * Dois eixos, um número só:
 * - `graphVersion()` — canais de mensagem (`lib/channels/**`,
 *   `app/api/v1/channels/**`, `scripts/spike-*`) e honra `META_GRAPH_VERSION`,
 *   como o `.env.example` já documenta. Sem a variável, cai no default.
 * - `VERSAO_PADRAO_DA_GRAPH` — o eixo de anúncio
 *   (`lib/plataformas-de-anuncio/meta/**`), que usa o MESMO número de
 *   propósito (a instalação não deve conviver com duas versões da plataforma),
 *   mas NÃO herda a variável do canal de mensagem: são credenciais e ciclos de
 *   vida diferentes. É por isso que o override vive na função, e não na
 *   constante.
 */

/** O default da instalação. `bump` aqui é mudança deliberada, não deriva. */
export const VERSAO_PADRAO_DA_GRAPH = "v22.0";

/**
 * A versão com que a Graph API é chamada hoje.
 *
 * `META_GRAPH_VERSION` continua mandando quando existe — instalação que já
 * apontou a variável para outra versão segue apontada.
 *
 * Vazia (ou só espaço) conta como ausente: `??` devolveria a string vazia e o
 * endereço sairia com um separador a mais, sem versão no meio. `META_GRAPH_VERSION=`
 * é estado real de quem copiou o `.env.example` e apagou o valor.
 */
export function graphVersion(): string {
  const daVariavel = process.env.META_GRAPH_VERSION?.trim();
  return daVariavel ? daVariavel : VERSAO_PADRAO_DA_GRAPH;
}
