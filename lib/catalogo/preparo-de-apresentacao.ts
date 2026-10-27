import { BUCKET_DA_APRESENTACAO } from "@/lib/catalogo/apresentacao";
import { BUCKET_DAS_FOTOS, mimeDaFoto } from "@/lib/catalogo/fotos";
import type { CatalogPresentationPlan } from "@/lib/catalogo/plano-de-apresentacao";
import { kindFromMime } from "@/lib/messaging/media/upload-validation";
import { formatCents } from "@/lib/money";

interface PreparedCatalogPresentationPayloadBase {
  product_id: string;
  product_code: string;
  item_index: number;
  step_index: number;
}

export interface PreparedCatalogPresentationMedia {
  bucket: typeof BUCKET_DA_APRESENTACAO | typeof BUCKET_DAS_FOTOS;
  storage_path: string;
  mime: string;
}

export type PreparedCatalogPresentationPayload =
  | (PreparedCatalogPresentationPayloadBase & {
      kind: "text";
      purpose: "presentation" | "title";
      text: string;
    })
  | (PreparedCatalogPresentationPayloadBase & {
      kind: "audio";
      media: PreparedCatalogPresentationMedia;
    })
  | (PreparedCatalogPresentationPayloadBase & {
      kind: "image";
      position: number;
      media: PreparedCatalogPresentationMedia;
    })
  | (PreparedCatalogPresentationPayloadBase & {
      kind: "price";
      text: string;
      price_cents: number;
      currency: string;
    });

export interface PreparedCatalogPresentation {
  payloads: PreparedCatalogPresentationPayload[];
  physical_payload_count: number;
}

interface PayloadLocation {
  product_id: string;
  product_code: string;
  item_index: number;
  step_index: number;
}

type MediaKind = "audio" | "image";

export type CatalogPresentationPreparationFailure =
  | ({
      code: "message_item_mismatch";
      message_product_id: string;
      message_product_code: string;
    } & PayloadLocation)
  | ({
      code: "invalid_media_step";
      reason:
        "invalid_storage_path" | "unsupported_image_path" | "missing_mime" | "mime_kind_mismatch";
      media_kind: MediaKind;
      storage_path: string;
      mime: string | null;
    } & PayloadLocation)
  | {
      code: "media_reused_between_items";
      bucket: string;
      storage_path: string;
      first: { product_id: string; product_code: string };
      second: { product_id: string; product_code: string };
    }
  | {
      code: "physical_count_mismatch";
      expected: number;
      actual: number;
      product_id?: string;
      product_code?: string;
    };

export type CatalogPresentationPreparationResult =
  | { ok: true; prepared: PreparedCatalogPresentation }
  | { ok: false; error: CatalogPresentationPreparationFailure };

const SUPPORTED_IMAGE_PATH = /\.(?:jpg|png)$/;

/**
 * Traduz, sem reordenar, o plano canônico em payloads físicos provider-agnostic.
 * Não lê nem copia bytes: apenas resolve e valida os metadados já presentes no plano.
 */
export function prepareCatalogPresentationPayloads(
  plan: CatalogPresentationPlan,
): CatalogPresentationPreparationResult {
  const payloads: PreparedCatalogPresentationPayload[] = [];
  const mediaOwners = new Map<
    string,
    { product_id: string; product_code: string; bucket: string; storage_path: string }
  >();

  for (const [itemIndex, item] of plan.items.entries()) {
    const beforeItem = payloads.length;

    for (const [stepIndex, message] of item.messages.entries()) {
      const location: PayloadLocation = {
        product_id: item.product_id,
        product_code: item.product_code,
        item_index: itemIndex,
        step_index: stepIndex,
      };

      if (message.product_id !== item.product_id || message.product_code !== item.product_code) {
        return {
          ok: false,
          error: {
            code: "message_item_mismatch",
            ...location,
            message_product_id: message.product_id,
            message_product_code: message.product_code,
          },
        };
      }

      if (message.kind === "text") {
        payloads.push({
          kind: "text",
          purpose: message.purpose,
          text: message.text,
          ...location,
        });
        continue;
      }

      if (message.kind === "price") {
        payloads.push({
          kind: "price",
          text: formatCents(message.price_cents, message.currency),
          price_cents: message.price_cents,
          currency: message.currency,
          ...location,
        });
        continue;
      }

      const mediaKind = message.kind;
      const storagePath = message.storage_path;
      const mime = mediaKind === "audio" ? message.mime : mimeDaFoto(storagePath);
      const bucket: PreparedCatalogPresentationMedia["bucket"] =
        mediaKind === "audio" ? BUCKET_DA_APRESENTACAO : BUCKET_DAS_FOTOS;

      if (!storagePath || storagePath.trim() !== storagePath) {
        return {
          ok: false,
          error: {
            code: "invalid_media_step",
            reason: "invalid_storage_path",
            media_kind: mediaKind,
            storage_path: storagePath,
            mime,
            ...location,
          },
        };
      }
      if (mediaKind === "image" && !SUPPORTED_IMAGE_PATH.test(storagePath)) {
        return {
          ok: false,
          error: {
            code: "invalid_media_step",
            reason: "unsupported_image_path",
            media_kind: mediaKind,
            storage_path: storagePath,
            mime: null,
            ...location,
          },
        };
      }
      if (!mime.trim()) {
        return {
          ok: false,
          error: {
            code: "invalid_media_step",
            reason: "missing_mime",
            media_kind: mediaKind,
            storage_path: storagePath,
            mime,
            ...location,
          },
        };
      }
      if (kindFromMime(mime) !== mediaKind) {
        return {
          ok: false,
          error: {
            code: "invalid_media_step",
            reason: "mime_kind_mismatch",
            media_kind: mediaKind,
            storage_path: storagePath,
            mime,
            ...location,
          },
        };
      }

      const mediaKey = `${bucket}\u0000${storagePath}`;
      const firstOwner = mediaOwners.get(mediaKey);
      if (
        firstOwner &&
        (firstOwner.product_id !== item.product_id || firstOwner.product_code !== item.product_code)
      ) {
        return {
          ok: false,
          error: {
            code: "media_reused_between_items",
            bucket,
            storage_path: storagePath,
            first: {
              product_id: firstOwner.product_id,
              product_code: firstOwner.product_code,
            },
            second: { product_id: item.product_id, product_code: item.product_code },
          },
        };
      }
      mediaOwners.set(mediaKey, {
        product_id: item.product_id,
        product_code: item.product_code,
        bucket,
        storage_path: storagePath,
      });

      const media = { bucket, storage_path: storagePath, mime };
      if (mediaKind === "audio") {
        payloads.push({ kind: "audio", media, ...location });
      } else {
        payloads.push({ kind: "image", position: message.position, media, ...location });
      }
    }

    const actualItemCount = payloads.length - beforeItem;
    if (actualItemCount !== item.physical_message_count) {
      return {
        ok: false,
        error: {
          code: "physical_count_mismatch",
          expected: item.physical_message_count,
          actual: actualItemCount,
          product_id: item.product_id,
          product_code: item.product_code,
        },
      };
    }
  }

  if (payloads.length !== plan.physical_message_count) {
    return {
      ok: false,
      error: {
        code: "physical_count_mismatch",
        expected: plan.physical_message_count,
        actual: payloads.length,
      },
    };
  }

  return {
    ok: true,
    prepared: {
      payloads,
      physical_payload_count: payloads.length,
    },
  };
}
