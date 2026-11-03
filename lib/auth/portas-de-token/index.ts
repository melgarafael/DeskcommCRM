/**
 * As portas de token das fatias R da Spec 33, juntas, na ordem em que entram em
 * `PUBLIC_PATHS`. Um arquivo por fatia para que as três andem em paralelo sem
 * disputar as mesmas linhas.
 */
import { MODELOS_DA_CONFIGURACAO } from "./configuracao";
import { MODELOS_DA_LEITURA } from "./leitura";
import { MODELOS_DA_OPERACAO } from "./operacao";
import { portaDeToken, type ModeloDePorta } from "./porta";

export { FORMA_DE_UUID, caminhoDoModelo, portaDeToken, type ModeloDePorta } from "./porta";

export const MODELOS_DE_PORTA: readonly ModeloDePorta[] = [
  ...MODELOS_DA_CONFIGURACAO,
  ...MODELOS_DA_OPERACAO,
  ...MODELOS_DA_LEITURA,
];

export const PORTAS_DE_TOKEN: RegExp[] = MODELOS_DE_PORTA.map(portaDeToken);
