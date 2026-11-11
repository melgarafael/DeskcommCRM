/**
 * Intervalo mínimo entre respostas da IA — "a pausa" configurável por agente.
 *
 * A janela de rajada (`debounce.ts`) junta as mensagens do cliente que chegam em
 * seguida, mas não impede a IA de responder de novo logo depois de responder.
 * Este módulo segura o PRÓXIMO turno até `última resposta da IA + intervalo`.
 *
 * Contrato:
 *   - `null`/ausente/0 = sem intervalo: o job nasce como sempre nasceu.
 *   - o intervalo só ADIA — nunca antecipa o `run_after` que a rajada já pediu;
 *   - o adiamento é por CONVERSA, medido pela última mensagem `sent_via = 'ai'`
 *     que não falhou: resposta de humano não conta, e a de IA que falhou também
 *     não (o cliente não a recebeu, não há o que espaçar);
 *   - o job adiado fica PENDING no futuro, então as mensagens que chegarem até lá
 *     entram de carona nele (`decidirRajada`) e são respondidas juntas.
 */
import type pg from 'pg';

/** Teto do intervalo (10 min): ninguém deixa o atendimento mudo sem querer. */
export const TETO_INTERVALO_ENTRE_RESPOSTAS_MS = 600_000;

/**
 * Intervalo EFETIVO de um agente. `null`/`undefined`/inválido = 0 (sem
 * intervalo); o valor configurado é CLAMPADO em [0, teto] — dado sujo que
 * entrou por fora da validação cai no teto em vez de travar a conversa.
 */
export function intervaloEfetivo(configurado: number | null | undefined): number {
  if (configurado === null || configurado === undefined || !Number.isFinite(configurado)) return 0;
  return Math.min(Math.max(0, Math.floor(configurado)), TETO_INTERVALO_ENTRE_RESPOSTAS_MS);
}

/**
 * O `run_after` do próximo turno, respeitando o intervalo. `undefined` = job
 * imediato (nenhuma espera pedida por ninguém).
 *
 * `agora` é injetável: a conta é aritmética e o teste prende o número sem
 * depender do relógio.
 */
export function runAfterComIntervalo(
  runAfter: Date | undefined,
  ultimaRespostaEm: Date | null,
  intervaloMs: number,
  agora: number = Date.now(),
): Date | undefined {
  if (intervaloMs <= 0 || ultimaRespostaEm === null) return runAfter;
  const liberaEm = ultimaRespostaEm.getTime() + intervaloMs;
  // Já passou do intervalo: nada a adiar.
  if (liberaEm <= agora) return runAfter;
  // A rajada já pede uma espera maior que o intervalo: ela vence.
  if (runAfter !== undefined && runAfter.getTime() >= liberaEm) return runAfter;
  return new Date(liberaEm);
}

/** Quando a IA respondeu pela última vez nesta conversa; `null` = nunca. */
export async function ultimaRespostaDaIa(
  pool: pg.Pool,
  alvo: { organizationId: string; conversationId: string },
): Promise<Date | null> {
  const { rows } = await pool.query<{ em: Date | string | null }>(
    `select max(created_at) as em from messages
      where organization_id = $1 and conversation_id = $2
        and direction = 'outbound' and sent_via = 'ai'
        and status <> 'failed'`,
    [alvo.organizationId, alvo.conversationId],
  );
  const em = rows[0]?.em;
  return em === null || em === undefined ? null : new Date(em);
}
