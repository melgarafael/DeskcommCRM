/**
 * A porta de entrada do seam. Feature nenhuma importa `lib/waha/*` direto —
 * pede o adapter do provider da conversa e o descritor de capabilities.
 */
import { metaCloudAdapter } from "./adapters/meta-cloud";
import { wahaAdapter } from "./adapters/waha";
import { zernioAdapter } from "./adapters/zernio";
import type { ChannelAdapter, ChannelProvider, ProviderDeMensagem } from "./types";

/**
 * Um adapter por provider de MENSAGEM. `wacalls` não entra: ele não endereça
 * destinatário nem envia envelope — ver `ProviderDeMensagem` em `./types`.
 */
const ADAPTERS: Record<ProviderDeMensagem, ChannelAdapter | null> = {
  waha: wahaAdapter,
  meta_cloud: metaCloudAdapter,
  zernio: zernioAdapter,
};

/**
 * Fail-closed: provider sem adapter (ou fora da matriz) lança em vez de cair no
 * WAHA por default. Enviar pelo canal errado é pior que não enviar.
 */
export function getAdapter(provider: ChannelProvider): ChannelAdapter {
  const adapter = ADAPTERS[provider as ProviderDeMensagem];
  if (!adapter) throw new Error(`unknown_channel_provider: ${provider}`);
  return adapter;
}

export {
  capabilitiesOf,
  CHANNEL_CAPABILITIES,
  DEFAULT_CHANNEL_PROVIDER,
  PROVIDERS_DE_MENSAGEM,
  PROVIDERS_SEM_MENSAGEM,
  canalConhecidoSemMensagem,
  transportaMensagem,
} from "./capabilities";
export { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "./session-ref";
export type { ChannelSessionRef } from "./session-ref";
export type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelProvider,
  ProviderDeMensagem,
  OutboundEnvelope,
  OutboundKind,
  OutboundMedia,
  RecipientInput,
} from "./types";
