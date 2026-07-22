/**
 * Parte NATIVA de mídia para o turno (Onda 3, camada de aprimoramento).
 * Capability-gated: só emite image/file para provider+modelo conhecidos por
 * aceitá-los; caso contrário [] e o derivado textual (já no contexto) cobre.
 * Usa signed URL curta do bucket privado — o provider baixa, nunca base64.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { LeadContextMessage } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { modelCapabilities } from "@/lib/agent-engine/edge/llm/capabilities";

const SIGNED_TTL_S = 300;

export type NativeMediaPart =
  | { type: "image"; image: URL }
  | { type: "file"; data: URL; mediaType: string };

export interface BuildNativeMediaPartsArgs {
  messages: LeadContextMessage[];
  provider: string;
  model: string;
  multimodalInput: boolean;
  admin: SupabaseClient;
  /** teto de mídias anexadas (default 1: só a inbound mais recente). */
  maxItems?: number;
}

export async function buildNativeMediaParts(args: BuildNativeMediaPartsArgs): Promise<NativeMediaPart[]> {
  if (!args.multimodalInput) return [];
  const caps = modelCapabilities(args.provider, args.model);
  if (!caps.image && !caps.pdf) return [];

  const maxItems = args.maxItems ?? 1;
  // mais recentes primeiro (o array vem em ordem cronológica asc → reverse)
  const candidates = [...args.messages]
    .reverse()
    .filter((m) => m.direction === "inbound" && m.media_storage_path)
    .slice(0, maxItems);

  const parts: NativeMediaPart[] = [];
  for (const m of candidates) {
    const mime = (m.media_mime ?? "").split(";")[0]!.trim().toLowerCase();
    const isImage = m.type === "image" && mime.startsWith("image/") && caps.image;
    const isPdf = m.type === "document" && mime === "application/pdf" && caps.pdf;
    if (!isImage && !isPdf) continue;

    const signed = await args.admin.storage.from("whatsapp-media").createSignedUrl(m.media_storage_path!, SIGNED_TTL_S);
    if (signed.error || !signed.data?.signedUrl) continue;
    const url = new URL(signed.data.signedUrl);
    if (isImage) parts.push({ type: "image", image: url });
    else parts.push({ type: "file", data: url, mediaType: "application/pdf" });
  }
  return parts;
}
