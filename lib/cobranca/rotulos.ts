import type { ErroDeLeitura, EstadoDaAssinatura } from "./vocabulario";

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

/** O último erro de leitura em linguagem do dono (tela Clientes). */
export const ROTULO_DO_ERRO: Record<ErroDeLeitura, string> = {
  credencial_invalida: "A chave não funciona mais",
  provedor_fora: "Provedor fora do ar",
  pagamento_de_assinatura_cancelada: "Pagou uma assinatura já cancelada",
  leitura_invalida: "Cliente não encontrado no provedor",
};
