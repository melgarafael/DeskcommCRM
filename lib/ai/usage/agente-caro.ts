/**
 * Quando um agente merece o aviso de "contexto caro" no painel de Uso de IA
 * (#4123).
 *
 * O aviso nasce de um número medido, não de um palpite: a fatia das chamadas de
 * TURNO cuja entrada passou de 100 mil tokens no período. Acima desse limite o
 * Claude Haiku 5.5 cobra 5× pela chamada inteira
 * (`lib/ai/custo-escalonado.ts`), e a causa costuma ser a mesma — base de
 * conhecimento, ferramentas ou histórico grandes demais no prompt.
 *
 * ─── Por que a fatia, e por que um piso de amostra ─────────────────────────
 *
 * Um agente com duas chamadas, uma delas grande, teria "50%" e um aviso que não
 * significa nada. O piso (`MINIMO_DE_CHAMADAS_MEDIDAS`) segura o ruído; o
 * limite (`FATIA_DE_CHAMADAS_QUE_AVISA`) é o que a instalação real da issue
 * mostrou (34% das chamadas de turno acima de 100k): 20% é folgado o bastante
 * para não acusar quem só tem picos.
 *
 * O denominador são as chamadas de turno (`agent_turn` e `followup_turn` — a
 * mesma definição de "turno" de `fn_uso_de_ia`), contadas no banco com
 * `count: "exact"` — nunca somando linhas em JS, que pararia em `max_rows`.
 */
import { LIMITE_DE_ENTRADA_EM_TOKENS } from "@/lib/ai/custo-escalonado";

/** Acima disso (e não "a partir de") o agente merece o aviso. */
export const FATIA_DE_CHAMADAS_QUE_AVISA = 0.2;

/** Abaixo deste número de chamadas no período, a fatia é ruído. */
export const MINIMO_DE_CHAMADAS_MEDIDAS = 20;

export interface MedidaDeTurnos {
  /** Chamadas de turno no período. */
  chamadas: number;
  /** Quantas delas passaram de `LIMITE_DE_ENTRADA_EM_TOKENS`. */
  acima_do_limite: number;
}

export interface AvisoDeContextoCaro {
  /** `false` quando não houve medição (falha do banco) ou amostra pequena. */
  medido: boolean;
  chamadas: number;
  acima_do_limite: number;
  /** 0..1, fracionária — quem formata é a tela. */
  fatia: number;
  /** A mesma fatia em pontos percentuais inteiros, para o texto. */
  percentual: number;
  avisa: boolean;
}

const SEM_MEDICAO: AvisoDeContextoCaro = {
  medido: false,
  chamadas: 0,
  acima_do_limite: 0,
  fatia: 0,
  percentual: 0,
  avisa: false,
};

export function avaliarContextoCaro(medida: MedidaDeTurnos | null): AvisoDeContextoCaro {
  if (!medida) return SEM_MEDICAO;
  const chamadas = Math.max(0, medida.chamadas);
  const acima = Math.min(chamadas, Math.max(0, medida.acima_do_limite));
  const fatia = chamadas > 0 ? acima / chamadas : 0;
  const medido = chamadas >= MINIMO_DE_CHAMADAS_MEDIDAS;
  return {
    medido,
    chamadas,
    acima_do_limite: acima,
    fatia,
    percentual: Math.round(fatia * 100),
    avisa: medido && fatia > FATIA_DE_CHAMADAS_QUE_AVISA,
  };
}

/** Nomes dos propósitos que contam como turno — os mesmos de `fn_uso_de_ia`. */
export const PROPOSITOS_DE_TURNO = ["agent_turn", "followup_turn"] as const;

/** O limite de entrada, reexportado para a tela não repetir o literal. */
export const LIMITE_DE_TOKENS_DE_ENTRADA = LIMITE_DE_ENTRADA_EM_TOKENS;
