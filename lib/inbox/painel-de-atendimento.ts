/**
 * O PAINEL DE ATENDIMENTO — três colunas para quem atende um número só.
 *
 * O Inbox tem sete abas e vários filtros; quem cuida de um número (o suporte, o
 * comercial) só quer saber três coisas: quem está esperando resposta, quem já
 * está sendo atendido e quem foi atendido hoje. Esta é a REGRA das colunas e das
 * consultas, separada do React para o teste prender as duas no mesmo conjunto.
 *
 *   - Aguardando: o cliente falou por último, ou a conversa foi entregue à equipe
 *     e ninguém assumiu (a régua da aba Fila: `comando_da_conversa`). Resposta da
 *     IA conta como atendimento (o que ela não resolve vira Caso, que tem fila
 *     própria). Ordem: quem espera há mais tempo em cima.
 *   - Em atendimento: viva e com a última palavra nossa. Mais recente em cima.
 *   - Atendidos hoje: encerradas no dia da organização. Mais recente em cima.
 *
 * Por que não `awaiting_since` sozinho: o banco não o limpa quando sai resposta
 * (medido em 23/10: conversa respondida às 17h19 seguia "esperando desde
 * 15h59"). Fora da régua da Fila, ele só vale enquanto for posterior à nossa
 * última resposta.
 */

import { comandosDaFila, esperaDaConversa, silencioVigente, STATUS_ENCERRADOS } from "@/lib/inbox/comando-da-conversa";
import { inicioDoDia } from "@/lib/notifications/push-de-venda";
import { dataIsoNoFuso } from "@/lib/propostas/data-no-fuso";

export interface ConversaDoPainel {
  id: string;
  status: string;
  comando_da_conversa?: string | null;
  created_at: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_message_at: string | null;
  awaiting_since: string | null;
  service_closed_at?: string | null;
  status_changed_at?: string | null;
  bot_silenced_until?: string | null;
  is_group?: boolean | null;
  contacts?: { force_human?: boolean | null; is_blocked?: boolean | null } | null;
}

export interface ColunasDoPainel<C extends ConversaDoPainel> {
  aguardando: Array<C & { esperandoDesde: string }>;
  emAtendimento: C[];
  atendidosHoje: C[];
}

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : Number.NaN);

/**
 * As três consultas da tela. A rota corta em 100, e por isso há duas para as
 * conversas vivas: `abertas` vem por última mensagem, e sozinha perderia justo
 * quem espera há mais tempo. `fila` é a pergunta da aba Fila (`tabToFilter`, caso
 * `unassigned`), que vem na ordem da espera. Ela pede `comando`, não
 * `assigned_to=unassigned`: "sem dono" inclui a conversa que o robô já respondeu,
 * cujo `awaiting_since` antigo tomaria o topo dos 100.
 */
export function consultasDoPainel({
  numero,
  automaticoDaOrg,
  fuso,
  agora = new Date(),
}: {
  numero: string;
  automaticoDaOrg: boolean | undefined;
  fuso: string | null | undefined;
  agora?: Date;
}) {
  const filtroNumero = numero ? `&channel_session_id=${numero}` : "";
  const desde = encodeURIComponent(inicioDoDia(agora, fuso).toISOString());
  return {
    abertas: `/api/v1/conversations?exclude_finished=true&limit=100${filtroNumero}`,
    fila: `/api/v1/conversations?comando=${comandosDaFila(automaticoDaOrg).join(",")}&limit=100${filtroNumero}`,
    encerradas: `/api/v1/conversations?status=closed&closed_since=${desde}&limit=100${filtroNumero}`,
  };
}

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

/**
 * A conversa entregue à equipe segue na espera até alguém assumir, como na Fila.
 * O `status` não decide: passada pelo motor, ela fica `open` com silêncio
 * `infinity` (medido na prova de tela do #3403).
 *
 * A Fila também mostra a conversa sem dono nos 5 min depois de uma resposta manual.
 * Essa janela não entra: alguém acabou de responder, e ela volta sozinha ao
 * automático, então o cartão iria para Aguardando e sairia de lá sem ninguém agir.
 * O silêncio é lido sem depender do relógio: quem disse `aguardando` foi o banco, e
 * a janela vencer no navegador antes da próxima consulta não muda a resposta.
 */
function esperaUmaPessoa(c: ConversaDoPainel, agora: Date): boolean {
  if (c.comando_da_conversa !== "aguardando") return false;
  if (c.is_group || c.contacts?.force_human || c.contacts?.is_blocked) return true;
  return c.bot_silenced_until == null || silencioVigente(c.bot_silenced_until, agora).duravel;
}

/**
 * O automático está no comando? É o selo do Inbox, e não `assignee_kind`: `'ai'` só
 * é gravado ao devolver a conversa (`devolverAtendimentoAoAgente`, que o encerramento
 * também chama), e o motor não o grava ao responder.
 */
export function automaticoNoComando(c: ConversaDoPainel, automaticoDaOrg: boolean | undefined): boolean {
  return automaticoDaOrg === true && c.comando_da_conversa === "automatico";
}

export function montarColunas<C extends ConversaDoPainel>(
  conversas: C[],
  fuso: string | null | undefined,
  agora = new Date(),
): ColunasDoPainel<C> {
  const aguardando: Array<C & { esperandoDesde: string }> = [];
  const emAtendimento: C[] = [];
  const atendidosHoje: C[] = [];
  const hoje = dataIsoNoFuso(agora, fuso ?? "");
  // A mesma conversa pode vir de `abertas` e de `fila`.
  for (const c of new Map(conversas.map((conversa) => [conversa.id, conversa])).values()) {
    if (STATUS_ENCERRADOS.has(c.status)) {
      const encerrada = c.service_closed_at ?? c.status_changed_at;
      if (c.status === "closed" && encerrada && dataIsoNoFuso(new Date(encerrada), fuso ?? "") === hoje) {
        atendidosHoje.push(c);
      }
    } else if (esperaUmaPessoa(c, agora)) {
      aguardando.push({ ...c, esperandoDesde: esperaDaConversa(c) ?? c.created_at });
    } else if (clienteFalouPorUltimo(c)) {
      aguardando.push({ ...c, esperandoDesde: esperandoDesde(c) });
    } else {
      emAtendimento.push(c);
    }
  }
  aguardando.sort((a, b) => ms(a.esperandoDesde) - ms(b.esperandoDesde));
  const recentePrimeiro = (a: C, b: C) => (ms(b.last_message_at) || 0) - (ms(a.last_message_at) || 0);
  emAtendimento.sort(recentePrimeiro);
  atendidosHoje.sort((a, b) => ms(b.service_closed_at ?? b.status_changed_at) - ms(a.service_closed_at ?? a.status_changed_at));
  return { aguardando, emAtendimento, atendidosHoje };
}

/** "25 min", "2 h", "3 d" — o tempo de espera no cartão, sempre para baixo. */
export function haQuantoTempo(iso: string, agora = new Date()): string {
  const min = Math.max(0, Math.floor((agora.getTime() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}
