/**
 * O que os ROTEIROS de atendimento coletaram de um contato, para a tela — a
 * ficha do contato e o painel da conversa (achado 1 da prova prática do #1130:
 * o dado ia para o banco e não aparecia em tela nenhuma).
 *
 * O valor vem de `contacts.custom_fields` (onde o roteiro grava, PR 1) e o
 * rótulo e a ordem, do grafo publicado do roteiro. Sem modelo: o resumo é
 * montado dos campos (decisão do titular, 23/09).
 */
import { flowGraphSchema, type DestinoDaResposta } from "./graph-schema";
import { destinoDaResposta, mapearChecklist, valoresDoChecklist } from "./atendimento";

export interface CampoDoRoteiro {
  key: string;
  label: string;
  /** `null` = o cliente ainda não respondeu (ou a pergunta foi encerrada). */
  valor: string | null;
  /**
   * Só existe quando a pergunta NÃO grava no contato (#3363): a resposta vale
   * para o card do negócio, então a ficha não tem valor dele para mostrar — e
   * mostrar "não respondido" seria mentira sobre uma pergunta já respondida.
   * A marca é a AUSÊNCIA da chave para o destino de sempre, o mesmo padrão do
   * grafo (`destino` opcional): nenhuma resposta de contato muda de formato.
   */
  onde?: Extract<DestinoDaResposta, "negocio">;
}

export interface RoteiroDoContato {
  enrollment_id: string;
  nome: string;
  status: string;
  iniciado_em: string;
  concluido_em: string | null;
  campos: CampoDoRoteiro[];
}

export interface LinhaDoRoteiro {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  nome: string;
  graph: unknown;
}

/** Puro: as linhas do banco viram o que a tela mostra, na ordem das perguntas. */
export function montarRoteirosDoContato(
  linhas: readonly LinhaDoRoteiro[],
  customFields: unknown,
): RoteiroDoContato[] {
  const saida: RoteiroDoContato[] = [];
  for (const linha of linhas) {
    const grafo = flowGraphSchema.safeParse(linha.graph);
    if (!grafo.success) continue;
    const checklist = mapearChecklist(grafo.data);
    if (!checklist.ok) continue;
    const valores = valoresDoChecklist(checklist.checklist, customFields);
    saida.push({
      enrollment_id: linha.id,
      nome: linha.nome,
      status: linha.status,
      iniciado_em: linha.started_at,
      concluido_em: linha.completed_at,
      campos: checklist.checklist.passos.flatMap((p) =>
        p.kind === "collect"
          ? [
              {
                key: p.node.config.key,
                label: p.node.config.label,
                valor: valores[p.node.config.key] ?? null,
                // A MESMA régua do fluxo (`destinoDaResposta`): pergunta de
                // negócio não tem valor no contato, e a ficha diz onde ele está.
                ...(destinoDaResposta(p.node.config) === "negocio"
                  ? { onde: "negocio" as const }
                  : {}),
              },
            ]
          : [],
      ),
    });
  }
  return saida;
}
