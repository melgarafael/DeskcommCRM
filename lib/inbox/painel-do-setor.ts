/**
 * O PAINEL DO SETOR — três colunas para quem atende um número só.
 *
 * O Inbox tem sete abas e vários filtros; quem cuida de um setor (o suporte, o
 * comercial) só quer saber três coisas: quem está esperando resposta, quem já
 * está sendo atendido e quem foi atendido hoje. Esta é a REGRA das colunas,
 * separada do React para o teste prender o que entra em cada uma.
 *
 *   - Aguardando: o cliente falou por último. Resposta da IA conta como
 *     atendimento (o que ela não resolve vira Caso, que tem fila própria).
 *     Ordem: quem espera há mais tempo em cima.
 *   - Em atendimento: aberta e com a última palavra nossa. Mais recente em cima.
 *   - Atendidos hoje: encerradas hoje. Mais recente em cima.
 *
 * Por que não `awaiting_since` sozinho: o banco não o limpa quando sai resposta
 * (medido em 23/10: conversa respondida às 17h19 seguia "esperando desde
 * 15h59"). Ele só vale enquanto for posterior à nossa última resposta.
 */

export interface ConversaDoPainel {
  id: string;
  status: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_message_at: string | null;
  awaiting_since: string | null;
  service_closed_at?: string | null;
  status_changed_at?: string | null;
}

export interface ColunasDoPainel<C extends ConversaDoPainel> {
  aguardando: Array<C & { esperandoDesde: string }>;
  emAtendimento: C[];
  atendidosHoje: C[];
}

const ABERTAS = new Set(["open", "claimed", "ai_handling"]);
const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : Number.NaN);

/** O cliente falou por último? (sem resposta nenhuma também conta) */
export function clienteFalouPorUltimo(c: ConversaDoPainel): boolean {
  const entrada = ms(c.last_inbound_at);
  if (Number.isNaN(entrada)) return false;
  const saida = ms(c.last_outbound_at);
  return Number.isNaN(saida) || entrada > saida;
}

/** Desde quando o cliente espera: `awaiting_since` só se for depois da nossa última resposta. */
export function esperandoDesde(c: ConversaDoPainel): string {
  const saida = ms(c.last_outbound_at);
  if (c.awaiting_since && (Number.isNaN(saida) || ms(c.awaiting_since) > saida)) return c.awaiting_since;
  return c.last_inbound_at as string;
}

function mesmoDia(iso: string | null | undefined, agora: Date): boolean {
  if (!iso) return false;
  return new Date(iso).toDateString() === agora.toDateString();
}

export function montarColunas<C extends ConversaDoPainel>(conversas: C[], agora = new Date()): ColunasDoPainel<C> {
  const aguardando: Array<C & { esperandoDesde: string }> = [];
  const emAtendimento: C[] = [];
  const atendidosHoje: C[] = [];
  for (const c of conversas) {
    if (ABERTAS.has(c.status)) {
      if (clienteFalouPorUltimo(c)) aguardando.push({ ...c, esperandoDesde: esperandoDesde(c) });
      else emAtendimento.push(c);
    } else if (c.status === "closed" && mesmoDia(c.service_closed_at ?? c.status_changed_at, agora)) {
      atendidosHoje.push(c);
    }
  }
  aguardando.sort((a, b) => ms(a.esperandoDesde) - ms(b.esperandoDesde));
  const recentePrimeiro = (a: C, b: C) => (ms(b.last_message_at) || 0) - (ms(a.last_message_at) || 0);
  emAtendimento.sort(recentePrimeiro);
  atendidosHoje.sort((a, b) => ms(b.service_closed_at ?? b.status_changed_at) - ms(a.service_closed_at ?? a.status_changed_at));
  return { aguardando, emAtendimento, atendidosHoje };
}

/** "há 25 min", "há 2 h", "há 3 d" — o tempo de espera no cartão. */
export function haQuantoTempo(iso: string, agora = new Date()): string {
  const min = Math.max(0, Math.round((agora.getTime() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}
