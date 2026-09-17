/**
 * A janela de 24 horas, do lado de QUEM ATENDE.
 *
 * ─── O que faltava ─────────────────────────────────────────────────────────
 *
 * A regra existe e é dura: nos canais com hetero-restrição (a API oficial, e
 * portanto também o parceiro que a intermedia), texto livre só sai enquanto o
 * cliente escreveu nas últimas 24 horas. Fora disso, apenas modelo aprovado —
 * a plataforma recusa com 131047.
 *
 * `windowRemainingMs` calcula isso desde sempre. Só que o ÚNICO consumidor era
 * o guardrail do agente de IA: o humano não via nada. Ele abria a conversa, não
 * tinha como saber que restavam vinte minutos, escrevia depois e recebia um
 * `failed` com um número de cinco dígitos.
 *
 * ─── Por que a tela não pergunta QUAL canal é ──────────────────────────────
 *
 * O invariante 1 da doutrina proíbe nomear provider fora de `lib/channels/` —
 * e é por isso que este arquivo existe aqui e não no componente. A tela recebe
 * um estado já decidido e não sabe (nem precisa saber) de quem é a regra.
 *
 * ─── Por que o estado é derivado a cada leitura ────────────────────────────
 *
 * Mesma razão pela qual não existe coluna de expiração (ver
 * `guardrails/messaging-window.ts`): a janela é uma CONTA sobre
 * `last_inbound_at`, e guardá-la criaria uma segunda verdade que envelhece
 * sozinha — parecendo autoritativa justamente quando já está errada.
 */
import { capabilitiesOf, canalConhecidoSemMensagem } from "./capabilities";
import { WINDOW_MS, windowRemainingMs } from "@/lib/agent-engine/guardrails/messaging-window";
import type { ChannelProvider } from "./types";

export type EstadoDaJanela =
  /** Canal sem restrição de janela: não há relógio a mostrar. */
  | { tipo: "sem_restricao" }
  /** Dá para escrever livremente; `restanteMs` é quanto falta para fechar. */
  | { tipo: "aberta"; restanteMs: number }
  /**
   * Fechada: só modelo aprovado sai daqui.
   *
   * `fechadaHaMs` é HÁ QUANTO TEMPO fechou — não quando o cliente escreveu.
   * É a pergunta que o operador faz de verdade ("passei muito?"), e a distância
   * até o vencimento é o que decide se ainda vale insistir ou se a conversa
   * esfriou. `null` quando o cliente nunca escreveu: aí não houve fechamento, e
   * inventar um número seria descrever um prazo que nunca correu.
   */
  | { tipo: "fechada"; fechadaHaMs: number | null };

/**
 * O estado da janela desta conversa, agora.
 *
 * `provider` nulo devolve `sem_restricao` — conversa sem sessão resolvida não
 * tem regra conhecida, e inventar "fechada" faria a tela travar um envio que
 * talvez saísse sem problema.
 */
export function estadoDaJanela(
  provider: string | null | undefined,
  lastInboundAt: string | null,
  agora: Date,
): EstadoDaJanela {
  if (!provider) return { tipo: "sem_restricao" };
  if (canalConhecidoSemMensagem(provider)) return { tipo: "sem_restricao" };

  const caps = capabilitiesOf(provider as ChannelProvider);
  // `freeformOutsideWindow: true` = o canal aceita texto livre a qualquer hora.
  // Mostrar um relógio nele seria inventar uma urgência que não existe.
  if (caps.freeformOutsideWindow) return { tipo: "sem_restricao" };

  if (!lastInboundAt) return { tipo: "fechada", fechadaHaMs: null };

  const ultimo = new Date(lastInboundAt);
  const restanteMs = windowRemainingMs(agora, ultimo);
  if (restanteMs > 0) return { tipo: "aberta", restanteMs };

  // Quanto passou DEPOIS do vencimento, não desde a mensagem: os dois números
  // diferem em exatamente 24h, e o que o operador pergunta é "passei muito?".
  const fechadaHaMs = Math.max(0, agora.getTime() - (ultimo.getTime() + WINDOW_MS));
  return { tipo: "fechada", fechadaHaMs };
}

/**
 * "23h 40m", "40m", "3m".
 *
 * Sem segundos: um número que muda sozinho na tela puxa o olho para o relógio
 * em vez da conversa, e a decisão que ele apoia ("escrevo agora ou mando
 * modelo?") não muda por causa de trinta segundos.
 *
 * Abaixo de um minuto vira "menos de 1m" e não "0m", que se lê como fechada —
 * e ainda dá para escrever.
 */
export function formatarRestante(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return "menos de 1m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * "3d", "5h", "20m" — quanto tempo passou desde que fechou.
 *
 * Uma unidade só, ao contrário do restante: aqui o número não apoia nenhuma
 * decisão fina (já fechou; a saída é a mesma), e "2d 7h 13m" pediria leitura
 * para responder o que "2d" já responde. No restante os minutos importam porque
 * decidem entre escrever agora e montar um modelo.
 */
export function formatarDecorrido(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "agora mesmo";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Está perto de fechar? Muda a cor do selo, não o texto.
 *
 * Duas horas porque é o horizonte em que ainda dá para AGIR — perguntar algo,
 * fechar um combinado — sem precisar de modelo. Alertar às vinte horas
 * restantes seria ruído; alertar aos cinco minutos chegaria tarde.
 */
export const LIMIAR_URGENTE_MS = 2 * 60 * 60 * 1000;

export { WINDOW_MS };
