import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/ttl";

/** Transporte do knob existente ao computed field; não autoriza nenhum envio. */
export function headersDaLeituraDoInbox(ambiente: Record<string, string | undefined>) {
  return { "x-deskcomm-ai-allowlist-ttl-ms": String(ttlDaAutorizacaoMs(ambiente)) };
}
