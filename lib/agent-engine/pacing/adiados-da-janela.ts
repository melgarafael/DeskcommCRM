/**
 * O TURNO ADIADO PELA JANELA NÃO PODE CONTINUAR DORMINDO DEPOIS QUE ELA ABRE.
 *
 * ═══ O defeito (#3383) ═══
 *
 * O contato escreve às 22h11 com a janela de resposta 7h–22h: `inbound-turn.ts`
 * adia o job para as 7h (comportamento correto) e o drain, na mensagem das
 * 22h40, o encontra com `status='pending' and run_after > now()` e o elege como
 * carona da rajada — "rajada coalescida em job pendente". O administrador tinha
 * aberto a janela para 0h–24h no meio-tempo (`PUT /api/v1/ai/pacing`), então o
 * job seguia com `run_after` às 7h e o contato ficou sem resposta até lá. Nada
 * lia a mudança de `resposta_start_hour`/`resposta_end_hour` para quem JÁ está
 * na fila: a janela nova só era vista no próximo contato.
 *
 * ═══ O que este módulo guarda ═══
 *
 * 1. **Rastro** (`adiadoPorJanela`): o `payloadPatch` que `rescheduleJob` grava
 *    no MESMO job quando o adiamento é da janela. Sem a chave no payload, o
 *    drain não distingue um job esperando a ABERTURA de um job esperando o
 *    debounce de rajada (8 s) nem um que esperou cap diário, saldo ou sessão —
 *    e acordar os últimos é churn (o turno roda, é vetado e volta para a fila).
 * 2. **Leitura** (`janelaDeRespostaAberta`): a mesma régua do motor
 *    (`janelaDeEnvioAberta(agora, knobs, true)`), que é quem sabe o fuso do
 *    tenant e o `0..24`. A política de horário não é reimplementada aqui — só
 *    consultada.
 * 3. **Acordar** (`soltarAdiadoPelaJanela` / `soltarAdiadosDaSessao`): pôr
 *    `run_after = now()` na MESMA linha pendente. Nunca `insert` — o job nasceu
 *    uma vez e tem de rodar uma vez (idempotência: a segunda chamada não acha
 *    `run_after > now()` e devolve 0; um job `running` jamais é re-armado, que
 *    é o que impediria o mesmo turno de disparar duas vezes).
 *
 * Os DOIS caminhos que usam isto: o drain (recusa de carona + acordar na hora)
 * e o leitor do `PUT /api/v1/ai/pacing` (reavaliação imediata, sem esperar o
 * próximo contato).
 */
import type { Logger } from '../obs/logger';
import type { Queryable } from '../queue/queue';

import { janelaDeEnvioAberta } from './engine';
import { loadChannelKnobs } from './store';

/** Chave do rastro no `payload` do job. */
export const CHAVE_ADIADO_POR_JANELA = 'adiado_por_janela';

export interface AdiadoPorJanela {
  /** Qual janela o turno leu: `resposta` lê `resposta*` (0495), `disparo` lê `window*`. */
  tipo: 'resposta' | 'disparo';
  /** Instante para o qual o job foi adiado — a abertura calculada pelo motor. */
  abertura: string;
  /** Janela que causou o adiamento (`7h-22h`), para ler no log sem reconstruir. */
  janela: string;
}

/** Rastro a colar no payload do job ADIADO (vira `payloadPatch` do `rescheduleJob`). */
export function adiadoPorJanela(info: AdiadoPorJanela): Record<string, unknown> {
  return { [CHAVE_ADIADO_POR_JANELA]: info };
}

/**
 * Este payload é de um job adiado pela janela de RESPOSTA?
 *
 * `false` para qualquer coisa que não seja o objeto com `tipo: 'resposta'` —
 * job sem rastro (debounce de rajada, cap, saldo, sessão) e adiado pela janela
 * de DISPARO (retomada) continuam recebendo carona como sempre.
 */
export function adiadoPelaJanelaDeResposta(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const rastro = (payload as Record<string, unknown>)[CHAVE_ADIADO_POR_JANELA];
  if (rastro === null || typeof rastro !== 'object') return false;
  return (rastro as Record<string, unknown>).tipo === 'resposta';
}

/**
 * Predicado SQL comum aos DOIS acordamentos, literal para o teste travar:
 * pendente, futuro, não em hold (lição do #830) e com o rastro da janela de
 * resposta. `run_after > now()` é o que torna a chamada idempotente.
 */
const PREDICADO_ADIADO_PELA_JANELA_DE_RESPOSTA = `status = 'pending'
     and run_after > now()
     and not (payload ? 'held_run_after')
     and payload -> 'adiado_por_janela' ->> 'tipo' = 'resposta'`;

/**
 * A janela de RESPOSTA está aberta AGORA para esta conexão?
 *
 * Fail-closed por escrito: sem leitura (banco fora, pool ausente) devolve
 * `false`, que é exatamente o comportamento de hoje — o drain coalesce e o PUT
 * não acorda ninguém. Uma consulta que falha não pode decidir sozinha que a
 * janela abriu.
 */
export async function janelaDeRespostaAberta(
  db: Queryable,
  alvo: { organizationId: string; channelSessionId: string; agora?: Date; log?: Logger },
): Promise<boolean> {
  try {
    const { knobs } = await loadChannelKnobs(db, alvo.organizationId, alvo.channelSessionId, alvo.log);
    return janelaDeEnvioAberta(alvo.agora ?? new Date(), knobs, true);
  } catch (err) {
    alvo.log?.warn('adiados da janela: leitura da janela de resposta falhou — mantendo o comportamento de hoje', {
      organization_id: alvo.organizationId,
      channel_session_id: alvo.channelSessionId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return false;
  }
}

/**
 * Acorda UM job adiado pela janela de resposta (caminho do drain, quando ele
 * recusa a carona da rajada). Devolve `true` só quando a linha estava mesmo
 * pendente e futura — quem já rodou ou já foi acordado não volta a frente.
 */
export async function soltarAdiadoPelaJanela(db: Queryable, jobId: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `update job_queue
        set run_after = now()
      where id = $1
        and ${PREDICADO_ADIADO_PELA_JANELA_DE_RESPOSTA}
      returning id`,
    [jobId],
  );
  return rows.length > 0;
}

/**
 * Reavalia TODOS os turnos adiados de uma conexão depois que a janela de
 * resposta mudou (`PUT /api/v1/ai/pacing`) — a mudança não pode ser lida só no
 * próximo contato.
 *
 * Devolve quantos jobs foram soltos. `0` também significa "janela fechada:
 * ninguém mexe", que é o caso em que o adiamento de hoje continua valendo.
 */
export async function soltarAdiadosDaSessao(
  db: Queryable,
  alvo: { organizationId: string; channelSessionId: string; agora?: Date; log?: Logger },
): Promise<number> {
  const agora = alvo.agora ?? new Date();
  if (!(await janelaDeRespostaAberta(db, { ...alvo, agora }))) return 0;
  const { rowCount } = await db.query(
    `update job_queue
        set run_after = now()
      where organization_id = $1
        and payload ->> 'channel_session_id' = $2
        and ${PREDICADO_ADIADO_PELA_JANELA_DE_RESPOSTA}`,
    [alvo.organizationId, alvo.channelSessionId],
  );
  return rowCount ?? 0;
}
