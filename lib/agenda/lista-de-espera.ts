/**
 * LISTA DE ESPERA — QUEM QUER ENCAIXE E QUEM CABE NA VAGA QUE ABRIU.
 *
 * Função PURA: sem banco, sem relógio (`agora` é parâmetro) e sem rede. O que
 * mora aqui é a decisão — cabe ou não cabe, e em que ordem —, porque é ela que
 * precisa ser provada por teste em todos os cantos; a escrita mora em
 * `encaixe.ts`.
 *
 * ─── O que isto resolve, em uma frase ─────────────────────────────────────
 *
 * Uma desmarcação abre um horário. Hoje quem sabia disso era a recepcionista, e
 * o "quero encaixe" de quem pediu antes vivia num caderno. A inscrição é a
 * MARCA no sistema; esta função responde, quando o horário abre, *quem da fila
 * cabe nele*.
 *
 * ─── As quatro perguntas, nesta ordem, e por que a ordem importa ──────────
 *
 * 1. **A vaga comporta o serviço?** A duração vem do MOLDE
 *    (`calendar_event_types.duration_minutes`), nunca do que a pessoa disse: um
 *    encaixe de 30 min num buraco de 20 min é a agenda prometendo o que não
 *    cabe.
 * 2. **É o profissional que ela pediu?** Sem preferência (`owner_user_id`
 *    nulo), qualquer um serve — é o caso mais comum e o que a recepcionista faz
 *    à mão.
 * 3. **O horário cai numa janela que ela ofereceu?** Janela VAZIA significa
 *    "qualquer horário", mesma régua do `windows` do roteamento — e o oposto da
 *    da agenda, que documenta em `horarios-livres.ts`. Aqui é lista de espera,
 *    não jornada: quem não restringiu não pode ser excluído.
 * 4. **Dá tempo de avisar?** Duas antecedências se somam por MAIOR, não por
 *    menor: a da inscrição ("só consigo com 2 dias") e a do serviço
 *    (`minimum_notice_minutes`, que a 0177 já descreve como "o que impede a
 *    agenda de aceitar um encaixe que o atendente não tem como cumprir").
 *
 * Depois disso, a ORDEM: urgência (maior primeiro) e, no empate, ordem de
 * chegada. É a fila que a recepcionista já faz na cabeça, só que escrita.
 *
 * ─── Limite declarado: nada aqui cruza a meia-noite ───────────────────────
 *
 * Um serviço que começa 23:30 e termina 00:30 não cabe em janela nenhuma desta
 * régua, e a janela `22:00–02:00` é descartada (fim antes do início). É a mesma
 * limitação do motor de horários livres, e está escrita para ser encontrada
 * antes de alguém vender atendimento noturno — não depois.
 */
import { z } from "zod";

import { scheduleWindowSchema, type ScheduleWindow } from "@/lib/schemas/routing";
import { rotuloLocal } from "@/lib/tempo/agora";

import { diaDaSemanaLocal, partesNoFuso } from "./fuso";

/** A situação da inscrição. Espelha `calendar_waitlist_status_check`. */
export type SituacaoDaEspera = "waiting" | "offered" | "booked" | "expired" | "cancelled";

/** O "quero encaixe" de uma pessoa — uma linha de `calendar_waitlist`. */
export interface InscricaoNaEspera {
  id: string;
  contactId: string;
  eventTypeId: string;
  /** `null` = qualquer profissional que atenda o serviço. */
  ownerUserId: string | null;
  /** Vazio = qualquer horário. `dow` segue a régua do roteamento (0 = domingo). */
  janelas: ScheduleWindow[];
  antecedenciaMinimaHoras: number;
  /** `null` = sem prazo: vale até ser atendida ou cancelada. */
  validoAte: Date | null;
  /** Maior primeiro. Empate desempata pela ordem de chegada (`createdAt`). */
  urgencia: number;
  createdAt: Date;
  /** Início da última vaga que a pessoa recusou ou deixou vencer. */
  vagaRecusadaInicio?: Date | null;
}

/** A vaga que abriu: o intervalo que a desmarcação liberou. */
export interface VagaAberta {
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
  ownerUserId: string | null;
  /** Fuso da agenda — é nele que as janelas da inscrição são lidas. */
  timeZone: string;
}

/** O molde do atendimento, do jeito que a decisão precisa dele. */
export interface ServicoDaEspera {
  eventTypeId: string;
  nome: string;
  duracaoMinutos: number;
  avisoMinimoMinutos: number;
}

