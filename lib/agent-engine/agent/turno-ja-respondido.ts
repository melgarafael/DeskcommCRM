/**
 * A MESMA mensagem do cliente não recebe duas respostas do agente.
 *
 * ## O defeito (medido em produção, 2026-09-24)
 *
 * Turnos do mesmo contato são serializados (`uniq_job_queue_one_running_per_contact`)
 * e cada um leva 70–90 s. O cliente escreveu "Sim" (14:02:39) e o job A ficou na
 * fila atrás do turno anterior, só começando às 14:04:07. Às 14:04:04 o cliente
 * mandou "365,00 2x na semana": A leu a conversa inteira e respondeu ao 365
 * (14:04:26). O "365" tinha ganhado o PRÓPRIO job B — a coalescência do drain só
 * pega carona em job *pendente*, e A já estava *rodando*; o anti-backlog do drain
 * passou, porque o 365 era de fato a inbound mais nova. B rodou às 14:05:21,
 * respondeu à mensagem pinada no payload sem perguntar se alguém já tinha
 * respondido, e o cliente recebeu duas vezes "Perfeito… Com um plano de R$365…".
 *
 * ## A régua, e por que não é "tem outbound depois da inbound"
 *
 * "Existe resposta depois da última mensagem do cliente" cala o turno errado: um
 * turno que LEU a conversa antes de a mensagem chegar e ENVIOU depois deixa uma
 * outbound posterior a uma mensagem que ele nunca viu. Calar o turno dela seria
 * trocar a resposta dupla por silêncio — pior.
 *
 * A pergunta certa é "algum turno que VIU a última mensagem do cliente já
 * respondeu?". Para isso cada turno anota no próprio job, ANTES de ler a conversa,
 * o `created_at` da inbound mais nova já gravada (`ultima_inbound_vista_em`). Tudo o
 * que aquele `select` enxerga está commitado, então a leitura do contexto que vem
 * DEPOIS enxerga também — a anotação nunca promete mais do que o turno viu.
 *
 * "Respondeu" é `send_ledger` com envio aceito ou enfileirado pelo WhatsApp:
 * turno que viu a mensagem e decidiu não enviar (veto, handoff, erro) não conta,
 * e o turno seguinte responde normalmente. Só `inbound_turn` entra na régua —
 * follow-up de retomada não é resposta à pergunta do cliente.
 */
import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

export interface AlvoDoTurno {
  organizationId: string;
  contactId: string;
  conversationId: string;
  jobId: string;
}

/**
 * Anota no job a inbound mais nova visível AGORA — chamar antes de o turno ler
 * a conversa. Um statement: o `||` do jsonb não pisa em chave alheia do payload
 * (`held_run_after` do session-watchdog, por exemplo).
 */
export async function anotarUltimaInboundVista(db: Queryable, alvo: AlvoDoTurno): Promise<void> {
  await db.query(
    `update job_queue
        set payload = payload || jsonb_build_object(
          'ultima_inbound_vista_em',
          (select max(m.created_at) from messages m
            where m.organization_id = $1 and m.conversation_id = $2 and m.direction = 'inbound'))
      where organization_id = $1 and id = $3`,
    [alvo.organizationId, alvo.conversationId, alvo.jobId],
  );
}

/**
 * `true` quando OUTRO turno de resposta deste contato, nesta conversa, viu a
 * inbound mais nova do cliente e enviou resposta. Sem inbound na conversa, `false`.
 */
export async function ultimaInboundJaRespondida(
  db: Queryable,
  alvo: AlvoDoTurno,
): Promise<boolean> {
  const { rows } = await db.query<{ respondida: boolean }>(
    `with ultima as (
       select max(created_at) as em from messages
        where organization_id = $1 and conversation_id = $2 and direction = 'inbound'
     )
     select exists (
       select 1
         from send_ledger s
         join job_queue j on j.id = s.job_id and j.organization_id = s.organization_id
         join messages o on o.id = s.crm_message_id and o.organization_id = s.organization_id
         cross join ultima u
        where s.organization_id = $1
          and s.contact_id = $3
          and s.job_id <> $4
          and s.status in ('accepted', 'queued')
          and j.kind = 'inbound_turn'
          and o.conversation_id = $2
          and u.em is not null
          and (j.payload->>'ultima_inbound_vista_em')::timestamptz >= u.em
     ) as respondida`,
    [alvo.organizationId, alvo.conversationId, alvo.contactId, alvo.jobId],
  );
  return rows[0]?.respondida === true;
}

