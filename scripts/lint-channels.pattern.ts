/**
 * O padrão que reconhece "nome de provider" para o invariante 1 da doutrina de
 * restrição de canal (`docs/doctrine/restricao-de-canal.md`).
 *
 * Mora num módulo separado de `lint-channels.ts` por um motivo só: o script é
 * uma casca que varre o disco e chama `process.exit` no topo do módulo, então
 * importá-lo de um teste RODARIA o lint. Sem separar, o mecanismo do
 * reconhecimento fica sem como ser vigiado — e foi exatamente o que deixou o
 * furo abaixo viver.
 *
 * ─── O furo (issue #118) ────────────────────────────────────────────────────
 *
 * A primeira versão era `/\b(waha|WAHA|meta_cloud|graph\.facebook\.com)\b/`.
 * `_` é *word character* em regex, então `\b` NÃO fecha entre `WAHA` e `_`:
 * `WAHA_API_KEY` e `waha_session_name` — os nomes de provider mais comuns do
 * código — passavam invisíveis pela catraca, que está no `gov:verify` e é
 * catraca de merge. Uma catraca com furo é pior que catraca nenhuma: o verde
 * afirma que a doutrina está sendo respeitada.
 *
 * ─── Por que DUAS fronteiras, e não uma ─────────────────────────────────────
 *
 * Um provider vira identificador em TypeScript de dois jeitos, e cada um pede
 * uma fronteira diferente. Uma regex só não expressa os dois sem virar ilegível
 * ou frouxa:
 *
 *   `waha_session_name`, `WAHA_API_KEY`, `@/lib/waha/x`  → separador não-alfanumérico
 *   `WahaClient`, `createWahaSession`                    → transição de caixa
 *
 * Consertar só a primeira deixaria a segunda como álibi para o próximo caso —
 * é o mesmo furo (uma grafia do provider que a catraca não vê), na outra
 * dimensão. Medido na main de 2026-08-05: a regra PascalCase custa **zero**
 * arquivo ofensor a mais (hoje todo arquivo que a tem também importa de
 * `lib/waha/`), então fechar a classe inteira aqui não cria dívida nova.
 */

/**
 * Grafia separada por não-alfanumérico: `waha`, `WAHA_API_KEY`,
 * `waha_session_name`, `lib/waha/client`, `meta_cloud`, `graph.facebook.com`.
 *
 * A fronteira é "não colado em alfanumérico" — deixa `_`, `/`, `.` e `-` serem
 * separadores de verdade (que `\b` não deixava) e continua ignorando `wahax` /
 * `xwaha`, onde `waha` é pedaço de outra palavra e não menção ao provider.
 *
 * O terceiro nome entrou JUNTO com o canal que ele nomeia. Um provider novo que
 * a catraca não conhece é o mesmo furo da issue #118 numa grafia nova: o gate
 * fica verde afirmando que a doutrina é respeitada enquanto o nome se espalha
 * por rota, componente e cópia de tela. Provider novo = uma linha aqui, no
 * mesmo commit.
 */
export const SEPARADO = /(?<![a-zA-Z0-9])(waha|meta_cloud|zernio|ryze|graph\.facebook\.com)(?![a-zA-Z0-9])/i;

/**
 * Grafia PascalCase dentro de identificador: `WahaClient`,
 * `WahaChannelAdapter`, `createWahaSession`.
 *
 * Case-SENSITIVE de propósito: é a transição de caixa que marca a fronteira do
 * segmento. Não seguido de minúscula/dígito exclui `Wahalla` — onde `Waha` é
 * começo de outra palavra, não segmento próprio.
 */
export const PASCAL = /(Waha|Zernio|Ryze)(?![a-z0-9])/;

/** Um trecho de código/prosa nomeia um provider de canal? */
export function nomeiaProvider(texto: string): boolean {
  return SEPARADO.test(texto) || PASCAL.test(texto);
}

/** Exportadas para o teste de fronteira poder vigiar cada uma isoladamente. */
export const PADROES = { SEPARADO, PASCAL } as const;
