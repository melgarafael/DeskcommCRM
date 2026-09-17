/**
 * Ponte de eventos WaCalls → Postgres — spec docs/specs/18-spec-voice-calls-wacalls.md §4.2.
 *
 * Mantém 1 conexão SSE persistente contra `${WACALLS_API_BASE_URL}/api/events`
 * (processo do WORKER, não trigger de banco — doutrina "trigger nunca faz
 * HTTP" não se aplica aqui, é o inverso: HTTP alimentando o banco). Reconecta
 * com backoff se cair (anti-morte, §6 da spec).
 *
 * Eventos medidos no código-fonte upstream (cmd/server/broker.go, commit
 * edeb31f): `call-status` é o upsert canônico pras DUAS direções — uma
 * chamada inbound dispara `call-status` (ringing) E `incoming` no mesmo
 * instante (session.go:60-64, mesmo OnIncoming), então `incoming` não
 * precisa gravar nada sozinho: só relaya pro frontend tocar o toque (§5.2).
 */
import type pg from 'pg';

import { phoneLookupVariants } from '@/lib/channels/phone-variants';
import { emitAgentActivityForContact } from '@/lib/leads/agent-activity';
import { motivoDaChamadaEmPortugues } from '@/lib/wacalls/motivo-da-chamada';

import type { Logger } from '../agent-engine/obs/logger';

export interface WacallsBridgeConfig {
  baseUrl: string;
  apiToken: string;
  /** Backoff de reconexão da SSE (ms) — sobe até este teto. */
  maxBackoffMs: number;
}

export interface WacallsSessionMap {
  channelSessionId: string;
  organizationId: string;
}

/**
 * Enquanto a ligação está de pé, a IA não fala naquela conversa.
 *
 * Reaproveita o mecanismo que já existe para "um humano assumiu"
 * (`conversations.bot_silenced_until`), lido por `isLeadInHandoff`
 * (`lib/agent-engine/agent/human-handoff.ts`) e pelo gate de elegibilidade
 * (`lib/ai/elegibilidade/gate.ts`) antes de qualquer chamada de modelo. É o
 * mesmo raciocínio de `lib/escalacao/atendimento-manual.ts`: uma pessoa está
 * falando com o cliente AGORA, e o agente respondendo por cima é o pior
 * atropelo que o produto pode cometer.
 *
 * NÃO mexe em `assignee_kind`: aquele CHECK exige `assigned_to_user_id`, e quem
 * atende do aparelho pareado não é necessariamente usuário do CRM. NÃO mexe em
 * `contacts.force_human`: aquilo tranca o contato inteiro, e uma ligação não é
 * um bloqueio.
 */
const MOTIVO_DO_SILENCIO = 'Ligação de voz em andamento';

/**
 * Teto do silêncio — anti-morte, não estimativa de duração.
 *
 * `'infinity'` seria o valor "certo" enquanto a ligação vive, e é exatamente o
 * que não pode ser usado: se o worker cair entre o `connected` e o `call-ended`
 * (os dois vêm da MESMA stream SSE, então os dois se perdem juntos), a conversa
 * ficaria muda para sempre e ninguém saberia por quê. Com teto, o pior caso é
 * a IA calada por duas horas — e o `call-ended`, quando chega, devolve a voz na
 * hora.
 */
const TETO_DO_SILENCIO = "now() + interval '2 hours'";

/** A conversa 1:1 mais recente do contato — a mesma regra de `fn_service_observe`. */
const CONVERSA_DO_CONTATO = `
  select id from conversations
   where organization_id = $1 and contact_id = $2 and not is_group
   order by last_message_at desc nulls last, created_at desc
   limit 1`;

async function calarIaDuranteALigacao(
  pool: pg.Pool,
  organizationId: string,
  contactId: string,
): Promise<void> {
  await pool.query(
    `update conversations
        set bot_silenced_until = ${TETO_DO_SILENCIO},
            last_handoff_at = now(),
            last_handoff_reason = $3,
            updated_at = now()
      where id = (${CONVERSA_DO_CONTATO})
        -- NUNCA ENCURTA. Um handoff humano durável (infinity) vence este
        -- teto, e escrever por cima devolveria à IA uma conversa que uma pessoa
        -- tinha tomado para si de propósito. Mesma regra de atendimento-manual.
        and (bot_silenced_until is null or bot_silenced_until < ${TETO_DO_SILENCIO})`,
    [organizationId, contactId, MOTIVO_DO_SILENCIO],
  );
}