/**
 * RESPOSTA OBSOLETA — o cliente escreveu de novo enquanto este turno pensava.
 *
 * ## O defeito (medido numa VPS, 17–25/09/2026)
 *
 * 39% das respostas de um agente de oficina (232 de 589) saíram a menos de 3
 * minutos de outra resposta ao mesmo cliente. O caso típico: "Oi" / "Boa tarde"
 * / "Tudo bem?" com 4–5 s entre si, e a pergunta real 20 s depois. O turno lê a
 * conversa no começo, leva 10–40 s no modelo e envia "Como posso te ajudar?" —
 * com a pergunta já na conversa. O turno seguinte, que viu a pergunta, responde
 * de novo. `ultimaInboundJaRespondida` (acima) não cala esse segundo turno, e
 * está certo: o primeiro nunca viu a pergunta. O defeito está no PRIMEIRO envio,
 * que sai desatualizado.
 *
 * ## A régua
 *
 * A inbound mais nova da conversa foi gravada DEPOIS de `ultima_inbound_vista_em`
 * (a anotação que o turno fez antes de ler a conversa)? Então a resposta foi
 * escrita sem ela, e a mensagem nova tem job próprio, que lê a conversa inteira
 * e responde a tudo de uma vez. Este turno não envia.
 *
 * "Mais nova" é pela MESMA ordem do anti-backlog do drain
 * (`coalesce(sent_at, created_at)`, o relógio do aparelho): é o drain quem
 * decide qual mensagem ganha turno. Uma mensagem reentregue com atraso (webhook
 * que voltou 503, replay) chega DEPOIS da anotação com relógio ANTERIOR ao da
 * última lida; o drain pula o evento dela como superado, e descartar a resposta
 * por causa dela deixaria o cliente sem ninguém respondendo.
 *
 * ## O teto
 *
 * Um cliente que escreve sem parar faria todo turno ficar obsoleto antes de
 * enviar. Por isso a régua só vale enquanto a mensagem mais antiga sem resposta
 * (desde a última outbound) tem menos de `tetoMs`: passado o teto, a resposta
 * sai mesmo desatualizada — uma resposta atrasada é ruim, silêncio é pior.
 * `tetoMs <= 0` desliga.
 */
export async function respostaFicouObsoleta(
  db: Queryable,
  alvo: Pick<AlvoDoTurno, 'organizationId' | 'conversationId' | 'jobId'>,
  tetoMs: number,
): Promise<boolean> {
  if (!(tetoMs > 0)) return false;
  const { rows } = await db.query<{ obsoleta: boolean }>(
    `with vista as (
       select (payload->>'ultima_inbound_vista_em')::timestamptz as em
         from job_queue where organization_id = $1 and id = $3
     ),
     ultima_out as (
       select max(created_at) as em from messages
        where organization_id = $1 and conversation_id = $2 and direction = 'outbound'
     ),
     pendente as (
       select min(m.created_at) as em from messages m cross join ultima_out o
        where m.organization_id = $1 and m.conversation_id = $2 and m.direction = 'inbound'
          and (o.em is null or m.created_at > o.em)
     ),
     mais_nova as (
       select created_at as em from messages
        where organization_id = $1 and conversation_id = $2 and direction = 'inbound'
        order by coalesce(sent_at, created_at) desc, created_at desc, id desc
        limit 1
     )
     select coalesce((select m.em > v.em from mais_nova m cross join vista v), false)
            and coalesce((select em from pendente) > now() - ($4 * interval '1 millisecond'), false)
            as obsoleta`,
    [alvo.organizationId, alvo.conversationId, alvo.jobId, tetoMs],
  );
  return rows[0]?.obsoleta === true;
}
