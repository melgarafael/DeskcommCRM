/**
 * Os consumidores do barramento que pertencem aos CANAIS — o ponto por onde
 * `lib/event-log/register-handlers.ts` os registra sem nomear provedor
 * (doutrina de restrição de canal: fora de `lib/channels/`, nenhum nome de
 * transporte). Quem acrescenta um consumidor de canal acrescenta aqui.
 */
import type { EventHandler } from "@/lib/event-log/dispatcher";

import { pinoReintentoHandler } from "./zernio/pino-reintento.handler";

export const CONSUMIDORES_DOS_CANAIS: readonly EventHandler[] = [
  // O pino que entrou só com o marcador: a API do canal não respondeu a tempo.
  pinoReintentoHandler,
];