async function devolverAVozDaIa(
  pool: pg.Pool,
  organizationId: string,
  contactId: string,
): Promise<void> {
  await pool.query(
    // Só desfaz o que ESTA ponte fez. Sem o predicado do motivo, desligar o
    // telefone devolveria à IA uma conversa que um atendente tinha assumido no
    // meio da ligação — silêncio de outro dono, apagado por engano.
    `update conversations
        set bot_silenced_until = null,
            last_handoff_at = null,
            last_handoff_reason = null,
            updated_at = now()
      where organization_id = $1 and contact_id = $2 and last_handoff_reason = $3`,
    [organizationId, contactId, MOTIVO_DO_SILENCIO],
  );
}

/**
 * O `owner` que o upstream devolve é o `X-Client-Id` que NÓS mandamos ao iniciar
 * ou aceitar a chamada — sempre o `auth.users.id` da sessão autenticada
 * (`lib/wacalls/client.ts`). Mas o campo é texto livre do ponto de vista do
 * WaCalls: uma chamada atendida no próprio aparelho pareado traz outra coisa, e
 * gravar isso numa coluna com FK para `auth.users` derrubaria a escrita inteira.
 * Só passa o que tem forma de uuid.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function donoValido(owner: unknown): string | null {
  return typeof owner === 'string' && UUID.test(owner) ? owner : null;
}

/**
 * O contato do número que ligou ou foi ligado — pelas DUAS grafias do celular.
 *
 * O peer vem do WhatsApp, e o WhatsApp registra muito celular brasileiro SEM o
 * nono dígito (`553198966398`); o cadastro guarda COM (`+5531998966398`,
 * `lib/channels/phone-variants.ts`). Casar só `'+' || peer` achava o contato
 * por acaso enquanto a ligação era discada para o endereço errado; com o
 * destino certo (`lib/voice/numero-discavel.ts`) deixaria de achar, e toda
 * ligação desse contato nasceria sem ele. `$1` = organização, `$2` = peer em
 * dígitos (compara com `wa_lid`), `$3` = `phoneLookupVariants(peer)`. A grafia
 * idêntica ao peer vence, para dois cadastros duplicados não sortearem.
 */
const CONTATO_DO_PEER = (org: string, peer: string, variantes: string) => `
  (select id from contacts
    where organization_id = ${org}
      and (phone_number = any(${variantes}::text[]) or wa_lid = ${peer})
      and is_merged_into is null
    order by (phone_number = '+' || ${peer}) desc
    limit 1)`;

/** `5511999999999@s.whatsapp.net` → `5511999999999`. JID sem o domínio. */
function peerToPhone(jid: string): string {
  return jid.split('@')[0] ?? jid;
}

async function resolveSession(
  pool: pg.Pool,
  cache: Map<string, WacallsSessionMap>,
  wacallsSessionId: string,
): Promise<WacallsSessionMap | null> {
  const cached = cache.get(wacallsSessionId);
  if (cached) return cached;
  const { rows } = await pool.query<{ id: string; organization_id: string }>(
    `select id, organization_id from channel_sessions
      where provider = 'wacalls' and wacalls_session_id = $1
        and archived_at is null`,
    [wacallsSessionId],
  );
  const row = rows[0];
  if (!row) return null;
  const mapped = { channelSessionId: row.id, organizationId: row.organization_id };
  cache.set(wacallsSessionId, mapped);
  return mapped;
}

