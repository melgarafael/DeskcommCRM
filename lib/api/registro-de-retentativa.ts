import { logger } from "@/lib/logger";

/**
 * O RETRY DO CLIENTE HTTP CONTA QUE ACONTECEU (#4508, item 8).
 *
 * ─── O que faltava ──────────────────────────────────────────────────────────
 *
 * O cliente repete 429/502/503/504 e as falhas de transporte até três vezes,
 * com espera crescente — e não deixava rastro nenhum disso. Quando o Inbox
 * demorava, o único jeito de saber se o atraso era UMA requisição lenta ou três
 * tentativas em série era ler o código e cronometrar a tela. Diagnóstico de
 * "a API está fora" e "a API está lenta" ficavam indistinguíveis de fora.
 *
 * ─── O canal é o que o projeto já tem ───────────────────────────────────────
 *
 * Uma linha estruturada por `logger` (JSON de uma linha, indexável por
 * agregador — ver `lib/logger.ts`). Nada de tabela, migration ou contador em
 * banco: uma métrica de retry de navegador não justifica escrita, e o volume é
 * o de requisições já feitas de qualquer jeito.
 *
 * ─── O nome é ESTÁVEL, e é o que se procura ────────────────────────────────
 *
 * `request_retried` é o token da linha (`msg` e `evento`): `git grep
 * request_retried` acha o emissor, e `jq 'select(.msg=="request_retried")'`
 * acha os eventos. O que vai junto é o mínimo para localizar o retry: método,
 * a ROTA LÓGICA (sem query e sem identificador no caminho), a tentativa que
 * está começando, o `X-Request-Id` já gerado (correlação com o log do
 * servidor) e o motivo — status HTTP ou nome do erro.
 *
 * Sem dado pessoal: nenhuma query string entra na linha. Filtro de busca do
 * inbox carrega o que a pessoa digitou, e busca por telefone é busca por pessoa.
 */

/** O token estável da linha. É por ele que se procura o evento. */
export const EVENTO_DE_RETENTATIVA = "request_retried";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SO_DIGITOS = /^\d+$/;

/**
 * A rota sem o que identifica UMA leitura: query string e identificador no
 * caminho.
 *
 * `/api/v1/conversations?search=maria&limit=50` → `/api/v1/conversations`;
 * `/api/v1/conversations/3f2a…/messages` → `/api/v1/conversations/:id/messages`.
 * O que interessa é a operação ("list_conversations"), não qual conversa.
 */
export function rotaLogica(path: string): string {
  const semQuery = path.split("?")[0] ?? "";
  return semQuery
    .split("/")
    .map((segmento) =>
      UUID.test(segmento) || SO_DIGITOS.test(segmento) ? ":id" : segmento,
    )
    .join("/");
}

export interface RetentativaObservada {
  /** O método da requisição que está sendo repetida. */
  metodo: string;
  /** O `path` cru; a normalização é feita aqui (`rotaLogica`). */
  rota: string;
  /** O número da tentativa que está COMEÇANDO — a segunda tentativa é `2`. */
  tentativa: number;
  /** O `X-Request-Id` desta requisição, para cruzar com o log da rota. */
  requestId?: string;
  /** Status HTTP que pediu a repetição (retry por resposta). */
  status?: number;
  /** Nome do erro que pediu a repetição (retry por transporte). */
  erro?: string;
}

/** Registra UM retry. Chamado do único ponto em que a repetição acontece. */
export function registrarRetentativa(evento: RetentativaObservada): void {
  logger.info(EVENTO_DE_RETENTATIVA, {
    evento: EVENTO_DE_RETENTATIVA,
    metodo: evento.metodo,
    rota: rotaLogica(evento.rota),
    tentativa: evento.tentativa,
    ...(evento.requestId ? { requestId: evento.requestId } : {}),
    ...(evento.status !== undefined ? { status: evento.status } : {}),
    ...(evento.erro ? { erro: evento.erro } : {}),
  });
}
