import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { doEventoDoGoogle, estaCancelado, type EventoDoGoogle, type MotivoDeRecusa } from "./evento";
import { ehEventoNosso } from "./escrita";
import { classificarErroDoGoogle } from "./erros";
import { googleTransport, GoogleHttpError, type GoogleFetch } from "./transport";
import { calendarSnapshotSchema, googleRpc, type CalendarFence } from "./sync-store";
import { reconcileAppointment, tokenForConnection } from "./sync-executor";

/**
 * Extrai classe, código e constraint de um erro do banco para registro estruturado,
 * sem carregar texto livre de erro (LGPD / PII).
 */
export function diagnosticoDeErro(erro: unknown): {
  class: string | null;
  code: string | null;
  constraint: string | null;
} {
  if (!erro || typeof erro !== "object") {
    return { class: null, code: null, constraint: null };
  }
  const e = erro as {
    code?: unknown;
    class?: unknown;
    constraint?: unknown;
    message?: unknown;
    details?: unknown;
  };
  const rawCode =
    typeof e.code === "string" && e.code.trim().length > 0 ? e.code.trim() : null;
  const rawClass =
    typeof e.class === "string" && e.class.trim().length > 0
      ? e.class.trim()
      : rawCode && rawCode.length >= 2
        ? rawCode.slice(0, 2)
        : null;

  let constraint: string | null = null;
  if (typeof e.constraint === "string" && e.constraint.trim().length > 0) {
    constraint = e.constraint.trim();
  } else {
    const pistas = [e.message, e.details].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    for (const texto of pistas) {
      const match =
        /(?:violates (?:check |unique |foreign key )?constraint|constraint) ["']?([a-zA-Z0-9_]+)["']?/i.exec(
          texto,
        );
      if (match?.[1]) {
        constraint = match[1];
        break;
      }
    }
  }

  return {
    class: rawClass,
    code: rawCode,
    constraint,
  };
}

/**
 * O evento do Google que a leitura recusou, nomeado com o dia e a hora DE PAREDE.
 *
 * Sem isto a rodada seguinte relê a mesma página para sempre e a tela repete a
 * frase genérica: o operador não tem como saber QUAL evento corrigir no Google.
 * A frase carrega a data e a hora como a tela do Google as mostra — e só isso.
 * Título e pessoa ficam de fora de propósito: o texto é persistido e sai na
 * tela, e conteúdo de terceiro não viaja para lá.
 */
export class EventoRecusadoNaLeitura extends Error {
  constructor(
    /** Motivo nomeado do parser, para o log e o programador; fica FORA da frase da tela (código cru não é texto para quem opera). */
    readonly motivo: MotivoDeRecusa,
    /** Dia (e hora, quando o evento tem) de parede, pronto para a tela. */
    readonly quando: string,
  ) {
    super(
      `O evento de ${quando} tem horário que a leitura não consegue usar. Corrija ou remova esse evento no Google Agenda.`,
    );
    this.name = "EventoRecusadoNaLeitura";
  }
}

/**
 * O evento foi criado por este sistema, mas o compromisso que o publicou não
 * existe mais no banco (#5109).
 *
 * Só chega aqui o evento que ainda OCUPA horário: a lápide cancelada sem par é
 * podada antes, porque não há o que reconciliar. A frase carrega o dia e a hora
 * de parede — e nada do conteúdo do evento (título, pessoa), pela mesma tesoura
 * de privacidade do `EventoRecusadoNaLeitura`.
 */
export class EventoDoProdutoSemVinculo extends Error {
  constructor(
    /** Dia (e hora, quando o evento tem) de parede, pronto para a tela. */
    readonly quando: string,
  ) {
    super(
      `O evento de ${quando} foi criado por este sistema, mas não tem mais compromisso correspondente. Corrija ou remova esse evento no Google Agenda.`,
    );
    this.name = "EventoDoProdutoSemVinculo";
  }
}

/** `YYYY-MM-DD` com hora opcional, exatamente como o Google devolve o `start`. */
const DATA_DE_PAREDE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;

/**
 * O dia e a hora de PAREDE do evento, do jeito que a tela do Google mostra.
 *
 * Lido do texto cru, sem converter fuso: a hora de parede é justamente a que a
 * pessoa vê lá. Converter mandaria o operador procurar o evento no dia errado
 * sempre que ele cruza a meia-noite.
 */