async function handleAuthState(
  pool: pg.Pool,
  sess: WacallsSessionMap,
  ev: { paired: boolean; state: string; qr?: string },
  log: Logger,
): Promise<void> {
  if (!ev.paired) {
    // O APARELHO FOI DESVINCULADO — pelo celular (WhatsApp › Aparelhos
    // conectados), por `Logout`, ou por o WhatsApp ter derrubado o vínculo.
    // O upstream emite `auth-state {state:"logged_out", paired:false}` e esta
    // ponte ignorava: `wacalls_paired_at` ficava preenchido para sempre, a tela
    // seguia dizendo "pareado", o botão "Chamar" continuava oferecido para uma
    // sessão sem aparelho, e parear de novo recebia 409 `voice_already_paired`
    // (`app/api/v1/voice/sessions/pair/route.ts`) — um beco sem saída.
    //
    // SÓ `logged_out`. Durante o pareamento o upstream emite `paired:false` com
    // `state:"qr"` a cada código novo, e isso não desfaz nada. A guarda
    // `wacalls_paired_at is not null` torna o QR vencido de uma sessão que
    // nunca pareou (também `logged_out`) um no-op.
    if (ev.state !== 'logged_out') return;
    const { rowCount } = await pool.query(
      `update channel_sessions
          set wacalls_paired_at = null,
              status = 'STOPPED',
              last_status_change_at = now(),
              updated_at = now()
        where id = $1 and wacalls_paired_at is not null`,
      [sess.channelSessionId],
    );
    if (rowCount) {
      log.warn('wacalls: aparelho de voz desvinculado', { channel_session_id: sess.channelSessionId });
    }
    return;
  }
  //
  // A guarda era `wacalls_paired_at is distinct from now()`, e o comentário
  // dizia que isso evitava reescrever a cada heartbeat. Não evitava nada:
  // `now()` é sempre distinto de qualquer valor gravado antes, inclusive de si
  // mesmo em outra transação. Cada `auth-state` do WaCalls — que chegam de
  // minuto em minuto enquanto a sessão vive — reescrevia a linha e logava
  // "sessão pareada" de novo, com o log dizendo o oposto do que acontecia.
  //
  // A guarda que funciona é a que pergunta o que MUDA: primeiro pareamento
  // (`antes is null`) ou volta ao ar depois de uma queda (`status` diferente de
  // WORKING). Heartbeat de sessão já pareada e já WORKING casa zero linhas.
  const { rows } = await pool.query<{ primeiro: boolean }>(
    `update channel_sessions c
        set wacalls_paired_at = coalesce(c.wacalls_paired_at, now()),
            status = 'WORKING',
            updated_at = now()
       from (select id, wacalls_paired_at as antes from channel_sessions where id = $1) o
      where c.id = o.id
        and (o.antes is null or c.status is distinct from 'WORKING')
     returning (o.antes is null) as primeiro`,
    [sess.channelSessionId],
  );
  if (rows[0]?.primeiro) {
    log.info('wacalls: sessão pareada', { channel_session_id: sess.channelSessionId });
  } else if (rows.length > 0) {
    log.info('wacalls: sessão de voz voltou ao ar', {
      channel_session_id: sess.channelSessionId,
    });
  }
}