export type MotivoDeRecusa =
  | "vaga_no_passado"
  | "servico_nao_cabe"
  | "profissional_diferente"
  | "fora_da_janela"
  | "antecedencia_insuficiente"
  | "inscricao_vencida"
  | "vaga_ja_recusada";

export type DecisaoDeEncaixe =
  | { cabe: true }
  | { cabe: false; motivo: MotivoDeRecusa };

const MINUTOS_DA_OFERTA = z.number().int().min(1).max(1440);

/**
 * Os prazos da oferta são escolha de cada organização (doc 208): sem valor
 * padrão, sem fallback. Configuração que não passa aqui deixa o recurso
 * desligado, e o `.catch` de leitura seria o defeito que a decisão proíbe.
 */
export const configDaListaDeEsperaSchema = z
  .strictObject({
    ativa: z.boolean(),
    /** Quanto tempo, no máximo, a vaga fica segurada para uma pessoa. */
    prazo_maximo_minutos: MINUTOS_DA_OFERTA,
    /** Folga entre o fim do prazo e o início da vaga. */
    margem_antes_minutos: z.number().int().min(0).max(1440),
    /** Prazo menor que este não dá tempo de responder: a vaga nem é oferecida. */
    prazo_minimo_minutos: MINUTOS_DA_OFERTA,
  })
  .refine((c) => c.prazo_minimo_minutos <= c.prazo_maximo_minutos, {
    message: "O prazo mínimo não pode passar do máximo.",
  });
export type ConfigDaListaDeEspera = z.infer<typeof configDaListaDeEsperaSchema>;

