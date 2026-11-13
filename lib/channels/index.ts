/**
 * A porta de entrada do seam. Feature nenhuma importa `lib/waha/*` direto —
 * pede o adapter do provider da conversa e o descritor de capabilities.
 */
import { datafyAdapter } from "./adapters/datafy";
import { metaCloudAdapter } from "./adapters/meta-cloud";
import { olxAdapter } from "./adapters/olx";
import { wahaAdapter } from "./adapters/waha";
import { socialAdapter } from "./social/adapter";
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
  zernio_social: socialAdapter,
  datafy: datafyAdapter,
  olx: olxAdapter,
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

/**
 * Os providers cujo adapter sabe perguntar se um número TEM conta
 * (`numeroTemConta`). Derivado dos adapters, não de uma lista à mão: quem
 * implementar o método entra sozinho. É o que o SQL usa para escolher uma
 * conexão capaz de perguntar, sem nomear provider fora deste diretório.
 */
export function provedoresQueConferemNumero(): ProviderDeMensagem[] {
  return (Object.keys(ADAPTERS) as ProviderDeMensagem[]).filter(
    (p) => typeof ADAPTERS[p]?.numeroTemConta === "function",
  );
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
  ContatoDoAparelho,
  ProviderDeMensagem,
  OutboundEnvelope,
  OutboundKind,
  OutboundMedia,
  RecipientInput,
} from "./types";
