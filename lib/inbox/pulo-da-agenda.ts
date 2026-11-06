import { MOTIVO_DO_PULO } from "@/lib/agenda/escolha-no-envio";
import type { Message } from "@/lib/types/messaging";

/**
 * A MENSAGEM QUE O FLUXO MANDOU PULAR POR CAUSA DA AGENDA (#3848).
 *
 * ═══ O que já existia, e por que não se inventa um estado novo ═══
 *
 * A escolha `nao_enviar` (#3813) faz o envio ser descartado quando o contato
 * tem compromisso `pending`/`confirmed`. O registro desse pulo já tem casa:
 * `lib/agenda/escolha-no-envio.ts:55` define `MOTIVO_DO_PULO`, a aba Atividade
 * o rotula e — desde o conserto do mantenedor no #3840 — a linha da mensagem
 * deixa de ficar em `queued` e vira `failed` com `error_code =
 * compromisso_na_agenda` (`app/api/v1/messages/_handler.ts`). Sem isso o
 * redrive do watchdog mandaria pelo canal justamente o que o operador escolheu
 * não mandar.
 *
 * Logo o caso JÁ está identificado no banco: `status = 'failed'` +
 * `error_code = 'compromisso_na_agenda'`. Este módulo não cria coluna, nem
 * status, nem código: ele lê esse par e devolve o pulo para a tela. Quem
 * escreve a linha continua sendo o mesmo caminho de sempre.
 *
 * ═══ O retrato, e por que ele é opcional ═══
 *
 * O código diz QUE foi um pulo; não diz QUAL compromisso barrou. O produtor
 * grava o retrato em `metadata.pulo_da_agenda` no mesmo UPDATE que marca a
 * falha (id, motivo medido pela guarda e o título no instante do pulo). Linhas
 * anteriores a isto — e o pulo cujo retrato não pôde ser lido — não têm a
 * chave: o selo continua aparecendo, só sem o compromisso à vista. Ler daqui é
 * tolerante de propósito: `metadata` é jsonb preenchido por terceiros, e um
 * objeto torto não pode derrubar a bolha.
 */
export const CHAVE_DO_PULO = "pulo_da_agenda";

export interface PuloDaAgenda {
  /** O compromisso que barrou o envio. Nulo quando a linha é anterior ao retrato. */
  appointment_id: string | null;
  /**
   * O que a guarda mediu: `agendado` (ainda vai acontecer), `em_atendimento`
   * (acontecendo agora) ou `presenca_pendente` (terminou e a presença não foi
   * confirmada). Valor fora destes não vira motivo de tela.
   */
  motivo: MotivoMedido | null;
  /** Título do compromisso no instante do pulo — dado do momento, sem releitura. */
  titulo: string | null;
}

export const MOTIVOS_MEDIDOS = ["agendado", "em_atendimento", "presenca_pendente"] as const;
export type MotivoMedido = (typeof MOTIVOS_MEDIDOS)[number];

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor : null;
}

function motivoConhecido(valor: string | null): MotivoMedido | null {
  return valor && (MOTIVOS_MEDIDOS as readonly string[]).includes(valor) ? (valor as MotivoMedido) : null;
}

/**
 * O pulo da agenda nesta mensagem, ou `null` quando ela não é um pulo.
 *
 * O discriminador é o par que o banco já grava — `failed` + o código do pulo —,
 * e não o retrato em `metadata`: uma linha sem retrato ainda é um pulo, e
 * esconder o selo dela seria voltar a mostrar "Falhou" para quem pulou de
 * propósito.
 */
export function puloDaAgendaDaMensagem(
  mensagem: Pick<Message, "status" | "error_code" | "metadata">,
): PuloDaAgenda | null {
  if (mensagem.status !== "failed" || mensagem.error_code !== MOTIVO_DO_PULO) return null;
  const bruto = (mensagem.metadata ?? {})[CHAVE_DO_PULO];
  const retrato =
    bruto && typeof bruto === "object" && !Array.isArray(bruto) ? (bruto as Record<string, unknown>) : {};
  return {
    appointment_id: texto(retrato.appointment_id),
    motivo: motivoConhecido(texto(retrato.motivo)),
    titulo: texto(retrato.titulo),
  };
}

/**
 * O compromisso que barrou, na MESMA rota que o Histórico da agenda e o Radar
 * já usam (`/app/agenda?compromisso=<id>`). Sem id não há para onde levar: a
 * tela não inventa um destino.
 */
export function hrefDoCompromisso(pulo: PuloDaAgenda): string | null {
  return pulo.appointment_id ? `/app/agenda?compromisso=${pulo.appointment_id}` : null;
}

/**
 * O retrato que o produtor grava. Fica aqui, ao lado do leitor, para os dois
 * lados da mesma chave não divergirem no nome do campo.
 */
export function retratoDoPulo(pulo: {
  appointment_id: string | null;
  motivo: string;
  titulo: string | null;
}): Record<string, unknown> {
  return { appointment_id: pulo.appointment_id, motivo: pulo.motivo, titulo: pulo.titulo };
}
