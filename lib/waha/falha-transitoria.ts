/**
 * FALHA DO BANCO NA INGESTÃO NÃO PODE SUMIR COM A MENSAGEM DO CLIENTE.
 *
 * Até aqui, `lib/waha/ingest.ts` tratava igual duas falhas de natureza oposta:
 * "o banco não respondeu agora" e "este dado nunca vai entrar". As duas viravam
 * `console.error` + `return`, e a rota devolvia 200 — o WAHA riscava o evento
 * da fila achando que entregou, e a mensagem do cliente não existia em lugar
 * nenhum além do arquivo cru em `webhook_events_log`, que nenhum código relia.
 * Sintoma do lado do dono: "o agente não respondeu". Medido em produção em
 * 14/09/2026: três mensagens de cliente perdidas num dia de `statement timeout`
 * (`[waha.ingest] message insert failed`), e duas na troca de banco de 24/09.
 *
 * Esta é a régua que separa as duas:
 *
 *   - PERMANENTE — o mesmo corpo vai falhar do mesmo jeito sempre: erro de dado
 *     (SQLSTATE 22xxx), de integridade (23xxx; o 23505 já é tratado antes, como
 *     dedup), de schema/permissão (42xxx), `raise exception` de regra de negócio
 *     (P0001) e pedido malformado ao PostgREST (PGRST1xx). Reentregar só
 *     martelaria. A rota segue devolvendo 200, mas o arquivo fica `error`.
 *
 *   - TRANSITÓRIA — todo o resto: `statement timeout` (57014), conexão (08xxx),
 *     recurso (53xxx), conflito de concorrência (40xxx), PostgREST sem banco
 *     (PGRST0xx) ou sem cache de schema (PGRST2xx), 5xx do gateway, `fetch
 *     failed`, e erro sem código. Na dúvida é transitória: reentregar uma
 *     mensagem que entraria custa um `23505`; desistir de uma que entraria custa
 *     a mensagem.
 */

export const PREFIXO_TRANSITORIA = "transitoria:";

export interface ErroDoBanco {
  code?: string | null;
  message?: string | null;
}

const PERMANENTE = /^(22|23|42)[0-9A-Z]{3}$|^P0001$|^PGRST1\d\d$/;

export function ehFalhaTransitoria(erro: ErroDoBanco): boolean {
  const code = (erro.code ?? "").trim();
  if (code === "") return true;
  return !PERMANENTE.test(code);
}

/**
 * Lançada pela ingestão quando o banco falhou de um jeito que uma nova
 * tentativa pode resolver. Quem recebe (rota ou cron de reprocessamento)
 * decide o desfecho: pedir reentrega ao WAHA, ou tentar de novo mais tarde.
 */
export class FalhaTransitoriaDeIngestao extends Error {
  readonly etapa: string;
  readonly codigo: string | null;

  constructor(etapa: string, erro: ErroDoBanco) {
    super(`${etapa}: ${erro.code ?? "sem_codigo"} ${erro.message ?? ""}`.trim());
    this.name = "FalhaTransitoriaDeIngestao";
    this.etapa = etapa;
    this.codigo = erro.code ?? null;
  }
}

/**
 * Falha que tentar de novo não conserta. Continua virando 200 para o WAHA (não
 * adianta martelar), mas deixa de ser silenciosa: o arquivo do webhook fica
 * `error` com a etapa e o código, em vez de `processed`.
 */
export class FalhaPermanenteDeIngestao extends Error {
  readonly etapa: string;
  readonly codigo: string | null;

  constructor(etapa: string, erro: ErroDoBanco) {
    super(`${etapa}: ${erro.code ?? "sem_codigo"} ${erro.message ?? ""}`.trim());
    this.name = "FalhaPermanenteDeIngestao";
    this.etapa = etapa;
    this.codigo = erro.code ?? null;
  }
}

/**
 * O ponto único onde a ingestão desiste de uma escrita que o banco recusou:
 * sempre lança, com a classe que diz a quem recebe se vale tentar de novo.
 */
export function lancarFalhaDeIngestao(etapa: string, erro: ErroDoBanco): never {
  if (ehFalhaTransitoria(erro)) throw new FalhaTransitoriaDeIngestao(etapa, erro);
  throw new FalhaPermanenteDeIngestao(etapa, erro);
}
