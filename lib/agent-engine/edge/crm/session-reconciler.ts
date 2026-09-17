/**
 * Watchdog de sessão (Fase 4A-2) — o pedaço do Vendaval que ficou de fora do
 * porte e cuja falta causou o incidente real das mensagens presas: o webhook
 * session.status se perde num restart e o espelho `channel_sessions` diverge do
 * WAHA real; como o envio exige WORKING no espelho, respostas ficam `queued`
 * para sempre.
 *
 * Três deveres, um tick:
 *   1. RECONCILIADOR: lê o status REAL das sessões na API do WAHA e corrige o
 *      espelho quando divergir (a fonte da verdade do status é o WAHA);
 *   2. RETOMA: sessão STOPPED que ainda é nossa (não arquivada) volta a subir.
 *      Restart de container, OOM e sono do Docker deixam a credencial no disco
 *      e a sessão parada — o envio exige WORKING, então inbound e auto-resposta
 *      morrem até alguém clicar Reconectar. FAILED não entra: pode ser banimento,
 *      e religar sozinho piora; SCAN_QR_CODE também não — tem gente no celular.
 *   3. REDRIVE: mensagens `sent_via='ai'` presas em `queued` cuja sessão está
 *      WORKING são reenviadas pelo WAHA (com espaçamento anti-rajada) e marcadas
 *      `sent`. Só linhas ainda `queued` entram, então nada é reenviado duas vezes
 *      pelo mesmo caminho — e, desde 14/09/2026, o eco da mensagem reenviada não
 *      fica duplicado na conversa nem prende a mensagem em `queued` (ver
 *      `markRedriveSent` e `removeRedriveEcho`). Antes esta linha dizia "nunca
 *      duplicadas", e o eco provava o contrário.
 *
 * Regra dura nº 4 respeitada: message-plane nunca fala com o WAHA — este módulo
 * é o WATCHDOG (admin-plane), o único lugar do engine autorizado a falar com o
 * WAHA diretamente (o envio normal segue via sendMessageHandler).
 */
import type pg from 'pg';

import { parseWahaMessageId, wahaEchoExternalIds } from '@/lib/waha/message-id';
import { lerNumerosDeTeste, numeroPodeTestar, preGoLiveAtivo } from '@/lib/ai/elegibilidade/pre-go-live';

import type { Logger } from '../../obs/logger';

export interface WatchdogConfig {
  wahaBaseUrl: string;
  wahaApiKey: string;
  /** intervalo do tick (knob WATCHDOG_INTERVAL_MS) */
  intervalMs: number;
  /** idade mínima de uma queued para redrive — evita corrida com o insert do handler */
  redriveMinAgeMs: number;
  /** teto de redrives por tick (anti-rajada) */
  redriveBatchSize: number;
  /** espaçamento entre redrives (base + jitter) */
  redriveSpacingMs: number;
}

interface WahaSession {
  name: string;
  status: string;
}

/**
 * Só STOPPED: a credencial no disco ainda vale e o start a reaproveita.
 * FAILED pode ser banimento — religar sozinho é o que o vigia de saúde recusa.
 * SCAN_QR_CODE tem alguém no celular; STARTING já está subindo.
 */
export function deveRetomarSessao(status: string): boolean {
  return status.toUpperCase() === 'STOPPED';
}

