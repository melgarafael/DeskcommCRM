/**
 * As reuniões da agência na Agenda Google (docs/agencia/SPEC-calendario.md, K2, K3).
 *
 * Usa a MESMA conexão do Drive (`accessToken` de `lib/agencia/acervo/drive.ts`,
 * K1), na agenda principal da conta. Só ida: a central escreve, nunca lê de volta.
 * `sendUpdates=all` faz o Google mandar o convite (e a mudança, e o cancelamento)
 * a quem tem e-mail.
 *
 * Nada aqui lança: falha vira `{ ok: false, erro }`, e quem chama grava o erro
 * na reunião — a reunião existe na central com ou sem o Google (K10).
 */
import { meetVideoUrl } from "@/lib/agenda/google/meet";
import { logger } from "@/lib/logger";

import { accessToken, estadoDoDrive, type Resultado } from "../acervo/drive";
import { corpoDoEvento } from "./regras";
import type { Formato } from "./vocabulario";

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

interface EventoDoGoogle {
  id: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } };
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
}

export interface EventoGravado {
  eventId: string;
  link: string | null;
  meetUrl: string | null;
}

function meetDoEvento(e: EventoDoGoogle): string | null {
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  return meetVideoUrl(e.hangoutLink) ?? meetVideoUrl(video);
}

function mensagemDeErro(status: number, corpo: string): string {
  if (status === 401) return "O acesso à Agenda Google expirou. Reconecte o Google em Configurações.";
  if (status === 403 && /insufficient|scope/i.test(corpo)) return "A conta Google não liberou a Agenda. Clique em Reconectar em Configurações.";
  if (status === 403 && /accessNotConfigured|has not been used|disabled/i.test(corpo))
    return "A Google Calendar API não está ativada no Google Cloud do app.";
  return `A Agenda Google recusou (${status}).`;
}

async function chamar(caminho: string, init: RequestInit): Promise<Resultado<EventoDoGoogle | null>> {
  const token = await accessToken();
  if (!token.ok) return token;
  try {
    const r = await fetch(`${API}${caminho}`, {
      ...init,
      headers: { Authorization: `Bearer ${token.valor}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (init.method === "DELETE" && (r.status === 404 || r.status === 410)) return { ok: true, valor: null };
    if (!r.ok) {
      const corpo = await r.text().catch(() => "");
      logger.warn("agência: Agenda Google recusou", { metodo: init.method, status: r.status, corpo: corpo.slice(0, 200) });
      return { ok: false, erro: mensagemDeErro(r.status, corpo) };
    }
    if (r.status === 204) return { ok: true, valor: null };
    return { ok: true, valor: (await r.json()) as EventoDoGoogle };
  } catch {
    return { ok: false, erro: "A Agenda Google não respondeu agora." };
  }
}

export interface ReuniaoParaOGoogle {
  id: string;
  eventId: string | null;
  titulo: string;
  inicio: string;
  fim: string;
  formato: Formato;
  local: string | null;
  emails: readonly string[];
  /** Já tem link do Meet: não pede outro. */
  temMeet: boolean;
}

/** A Agenda está liberada? Sem isto a reunião fica só na central, e a tela diz por quê. */
export async function agendaDisponivel(): Promise<boolean> {
  return (await estadoDoDrive()).agendaLiberada;
}

/** Cria (sem `eventId`) ou atualiza o evento. Pede o Meet quando a reunião é online e ainda não tem. */
export async function gravarEvento(r: ReuniaoParaOGoogle): Promise<Resultado<EventoGravado>> {
  const pedidoDeMeet = r.formato === "online" && !r.temMeet ? `${r.id}-${Date.now()}` : null;
  const corpo = corpoDoEvento({ ...r, reuniaoId: r.id, pedidoDeMeet });
  // Mudou de online para presencial: tira o Meet do evento.
  if (r.eventId && r.formato !== "online") corpo.conferenceData = null;
  const consulta = "?conferenceDataVersion=1&sendUpdates=all";
  const resposta = r.eventId
    ? await chamar(`/${encodeURIComponent(r.eventId)}${consulta}`, { method: "PATCH", body: JSON.stringify(corpo) })
    : await chamar(consulta, { method: "POST", body: JSON.stringify(corpo) });
  if (!resposta.ok) return resposta;
  let evento = resposta.valor;
  if (!evento) return { ok: false, erro: "A Agenda Google não devolveu o evento." };

  // O Meet às vezes nasce "pending": uma releitura curta costuma trazer o link.
  if (pedidoDeMeet && !meetDoEvento(evento) && evento.conferenceData?.createRequest?.status?.statusCode === "pending") {
    await new Promise((ok) => setTimeout(ok, 1500));
    const relido = await chamar(`/${encodeURIComponent(evento.id)}`, { method: "GET" });
    if (relido.ok && relido.valor) evento = relido.valor;
  }
  return { ok: true, valor: { eventId: evento.id, link: evento.htmlLink ?? null, meetUrl: meetDoEvento(evento) } };
}

/** Cancela o evento no Google; o Google avisa os convidados. Evento que já não existe conta como feito. */
export async function cancelarEvento(eventId: string): Promise<Resultado<null>> {
  const r = await chamar(`/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE" });
  return r.ok ? { ok: true, valor: null } : r;
}
