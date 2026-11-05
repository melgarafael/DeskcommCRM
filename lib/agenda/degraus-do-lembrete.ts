/**
 * AS RÉGUAS DO LEMBRETE — quando um degrau está na hora, e o que fazer com o
 * link da reunião. Puras, sem banco, compartilhadas pelos DOIS lembretes:
 *
 * - o do CLIENTE (`app/api/v1/cron/agenda-reminder/route.ts`), que sai pela
 *   conversa dele;
 * - o do DONO (`lib/agenda/lembrete-ao-dono.ts`), que sai pelo número do aviso
 *   de agendamento.
 *
 * Moraram dentro da rota do cron até o lembrete do dono nascer. Uma segunda
 * cópia de `estaNaHora` divergiria no primeiro conserto — e é a regra que
 * decide se alguém recebe mensagem. A rota reexporta as duas, para quem já as
 * importava de lá.
 */

/**
 * Está na hora de lembrar?
 *
 * Cedo demais não manda, tarde demais (já começou) também não.
 */
export function estaNaHora(agora: Date, comeca: Date, antecedenciaMin: number): boolean {
  if (comeca.getTime() <= agora.getTime()) return false;
  return comeca.getTime() - antecedenciaMin * 60_000 <= agora.getTime();
}

/**
 * A hora deste degrau já tinha passado quando a reunião foi marcada?
 *
 * Issue #2223: reunião marcada às 18:30 para as 16h do dia seguinte tem o
 * degrau de 1440 min às 16:00 de hoje — instante anterior à existência da
 * própria linha. `<=`: marcado no MESMO instante da hora do degrau também é
 * descartado. Sem `marcadoEm` a guarda fica fora do caminho.
 */
export function vencidoNaMarcacao(comeca: Date, degrauMin: number, marcadoEm: Date | null | undefined): boolean {
  if (!marcadoEm) return false;
  return comeca.getTime() - degrauMin * 60_000 <= marcadoEm.getTime();
}

// ─── O link da reunião ──────────────────────────────────────────────────────

/**
 * Quanto antes do início um lembrete ainda ESPERA o link do Meet ficar pronto.
 *
 * O Meet nasce `pending` e a criação no Google roda em segundo plano, com
 * novas tentativas (`meeting_next_attempt_at`). Um lembrete que sai sem o link
 * enquanto ele ainda pode chegar obriga a pessoa a procurar o link em outro
 * lugar — então o degrau espera. Mas esperar para sempre faria o aviso de
 * 1 hora nunca sair numa reunião cujo link travou: a 15 minutos do início o
 * lembrete sai mesmo sem link, dizendo que ele chega por aqui.
 */
export const ESPERA_PELO_LINK_ATE_MIN = 15;

export type EstadoDoLink = "nao_e_meet" | "pronto" | "pendente" | "indisponivel";

export interface LinkDaReuniao {
  estado: EstadoDoLink;
  /** Só existe com `estado = "pronto"`. */
  url: string | null;
}

/**
 * O link que um lembrete pode levar, a partir da linha do compromisso.
 *
 * Só `ready` com URL é link: `meeting_url` de um Meet ainda `pending` não é
 * prometido a ninguém (mesma régua de `lib/mcp/tools/agendamento.ts`, que só
 * devolve a URL com `meetingState === "ready"`). `video_link` é a sala que a
 * própria equipe escreveu no compromisso — ela é o link, sem estado.
 */
export function linkDaReuniao(linha: {
  location_kind?: string | null;
  meeting_state?: string | null;
  meeting_url?: string | null;
}): LinkDaReuniao {
  const url = typeof linha.meeting_url === "string" && /^https:\/\//i.test(linha.meeting_url.trim())
    ? linha.meeting_url.trim()
    : null;
  if (linha.location_kind !== "google_meet") {
    return linha.location_kind === "video_link" && url ? { estado: "pronto", url } : { estado: "nao_e_meet", url: null };
  }
  if (linha.meeting_state === "ready" && url) return { estado: "pronto", url };
  if (linha.meeting_state === "pending" || linha.meeting_state === "not_requested") {
    return { estado: "pendente", url: null };
  }
  return { estado: "indisponivel", url: null };
}

/**
 * O lembrete deve esperar o link nesta rodada?
 *
 * Sim enquanto o link está a caminho e ainda falta mais que
 * `ESPERA_PELO_LINK_ATE_MIN` para começar. Quem espera NÃO carimba nem
 * reivindica o degrau: a rodada seguinte o encontra pendente de novo.
 */
export function esperaPeloLink(link: LinkDaReuniao, comeca: Date, agora: Date): boolean {
  if (link.estado !== "pendente") return false;
  return comeca.getTime() - agora.getTime() > ESPERA_PELO_LINK_ATE_MIN * 60_000;
}

// ─── O degrau do lembrete do DONO ───────────────────────────────────────────

/** Um lembrete ao dono já reivindicado para este compromisso e este destino. */
export interface LembreteJaReivindicado {
  degrau: number;
  /** O `starts_at` a que ele se referia — muda quando a reunião é remarcada. */
  inicio: string;
  status: string;
  enviadoEm: string | null;
}

/**
 * Qual degrau do lembrete ao dono sai AGORA — ou `null`.
 *
 * - Só os degraus vencidos (`estaNaHora`) e que não venceram antes da
 *   marcação desta data (`vencidoNaMarcacao`, a régua do #2223).
 * - Se vários venceram juntos (marcou 3 h antes, cron parado), sai UM: o mais
 *   próximo do início. O mais antecipado perdeu a função, e a chave única da
 *   entrega é por degrau — o maior nunca é reivindicado depois do menor porque
 *   o menor vence sempre DEPOIS dele.
 * - **Anti-rajada na remarcação** (a mesma régua do #2249 do lembrete do
 *   cliente): empurrar a reunião 30 min depois de o aviso de 1 dia sair não
 *   gera um segundo aviso de 1 dia 30 min depois do primeiro. Um degrau novo só
 *   sai se o último lembrete ENVIADO deste destino ficou a pelo menos metade
 *   do intervalo do degrau antes da hora dele.
 *
 * A chave única do banco (compromisso, destino, degrau, início) é quem impede
 * o MESMO degrau da MESMA data de sair duas vezes; esta função decide só qual
 * degrau é candidato.
 */
export function degrauDoDonoAgora(input: {
  agora: Date;
  comeca: Date;
  degraus: number[];
  marcadoEm: Date | null;
  jaReivindicados: LembreteJaReivindicado[];
}): number | null {
  const vencidos = [...new Set(input.degraus)]
    .filter((d) => Number.isFinite(d) && d > 0)
    .filter((d) => estaNaHora(input.agora, input.comeca, d) && !vencidoNaMarcacao(input.comeca, d, input.marcadoEm))
    .sort((a, b) => a - b);
  const degrau = vencidos[0];
  if (degrau === undefined) return null;

  const alvo = input.comeca.getTime() - degrau * 60_000;
  const inicio = input.comeca.toISOString();
  for (const r of input.jaReivindicados) {
    // A mesma data e o mesmo degrau: quem decide é a chave única (a entrega
    // pendente é retomada; a resolvida não sai de novo).
    if (r.degrau === degrau && Date.parse(r.inicio) === Date.parse(inicio)) continue;
    if (r.status !== "enviado" || !r.enviadoEm) continue;
    if (alvo - Date.parse(r.enviadoEm) < (degrau * 60_000) / 2) return null;
  }
  return degrau;
}