async function handleCallStatus(
  pool: pg.Pool,
  sess: WacallsSessionMap,
  ev: {
    id: string;
    status: string;
    peer: string;
    direction?: string;
    startedAt: number;
    owner?: unknown;
  },
  log: Logger,
): Promise<void> {
  const peerPhone = peerToPhone(ev.peer);
  // Quem está na linha. O upstream manda em TODO `call-status`; a versão
  // anterior desta ponte descartava, e o resultado era uma ligação sem dono:
  // qualquer colega da organização desligava a chamada de qualquer outro, a
  // linha do tempo dizia "Sistema", e o painel de chamada em andamento
  // aparecia para o escritório inteiro.
  const dono = donoValido(ev.owner);
  // O SENTIDO NÃO VEM NO EVENTO. `call-status` sai do broker com
  // `type, sessionId, id, owner, status, peer, startedAt, peerName,
  // peerPhotoUrl` — sem `direction` (`internal/app/events/callregistry.go`);
  // só o snapshot `call-list` e a API REST carregam o campo. A versão anterior
  // caía em `'inbound'` sempre que ele faltava, ou seja, em TODA ligação feita
  // pelo CRM: o painel dizia "Conectando…" em vez de "Chamando…", e a que
  // ninguém atendeu virava "Chamada perdida" na Central — medido na VPS em
  // 2026-09-15, duas ligações, dois avisos falsos.
  //
  // O que distingue os dois sentidos no PRIMEIRO evento é o dono: quem disca
  // pelo CRM já entra com `X-Client-Id`, então a ligação nasce com `owner`;
  // uma recebida toca sem dono até alguém atender. Limite conhecido: uma
  // ligação FEITA fora do CRM (a tela web do próprio WaCalls) nasce sem dono e
  // é lida como recebida até o snapshot a corrigir.
  //
  // Sentido INFERIDO só vale no INSERT; no caminho de conflito ele não
  // reescreve nada, para um `connected` com dono numa recebida não a virar.
  // Sentido DECLARADO (o snapshot `call-list` o traz) reescreve, porque é a
  // verdade do upstream — é assim que a reconexão corrige o que foi inferido.
  const declarada = ev.direction === 'outbound' || ev.direction === 'inbound';
  const direction: 'inbound' | 'outbound' = declarada
    ? (ev.direction as 'inbound' | 'outbound')
    : dono
      ? 'outbound'
      : 'inbound';

  // O peer do WhatsApp vem em DÍGITOS PUROS ("5511999998888"); a coluna
  // `contacts.phone_number` guarda E.164 COM o "+", e a constraint
  // `contacts_phone_e164_format` garante que é sempre assim. Casar cru contra
  // cru NUNCA acha ninguém: toda ligação nasceria sem contato, sem atividade na
  // linha do tempo, e o aviso de chamada perdida sem o botão de ligar de volta.
  // As duas grafias do nono dígito entram — ver `CONTATO_DO_PEER`. O `wa_lid`
  // continua cru: é identificador do WhatsApp, não telefone.
  const { rows } = await pool.query<{ contact_id: string | null }>(
    `insert into voice_calls
       (organization_id, channel_session_id, contact_id, wacalls_call_id, direction,
        peer_phone, status, started_at, owner_user_id, answered_at)
     values ($1, $2, ${CONTATO_DO_PEER('$1', '$5', '$10')},
             $3, $4, $5, $6, to_timestamp($7 / 1000.0), $8,
             -- Tambem no INSERT, e nao so no caminho de conflito: nem toda
             -- chamada passa por 'ringing' antes de 'connected'. Ligacao de
             -- SAIDA ja nasce conectando, e a ponte reconecta com backoff, entao
             -- o primeiro evento que ela ve pode ser o 'connected'. Sem esta
             -- linha, essas chamadas nasciam com answered_at nulo e NUNCA
             -- contavam como atendidas: nao entravam nas metricas do atendente,
             -- nao quebravam o silencio do negocio, e a de saida ainda virava
             -- "chamada perdida" no aviso da Central quando desligasse.
             case when $6 = 'connected' then now() else null end)
     on conflict (organization_id, wacalls_call_id) do update
       set status = excluded.status,
           direction = case when $9 then excluded.direction else voice_calls.direction end,
           contact_id = coalesce(voice_calls.contact_id, excluded.contact_id),
           -- coalesce e nao excluded: o dono e gravado pela rota de atender
           -- (que sabe QUEM clicou) antes de o SSE chegar, e um evento posterior
           -- sem owner nao pode apagar essa informacao.
           owner_user_id = coalesce(voice_calls.owner_user_id, excluded.owner_user_id),
           answered_at = case
             when voice_calls.answered_at is null and excluded.status = 'connected'
               then now()
             else voice_calls.answered_at
           end,
           updated_at = now()
     returning contact_id`,
    [
      sess.organizationId,
      sess.channelSessionId,
      ev.id,
      direction,
      peerPhone,
      ev.status,
      ev.startedAt,
      dono,
      declarada,
      phoneLookupVariants(peerPhone),
    ],
  );
  log.info('wacalls: call-status', {
    channel_session_id: sess.channelSessionId,
    wacalls_call_id: ev.id,
    status: ev.status,
  });

  const contactId = rows[0]?.contact_id ?? null;
  if (ev.status === 'connected' && contactId) {
    await calarIaDuranteALigacao(pool, sess.organizationId, contactId);
    log.info('wacalls: IA calada enquanto a ligação está de pé', { contact_id: contactId });
  }
}

