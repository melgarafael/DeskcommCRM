import { describe, expect, it } from "vitest";

import {
  planCatalogPresentation,
  type CatalogPresentationPlan,
  type ResolvedCatalogPresentation,
} from "@/lib/catalogo/plano-de-apresentacao";
import { prepareCatalogPresentationPayloads } from "@/lib/catalogo/preparo-de-apresentacao";

function apartamento(
  code: string,
  overrides: Partial<ResolvedCatalogPresentation> = {},
): ResolvedCatalogPresentation {
  return {
    product_id: `id-${code}`,
    product_code: code,
    product_name: `Apartamento ${code}`,
    price_cents: 750_000_00,
    currency: "BRL",
    photo_storage_paths: [`${code}/fachada.jpg`, `${code}/sala.png`],
    presentation: {
      enabled: true,
      kind: "text",
      title: null,
      text_content: `Descrição de ${code}.`,
      use_catalog_photos: true,
      show_price: false,
      audio_storage_path: null,
      audio_mime: null,
    },
    ...overrides,
  };
}

function planFor(
  orderedProductCodes: readonly string[],
  resolvedItems: readonly ResolvedCatalogPresentation[],
): CatalogPresentationPlan {
  const result = planCatalogPresentation({
    ordered_product_codes: orderedProductCodes,
    resolved_items: resolvedItems,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Falha inesperada: ${result.error.code}`);
  return result.plan;
}

function prepare(plan: CatalogPresentationPlan) {
  const result = prepareCatalogPresentationPayloads(plan);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Falha inesperada: ${result.error.code}`);
  return result.prepared;
}

describe("preparo dos payloads da apresentação do catálogo", () => {
  it("preserva APTO-CENTRO → APTO-JARDINS → APTO-MOEMA e a ordem interna dos steps", () => {
    const plan = planFor(
      ["APTO-CENTRO", "APTO-JARDINS", "APTO-MOEMA"],
      [apartamento("APTO-MOEMA"), apartamento("APTO-CENTRO"), apartamento("APTO-JARDINS")],
    );

    const prepared = prepare(plan);

    expect(prepared.payloads.map((payload) => payload.product_code)).toEqual([
      "APTO-CENTRO",
      "APTO-CENTRO",
      "APTO-CENTRO",
      "APTO-JARDINS",
      "APTO-JARDINS",
      "APTO-JARDINS",
      "APTO-MOEMA",
      "APTO-MOEMA",
      "APTO-MOEMA",
    ]);
    expect(prepared.payloads.map((payload) => payload.kind)).toEqual([
      "text",
      "image",
      "image",
      "text",
      "image",
      "image",
      "text",
      "image",
      "image",
    ]);
  });

  it("prepara texto e preço como payloads físicos já renderizados", () => {
    const item = apartamento("APTO-CENTRO", { photo_storage_paths: [] });
    if (!item.presentation) throw new Error("fixture sem apresentação");
    item.presentation = {
      ...item.presentation,
      title: "Apartamento no Centro",
      text_content: "Duas suítes e varanda.",
      use_catalog_photos: false,
      show_price: true,
    };

    const prepared = prepare(planFor([item.product_code], [item]));

    expect(prepared.payloads).toEqual([
      {
        kind: "text",
        purpose: "presentation",
        text: "Apartamento no Centro\n\nDuas suítes e varanda.",
        product_id: "id-APTO-CENTRO",
        product_code: "APTO-CENTRO",
        item_index: 0,
        step_index: 0,
      },
      {
        kind: "price",
        text: "R$ 750.000,00",
        price_cents: 750_000_00,
        currency: "BRL",
        product_id: "id-APTO-CENTRO",
        product_code: "APTO-CENTRO",
        item_index: 0,
        step_index: 1,
      },
    ]);
  });

  it("mantém áudio distinguível de imagem e preserva o MIME exato", () => {
    const item = apartamento("APTO-JARDINS", {
      photo_storage_paths: ["APTO-JARDINS/fachada.jpg"],
    });
    if (!item.presentation) throw new Error("fixture sem apresentação");
    item.presentation = {
      ...item.presentation,
      kind: "audio",
      text_content: null,
      audio_storage_path: "org/id-APTO-JARDINS/apresentacao.ogg",
      audio_mime: "audio/ogg; codecs=opus",
    };

    const prepared = prepare(planFor([item.product_code], [item]));
    const audio = prepared.payloads.find((payload) => payload.kind === "audio");
    const image = prepared.payloads.find((payload) => payload.kind === "image");

    expect(audio).toMatchObject({
      kind: "audio",
      media: {
        bucket: "catalog-presentation-media",
        storage_path: "org/id-APTO-JARDINS/apresentacao.ogg",
        mime: "audio/ogg; codecs=opus",
      },
    });
    expect(image).toMatchObject({
      kind: "image",
      media: {
        bucket: "catalog-photos",
        storage_path: "APTO-JARDINS/fachada.jpg",
        mime: "image/jpeg",
      },
    });
  });

  it("preserva múltiplas fotos, posição e MIME na ordem cadastrada", () => {
    const item = apartamento("APTO-MOEMA", {
      photo_storage_paths: [
        "APTO-MOEMA/1-fachada.jpg",
        "APTO-MOEMA/2-sala.png",
        "APTO-MOEMA/3-suite.jpg",
      ],
    });

    const prepared = prepare(planFor([item.product_code], [item]));

    expect(
      prepared.payloads
        .filter((payload) => payload.kind === "image")
        .map((payload) => [payload.position, payload.media.storage_path, payload.media.mime]),
    ).toEqual([
      [0, "APTO-MOEMA/1-fachada.jpg", "image/jpeg"],
      [1, "APTO-MOEMA/2-sala.png", "image/png"],
      [2, "APTO-MOEMA/3-suite.jpg", "image/jpeg"],
    ]);
  });

  it("usa o mesmo contrato para item único", () => {
    const prepared = prepare(planFor(["APTO-CENTRO"], [apartamento("APTO-CENTRO")]));

    expect(new Set(prepared.payloads.map((payload) => payload.product_code))).toEqual(
      new Set(["APTO-CENTRO"]),
    );
    expect(prepared.payloads.map((payload) => payload.item_index)).toEqual([0, 0, 0]);
  });

  it("recusa reutilizar a mesma mídia entre itens", () => {
    const shared = "catalogo/mesma-foto.jpg";
    const plan = planFor(
      ["APTO-CENTRO", "APTO-JARDINS"],
      [
        apartamento("APTO-CENTRO", { photo_storage_paths: [shared] }),
        apartamento("APTO-JARDINS", { photo_storage_paths: [shared] }),
      ],
    );

    expect(prepareCatalogPresentationPayloads(plan)).toEqual({
      ok: false,
      error: {
        code: "media_reused_between_items",
        bucket: "catalog-photos",
        storage_path: shared,
        first: { product_id: "id-APTO-CENTRO", product_code: "APTO-CENTRO" },
        second: { product_id: "id-APTO-JARDINS", product_code: "APTO-JARDINS" },
      },
    });
  });

  it("recusa step associado a outro item em vez de misturar os payloads", () => {
    const plan = planFor(["APTO-CENTRO"], [apartamento("APTO-CENTRO")]);
    const first = plan.items[0]?.messages[0];
    if (!first) throw new Error("fixture sem step");
    first.product_id = "id-APTO-JARDINS";
    first.product_code = "APTO-JARDINS";

    expect(prepareCatalogPresentationPayloads(plan)).toEqual({
      ok: false,
      error: {
        code: "message_item_mismatch",
        product_id: "id-APTO-CENTRO",
        product_code: "APTO-CENTRO",
        item_index: 0,
        step_index: 0,
        message_product_id: "id-APTO-JARDINS",
        message_product_code: "APTO-JARDINS",
      },
    });
  });

  it("devolve erro estruturado quando o MIME do step não corresponde ao áudio", () => {
    const item = apartamento("APTO-CENTRO", { photo_storage_paths: [] });
    if (!item.presentation) throw new Error("fixture sem apresentação");
    item.presentation = {
      ...item.presentation,
      kind: "audio",
      text_content: null,
      use_catalog_photos: false,
      audio_storage_path: "org/id-APTO-CENTRO/apresentacao.ogg",
      audio_mime: "image/jpeg",
    };
    const plan = planFor([item.product_code], [item]);

    expect(prepareCatalogPresentationPayloads(plan)).toEqual({
      ok: false,
      error: {
        code: "invalid_media_step",
        reason: "mime_kind_mismatch",
        media_kind: "audio",
        product_id: "id-APTO-CENTRO",
        product_code: "APTO-CENTRO",
        item_index: 0,
        step_index: 1,
        storage_path: "org/id-APTO-CENTRO/apresentacao.ogg",
        mime: "image/jpeg",
      },
    });
  });

  it("mantém a contagem preparada igual à contagem física do planner", () => {
    const audio = apartamento("APTO-JARDINS", {
      photo_storage_paths: ["APTO-JARDINS/fachada.jpg"],
    });
    if (!audio.presentation) throw new Error("fixture sem apresentação");
    audio.presentation = {
      ...audio.presentation,
      kind: "audio",
      text_content: null,
      show_price: true,
      audio_storage_path: "org/id-APTO-JARDINS/apresentacao.ogg",
      audio_mime: "audio/ogg;codecs=opus",
    };
    const plan = planFor(["APTO-CENTRO", "APTO-JARDINS"], [audio, apartamento("APTO-CENTRO")]);

    const prepared = prepare(plan);

    expect(prepared.payloads).toHaveLength(plan.physical_message_count);
    expect(prepared.physical_payload_count).toBe(plan.physical_message_count);
  });
});