function quandoDoEvento(evento: EventoDoGoogle): string {
  const inicio = evento.start;
  const texto = (inicio?.dateTime ?? inicio?.date ?? "").trim();
  const m = DATA_DE_PAREDE.exec(texto);
  if (!m) return "data ilegível";
  const [, ano, mes, dia, hora, minuto] = m;
  return hora && minuto ? `${dia}/${mes}/${ano} às ${hora}:${minuto}` : `${dia}/${mes}/${ano}`;
}

/** A frase persistida quando a leitura incremental do Google falha. */
export function mensagemDaRecusaDeLeitura(erro: unknown): string {
  if (erro instanceof GoogleHttpError) {
    return classificarErroDoGoogle(erro, "sincronizar").mensagem;
  }
  // A recusa do evento é diagnóstica por natureza: data e hora já passaram pelo
  // recorte que remove título e pessoa, então a frase pode ir para a tela.
  if (erro instanceof EventoRecusadoNaLeitura) return erro.message;
  // Mesma regra para o evento do produto sem vínculo (#5109): a frase nomeia o
  // evento e o que fazer, e nada mais.
  if (erro instanceof EventoDoProdutoSemVinculo) return erro.message;
  return "A leitura não terminou. Tente sincronizar novamente nas configurações.";
}

/** Ids por consulta de vínculo: mantém a URL do `.in` bem abaixo de 8 KB. */
const IDS_POR_CONSULTA = 50;

