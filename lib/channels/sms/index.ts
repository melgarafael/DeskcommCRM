/**
 * Canal de SMS (#4415) — a porta para quem está fora de `lib/channels/`.
 *
 * A rota de conexão (app/api/v1/channels/sms) precisa conferir a conta e
 * apontar o recebimento do número, mas não pode importar um módulo que leva o
 * nome do fornecedor (invariante 1 da doutrina de restrição de canal). Ela
 * importa daqui; o fornecedor fica dentro desta pasta.
 */
export { acharNumeroNaConta, apontarRecebimentoDoNumero, type AchadoDoNumero } from "./twilio";
export { ROTULO_DO_CANAL_SMS } from "./credentials";
export { acharSessaoDeSms, salvarSessaoDeSms, type SessaoDeSms } from "./session";
