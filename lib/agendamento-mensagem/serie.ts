/**
 * O QUE ACONTECE DEPOIS DE UMA OCORRÊNCIA da série (segunda parte da #3118).
 *
 * Regra de negócio, em um lugar só:
 *   - encaminhada, falhou ou pulada (número fora do ar + `cancelar`): a série segue
 *     para a PRÓXIMA ocorrência, a partir de agora. Sem rajada: as ocorrências que
 *     passaram enquanto o cron esteve parado não são disparadas de uma vez.
 *   - quem agendou perdeu o acesso à empresa: a série inteira para (`sem_acesso`).
 *   - não há próxima ocorrência (passou do término, ou a série era única): a série
 *     termina com o desfecho dela.
 *
 * Função pura: o cron só grava o que ela devolve.
 */
import { proximaOcorrenciaDepois, type RegraDeRecorrencia } from "@/lib/agendamento-mensagem/recorrencia";

export type DesfechoDaOcorrencia = { status: "encaminhada" | "falhou" | "cancelada"; motivo: string | null };

/** Próximo `scheduled_at` ISO da série, ou `null` quando ela termina neste desfecho. */
export function proximoDaSerie(regra: RegraDeRecorrencia, agora: Date, desfecho: DesfechoDaOcorrencia): string | null {
  if (desfecho.status === "cancelada" && desfecho.motivo === "sem_acesso") return null;
  const proxima = proximaOcorrenciaDepois(regra, agora);
  return proxima ? proxima.toISOString() : null;
}
