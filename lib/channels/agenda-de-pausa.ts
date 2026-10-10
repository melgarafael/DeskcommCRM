/**
 * A JANELA DE MANUTENÇÃO — a régua pura da pausa agendada (issue #2388).
 *
 * ─── O defeito que este módulo fecha ────────────────────────────────────────
 *
 * A pausa existe só como ação manual imediata (`metadata.disabled`, escrita pela
 * RPC `fn_definir_canal_desativado` da 0545). Nada volta para retomar: a janela
 * de manutenção vira "alguém acorda às 3h para clicar" ou "o número fica
 * pausado até segunda ordem", e enquanto isso a entrega é gravada e some da
 * inbox em silêncio.
 *
 * ─── Por que a ORIGEM da pausa é a régua, e não detalhe ──────────────────────
 *
 * `disabled: true` sozinho não diz quem pausou. Se a agenda retomasse tudo que
 * estiver desligado, ela sobrescreveria a pausa MANUAL que o operador fez
 * DURANTE a janela (critério 3 da issue) e assumiria a posse de uma pausa manual
 * já existente antes dela. Daí `disabled_by` (`manual` × `schedule`) e
 * `disabled_schedule_id` (QUAL janela) — gravados pela mesma escrita atômica da
 * 0545. Ausente ou nulo = pausa manual ou chave de banco anterior: sem origem
 * ninguém retoma às cegas.
 *
 * ─── Relógio INJETADO ───────────────────────────────────────────────────────
 *
 * `acaoDaAgenda` não lê `Date.now()`: quem chama passa o instante. É o que
 * permite provar a borda do fim de janela com um teste determinístico (o cron
 * chama com `new Date()`), e é o critério 2 da issue — teste com relógio
 * injetado, nunca `sleep`.
 *
 * ─── Relógio de PAREDE × instante ────────────────────────────────────────────
 *
 * O `starts_at`/`ends_at` do banco é timestamptz: instante absoluto. A tela é
 * que monta o instante a partir da hora de parede no fuso DA ORGANIZAÇÃO
 * (`instanteDe`, lib/agenda/fuso) — assim a janela atravessa a virada de
 * horário de verão sem "um a mais" nem "um a menos" (critério 7). Aqui dentro só
 * há comparação de instantes, e trocar os dois nunca dá nada.
 */
import { canalDesativado } from "@/lib/channels/desativado";

export type StatusDaAgenda = "scheduled" | "running" | "done" | "cancelled";

export type AgendaDePausa = {
  starts_at: string;
  ends_at: string;
  status: StatusDaAgenda | string;
};

/** O que o cron faz com a agenda nesta batida. */
export type AcaoDaAgenda =
  /** ainda não abriu a janela — espera a próxima batida; */
  | "aguardando"
  /** janela abriu: pausa o escopo ainda ligado (se nada da outra ponta rodar, fica assim até o fim); */
  | "pausar"
  /** janela fechou: retoma SÓ o que esta agenda pausou; */
  | "retomar"
  /** não faz nada (dentro da janela já pausada, cancelada ou encerrada); */
  | "nada"
  /** agendada que já passou inteira: NÃO pausa depois do fim, só encerra; */
  | "expirada";

const instanteDe = (valor: string | Date): number =>
  valor instanceof Date ? valor.getTime() : new Date(valor).getTime();

/**
 * A régua da janela, em instantes absolutos.
 *
 * Ordem que importa: o ESTADO manda antes do relógio (cancelada e encerrada não
 * se mexem), e uma agenda que nunca chegou a rodar e cuja janela já passou é
 * `expirada` — pausar às 6h uma janela das 3h às 5h seria pior que não pausar.
 */
export function acaoDaAgenda(agenda: AgendaDePausa, agora: Date): AcaoDaAgenda {
  const inicio = instanteDe(agenda.starts_at);
  const fim = instanteDe(agenda.ends_at);
  const t = agora.getTime();

  if (agenda.status === "cancelled" || agenda.status === "done") return "nada";

  if (agenda.status === "running") {
    return t < fim ? "nada" : "retomar";
  }

  // scheduled (ou estado futuro que ainda nem começou)
  if (t < inicio) return "aguardando";
  if (t < fim) return "pausar";
  return "expirada";
}

/** Quem a agenda pode pausar: ligado e não arquivado (o `where` da RPC cuida do arquivado). */
export function canalElegivelParaPausa(metadata: unknown): boolean {
  return !canalDesativado(metadata);
}

/**
 * Quem a agenda pode retomar: pausado POR ESTA janela.
 *
 * A ausência de origem (chave de banco anterior à 0626) não elegibiliza: o
 * desconhecido não é retomado às cegas.
 */
export function canalElegivelParaRetomada(metadata: unknown, agendaId: string): boolean {
  if (!canalDesativado(metadata)) return false;
  const m = (metadata ?? {}) as Record<string, unknown>;
  if (m.disabled_by !== "schedule") return false;
  return m.disabled_schedule_id === agendaId;
}

/**
 * A OUTRA janela aberta agora que também cobre o canal — quem herda a pausa
 * quando esta termina.
 *
 * Sem isto, duas janelas sobrepostas religavam o canal no meio da segunda: a
 * que começa com o canal já pausado não toma posse dele (`canalElegivelParaPausa`
 * pula), e o fim da primeira o devolvia ao ar. Com isto, o fim da primeira passa
 * a posse para a que continua aberta, e é o fim DELA que retoma.
 *
 * "Aberta" é viva (`scheduled`/`running`) com `starts_at <= agora < ends_at`:
 * a agendada que abre no mesmo minuto em que a outra fecha também conta, seja
 * qual for a ordem em que a batida as lê.
 */
export function janelaQueHerdaAPausa<
  T extends AgendaDePausa & { id: string; organization_id: string; channel_session_id: string | null },
>(agenda: T, canalId: string, vivas: readonly T[], agora: Date): T | undefined {
  const t = agora.getTime();
  return vivas.find(
    (outra) =>
      outra.id !== agenda.id &&
      outra.organization_id === agenda.organization_id &&
      (outra.channel_session_id === null || outra.channel_session_id === canalId) &&
      (outra.status === "scheduled" || outra.status === "running") &&
      instanteDe(outra.starts_at) <= t &&
      t < instanteDe(outra.ends_at),
  );
}
