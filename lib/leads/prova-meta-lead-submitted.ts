import type { AtribuicaoDeAnuncio } from "./atribuicao-de-anuncio";

export const CHAVE_ANCORA_CTWA = "meta_ctwa_message_v1";
export const CHAVE_PROVA_NASCIMENTO_META = "meta_capi_lead_birth_v1";

/** O clique pertence à mensagem atual; `adId` identifica o anúncio, não o clique. */
export function ancoraCtwaDaMensagem(
  atribuicao: AtribuicaoDeAnuncio | null,
): Record<string, unknown> {
  const clique = atribuicao?.sourceId?.trim();
  if (atribuicao?.plataforma !== "meta_ads" || !clique || clique.length > 512) return {};
  return {
    [CHAVE_ANCORA_CTWA]: {
      platform: "meta_ads",
      source_type: "ad",
      ctwa_clid: clique,
    },
  };
}

export interface ProvaMetaLeadSubmitted {
  platform: "meta_ads";
  source_type: "ad";
  ctwa_clid: string;
  message_id: string;
  conversation_id: string;
  captured_at: string;
}

export function lerProvaMetaLeadSubmitted(metadata: unknown): ProvaMetaLeadSubmitted | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const proof = (metadata as Record<string, unknown>)[CHAVE_PROVA_NASCIMENTO_META];
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return null;
  const p = proof as Record<string, unknown>;
  if (
    p.platform !== "meta_ads" ||
    p.source_type !== "ad" ||
    typeof p.ctwa_clid !== "string" ||
    !p.ctwa_clid.trim() ||
    p.ctwa_clid.length > 512 ||
    typeof p.message_id !== "string" ||
    !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(p.message_id) ||
    typeof p.conversation_id !== "string" ||
    !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(p.conversation_id) ||
    typeof p.captured_at !== "string" ||
    !Number.isFinite(Date.parse(p.captured_at))
  )
    return null;
  return p as unknown as ProvaMetaLeadSubmitted;
}

export function removerProvaMetaLeadSubmitted(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const { [CHAVE_PROVA_NASCIMENTO_META]: _proof, ...rest } = metadata ?? {};
  return rest;
}

/** Respostas genéricas mostram a origem comercial sem expor a prova interna. */
export function ocultarProvaMetaNaResposta<T extends Record<string, unknown>>(lead: T): T {
  const metadata = lead.source_metadata;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !(CHAVE_PROVA_NASCIMENTO_META in metadata)
  )
    return lead;
  return {
    ...lead,
    source_metadata: removerProvaMetaLeadSubmitted(metadata as Record<string, unknown>),
  };
}
