/** Probabilidade de SIM, não taxa de acerto. Dúvida chama a revisão de reserva. */
import type { Resposta } from "@/lib/ai/decisao/cliente";
import type { PromiseClassification } from "./semantic";

export const LIMITES_DA_REVISAO = { nao: 0.2, sim: 0.8 } as const;
export const SINAIS_DA_REVISAO = ["comercial", "retorno", "so_assistente"] as const;
export type SinalDaRevisao = (typeof SINAIS_DA_REVISAO)[number];
export type ProbabilidadesDaRevisao = Record<SinalDaRevisao, number>;

export type DecisaoDaRevisao =
  | { motivo: "decidiu"; probabilidades: ProbabilidadesDaRevisao; veredito: PromiseClassification }
  | { motivo: "duvida"; probabilidades: ProbabilidadesDaRevisao; campo: SinalDaRevisao }
  | { motivo: "resposta_ilegivel"; campo: SinalDaRevisao };

export function decidirRevisao(respostas: Readonly<Record<string, Resposta>>): DecisaoDaRevisao {
  const probabilidades = {} as ProbabilidadesDaRevisao;
  for (const campo of SINAIS_DA_REVISAO) {
    const r = respostas[campo];
    if (r?.tipo !== "noul" || !Number.isFinite(r.noul) || r.noul < 0 || r.noul > 1) {
      return { motivo: "resposta_ilegivel", campo };
    }
    probabilidades[campo] = r.noul;
  }
  for (const campo of SINAIS_DA_REVISAO) {
    // Sem retorno operacional, sua autoria não influencia o gate de caso/follow-up.
    if (campo === "so_assistente" && probabilidades.retorno <= LIMITES_DA_REVISAO.nao) continue;
    const p = probabilidades[campo];
    if (p > LIMITES_DA_REVISAO.nao && p < LIMITES_DA_REVISAO.sim) {
      return { motivo: "duvida", campo, probabilidades };
    }
  }
  const retorno = probabilidades.retorno >= LIMITES_DA_REVISAO.sim;
  return {
    motivo: "decidiu", probabilidades,
    veredito: {
      isPromise: probabilidades.comercial >= LIMITES_DA_REVISAO.sim,
      suspectPhrase: null, // O JEV classifica; não inventar uma frase que ele não devolve.
      prometeuRetornoHumano: retorno,
      retornoSoDoAssistente: retorno && probabilidades.so_assistente >= LIMITES_DA_REVISAO.sim,
    },
  };
}
