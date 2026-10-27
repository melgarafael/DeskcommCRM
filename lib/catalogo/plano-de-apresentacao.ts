import { z } from "zod";

import {
  catalogProductPresentationPreview,
  type PresentationBlocker,
  type PresentationKind,
} from "@/lib/catalogo/apresentacao";

const productCodeSchema = z.string().trim().min(1).max(60);

/** Contrato da escolha da IA: uma operação, com os itens na ordem pedida. */
export const catalogPresentationSelectionSchema = z
  .object({ product_codes: z.array(productCodeSchema).min(1) })
  .strict()
  .superRefine(({ product_codes: productCodes }, context) => {
    const seen = new Set<string>();
    for (const [index, productCode] of productCodes.entries()) {
      if (seen.has(productCode)) {
        context.addIssue({
          code: "custom",
          path: ["product_codes", index],
          message: "O código do produto não pode aparecer mais de uma vez.",
        });
      }
      seen.add(productCode);
    }
  });

export type CatalogPresentationSelection = z.infer<typeof catalogPresentationSelectionSchema>;

export interface ResolvedCatalogPresentation {
  product_id: string;
  product_code: string;
  product_name: string;
  price_cents: number;
  currency: string;
  photo_storage_paths: readonly string[];
  presentation: {
    enabled: boolean;
    kind: PresentationKind;
    title: string | null;
    text_content: string | null;
    use_catalog_photos: boolean;
    show_price: boolean;
    audio_storage_path: string | null;
    audio_mime: string | null;
  } | null;
}

interface CatalogPresentationMessageBase {
  product_id: string;
  product_code: string;
}

export type CatalogPresentationMessage =
  | (CatalogPresentationMessageBase & {
      kind: "text";
      purpose: "presentation" | "title";
      text: string;
    })
  | (CatalogPresentationMessageBase & {
      kind: "audio";
      storage_path: string;
      mime: string;
    })
  | (CatalogPresentationMessageBase & {
      kind: "image";
      storage_path: string;
      position: number;
    })
  | (CatalogPresentationMessageBase & {
      kind: "price";
      price_cents: number;
      currency: string;
    });

export interface CatalogPresentationPlanItem {
  product_id: string;
  product_code: string;
  product_name: string;
  messages: CatalogPresentationMessage[];
  physical_message_count: number;
}

export interface CatalogPresentationPlan {
  items: CatalogPresentationPlanItem[];
  physical_message_count: number;
}

export type CatalogPresentationPlanFailure =
  | { code: "invalid_selection" }
  | { code: "duplicate_product_code"; product_code: string }
  | { code: "product_not_found"; product_code: string }
  | { code: "ambiguous_product_code"; product_code: string }
  | { code: "presentation_not_found"; product_code: string }
  | { code: "presentation_disabled"; product_code: string }
  | {
      code: "presentation_incomplete";
      product_code: string;
      blockers: PresentationBlocker[];
    };

export type CatalogPresentationPlanResult =
  | { ok: true; plan: CatalogPresentationPlan }
  | { ok: false; error: CatalogPresentationPlanFailure };

function duplicateCode(productCodes: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const productCode of productCodes) {
    if (seen.has(productCode)) return productCode;
    seen.add(productCode);
  }
  return null;
}

/**
 * Faz o preflight inteiro e só então devolve o plano. A ordem da query não é
 * observável: a sequência final nasce exclusivamente de `ordered_product_codes`.
 */
export function planCatalogPresentation(input: {
  ordered_product_codes: readonly string[];
  resolved_items: readonly ResolvedCatalogPresentation[];
}): CatalogPresentationPlanResult {
  const normalizedCodes = input.ordered_product_codes.map((productCode) => productCode.trim());
  const duplicate = duplicateCode(normalizedCodes);
  if (duplicate) {
    return { ok: false, error: { code: "duplicate_product_code", product_code: duplicate } };
  }

  const selection = catalogPresentationSelectionSchema.safeParse({
    product_codes: normalizedCodes,
  });
  if (!selection.success) return { ok: false, error: { code: "invalid_selection" } };

  const byCode = new Map<string, ResolvedCatalogPresentation>();
  for (const item of input.resolved_items) {
    if (byCode.has(item.product_code)) {
      return {
        ok: false,
        error: { code: "ambiguous_product_code", product_code: item.product_code },
      };
    }
    byCode.set(item.product_code, item);
  }

  const orderedItems: ResolvedCatalogPresentation[] = [];
  for (const productCode of selection.data.product_codes) {
    const item = byCode.get(productCode);
    if (!item) {
      return { ok: false, error: { code: "product_not_found", product_code: productCode } };
    }
    if (!item.presentation) {
      return {
        ok: false,
        error: { code: "presentation_not_found", product_code: productCode },
      };
    }
    if (!item.presentation.enabled) {
      return {
        ok: false,
        error: { code: "presentation_disabled", product_code: productCode },
      };
    }
    orderedItems.push(item);
  }

  const plannedItems: CatalogPresentationPlanItem[] = [];
  for (const item of orderedItems) {
    const presentation = item.presentation;
    if (!presentation) {
      return {
        ok: false,
        error: { code: "presentation_not_found", product_code: item.product_code },
      };
    }

    const preview = catalogProductPresentationPreview({
      product_name: item.product_name,
      kind: presentation.kind,
      title: presentation.title,
      text_content: presentation.text_content,
      use_catalog_photos: presentation.use_catalog_photos,
      show_price: presentation.show_price,
      has_audio: Boolean(presentation.audio_storage_path && presentation.audio_mime),
      photo_count: item.photo_storage_paths.length,
    });
    if (preview.blockers.length > 0) {
      return {
        ok: false,
        error: {
          code: "presentation_incomplete",
          product_code: item.product_code,
          blockers: preview.blockers,
        },
      };
    }

    const association = { product_id: item.product_id, product_code: item.product_code };
    const messages: CatalogPresentationMessage[] = [];
    if (presentation.kind === "text") {
      messages.push({
        ...association,
        kind: "text",
        purpose: "presentation",
        text: `${preview.effective_title}\n\n${presentation.text_content?.trim() ?? ""}`,
      });
    } else {
      messages.push({
        ...association,
        kind: "text",
        purpose: "title",
        text: preview.effective_title,
      });
      messages.push({
        ...association,
        kind: "audio",
        storage_path: presentation.audio_storage_path!,
        mime: presentation.audio_mime!,
      });
    }

    if (presentation.use_catalog_photos) {
      for (const [position, storagePath] of item.photo_storage_paths.entries()) {
        messages.push({
          ...association,
          kind: "image",
          storage_path: storagePath,
          position,
        });
      }
    }
    if (presentation.show_price) {
      messages.push({
        ...association,
        kind: "price",
        price_cents: item.price_cents,
        currency: item.currency,
      });
    }

    plannedItems.push({
      ...association,
      product_name: item.product_name,
      messages,
      physical_message_count: preview.physical_message_count,
    });
  }

  return {
    ok: true,
    plan: {
      items: plannedItems,
      physical_message_count: plannedItems.reduce(
        (total, item) => total + item.physical_message_count,
        0,
      ),
    },
  };
}
