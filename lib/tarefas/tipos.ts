/**
 * TAREFA — o lembrete de trabalho interno com prazo.
 *
 * Extraído do PR #418 (@clinicacentrodosorrisosc-code). O que muda em relação
 * ao original é o VOCABULÁRIO: lá a lista misturava tarefas com "agendamentos"
 * lidos de `custom_fields.agendamento_*` do lead, e trazia palavras de clínica
 * (consulta, procedimento, compareceu/faltou) direto no código. Aqui só existe
 * tarefa; compromisso com cliente é a Agenda (`lib/agenda/tipos.ts`), que já
 * tem tabela, horário, local e confirmação.
 *
 * ─── Por que este módulo NÃO tem rótulo em português ────────────────────────
 *
 * Rótulo é interface, e interface passa por `t()` — senão quem escolhe espanhol
 * lê "Concluída" no meio da tela. Aqui ficam os CÓDIGOS e a lógica pura de
 * prazo; a tela decide como cada código se chama. É também o que permite testar
 * a regra de atraso sem montar componente nenhum.
 *
 * ⚠️ A FORMA das duas listas abaixo é requisito de instrumento, não estilo: o
 * extrator de `tests/invariants/vocabulario-banco-x-typescript.test.ts` lê
 * `const X = [...] as const` e compara com o CHECK da migration 0210. Trocar
 * por um `Record` de objetos deixaria o par cego.
 */

export const PRIORIDADES_DA_TAREFA = ["low", "medium", "high", "urgent"] as const;
export type PrioridadeDaTarefa = (typeof PRIORIDADES_DA_TAREFA)[number];

export const SITUACOES_DA_TAREFA = ["pending", "in_progress", "done", "cancelled"] as const;
export type SituacaoDaTarefa = (typeof SITUACOES_DA_TAREFA)[number];

/** Uma linha de `crm_tasks`, como a API a devolve. */
export interface Tarefa {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  /** ISO-8601 com offset. Nula = sem prazo — ver o cabeçalho da migration 0210. */
  due_date: string | null;
  priority: PrioridadeDaTarefa;
  status: SituacaoDaTarefa;
  lead_id: string | null;
  contact_id: string | null;
  assigned_to: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface NovaTarefa {
  title: string;
  description?: string | null;
  due_date?: string | null;
  priority?: PrioridadeDaTarefa;
  status?: SituacaoDaTarefa;
  lead_id?: string | null;
  contact_id?: string | null;
  assigned_to?: string | null;
}

export type EdicaoDaTarefa = Partial<NovaTarefa>;

/** Encerrada de qualquer das duas formas: feita ou desistida. */
export function estaEncerrada(tarefa: Pick<Tarefa, "status">): boolean {
  return tarefa.status === "done" || tarefa.status === "cancelled";
}

/**
 * Atrasada = tem prazo, o prazo passou, e ninguém a encerrou.
 *
 * `agora` é parâmetro para o teste poder fixar o relógio. Sem isso, um caso de
 * "vence hoje às 23h" fica verde de manhã e vermelho à noite — e um teste que
 * depende da hora em que a suíte roda não vigia nada.
 */
export function estaAtrasada(
  tarefa: Pick<Tarefa, "due_date" | "status">,
  agora: Date = new Date(),
): boolean {
  if (!tarefa.due_date) return false;
  if (estaEncerrada(tarefa)) return false;
  return new Date(tarefa.due_date).getTime() < agora.getTime();
}

/**
 * As faixas da lista, na ordem em que a tela as mostra.
 *
 * "Atrasada" vem primeiro porque é a única que pede ação AGORA. "Encerrada"
 * vem por último e não some: quem acabou de marcar como feita precisa ver para
 * onde a linha foi, senão a tarefa parece ter sido apagada.
 */
export const FAIXAS_DE_PRAZO = [
  "atrasada",
  "hoje",
  "esta_semana",
  "mais_tarde",
  "sem_prazo",
  "encerrada",
] as const;
export type FaixaDePrazo = (typeof FAIXAS_DE_PRAZO)[number];

const UM_DIA_MS = 86_400_000;

export function faixaDePrazo(
  tarefa: Pick<Tarefa, "due_date" | "status">,
  agora: Date = new Date(),
): FaixaDePrazo {
  if (estaEncerrada(tarefa)) return "encerrada";
  if (!tarefa.due_date) return "sem_prazo";

  const inicioDeHoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime();
  const inicioDeAmanha = inicioDeHoje + UM_DIA_MS;
  const fimDaSemana = inicioDeHoje + 7 * UM_DIA_MS;
  const prazo = new Date(tarefa.due_date).getTime();

  if (prazo < inicioDeHoje) return "atrasada";
  if (prazo < inicioDeAmanha) return "hoje";
  if (prazo < fimDaSemana) return "esta_semana";
  return "mais_tarde";
}

/**
 * Agrupa para a lista, preservando a ordem de `FAIXAS_DE_PRAZO` e devolvendo
 * só as faixas que têm alguma linha — cabeçalho de grupo vazio é ruído.
 */
export function agrupaPorPrazo<T extends Pick<Tarefa, "due_date" | "status">>(
  tarefas: readonly T[],
  agora: Date = new Date(),
): Array<{ faixa: FaixaDePrazo; tarefas: T[] }> {
  const porFaixa = new Map<FaixaDePrazo, T[]>();
  for (const tarefa of tarefas) {
    const faixa = faixaDePrazo(tarefa, agora);
    const atual = porFaixa.get(faixa);
    if (atual) atual.push(tarefa);
    else porFaixa.set(faixa, [tarefa]);
  }
  return FAIXAS_DE_PRAZO.flatMap((faixa) => {
    const linhas = porFaixa.get(faixa);
    return linhas?.length ? [{ faixa, tarefas: linhas }] : [];
  });
}

/**
 * `YYYY-MM-DD` do prazo no fuso de quem olha, para casar com a célula do
 * calendário.
 *
 * ⚠️ NÃO é `due_date.slice(0, 10)`, que era o que o original fazia. Aquele
 * recorte lê o dia em UTC: uma tarefa marcada para 31/12 às 21h em Brasília
 * (`2026-12-31T21:00-03:00`) tem `2027-01-01` no ISO em UTC e cairia no mês
 * seguinte do calendário — a pessoa marca dezembro e a tarefa some para janeiro.
 */
export function diaLocalDoPrazo(iso: string): string {
  const d = new Date(iso);
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mes}-${dia}`;
}
