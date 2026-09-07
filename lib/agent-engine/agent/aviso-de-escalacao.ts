import type {JobClaim} from "../queue/claim";
/**
 * O ENVIO do aviso de que a IA está saindo de campo — lado do MOTOR (`pg`).
 *
 * A frase mora em `lib/escalacao/aviso-ao-lead.ts` (uma só, para os dois mundos).
 * Aqui só o encanamento: resolver a disponibilidade real da equipe, montar o
 * corpo e mandá-lo pela MESMA cadeia de guardrails por onde passa tudo que sai
 * daqui — `runBeforeSend`. Nada sai por baixo dela (CLAUDE.md, princípio 2).
 *
 * ## É o irmão de `runDeterministicReentry`
 *
 * `lib/agent-engine/agent/followup-turn.ts` já envia texto escrito em CÓDIGO,
 * sem gastar modelo, atrás da cadeia. Este arquivo é a mesma figura para um
 * momento diferente: lá é a re-entrada, aqui é a saída.
 *
 * ## Duas escolhas de gate que precisam estar escritas
 *
 * 1. **`casesEnabled: false` de propósito.** O `casePromiseGate` existe para o
 *    lead nunca receber promessa-de-humano que o modelo inventou sem abrir caso.
 *    Este corpo promete um humano — e a promessa é VERDADEIRA por construção: a
 *    linha seguinte do chamador executa a passagem. Deixar o gate armado aqui o
 *    faria vetar exatamente a mensagem que ele existe para garantir, e o desfecho
 *    seria o silêncio que este arquivo veio acabar.
 * 2. **`seq: 0`.** O contrato do ledger é "posição da mensagem no turno (1..n)"
 *    (`ChannelSendInput.seq`), e o aviso não é uma mensagem do turno — é a
 *    despedida dele. `0` nunca colide com o `seq` que a tool `send_message`
 *    consome, então o replay pós-crash de um job continua deduplicando por
 *    `(job_id, seq)` sem que um aviso vire `already_sent` de uma fala do modelo
 *    (ou o contrário).
 *
 * ## O que acontece quando a cadeia VETA
 *
 * A passagem para humano acontece do mesmo jeito — quem pediu uma pessoa não
 * pode ficar preso ao automático porque a janela de envio fechou. Mas o desfecho
 * volta ao chamador para virar linha no aviso da Central: o atendente que abre a
 * conversa precisa saber se o cliente foi avisado ou está esperando no escuro.
 * Falhar fechado na AÇÃO, aberto na INFORMAÇÃO.
 */
import type pg from 'pg';

import { expectativaDeAtendimento } from '@/lib/escalacao/disponibilidade';
import { deriveLgpdFromContact } from '../guardrails/lgpd/legal-basis';
import { textoDoAviso, type MotivoDoAviso } from '@/lib/escalacao/aviso-ao-lead';

import type { ChannelAdapter } from '../channel-adapter';
import { runBeforeSend } from '../guardrails/before-send';
import type { LgpdInput } from '../guardrails/lgpd/legal-basis';
import type { Logger } from '../obs/logger';

/**
 * `seq` do aviso no ledger de envio. Ver o cabeçalho: o turno usa 1..n.
 */
export const SEQ_DO_AVISO = 0;

/** O que aconteceu com o aviso — vai ao log e ao aviso da Central, nunca ao lead. */
export type DesfechoDoAviso =
  | { avisado: true }
  /** A cadeia vetou (janela fechada, contato bloqueado, cap diário…) ou o canal não aceitou. */
  | { avisado: false; porque: string };

export interface AvisoDeEscalacaoIds {
  jobClaim?:JobClaim;
  tenantId: string;
  leadId: string;
  conversationId: string;
  channelSessionId: string;
  jobId: string;
}