/** As janelas de uma inscrição, na escrita e na leitura: a mesma régua do roteamento. */
export const janelasDaEsperaSchema = z.array(scheduleWindowSchema).max(50);

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" em minutos desde a meia-noite. `null` = texto que não é hora. */
export function minutosDaParede(hora: string): number | null {
  const m = HHMM.exec(hora.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutos de parede e dia da semana LOCAIS daquele instante. */
function paredeLocal(instante: Date, fuso: string): { dow: number; minutos: number } {
  const p = partesNoFuso(instante, fuso);
  return { dow: diaDaSemanaLocal(instante, fuso), minutos: p.hora * 60 + p.minuto };
}

/**
 * O atendimento inteiro cai numa janela oferecida?
 *
 * ⚠️ O FIM TAMBÉM TEM DE CABER. Janela `09:00–12:00` com serviço de 60 min aceita
 * 11:00, não 11:30 — quem termina 12:30 está fora do que a pessoa disse que
 * podia. É a diferença entre "cabe o começo" e "cabe o atendimento", e a versão
 * anterior desta função comparava só o início.
 *
 * Janela com texto inválido não casa (`minutosDaParede` devolve `null`), e a
 * leitura da inscrição recusa a linha antes de chegar aqui: a falha é fechada,
 * do lado que não promete horário.
 */
export function cabeNaJanela(
  janelas: readonly ScheduleWindow[],
  inicio: Date,
  duracaoMinutos: number,
  fuso: string,
): boolean {
  if (janelas.length === 0) return true;
  const { dow, minutos } = paredeLocal(inicio, fuso);
  const fim = minutos + duracaoMinutos;
  // Nada cruza a meia-noite neste módulo: quem termina depois dela não casa.
  if (fim > 24 * 60) return false;
  return janelas.some((janela) => {
    if (janela.dow !== dow) return false;
    const de = minutosDaParede(janela.start);
    const ate = minutosDaParede(janela.end);
    if (de === null || ate === null) return false;
    return minutos >= de && fim <= ate;
  });
}

/**
 * A vaga serve para esta inscrição? Devolve o MOTIVO da recusa, e não um
 * booleano: é o motivo que o teste consegue cobrar caso a caso, e é ele que a
 * tela vai poder mostrar quando a equipe perguntar "por que fulano não foi
 * chamado?".
 */
export function decideEncaixe(
  vaga: VagaAberta,
  servico: ServicoDaEspera,
  inscricao: InscricaoNaEspera,
  agora: Date,
): DecisaoDeEncaixe {
  const inicio = vaga.startsAt.getTime();
  const fimDaVaga = vaga.endsAt.getTime();
  if (inicio <= agora.getTime()) return { cabe: false, motivo: "vaga_no_passado" };
  if (inscricao.vagaRecusadaInicio?.getTime() === inicio) {
    return { cabe: false, motivo: "vaga_ja_recusada" };
  }
  const duracaoMs = servico.duracaoMinutos * 60_000;
  if (inicio + duracaoMs > fimDaVaga) return { cabe: false, motivo: "servico_nao_cabe" };
  if (inscricao.ownerUserId !== null && inscricao.ownerUserId !== vaga.ownerUserId) {
    return { cabe: false, motivo: "profissional_diferente" };
  }
  if (!cabeNaJanela(inscricao.janelas, vaga.startsAt, servico.duracaoMinutos, vaga.timeZone)) {
    return { cabe: false, motivo: "fora_da_janela" };
  }
  if (inscricao.validoAte !== null && inscricao.validoAte.getTime() < agora.getTime()) {
    return { cabe: false, motivo: "inscricao_vencida" };
  }
  const antecedenciaMs =
    Math.max(inscricao.antecedenciaMinimaHoras * 60, servico.avisoMinimoMinutos) * 60_000;
  if (inicio - agora.getTime() < antecedenciaMs) {
    return { cabe: false, motivo: "antecedencia_insuficiente" };
  }
  return { cabe: true };
}

/**
 * A fila inteira, já na ordem de chamada — urgência primeiro, chegada depois.
 *
 * `id` fecha o desempate para a ordem ser DETERMINÍSTICA: duas inscrições do
 * mesmo instante (import de planilha, dois cliques) não podem alternar entre
 * rodadas, senão o teste fica intermitente e a recepção vê ordem differente a
 * cada abertura de vaga.
 */
export function ordenarFila(inscricoes: readonly InscricaoNaEspera[]): InscricaoNaEspera[] {
  return [...inscricoes].sort(
    (a, b) =>
      b.urgencia - a.urgencia ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
}

export interface CandidatoAoEncaixe {
  inscricao: InscricaoNaEspera;
  servico: ServicoDaEspera;
}

/**
 * Quem da fila CABE, na ordem de chamada. `servico` é consultado sob demanda
 * porque duas inscrições podem ser de atendimentos diferentes — e um molde
 * apagado simplesmente não entra na conta. É uma lista, e não só o primeiro:
 * quem cabe na decisão ainda pode não poder ser avisado, e aí chama o seguinte.
 */
export function candidatosAoEncaixe(
  vaga: VagaAberta,
  fila: readonly InscricaoNaEspera[],
  servicoDe: (eventTypeId: string) => ServicoDaEspera | null,
  agora: Date,
): CandidatoAoEncaixe[] {
  const candidatos: CandidatoAoEncaixe[] = [];
  for (const inscricao of ordenarFila(fila)) {
    const servico = servicoDe(inscricao.eventTypeId);
    if (servico && decideEncaixe(vaga, servico, inscricao, agora).cabe) {
      candidatos.push({ inscricao, servico });
    }
  }
  return candidatos;
}

/** O primeiro da fila que cabe. */
export function escolherCandidato(
  vaga: VagaAberta,
  fila: readonly InscricaoNaEspera[],
  servicoDe: (eventTypeId: string) => ServicoDaEspera | null,
  agora: Date,
): CandidatoAoEncaixe | null {
  return candidatosAoEncaixe(vaga, fila, servicoDe, agora)[0] ?? null;
}

/**
 * Até quando a vaga fica segurada para a primeira pessoa da fila, pelos prazos
 * da organização: o teto, ou a margem antes do início, o que vier primeiro.
 *
 * Devolve `null` quando não sobra o prazo mínimo — e aí a vaga NÃO é oferecida.
 * Uma oferta que nasce vencida é promessa que não se cumpre; o horário segue
 * livre para quem aparecer na conversa.
 */
export function prazoDaOferta(
  vaga: VagaAberta,
  agora: Date,
  config: ConfigDaListaDeEspera,
): Date | null {
  const limite = Math.min(
    vaga.startsAt.getTime() - config.margem_antes_minutos * 60_000,
    agora.getTime() + config.prazo_maximo_minutos * 60_000,
  );
  if (limite - agora.getTime() < config.prazo_minimo_minutos * 60_000) return null;
  return new Date(limite);
}

/** "terça 03/11 às 14:00, até 15:30" — o texto que o agente manda. */
export function textoDaOferta(
  vaga: VagaAberta,
  servico: ServicoDaEspera,
  expiraEm: Date,
): string {
  const quando = rotuloLocal(vaga.startsAt, vaga.timeZone);
  const limite = rotuloLocal(expiraEm, vaga.timeZone);
  const ate = limite.slice(-5);
  return (
    `Abriu ${quando} para ${servico.nome} (${servico.duracaoMinutos} min). ` +
    `Quer esse horário? Me responde SIM até ${ate} — se eu não tiver resposta até lá, ` +
    `ele vai para a próxima pessoa da lista.`
  );
}