async function startWahaSession(cfg: WatchdogConfig, name: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${cfg.wahaBaseUrl}/api/sessions/${encodeURIComponent(name)}/start`,
      {
        method: 'POST',
        headers: { 'X-Api-Key': cfg.wahaApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15_000),
      },
    );
    // 422/409 = já está subindo ou WORKING — o efeito que queremos.
    return res.ok || res.status === 422 || res.status === 409;
  } catch {
    return false;
  }
}

async function fetchWahaSessions(cfg: WatchdogConfig): Promise<WahaSession[] | null> {
  try {
    const res = await fetch(`${cfg.wahaBaseUrl}/api/sessions?all=true`, {
      headers: { 'X-Api-Key': cfg.wahaApiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as WahaSession[];
    return Array.isArray(data) ? data : null;
  } catch {
    return null; // WAHA fora: tick pula (transiente) — nunca derruba o worker
  }
}

/** Corrige o espelho channel_sessions para o status REAL do WAHA e retoma STOPPED. */
export async function reconcileSessions(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
): Promise<number> {
  const sessions = await fetchWahaSessions(cfg);
  if (sessions === null) {
    log.warn('watchdog: WAHA indisponível — tick de reconciliação pulado', {});
    return 0;
  }
  let fixed = 0;
  for (const s of sessions) {
    const wahaStatus = (s.status ?? '').toUpperCase();
    // Arquivada não é nossa: a exclusão desloga o aparelho. Uma sessão STOPPED
    // órfã no transporte não pode voltar a receber mensagem num canal que a UI
    // já não mostra.
    const { rows: nossas } = await pool.query<{ id: string; status: string }>(
      // `to_jsonb(cs) ->> 'archived_at'` em vez de `cs.archived_at`, como em
      // `agent/followup-turn.ts:254` e pelo mesmo motivo: a coluna nasce na
      // migration 0106 e, num clone que subiu o código sem aplicá-la,
      // referenciá-la direto derruba o tick INTEIRO com 42703 — levando junto o
      // redrive das mensagens em fila, que roda depois desta função.
      `select cs.id, cs.status from channel_sessions cs
       where cs.waha_session_name = $1 and to_jsonb(cs) ->> 'archived_at' is null`,
      [s.name],
    );
    if (nossas.length === 0) continue;

    let nextStatus = wahaStatus;
    if (deveRetomarSessao(wahaStatus)) {
      const started = await startWahaSession(cfg, s.name);
      if (started) {
        nextStatus = 'STARTING';
        // O info sai só quando o espelho REALMENTE muda (logo abaixo, no
        // `returning`). Aqui ele sairia a cada tick de 60 s enquanto a sessão
        // continuasse parada — 1440 linhas por dia repetindo a mesma boa
        // notícia é o caminho mais curto para o operador parar de ler o log.
      }
    }

    const { rows } = await pool.query<{ id: string; status: string }>(
      `update channel_sessions
          set status = $2, updated_at = now()
        where waha_session_name = $1
          and to_jsonb(channel_sessions) ->> 'archived_at' is null
          and status is distinct from $2
       returning id, status`,
      [s.name, nextStatus],
    );
    for (const row of rows) {
      fixed += 1;
      log.warn('watchdog: espelho de sessão reconciliado com o WAHA real', {
        channel_session_id: row.id,
        waha_session: s.name,
        status: nextStatus,
      });
    }
  }
  return fixed;
}

interface QueuedRow {
  id: string;
  organization_id: string;
  /** A limpeza do eco só procura na conversa da própria mensagem. */
  conversation_id: string;
  body: string | null;
  waha_session_name: string;
  wa_identity: string | null;
  wa_lid: string | null;
  phone_number: string | null;
  is_group: boolean;
  group_chat_id: string | null;
}

/**
 * chatId do WAHA a partir da identidade do contato — MESMA REGRA de
 * `resolveWahaChatId` (lib/waha/send.ts), e as duas precisam continuar iguais:
 * este caminho reenvia o que aquele deixou preso, e divergir aqui faria o
 * redrive mandar a mensagem para um endereço diferente do envio original.
 *
 * `wa_lid` na frente pelo motivo da 0122: `wa_identity` é GERADA com o telefone
 * antes do lid, então o contato @lid que ganhou número passa a bater na linha do
 * `phone:` e a conversa mudaria de canal no reenvio.
 */
function chatIdOf(m: QueuedRow): string | null {
  if (m.is_group && m.group_chat_id) return m.group_chat_id;
  if (m.wa_lid) return `${m.wa_lid}@lid`;
  if (m.wa_identity?.startsWith('lid:')) return `${m.wa_identity.slice(4)}@lid`;
  if (m.wa_identity?.startsWith('phone:+')) return `${m.wa_identity.slice(7)}@c.us`;
  if (m.phone_number) return `${m.phone_number.replace('+', '')}@c.us`;
  return null;
}

/**
 * Marca `sent` a mensagem que o WAHA acabou de aceitar.
 *
 * Devolve `true` quando o id NÃO pôde ser gravado porque o eco dela já o ocupa.
 * No WEBJS o eco grava o `_serialized`, exatamente a string que o envio devolve,
 * e o unique `(organization_id, external_id)` recusa uma segunda linha com o
 * mesmo id. Antes, essa recusa caía no `catch` do laço como "erro transiente —
 * mantida queued", e o cliente recebia a mesma mensagem de novo a cada tick — a
 * armadilha medida na issue #196 do DeskcommCRM. Aqui a mensagem sai `sent` sem
 * o id, e quem o grava é `stampExternalIdAfterEcho`, depois que o eco sai.
 *
 * Qualquer outro erro sobe como antes: sem conseguir escrever no banco, não há
 * como marcar nada daqui.
 */
async function markRedriveSent(
  pool: pg.Pool,
  m: QueuedRow,
  externalId: string | null,
): Promise<boolean> {
  try {
    await pool.query(
      `update messages
       set status = 'sent', ack = 0,
           external_id = coalesce($2, external_id),
           metadata = metadata || '{"redrive":"watchdog"}'::jsonb
       where id = $1 and organization_id = $3 and status = 'queued'`,
      [m.id, externalId, m.organization_id],
    );
    return false;
  } catch (err) {
    if ((err as { code?: unknown }).code !== '23505') throw err;
    await pool.query(
      `update messages
       set status = 'sent', ack = 0,
           metadata = metadata || '{"redrive":"watchdog"}'::jsonb
       where id = $1 and organization_id = $2 and status = 'queued'`,
      [m.id, m.organization_id],
    );
    return true;
  }
}

/**
 * Apaga a linha que o webhook criou para o eco desta mensagem reenviada.
 *
 * O escopo é o mesmo, e deliberadamente estreito, da limpeza do envio normal:
 * mesma organização, mesma conversa, só o que veio do celular
 * (`external_device`) e nunca a própria linha. O id cru do WhatsApp pode colidir
 * entre mensagens diferentes; restringir à conversa mantém o estrago de uma
 * colisão no único lugar onde ela seria de fato esta mensagem.
 *
 * BLINDADO: a mensagem já saiu e já está `sent`. Não conseguir apagar deixa a
 * duplicata na tela, que é o mundo de antes desta função — deixar a exceção
 * subir faria o laço registrar como falha uma entrega que deu certo.
 */
async function removeRedriveEcho(
  pool: pg.Pool,
  m: QueuedRow,
  externalId: string,
  chatId: string,
  log: Logger,
): Promise<void> {
  try {
    await pool.query(
      `delete from messages
       where organization_id = $1
         and conversation_id = $2
         and sent_via = 'external_device'
         and external_id = any($3::text[])
         and id <> $4`,
      [m.organization_id, m.conversation_id, wahaEchoExternalIds(externalId, chatId), m.id],
    );
  } catch (err) {
    log.warn('watchdog: não consegui remover o eco da mensagem reenviada', {
      message_id: m.id,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}

/**
 * Grava o id que o eco ocupava, agora que o eco saiu.
 *
 * Sem o id, o `message.ack` do webhook nunca encontra a linha e a mensagem trava
 * em `sent`: sem entregue, sem lida. `external_id is null` garante que isto nunca
 * sobrescreve um id que outro caminho já gravou.
 *
 * BLINDADO pelo mesmo motivo de `removeRedriveEcho`. Se o eco não saiu (a remoção
 * falhou), o unique recusa de novo e a mensagem fica `sent` sem id: sem ack e com
 * a duplicata na tela — mas sem reenvio.
 */
async function stampExternalIdAfterEcho(
  pool: pg.Pool,
  m: QueuedRow,
  externalId: string,
  log: Logger,
): Promise<void> {
  try {
    await pool.query(
      `update messages set external_id = $2
       where id = $1 and organization_id = $3 and external_id is null`,
      [m.id, externalId, m.organization_id],
    );
  } catch (err) {
    log.warn('watchdog: mensagem reenviada ficou sem id — o eco ainda o ocupa', {
      message_id: m.id,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}

/** Reenvia mensagens AI presas em queued com sessão WORKING. */
export async function redriveQueued(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
): Promise<number> {
  const { rows } = await pool.query<QueuedRow>(
    `select m.id, m.organization_id, m.conversation_id, m.body, s.waha_session_name,
            c.wa_identity, c.wa_lid, c.phone_number, v.is_group, v.group_chat_id
     from messages m
     join channel_sessions s on s.id = m.channel_session_id and s.organization_id = m.organization_id
     join conversations v on v.id = m.conversation_id and v.organization_id = m.organization_id
     join contacts c on c.id = m.contact_id and c.organization_id = m.organization_id
     where m.sent_via = 'ai' and m.status = 'queued'
       and s.status = 'WORKING'
       and c.is_blocked = false
       -- ─── Só as sessões que ESTE resgate consegue alcançar ───────────────
       --
       -- Este worker fala um transporte só, direto, e não resolve adapter: ele
       -- e processo separado, com pg cru, sem o seam. Sem este filtro a
       -- consulta trazia mensagem de QUALQUER canal e postava com
       -- session nula — a coluna e nula fora deste transporte. Na melhor
       -- hipótese o provedor recusa e a mensagem fica presa para sempre com um
       -- warn por tique; na pior, um envio sai pelo número errado.
       --
       -- Deixar de fora NÃO é resolver: é parar de fazer a coisa errada. Quem
       -- conta as que ficaram sem resgate é o bloco logo abaixo — silêncio aqui
       -- é o que fez este defeito durar.
       and s.waha_session_name is not null
       and m.created_at < now() - make_interval(secs => $1 / 1000.0)
     order by m.created_at
     limit $2`,
    [cfg.redriveMinAgeMs, cfg.redriveBatchSize],
  );

  // As que este resgate NÃO alcança. Não são reenviadas daqui — enviar em dobro
  // é pior que não enviar, e este processo não tem como saber se o outro
  // caminho já mandou. O que elas não podem continuar sendo é INVISÍVEIS.
  const { rows: foraDoAlcance } = await pool.query<{ n: string }>(
    `select count(*)::text as n
     from messages m
     join channel_sessions s on s.id = m.channel_session_id
     where m.sent_via = 'ai' and m.status = 'queued'
       and s.status = 'WORKING'
       and s.waha_session_name is null
       and m.created_at < now() - make_interval(secs => $1 / 1000.0)`,
    [cfg.redriveMinAgeMs],
  );
  const presas = Number(foraDoAlcance[0]?.n ?? '0');
  if (presas > 0) {
    log.warn('watchdog: mensagens presas em canal que este resgate não alcança', {
      quantidade: presas,
    });
  }

  let sent = 0;
  for (const m of rows) {
    const chatId = chatIdOf(m);
    if (chatId === null || m.body === null) {
      log.warn('watchdog: queued sem destino/corpo — pulada', { message_id: m.id });
      continue;
    }
    // `jaSaiu` separa os dois desfechos que o `catch` de baixo confundia: a
    // mensagem que nunca saiu (reenviar é certo) e a que JÁ chegou ao cliente
    // (reenviar é mandar duas vezes). Declarado FORA do `try` porque é lá que o
    // `catch` o lê — dentro, ele não existiria para o tratamento do erro, e foi
    // exatamente isso que o `pnpm typecheck` pegou na primeira versão deste
    // conserto (TS2304: Cannot find name 'jaSaiu').
    let jaSaiu = false;
    try {
      // A lista pode mudar enquanto a mensagem espera ou entre itens do lote.
      // Este redrive fala direto com o WAHA, portanto também precisa da guarda
      // do sink. Falha de leitura cai no catch e NÃO envia.
      const { rows: acesso } = await pool.query<{ metadata: unknown; phone_number: string | null }>(
        `select s.metadata, c.phone_number
         from messages m
         join channel_sessions s on s.id = m.channel_session_id and s.organization_id = m.organization_id
         join contacts c on c.id = m.contact_id and c.organization_id = m.organization_id
         where m.id = $1 and m.organization_id = $2 and m.status = 'queued'`,
        [m.id, m.organization_id],
      );
      const atual = acesso[0];
      if (!atual) continue;
      if (preGoLiveAtivo(atual.metadata) && !numeroPodeTestar(atual.phone_number ?? '', lerNumerosDeTeste(atual.metadata))) {
        await pool.query(
          `update messages set status = 'failed', error_code = 'pre_go_live',
             error_message = 'Envio automático bloqueado pelo modo de teste do canal.'
           where id = $1 and organization_id = $2 and status = 'queued'`,
          [m.id, m.organization_id],
        );
        log.info('watchdog: reenvio bloqueado pelo modo de teste', { message_id: m.id });
        continue;
      }
      const res = await fetch(`${cfg.wahaBaseUrl}/api/sendText`, {
        method: 'POST',
        headers: { 'X-Api-Key': cfg.wahaApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: m.waha_session_name, chatId, text: m.body }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        log.warn('watchdog: redrive falhou no WAHA — mantida queued para o próximo tick', {
          message_id: m.id,
          status_code: res.status,
        });
        continue;
      }
      jaSaiu = true;
      const data = (await res.json().catch(() => null)) as unknown;
      const externalId = parseWahaMessageId(data);
      // Daqui em diante a mensagem JÁ SAIU para o cliente. Devolvê-la a `queued`
      // é o pior desfecho possível: o `catch` de baixo a trata como falha
      // transiente e o próximo tick a manda de novo — a cada tick, sem limite.
      const idTakenByEcho = await markRedriveSent(pool, m, externalId);
      if (externalId !== null) {
        // O eco desta mensagem pode ter chegado pelo webhook ANTES de a linha
        // acima gravar o id: não casou com nada e virou uma segunda linha com a
        // mesma frase. Mesma limpeza que o envio normal faz
        // (`removerEcoDoProprioEnvio` em `app/api/v1/messages/_handler.ts`), com
        // a mesma lista de ids.
        await removeRedriveEcho(pool, m, externalId, chatId, log);
        if (idTakenByEcho) await stampExternalIdAfterEcho(pool, m, externalId, log);
      }
      sent += 1;
      log.info('watchdog: mensagem presa reenviada', { message_id: m.id, has_external_id: externalId !== null });
    } catch (err) {
      const erro = (err instanceof Error ? err.message : String(err)).slice(0, 120);
      if (jaSaiu) {
        // O comentário acima promete que a mensagem que já saiu não volta para
        // `queued`. A promessa vale para o `23505` (tratado em
        // `markRedriveSent`) e NÃO vale para qualquer outra falha de banco: ali
        // a linha continua `queued` e o próximo tick reenvia ao cliente uma
        // mensagem que ele já recebeu. Não há como consertar daqui — se o banco
        // não aceita escrita, nenhuma marcação passa —, então o mínimo honesto é
        // não chamar isso de transiente e dizer, no nível certo, o que está em
        // risco.
        log.error('watchdog: a mensagem SAIU para o cliente e o banco não registrou — o próximo tick pode reenviar', {
          message_id: m.id,
          error: erro,
        });
      } else {
        log.warn('watchdog: redrive com erro transiente — mantida queued', {
          message_id: m.id,
          error: erro,
        });
      }
    }
    // espaçamento anti-rajada entre reenvios
    await new Promise((r) => setTimeout(r, cfg.redriveSpacingMs + Math.random() * cfg.redriveSpacingMs));
  }
  return sent;
}

/** Loop do watchdog — reconcilia e redrive a cada tick; erro nunca derruba o worker. */
export async function runSessionWatchdogLoop(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const fixed = await reconcileSessions(pool, cfg, log);
      const redriven = await redriveQueued(pool, cfg, log);
      if (fixed + redriven > 0) {
        log.info('watchdog: tick com ação', { reconciled: fixed, redriven });
      }
    } catch (err) {
      log.error('watchdog: tick falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, cfg.intervalMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
