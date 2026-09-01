/**
 * Reexporta a fábrica do canal físico PRÉ-seam do agent-engine
 * (`lib/agent-engine/edge/channel/waha-adapter.ts`, dívida conhecida de
 * `scripts/lint-channels.ts`) por um caminho que não nomeia o provider.
 *
 * Quem precisa do MESMO `ChannelAdapter` que `followup-turn.ts` usa para a
 * re-entrada determinística — sem inventar um segundo caminho de rede pro
 * canal físico — importa daqui, nunca do arquivo concreto (doutrina de
 * restrição de canal, invariante 1). Este módulo mora em `lib/channels/` de
 * propósito: é a pasta que a própria varredura já exclui do scan.
 */
export { defaultChannelAdapter } from "../agent-engine/edge/channel/waha-adapter";