export async function refreshCatalog(
  db: SupabaseClient,
  org: string,
  connectionId: string,
  transport?: GoogleFetch,
) {
  const { data, error } = await db
    .from("calendar_connections")
    .select("calendar_selection_revision::text")
    .eq("organization_id", org)
    .eq("id", connectionId)
    .single();
  if (error) throw error;
  const token = await tokenForConnection(db, org, connectionId);
  const items = await googleTransport(token, transport).calendars();
  await googleRpc(db, "fn_google_catalog", {
    p_org: org,
    p_connection: connectionId,
    p_items: items,
    p_revision: String(data.calendar_selection_revision),
  });
}
export async function syncCalendar(
  db: SupabaseClient,
  org: string,
  calendarId: string,
  transport?: GoogleFetch,
): Promise<"busy" | "complete" | "partial" | "deferred" | "failed"> {
  const raw = await googleRpc(db, "fn_google_calendar", {
    p_org: org,
    p_id: calendarId,
    p_action: "claim",
  });
  if (!raw) return "busy";
  const c = calendarSnapshotSchema.parse(raw);
  if (!c.sync_cursor) throw new Error("Leitura sem cursor reservado.");
  const fence: CalendarFence = { id: c.id, claim: c.claim, cursor: c.sync_cursor };
  const call = (action: string, args: Record<string, unknown> = {}) =>
    googleRpc(db, "fn_google_calendar", {
      p_org: org,
      p_id: calendarId,
      p_action: action,
      p_args: { claim: c.claim, cursor: fence.cursor, ...args },
    });
  try {
    const token = await tokenForConnection(db, org, c.connection_id);
    let timeZone = c.time_zone;
    if (!timeZone) {
      const { data: organization, error } = await db
        .from("organizations")
        .select("timezone")
        .eq("id", org)
        .single();
      if (error || !organization?.timezone) throw new Error("Fuso da organização indisponível.");
      timeZone = organization.timezone;
    }
    const page = await googleTransport(token, transport).page(
      c.external_calendar_id,
      c.sync_cursor,
    );
    const eventIds = page.items
      .map((item) => item.id?.trim())
      .filter((eventId): eventId is string => Boolean(eventId));
    if (eventIds.length !== page.items.length) throw new Error("Evento sem identidade no lote do Google.");
    const linkedByEventId = new Map<string, string>();
    // Em blocos: o `.in` vai na URL do PostgREST, e 250 ids do Google (a página
    // cheia) passam do limite de linha de requisição comum em proxy (8 KB).
    for (let i = 0; i < eventIds.length; i += IDS_POR_CONSULTA) {
      const { data: linkedAppointments, error } = await db
        .from("calendar_appointments")
        .select("id,google_event_id")
        .eq("organization_id", org)
        .eq("google_connection_id", c.connection_id)
        .eq("google_calendar_id", c.external_calendar_id)
        .in("google_event_id", eventIds.slice(i, i + IDS_POR_CONSULTA));
      if (error) throw error;
      for (const appointment of linkedAppointments ?? []) {
        if (appointment.google_event_id) {
          linkedByEventId.set(appointment.google_event_id, appointment.id);
        }
      }
    }
    const items: Record<string, unknown>[] = [];
    const pruneIds = new Set<string>();
    const windowStart = Date.parse(c.sync_cursor.window_start);
    const windowEnd = Date.parse(c.sync_cursor.window_end);
    if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
      throw new Error("Janela de cobertura inválida.");
    }
    for (const rawEvent of page.items) {
      const event = rawEvent as EventoDoGoogle;
      const eventId = event.id!.trim();
      const linkedAppointmentId = linkedByEventId.get(eventId);
      if (linkedAppointmentId) {
        await call("renew");
        const result = await reconcileAppointment(db, org, linkedAppointmentId, {
          transport,
          calendarFence: fence,
          remote: event,
          token,
        });
        // A página foi lida, mas o vínculo ocupado impede gravar o checkpoint.
        if (result === "busy") return "deferred";
        if (result === "failed") throw new Error("Compromisso vinculado ainda não reconciliado.");
        pruneIds.add(eventId);
        continue;
      }
      if (ehEventoNosso(event.id)) {
        // Lápide do produto sem par (#5109): o compromisso que a publicou foi
        // excluído, então não há o que reconciliar. Podar em vez de lançar —
        // lançar aqui derrubava a página inteira a cada leitura, inclusive na
        // completa, e a agenda nunca mais sincronizava.
        if (estaCancelado(event)) {
          pruneIds.add(eventId);
          continue;
        }
        throw new EventoDoProdutoSemVinculo(quandoDoEvento(event));
      }
      const read = doEventoDoGoogle(event, { fusoDoCalendario: timeZone! });
      if (read.tipo === "recusado")
        throw new EventoRecusadoNaLeitura(read.motivo, quandoDoEvento(event));
      if (read.tipo === "cancelado") {
        items.push({
          external_event_id: read.externalEventId,
          status: "cancelled",
          recurring_event_id: event.recurringEventId,
          original_start_time: event.originalStartTime,
        });
        continue;
      }
      const begins = Date.parse(read.evento.starts_at);
      const ends = Date.parse(read.evento.ends_at);
      if (!(ends > begins)) {
        pruneIds.add(eventId);
        continue;
      }
      if (ends <= windowStart || begins >= windowEnd) {
        pruneIds.add(eventId);
        continue;
      }
      items.push({
        ...read.evento,
        title: null,
        transparency: read.evento.ocupa ? "opaque" : "transparent",
        recurring_event_id: event.recurringEventId,
        original_start_time: event.originalStartTime,
      });
    }
    const saved = calendarSnapshotSchema.parse(
      await googleRpc(db, "fn_google_calendar_page_batch", {
        p_org: org,
        p_id: calendarId,
        p_args: {
          claim: c.claim,
          cursor: fence.cursor,
          items,
          prune_ids: [...pruneIds],
          next_page_token: page.nextPageToken ?? null,
          next_sync_token: page.nextSyncToken ?? null,
        },
      }),
    );
    // O cursor mudou no commit. Release só usa aquisição, não o cursor anterior.
    fence.cursor = saved.sync_cursor ?? fence.cursor;
    return saved.sync_cursor ? "partial" : "complete";
  } catch (e) {
    const diag = diagnosticoDeErro(e);
    logger.warn("[agenda.google.sync] leitura da agenda falhou", {
      class: diag.class,
      code: diag.code,
      constraint: diag.constraint,
      // A frase que a tela mostra também vai para o log (#5109): sem ela o log
      // só tinha class/code/constraint e a causa real se perdia. É a versão
      // SANITIZADA — a mensagem crua do erro continua fora do log (LGPD/PII).
      message: mensagemDaRecusaDeLeitura(e),
    });
    try {
      if (e instanceof GoogleHttpError && e.status === 410) await call("reset");
      else await call("error", { message: mensagemDaRecusaDeLeitura(e) });
    } catch {
      /* fence vencido não grava diagnóstico tardio */
    }
    return "failed";
  } finally {
    try {
      await googleRpc(db, "fn_google_calendar", {
        p_org: org,
        p_id: calendarId,
        p_action: "release",
        p_args: { claim: c.claim },
      });
    } catch {
      /* não liberar aquisição nova */
    }
  }
}