async function handleCallEnded(
  pool: pg.Pool,
  sess: WacallsSessionMap,
  ev: { id: string; reason: string; endedAt: number; owner?: unknown },
  log: Logger,
): Promise<void> {
  const { rows } = await pool.query<{
    id: string;
    contact_id: string | null;
    started_at: string;
    answered_at: string | null;
    peer_phone: string;
    owner_user_id: string | null;
    direction: 'inbound' | 'outbound';
  }>(
    `update voice_calls
        set status = 'ended', end_reason = $3, ended_at = to_timestamp($4 / 1000.0),
            owner_user_id = coalesce(owner_user_id, $5),
            duration_ms = case
              when answered_at is not null then $4 - (extract(epoch from answered_at) * 1000)::bigint
              else null
            end,
            updated_at = now()
      where organization_id = $1 and wacalls_call_id = $2
      returning id, contact_id, started_at, answered_at, peer_phone, owner_user_id, direction`,
    [sess.organizationId, ev.id, ev.reason, ev.endedAt, donoValido(ev.owner)],
  );
  const row = rows[0];
  if (!row) {
    log.warn('wacalls: call-ended sem linha correspondente em voice_calls', {
      wacalls_call_id: ev.id,
    });
    return;
  }

  const atendida = !!row.answered_at;
  const recebida = row.direction === 'inbound';

  // Desligou: a IA volta a falar. Antes de qualquer outra coisa — se a linha
  // abaixo falhar, o pior desfecho é um aviso que não nasceu, não uma conversa
  // que ficou muda.
  if (row.contact_id) {
    await devolverAVozDaIa(pool, sess.organizationId, row.contact_id);
  }

  // Perdida = RECEBIDA e nunca atendida. `end_reason` do upstream não distingue
  // "tocou e ninguém pegou" de "operador recusou" — para o inbox os dois merecem
  // alerta igual: alguém precisa ligar de volta. Uma ligação FEITA daqui que o
  // cliente não atendeu não é perdida: quem discou já sabe, e um aviso pedindo
  // para "ligar de volta" a quem acabou de ligar é ruído com cara de urgência.
  //
  // `ref_kind = 'contact'` e não `'voice_call'`: a ficha do contato é onde mora
  // o botão de ligar, então abrir o contexto e FAZER o que o aviso pede viram o
  // mesmo clique (ver `POLITICAS_DE_AVISO` em `lib/ai/inbox-destino.ts`).
  // Chamada de número que não casou com contato nenhum entra sem referência —
  // o telefone está no título, e o aviso continua sendo aviso.
  if (!atendida && recebida) {
    await pool.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       values ($1, 'voice_call_missed', 'warn', $2, $3, $4, $5)`,
      [
        sess.organizationId,
        `Chamada perdida de ${row.peer_phone}`,
        motivoDaChamadaEmPortugues(ev.reason),
        row.contact_id ? 'contact' : null,
        row.contact_id,
      ],
    );
  }

  // `status` EXPLÍCITO. Este é evento de REGISTRO, não comando: ninguém precisa
  // consumi-lo, e `lib/event-log/drain.ts` só enxerga tipos com handler
  // declarado (`.in("event_type", handledTypes)`). Nascendo `pending`, a linha
  // ficava pendurada para sempre com cara de trabalho na fila, e o `event_log`
  // não tem poda. Mesmo padrão de `agent.operator_turn`
  // (`lib/agent-engine/agent/operator-turn.ts`).
  await pool.query(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, status, payload)
     values ($1, 'voice_call.ended', 'voice_call', $2, 'done', $3)`,
    [
      sess.organizationId,
      row.id,
      JSON.stringify({ wacalls_call_id: ev.id, end_reason: ev.reason, answered: atendida }),
    ],
  );

  if (row.contact_id) {
    const result = await emitAgentActivityForContact({
      pool,
      organizationId: sess.organizationId,
      contactId: row.contact_id,
      // DOIS tipos, e a diferença não é cosmética: `voice_call` entra na lista
      // positiva de `fn_update_last_activity_at` (migration 0079) e portanto
      // quebra o silêncio do negócio; `voice_call_missed` NÃO entra. Um
      // telefone que tocou sem ninguém atender é constatação de silêncio, não
      // interação — carimbar `last_activity_at` ali esfriaria o Radar de Risco
      // por um contato com quem ninguém falou.
      // TRÊS desfechos, e o terceiro tem tipo próprio porque a linha do tempo
      // rotula pelo TIPO (`activityLabel`): gravar a ligação FEITA sem resposta
      // como `voice_call_missed` escrevia "Chamada de voz perdida" no negócio
      // de quem acabou de discar — o mesmo texto falso que a Central deixou de
      // mostrar. `voice_call_unanswered` também fica fora da lista positiva de
      // `fn_update_last_activity_at`: ninguém falou com ninguém.
      type: atendida ? 'voice_call' : recebida ? 'voice_call_missed' : 'voice_call_unanswered',
      reason: atendida
        ? 'Chamada de voz atendida'
        : recebida
          ? `Chamada de voz perdida — ${motivoDaChamadaEmPortugues(ev.reason)}`
          : `Chamada de voz sem resposta — ${motivoDaChamadaEmPortugues(ev.reason)}`,
      sourceModule: 'voice_calls',
      sourceId: row.id,
      // Quem atendeu assina. Sem isto a linha caía em `webhook_source` →
      // `actor_kind='system'`, e a linha do tempo do negócio dizia "Sistema"
      // onde havia uma pessoa.
      usuarioId: row.owner_user_id,
      payload: { end_reason: ev.reason, answered: atendida },
    });
    if (!result.routed) {
      log.info('wacalls: call-ended sem lead aberto, sem atividade', {
        contact_id: row.contact_id,
        reason: result.reason,
      });
    }
  }
}

