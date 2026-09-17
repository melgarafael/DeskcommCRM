/**
 * As inscrições de follow-up que o seed de demonstração grava — o estado de cada
 * uma e a TRILHA que levou a ele.
 *
 * ⚠️ VIVE FORA DO SEEDER PELO MESMO MOTIVO DO GRAFO (`grafo-de-demonstracao.ts`):
 * o seeder roda `main()` ao ser importado, e aqui é só dado. É o que deixa
 * `tests/unit/followups-de-demonstracao-sao-possiveis.test.ts` reencenar cada
 * trilha com o motor DE VERDADE (`runFollowupTick`, `completeTurnForEnrollment`,
 * `applyReactivityEvent`) e reprovar o passo que ele não gravaria.
 *
 * A primeira versão mostrava, no dossiê de "Follow-up · esperando resposta":
 * "Começou 15/09" com passos de 12/09 e 13/09; os passos como "código: enrolled"
 * e "código: node_entered" — este nenhum código do repositório emite, e o
 * primeiro só a falta à consulta do `baseline.sql`; e "Aguardando resposta" no nó
 * da mensagem sem nenhum envio antes. `followup_enrollment_events` é texto livre
 * no banco, e a tela traduz o que não conhece com o `default` de
 * `descreveEvento` — então a trilha impossível era gravada sem erro e mostrada
 * como se fosse história.
 *
 * O que vale aqui, e o teste cobra:
 *   • só códigos que o motor grava, com o payload que ele grava;
 *   • a chave de idempotência que ele grava (`${nó}:${passos}`) — não é
 *     cosmético: o motor decide "a espera já começou?" procurando essa chave, e
 *     sem ela a inscrição "aguardando o relógio" recomeçaria a espera em vez de
 *     seguir quando o relógio vencer;
 *   • datas em ordem, a partir do início da inscrição, e nada no futuro;
 *   • o estado da linha é o que o motor deixa depois do último passo.
 */
import {
  ESPERA_MS,
  NO_ESPERA,
  NO_FIM,
  NO_INICIO,
  NO_MENSAGEM,
  NO_RESPOSTA,
  PRAZO_DA_RESPOSTA_MS,
} from "./grafo-de-demonstracao";

/** O ponteiro do fluxo — a política de handoff decide o que um atendimento humano faz com a inscrição. */
export const PONTEIRO_DE_DEMONSTRACAO = {
  name: "Retomada de contato (demonstração)",
  handoff_policy: "pause",
  trigger_config: { kind: "manual" },
} as const;

/**
 * Quem gravou o passo. Serve a quem lê (o dossiê distingue motor, pessoa e
 * cliente) e ao teste, que chama a porta real correspondente para reencená-lo.
 */
export type OrigemDoPasso =
  /** o tick do cron (`followup-flow-worker`, 1×/min) */
  | "motor"
  /** o worker que concluiu o envio da mensagem */
  | "envio"
  /** uma pessoa assumiu a conversa (`ai.handoff_triggered`, drenado pela reatividade) */
  | "atendimento_humano";

export interface PassoDeDemonstracao {
  origem: OrigemDoPasso;
  node_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  created_at: string;
}

export interface EstadoDaInscricao {
  status: "active" | "waiting_reply" | "paused_handoff" | "completed";
  current_node_id: string;
  steps_taken: number;
  next_eval_at: string | null;
  outcome: "exhausted" | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface InscricaoDeDemonstracao {
  contato: { nome: string; telefone: string };
  estado: EstadoDaInscricao;
  /** A trilha depende do id da inscrição: a chave de uma reação do motor o carrega. */
  passos(inscricaoId: string): PassoDeDemonstracao[];
}

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
/** O cron do scheduler bate a cada minuto: é o intervalo entre dois passos do motor. */
const TICK = MINUTO;
/** O worker pega o turno enfileirado e conclui o envio em segundos. */
const ENVIO = 30_000;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Monta a trilha passo a passo, no relógio do mundo em que ela aconteceu.
 *
 * Passo do motor e do envio SOMA em `steps_taken` e usa a chave `${nó}:${passos}`;
 * reação a atendimento humano NÃO soma e usa a chave da reatividade. É a regra
 * de `applyResult` (engine.ts), `completeTurnForEnrollment` (turn-bridge.ts) e
 * `applyStep` (reactivity.ts) — escrita aqui, conferida lá pelo teste.
 */
class Trilha {
  private relogio: number;
  private dados = 0;
  private readonly montadores: Array<(inscricaoId: string) => PassoDeDemonstracao> = [];

  constructor(readonly inicio: number) {
    this.relogio = inicio;
  }

  get agora(): number {
    return this.relogio;
  }

  get passosDados(): number {
    return this.dados;
  }

  passo(
    origem: Exclude<OrigemDoPasso, "atendimento_humano">,
    node_id: string,
    event_type: string,
    depoisDe: number,
    payload: (quando: number) => Record<string, unknown> = () => ({}),
  ): this {
    this.relogio += depoisDe;
    const quando = this.relogio;
    const idempotency_key = `${node_id}:${this.dados}`;
    this.dados += 1;
    this.montadores.push(() => ({
      origem,
      node_id,
      event_type,
      payload: payload(quando),
      idempotency_key,
      created_at: iso(quando),
    }));
    return this;
  }

