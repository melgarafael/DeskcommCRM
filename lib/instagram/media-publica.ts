/**
 * Uma URL temporária e pública pra mídia que já está no nosso Storage
 * privado — a Graph API busca a mídia ela mesma via HTTP, então precisa
 * conseguir alcançá-la sem nenhuma credencial nossa.
 *
 * Mesmo mecanismo de `app/api/v1/messages/[id]/media/route.ts`
 * (`createSignedUrl`), com TTL maior: um container de Reels pode levar
 * minutos processando antes da Meta terminar de buscar/transcodificar o
 * vídeo, e uma URL de 1h (o padrão do resto do repo) some no meio do
 * processo em caso de retry.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const TTL_SEGUNDOS = 30 * 60;

export interface MidiaDaMensagem {
  url: string;
  mime: string | null;
  tipo: "image" | "video" | "outro";
}

export async function urlPublicaTemporaria(
  admin: SupabaseClient,
  organizationId: string,
  messageId: string,
): Promise<MidiaDaMensagem | null> {
  const { data: msg } = await admin
    .from("messages")
    .select("organization_id, media_storage_path, media_mime")
    .eq("id", messageId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!msg?.media_storage_path) return null;

  const { data: signed, error } = await admin.storage
    .from("whatsapp-media")
    .createSignedUrl(msg.media_storage_path, TTL_SEGUNDOS);
  if (error || !signed?.signedUrl) return null;

  const mime = (msg.media_mime as string | null) ?? null;
  const tipo = mime?.startsWith("image/") ? "image" : mime?.startsWith("video/") ? "video" : "outro";

  return { url: signed.signedUrl, mime, tipo };
}