/**
 * Uma linha SSE `data: {...}` já sem o prefixo — parseada e despachada.
 *
 * Exportada para que `tests/invariants/voz-ponte-de-eventos.test.ts` exercite os
 * efeitos desta ponte contra um Postgres de verdade. O que ela faz é quase todo
 * SQL — silenciar a IA, abrir aviso, gravar evento, carimbar a linha do tempo —
 * e um dublê de `pg.Pool` mediria o TEXTO das consultas, não o estado que elas
 * deixam. Nada mais deste módulo é público: o worker chama
 * `runVoiceCallsBridgeLoop`.
 */
export async function despacharEventoWacalls(
  pool: pg.Pool,
  cache: Map<string, WacallsSessionMap>,
  raw: string,
  log: Logger,
): Promise<void> {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = ev['type'];
  if (type === 'call-list') {
    // O snapshot que o broker manda a todo assinante NOVO — isto é, a cada
    // reconexão desta ponte. É a única fonte no stream que carrega `direction`
    // (registros `CallRecord`, `internal/app/events/callregistry.go`: `sessionId,
    // callId, owner, direction, peer, startedAt, status, endedAt?`), e cobre a
    // ligação que começou enquanto a ponte estava caída: cada registro ativo
    // passa pelo mesmo upsert do `call-status`, com o sentido DECLARADO — que,
    // ao contrário do inferido, reescreve a linha que já existia.
    //
    // Limite conhecido: a ligação que TERMINOU com a ponte caída não vem aqui
    // (registro `ended` ou ausente), e a linha dela segue aberta até o teto de
    // silêncio da IA. Fechá-la exigiria disparar os efeitos de `call-ended`
    // sem o evento — ver o issue aberto junto com este conserto.
    const calls = Array.isArray(ev['calls']) ? (ev['calls'] as Record<string, unknown>[]) : [];
    for (const c of calls) {
      if (typeof c['sessionId'] !== 'string' || typeof c['callId'] !== 'string') {
        // Forma inesperada é informação, não silêncio: se o upstream renomear
        // a chave, esta linha é o único rastro de que a reconexão parou de
        // reconciliar.
        log.warn('wacalls: registro do call-list fora do formato', {
          chaves: Object.keys(c).join(',').slice(0, 200),
        });
        continue;
      }
      if (c['status'] === 'ended') continue;
      // Um registro que lança não derruba o lote: no incremental 1 evento é 1
      // linha, e o snapshot precisa da mesma granularidade.
      try {
        const sess = await resolveSession(pool, cache, c['sessionId']);
        if (!sess) continue;
        await handleCallStatus(
          pool,
          sess,
          {
            id: c['callId'],
            status: String(c['status']),
            peer: String(c['peer'] ?? ''),
            direction: typeof c['direction'] === 'string' ? c['direction'] : undefined,
            startedAt: typeof c['startedAt'] === 'number' ? c['startedAt'] : Date.now(),
            owner: c['owner'],
          },
          log,
        );
      } catch (err) {
        log.error('wacalls: registro do call-list falhou ao reconciliar', {
          wacalls_call_id: c['callId'],
          error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        });
      }
    }
    return;
  }
  const sessionId = ev['sessionId'];
  if (typeof type !== 'string' || typeof sessionId !== 'string') return;
  // `session-list` é snapshot pro client React do próprio WaCalls — a
  // `auth-state` incremental já diz tudo o que o banco precisa.
  if (type === 'session-list') return;

  const sess = await resolveSession(pool, cache, sessionId);
  if (!sess) return; // sessão de outra instalação/teste — não é nossa

  switch (type) {
    case 'incoming': {
      // A ÚNICA fonte de "recebida" que o upstream emite por nome, uma vez por
      // ligação (`wireCall` → `OnIncoming`: `UpsertCall` e então
      // `EmitIncoming`). Normalmente só confirma o que a inferência pelo dono já
      // gravou no `call-status` anterior. É defesa para dois casos: o
      // `call-status` que se perdeu (a linha nasce aqui, como manda a §4.2) e a
      // inferência que errou por qualquer motivo (o sentido é corrigido).
      const id = ev['id'];
      const peer = ev['peer'];
      if (typeof id !== 'string' || !id || typeof peer !== 'string' || !peer) {
        log.warn('wacalls: incoming fora do formato', { chaves: Object.keys(ev).join(',').slice(0, 200) });
        return;
      }
      const peerPhone = peerToPhone(peer);
      await pool.query(
        `insert into voice_calls
           (organization_id, channel_session_id, contact_id, wacalls_call_id, direction,
            peer_phone, status, started_at)
         values ($1, $2, ${CONTATO_DO_PEER('$1', '$4', '$6')},
                 $3, 'inbound', $4, 'ringing', to_timestamp($5 / 1000.0))
         on conflict (organization_id, wacalls_call_id) do update
           set direction = 'inbound', updated_at = now()
           where voice_calls.direction is distinct from 'inbound'`,
        [
          sess.organizationId,
          sess.channelSessionId,
          id,
          peerPhone,
          typeof ev['offeredAt'] === 'number' ? ev['offeredAt'] : Date.now(),
          phoneLookupVariants(peerPhone),
        ],
      );
      return;
    }
    case 'auth-state':
      await handleAuthState(pool, sess, ev as { paired: boolean; state: string; qr?: string }, log);
      return;
    case 'call-status':
      await handleCallStatus(
        pool,
        sess,
        ev as {
          id: string;
          status: string;
          peer: string;
          direction?: string;
          startedAt: number;
          owner?: unknown;
        },
        log,
      );
      return;
    case 'call-ended':
      await handleCallEnded(
        pool,
        sess,
        ev as { id: string; reason: string; endedAt: number; owner?: unknown },
        log,
      );
      return;
    default:
      // session-qr / incoming-claimed / call-quality…: pura notificação de UI
      // (§5.2/§5.1 da spec) — sem escrita no banco.
      return;
  }
}

