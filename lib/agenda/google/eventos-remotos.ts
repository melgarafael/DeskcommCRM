/**
 * A listagem de eventos de um calendário do Google — a metade da VOLTA.
 *
 * ─── A paginação não é detalhe, e o que se perde nela é horário ───────────
 *
 * `events.list` devolve página. Quem lê só a primeira perde os eventos do FIM
 * da lista — e o que se perde vira horário oferecido em cima de compromisso
 * real, que é o mesmo desfecho da DECISÃO 3.2 por outra porta. Por isso o laço
 * percorre `nextPageToken` até acabar.
 *
 * E o `nextSyncToken` só vem na ÚLTIMA página. Guardá-lo antes do fim
 * congelaria a sincronização num ponto intermediário: as páginas seguintes
 * nunca chegariam, e as ausências pareceriam "não há mais eventos".
 *
 * ─── `singleEvents: true` faz parte do contrato do token ──────────────────
 *
 * Ele manda o Google expandir série em instâncias — que é o que a leitura
 * espera, e o motivo de `doEventoDoGoogle` RECUSAR um evento-mestre. Mudá-lo
 * entre a chamada inicial e as incrementais invalida o `syncToken`, então ele é
 * constante aqui e não parâmetro.
 *
 * ─── A janela só existe no primeiro sync ──────────────────────────────────
 *
 * Mandar `timeMin`/`timeMax` JUNTO com `syncToken` devolve 400: o token já
 * codifica a janela. Por isso os dois nunca vão juntos.
 */

import type { EventoDoGoogle } from "./evento";

const ENDERECO_DE_EVENTOS = "https://www.googleapis.com/calendar/v3/calendars";
const PRAZO_MS = 15_000;

/** Quantas páginas antes de desistir — trava contra `nextPageToken` que não acaba. */
const TETO_DE_PAGINAS = 20;

/** Horizonte do primeiro sync. Três meses é o que o cal.com usa, e basta para agenda. */
export const JANELA_INICIAL_DIAS = 90;

export interface PaginaDeEventos {
  eventos: EventoDoGoogle[];
  /** Guardar para a próxima rodada. `null` quando o Google não mandou. */
  syncToken: string | null;
  /** Verdadeiro quando o teto de páginas cortou a leitura. */
  truncada: boolean;
}

export type LeituraDeEventos =
  | { ok: true; pagina: PaginaDeEventos }
  /** `erro` é o objeto CRU do Google — passe a `classificarErroDoGoogle`. */
  | { ok: false; erro: unknown; detalhe: string };

export async function listarEventos(
  accessToken: string,
  calendarId: string,
  opcoes: { syncToken?: string | null; agora: Date },
): Promise<LeituraDeEventos> {
  const eventos: EventoDoGoogle[] = [];
  let syncToken: string | null = opcoes.syncToken?.trim() || null;
  let pageToken: string | null = null;
  let paginas = 0;

  do {
    const parametros = new URLSearchParams({ singleEvents: "true", maxResults: "250" });
    if (opcoes.syncToken) {
      parametros.set("syncToken", opcoes.syncToken);
    } else if (!opcoes.syncToken) {
      // Só no primeiro sync. Nunca junto do syncToken — o Google devolve 400.
      const fim = new Date(opcoes.agora.getTime() + JANELA_INICIAL_DIAS * 24 * 60 * 60 * 1000);
      parametros.set("timeMin", opcoes.agora.toISOString());
      parametros.set("timeMax", fim.toISOString());
    }
    if (pageToken) parametros.set("pageToken", pageToken);

    let resposta: Response;
    try {
      resposta = await fetch(
        `${ENDERECO_DE_EVENTOS}/${encodeURIComponent(calendarId)}/events?${parametros.toString()}`,
        {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(PRAZO_MS),
          cache: "no-store",
        },
      );
    } catch (erro) {
      return { ok: false, erro, detalhe: erro instanceof Error ? erro.message : String(erro) };
    }

    let bruto: unknown;
    try {
      bruto = await resposta.json();
    } catch {
      return { ok: false, erro: { status: resposta.status }, detalhe: `HTTP ${resposta.status} com corpo ilegível` };
    }

    if (!resposta.ok) {
      // O corpo CRU vai inteiro para quem classifica — é assim que o
      // `410 fullSyncRequired` chega reconhecível. Passar só o status faria ele
      // virar "evento sumiu", que é o caminho que apaga linha.
      return { ok: false, erro: bruto, detalhe: `HTTP ${resposta.status}` };
    }

    const corpo = typeof bruto === "object" && bruto !== null ? (bruto as Record<string, unknown>) : {};
    const itens = Array.isArray(corpo.items) ? (corpo.items as EventoDoGoogle[]) : [];
    eventos.push(...itens);

    pageToken = typeof corpo.nextPageToken === "string" ? corpo.nextPageToken : null;
    // Só a última página traz `nextSyncToken`.
    if (typeof corpo.nextSyncToken === "string") syncToken = corpo.nextSyncToken;

    paginas += 1;
  } while (pageToken && paginas < TETO_DE_PAGINAS);

  return {
    ok: true,
    pagina: {
      eventos,
      // Leitura cortada não pode guardar token: ele marcaria como lido o que
      // não foi lido, e as páginas perdidas nunca voltariam.
      syncToken: pageToken ? null : syncToken,
      truncada: Boolean(pageToken),
    },
  };
}
