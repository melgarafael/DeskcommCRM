/**
 * Canal de SMS (#4415) — a porta para quem está fora de `lib/channels/`.
 *
 * As rotas de conexão (app/api/v1/channels/sms) e de exclusão de conexão
 * (app/api/v1/channel-sessions/[id]) precisam falar com o fornecedor, mas não
 * podem importar um módulo que leva o nome dele (invariante 1 da doutrina de
 * restrição de canal). Elas importam daqui; o fornecedor fica dentro desta
 * pasta.
 */
import { CHANNEL_PROVIDER_TWILIO } from "../capabilities";

export { acharNumeroNaConta, apontarRecebimentoDoNumero, type AchadoDoNumero } from "./twilio";
export { ROTULO_DO_CANAL_SMS } from "./credentials";
export { acharSessaoDeSms, salvarSessaoDeSms, type SessaoDeSms } from "./session";
export { encerrarConexaoDeSms, type EncerramentoDoSms } from "./desconectar";

/** O provider do canal de SMS, pelo nome do canal — para a rota de exclusão comparar sem nomear o fornecedor. */
export const PROVEDOR_DO_CANAL_SMS = CHANNEL_PROVIDER_TWILIO;
