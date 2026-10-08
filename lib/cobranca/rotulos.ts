import type { EstadoDaAssinatura } from "./vocabulario";

/**
 * O estado da assinatura em linguagem de quem opera (chaves de `t()`), para as
 * telas do dono e da empresa. `Record` exaustivo: estado novo em
 * ESTADOS_DA_ASSINATURA não compila sem rótulo.
 */
export const ROTULO_DO_ESTADO: Record<EstadoDaAssinatura, string> = {
  trial: "Teste grátis",
  ativa: "Em dia",
  em_atraso: "Em atraso",
  cancelada: "Cancelada",
};