/** Lê a stream SSE linha a linha até fechar/errar; devolve quando o corpo acaba. */
async function pumpSse(
  res: Response,
  pool: pg.Pool,
  cache: Map<string, WacallsSessionMap>,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          await despacharEventoWacalls(pool, cache, payload, log);
        } catch (err) {
          log.error('wacalls: evento falhou ao processar', {
            error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Loop de vida: conecta, bombeia até cair, reconecta com backoff exponencial
 * (teto `maxBackoffMs`). Sai só quando `signal` aborta (shutdown do worker).
 */
export async function runVoiceCallsBridgeLoop(
  pool: pg.Pool,
  cfg: WacallsBridgeConfig,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  const cache = new Map<string, WacallsSessionMap>();
  let backoffMs = 1000;

  while (!signal.aborted) {
    try {
      const res = await fetch(`${cfg.baseUrl}/api/events`, {
        headers: {
          'X-Client-Id': 'deskcomm-worker',
          Authorization: `Bearer ${cfg.apiToken.trim()}`,
        },
        signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`wacalls_events_${res.status}`);
      }
      log.info('wacalls: conectado ao stream de eventos', {});
      backoffMs = 1000; // conexão boa — reseta o backoff
      await pumpSse(res, pool, cache, log, signal);
      if (signal.aborted) return;
      log.warn('wacalls: stream de eventos caiu, reconectando', {});
    } catch (err) {
      if (signal.aborted) return;
      log.error('wacalls: conexão ao stream de eventos falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        next_retry_ms: backoffMs,
      });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, backoffMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    backoffMs = Math.min(backoffMs * 2, cfg.maxBackoffMs);
  }
}
