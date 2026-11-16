import { z } from "zod";

import { MAXIMO_DE_FOTOS } from "@/lib/catalogo/fotos";
import { MAX_VOICE_BYTES, VOICE_MIME } from "@/lib/messaging/media/voice-constants";

export const BUCKET_DA_APRESENTACAO = "catalog-presentation-media";
export const TAMANHO_MAXIMO_DO_AUDIO = MAX_VOICE_BYTES;
export const MIME_DO_AUDIO_DA_APRESENTACAO = VOICE_MIME;
export const MAXIMO_DE_MENSAGENS_FISICAS_POR_ITEM = 2 + MAXIMO_DE_FOTOS + 1;

export const presentationKindSchema = z.enum(["text", "audio"]);
export type PresentationKind = z.infer<typeof presentationKindSchema>;

const expectedUpdatedAt = z.string().datetime({ offset: true }).nullable();

export const catalogProductPresentationPatchSchema = z
  .object({
    enabled: z.boolean(),
    kind: presentationKindSchema,
    title: z.string().trim().max(200).nullable(),
    text_content: z.string().trim().max(4096).nullable(),
    use_catalog_photos: z.boolean(),
    show_price: z.boolean(),
    expected_updated_at: expectedUpdatedAt,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled && value.kind === "text" && !value.text_content?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["text_content"],
        message: "Escreva o texto antes de ativar a apresentação.",
      });
    }
  });

export const catalogProductPresentationAudioMutationSchema = z
  .object({ expected_updated_at: expectedUpdatedAt })
  .strict();

export interface CatalogProductPresentationRow {
  id: string;
  organization_id: string;
  catalog_product_id: string;
  enabled: boolean;
  kind: PresentationKind;
  title: string | null;
  text_content: string | null;
  use_catalog_photos: boolean;
  show_price: boolean;
  audio_storage_path: string | null;
  audio_mime: string | null;
  audio_size_bytes: number | null;
  created_at: string;
  updated_at: string;
}

export interface CatalogProductPresentationPublic {
  enabled: boolean;
  kind: PresentationKind;
  title: string | null;
  text_content: string | null;
  use_catalog_photos: boolean;
  show_price: boolean;
  has_audio: boolean;
  audio_mime: string | null;
  audio_size_bytes: number | null;
  audio_url: string | null;
  updated_at: string | null;
}

export function emptyCatalogProductPresentation(): CatalogProductPresentationPublic {
  return {
    enabled: false,
    kind: "text",
    title: null,
    text_content: null,
    use_catalog_photos: true,
    show_price: false,
    has_audio: false,
    audio_mime: null,
    audio_size_bytes: null,
    audio_url: null,
    updated_at: null,
  };
}

export function publicCatalogProductPresentation(
  row: CatalogProductPresentationRow | null,
  audioUrl: string | null = null,
): CatalogProductPresentationPublic {
  if (!row) return emptyCatalogProductPresentation();
  const hasAudio = Boolean(row.audio_storage_path);
  return {
    enabled: row.enabled,
    kind: row.kind,
    title: row.title,
    text_content: row.text_content,
    use_catalog_photos: row.use_catalog_photos,
    show_price: row.show_price,
    has_audio: hasAudio,
    audio_mime: hasAudio ? row.audio_mime : null,
    audio_size_bytes: hasAudio ? row.audio_size_bytes : null,
    audio_url: hasAudio ? audioUrl : null,
    updated_at: row.updated_at,
  };
}

const UUID_OGG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ogg$/;

export function audioPertenceAoProduto(path: string, organizationId: string, productId: string): boolean {
  const prefix = `${organizationId}/${productId}/`;
  return path.startsWith(prefix) && UUID_OGG.test(path.slice(prefix.length));
}

/** O container e o codec saem dos bytes, não do Content-Type do navegador. */
export function isOggOpus(bytes: Uint8Array): boolean {
  if (bytes.length < 36) return false;
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.slice(start, start + length));
  if (ascii(0, 4) !== "OggS") return false;
  const limit = Math.min(bytes.length - 8, 256);
  for (let index = 0; index <= limit; index += 1) {
    if (ascii(index, 8) === "OpusHead") return true;
  }
  return false;
}

export type PresentationBlocker =
  | "incomplete_configuration"
  | "missing_audio"
  | "missing_photos"
  | "physical_limit_exceeded";

export interface PresentationPreviewInput {
  product_name: string;
  kind: PresentationKind;
  title: string | null;
  text_content: string | null;
  use_catalog_photos: boolean;
  show_price: boolean;
  has_audio: boolean;
  photo_count: number;
}

export function catalogProductPresentationPreview(input: PresentationPreviewInput): {
  effective_title: string;
  physical_message_count: number;
  blockers: PresentationBlocker[];
} {
  const blockers: PresentationBlocker[] = [];
  if (input.kind === "text" && !input.text_content?.trim()) blockers.push("incomplete_configuration");
  if (input.kind === "audio" && !input.has_audio) blockers.push("missing_audio");
  if (input.use_catalog_photos && input.photo_count === 0) blockers.push("missing_photos");

  // Texto: título + corpo na mesma bolha. Áudio: título e player são dois envios.
  const presentationMessages = input.kind === "audio" ? 2 : 1;
  const physicalMessageCount =
    presentationMessages +
    (input.use_catalog_photos ? input.photo_count : 0) +
    (input.show_price ? 1 : 0);
  if (physicalMessageCount > MAXIMO_DE_MENSAGENS_FISICAS_POR_ITEM) {
    blockers.push("physical_limit_exceeded");
  }

  return {
    effective_title: input.title?.trim() || input.product_name,
    physical_message_count: physicalMessageCount,
    blockers,
  };
}