  atendimentoHumano(node_id: string, depoisDe: number, idDoEvento: string, statusAnterior: string): this {
    this.relogio += depoisDe;
    const quando = this.relogio;
    this.montadores.push((inscricaoId) => ({
      origem: "atendimento_humano",
      node_id,
      event_type: "handoff_paused",
      payload: { prior_status: statusAnterior },
      idempotency_key: `reactivity:${idDoEvento}:${inscricaoId}:handoff_paused`,
      created_at: iso(quando),
    }));
    return this;
  }

  passos(inscricaoId: string): PassoDeDemonstracao[] {
    return this.montadores.map((montar) => montar(inscricaoId));
  }
}

/** Início → espera começou. O comum de toda inscrição manual deste fluxo. */
function comecaAEsperar(inicio: number): Trilha {
  return new Trilha(inicio)
    .passo("motor", NO_INICIO, "node_advanced", TICK, () => ({ next_node_id: NO_ESPERA }))
    .passo("motor", NO_ESPERA, "wait_started", TICK, (t) => ({ next_eval_at: iso(t + ESPERA_MS) }));
}

/** ...espera venceu → mensagem enviada → esperando o cliente. */
function mandaEEsperaResposta(trilha: Trilha): Trilha {
  return trilha
    .passo("motor", NO_ESPERA, "node_advanced", ESPERA_MS + TICK, () => ({ next_node_id: NO_MENSAGEM }))
    .passo("motor", NO_MENSAGEM, "turn_enqueued", TICK, () => ({
      purpose: "send_message",
      wake_status: "active",
    }))
    .passo("envio", NO_MENSAGEM, "action_sent", ENVIO)
    .passo("motor", NO_RESPOSTA, "wait_started", TICK, (t) => ({
      next_eval_at: iso(t + PRAZO_DA_RESPOSTA_MS),
      wake_status: "waiting_reply",
    }));
}

/**
 * As quatro inscrições, uma por estado que a Fila distingue.
 *
 * `idDoEventoDeAtendimento` é o id da linha de `event_log` que teria pausado a
 * inscrição — a reatividade o grava na chave. O seed passa um uuid novo; o
 * teste, um fixo.
 */
export function inscricoesDeDemonstracao(agoraMs: number, idDoEventoDeAtendimento: string): InscricaoDeDemonstracao[] {
  // Aguardando o relógio: a espera começou há 18 h e vence daqui a ~6 h.
  const relogio = comecaAEsperar(agoraMs - 18 * HORA);

  // Esperando resposta: a mensagem saiu há ~8 h; o prazo do cliente vence em ~1 dia e meio.
  const resposta = mandaEEsperaResposta(comecaAEsperar(agoraMs - ESPERA_MS - 8 * HORA));

  // Pausado por atendimento: uma pessoa assumiu a conversa durante a espera.
  const pausado = comecaAEsperar(agoraMs - 10 * HORA).atendimentoHumano(
    NO_ESPERA,
    7 * HORA,
    idDoEventoDeAtendimento,
    "active",
  );

  // Concluído: ninguém respondeu no prazo, e o fluxo acabou há ~6 h.
  const concluido = mandaEEsperaResposta(comecaAEsperar(agoraMs - ESPERA_MS - PRAZO_DA_RESPOSTA_MS - 6 * HORA))
    .passo("motor", NO_RESPOSTA, "node_advanced", PRAZO_DA_RESPOSTA_MS + TICK, () => ({ next_node_id: NO_FIM }))
    .passo("motor", NO_FIM, "flow_completed", TICK, () => ({ outcome: "exhausted", cancel_reason: null }));

  return [
    {
      contato: { nome: "Follow-up · aguardando o relógio", telefone: "+5511970000101" },
      estado: {
        status: "active",
        current_node_id: NO_ESPERA,
        steps_taken: relogio.passosDados,
        next_eval_at: iso(relogio.agora + ESPERA_MS),
        outcome: null,
        started_at: iso(relogio.inicio),
        updated_at: iso(relogio.agora),
        completed_at: null,
      },
      passos: (id) => relogio.passos(id),
    },
    {
      contato: { nome: "Follow-up · esperando resposta", telefone: "+5511970000102" },
      estado: {
        status: "waiting_reply",
        current_node_id: NO_RESPOSTA,
        steps_taken: resposta.passosDados,
        next_eval_at: iso(resposta.agora + PRAZO_DA_RESPOSTA_MS),
        outcome: null,
        started_at: iso(resposta.inicio),
        updated_at: iso(resposta.agora),
        completed_at: null,
      },
      passos: (id) => resposta.passos(id),
    },
    {
      contato: { nome: "Follow-up · pausado por atendimento", telefone: "+5511970000103" },
      estado: {
        status: "paused_handoff",
        current_node_id: NO_ESPERA,
        steps_taken: pausado.passosDados,
        next_eval_at: null,
        outcome: null,
        started_at: iso(pausado.inicio),
        updated_at: iso(pausado.agora),
        completed_at: null,
      },
      passos: (id) => pausado.passos(id),
    },
    {
      contato: { nome: "Follow-up · concluído", telefone: "+5511970000104" },
      estado: {
        status: "completed",
        current_node_id: NO_FIM,
        steps_taken: concluido.passosDados,
        next_eval_at: null,
        outcome: "exhausted",
        started_at: iso(concluido.inicio),
        updated_at: iso(concluido.agora),
        completed_at: iso(concluido.agora),
      },
      passos: (id) => concluido.passos(id),
    },
  ];
}