export interface AvisoDeEscalacaoOpts {
  motivo: MotivoDoAviso;
  channel: ChannelAdapter;
  /** `contacts.is_blocked` lido no contexto deste turno (fonte confiável). */
  optedOutThisTurn: boolean;
  now: Date;
  log: Logger;
  lgpd?: LgpdInput;
  agentId?: string | null;
  disclosureMode?: 'inject' | 'veto';
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Avisa o lead de que uma pessoa vai assumir. NUNCA lança: um erro aqui não pode
 * impedir a passagem que ele antecede — o cliente sem aviso é ruim, o cliente
 * preso a um automático que já decidiu sair é pior.
 */
export async function avisarLeadDaEscalacao(
  pool: pg.Pool,
  ids: AvisoDeEscalacaoIds,
  opts: AvisoDeEscalacaoOpts,
): Promise<DesfechoDoAviso> {
  let body: string;
  try {
    const { quem } = await expectativaDeAtendimento(pool, ids.tenantId, opts.now);
    body = textoDoAviso(opts.motivo, quem, ids.leadId);
  } catch (err) {
    // `expectativaDeAtendimento` já tem rede própria; se ainda assim quebrar,
    // a frase conservadora (sem prazo) é a certa — nunca a ausência de frase.
    opts.log.warn('aviso de escalação: disponibilidade não lida, usando a frase conservadora', {
      error: err instanceof Error ? err.message.slice(0, 120) : 'erro desconhecido',
    });
    body = textoDoAviso(opts.motivo, null, ids.leadId);
  }

  try {
    const chain = await runBeforeSend({
      pool,
      log: opts.log,
      tenantId: ids.tenantId,
      leadId: ids.leadId,
      jobId: ids.jobId,
      channelSessionId: ids.channelSessionId,
      body,
      optedOutThisTurn: opts.optedOutThisTurn,
      // Ver `GateContext.spinningEnforced`: com o gate armado, a terceira pessoa
      // a ser escalada na mesma janela do número receberia silêncio — pelo
      // guardrail. Este é o ÚNICO chamador que o desarma.
      enforceSpinning: false,
      // Mesmo débito declarado no caminho do agente e no da re-entrada: o
      // daily_message_limit do CRM ainda não é lido no runtime.
      crmDailyLimit: null,
      now: opts.now,
      ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
      ...(opts.lgpd !== undefined ? { lgpd: opts.lgpd } : {}),
      ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
      ...(opts.disclosureMode !== undefined ? { disclosureMode: opts.disclosureMode } : {}),
      send: (finalBody) =>
        opts.channel.send({
          tenantId: ids.tenantId,
          leadId: ids.leadId,
          jobId: ids.jobId,
          jobClaim:ids.jobClaim,
          seq: SEQ_DO_AVISO,
          conversationId: ids.conversationId,
          body: finalBody,
        }),
    });

    if (chain.status === 'vetoed') {
      opts.log.info('aviso de escalação vetado pela cadeia — a passagem acontece assim mesmo', {
        code: chain.code,
      });
      return { avisado: false, porque: chain.code };
    }

    const outcome = chain.outcome;
    switch (outcome.kind) {
      case 'sent':
      case 'already_sent':
      case 'queued':
        // 'queued' = o canal aceitou e segura (sessão fora do ar) — está sob
        // custódia do CRM, então o cliente FOI avisado do ponto de vista de quem
        // decide; a entrega é problema do canal, com dono e watchdog próprios.
        opts.log.info('lead avisado antes da passagem para humano', { kind: outcome.kind });
        return { avisado: true };
      case 'blocked':
        return { avisado: false, porque: 'contato_bloqueado' };
      case 'failed':
        return { avisado: false, porque: 'canal_falhou' };
      case 'unavailable':
        return { avisado: false, porque: 'canal_indisponivel' };
    }
  } catch (err) {
    opts.log.warn('aviso de escalação falhou — a passagem acontece assim mesmo', {
      error: err instanceof Error ? err.message.slice(0, 200) : 'erro desconhecido',
    });
    return { avisado: false, porque: 'erro_no_envio' };
  }
}


/**
 * A mesma coisa, para quem NÃO tem o contexto do turno na mão.
 *
 * A escolta do orçamento (`comHandoffSeOrcamentoAcabar`) envolve o turno INTEIRO
 * — inclusive a leitura do contexto —, então quando ela precisa avisar, o
 * `getLeadContext` pode nem ter rodado. Em vez de deixar esse caminho sem os
 * insumos dos gates (o de LGPD viraria no-op, e um contato anonimizado receberia
 * mensagem), ele lê a linha do contato direto do banco. É UMA query, e só no
 * caminho de erro — o caminho feliz não paga nada por ela.
 */
export async function avisarLeadLendoOContato(
  pool: pg.Pool,
  ids: AvisoDeEscalacaoIds,
  opts: Omit<AvisoDeEscalacaoOpts, 'optedOutThisTurn' | 'lgpd'>,
): Promise<DesfechoDoAviso> {
  let optedOutThisTurn = false;
  let lgpd: LgpdInput | undefined;
  try {
    const { rows } = await pool.query<{
      is_blocked: boolean;
      is_anonymized: boolean;
      source: string | null;
      consent: Record<string, unknown> | null;
    }>(
      'select is_blocked, is_anonymized, source, consent from contacts where organization_id = $1 and id = $2',
      [ids.tenantId, ids.leadId],
    );
    const c = rows[0];
    if (c !== undefined) {
      optedOutThisTurn = c.is_blocked === true;
      // isProspecting=false: isto responde a alguém que JÁ está numa conversa —
      // mesma leitura de `get-lead-context.ts`.
      lgpd = deriveLgpdFromContact(
        { source: c.source, consent: c.consent, is_anonymized: c.is_anonymized },
        false,
      );
    }
  } catch (err) {
    // Sem a leitura, o `stopGate` ainda lê as travas DIRETO da fonte sob o lock
    // (`readStopFlags`) — o que se perde é só o gate de LGPD, e perder o aviso
    // inteiro por causa disso seria trocar um risco pequeno por um dano certo.
    opts.log.warn('aviso de escalação: contato não lido, seguindo com o que a cadeia lê sozinha', {
      error: err instanceof Error ? err.message.slice(0, 120) : 'erro desconhecido',
    });
  }
  return avisarLeadDaEscalacao(pool, ids, {
    ...opts,
    optedOutThisTurn,
    ...(lgpd !== undefined ? { lgpd } : {}),
  });
}
