import { describe, expect, it } from "vitest";

import {
  catalogPresentationSelectionSchema,
  planCatalogPresentation,
  type ResolvedCatalogPresentation,
} from "@/lib/catalogo/plano-de-apresentacao";

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
    photo_storage_paths: [`${code}/fachada.jpg`, `${code}/sala.jpg`],
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
) {
  const result = planCatalogPresentation({
    ordered_product_codes: orderedProductCodes,
    resolved_items: resolvedItems,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Falha inesperada: ${result.error.code}`);
  return result.plan;
}

describe("plano de apresentação do catálogo", () => {
  it("preserva A → B → C mesmo quando a resolução por IN volta em outra ordem", () => {
    const plan = planFor(
      ["APTO-CENTRO", "APTO-JARDINS", "APTO-MOEMA"],
      [apartamento("APTO-MOEMA"), apartamento("APTO-CENTRO"), apartamento("APTO-JARDINS")],
    );

    expect(plan.items.map((item) => item.product_code)).toEqual([
      "APTO-CENTRO",
      "APTO-JARDINS",
      "APTO-MOEMA",
    ]);
  });

  it("usa o mesmo caminho para item único", () => {
    const plan = planFor(["APTO-CENTRO"], [apartamento("APTO-CENTRO")]);

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.product_code).toBe("APTO-CENTRO");
  });

  it("rejeita código duplicado no contrato e no planejador", () => {
    expect(
      catalogPresentationSelectionSchema.safeParse({
        product_codes: ["APTO-CENTRO", "APTO-CENTRO"],
      }).success,
    ).toBe(false);
    expect(
      planCatalogPresentation({
        ordered_product_codes: ["APTO-CENTRO", "APTO-CENTRO"],
        resolved_items: [apartamento("APTO-CENTRO")],
      }),
    ).toEqual({
      ok: false,
      error: { code: "duplicate_product_code", product_code: "APTO-CENTRO" },
    });
  });

  it("falha o preflight quando a apresentação está ausente", () => {
    const result = planCatalogPresentation({
      ordered_product_codes: ["APTO-CENTRO"],
      resolved_items: [apartamento("APTO-CENTRO", { presentation: null })],
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "presentation_not_found", product_code: "APTO-CENTRO" },
    });
  });

  it("falha o preflight quando a apresentação está desativada", () => {
    const item = apartamento("APTO-CENTRO");
    if (!item.presentation) throw new Error("fixture sem apresentação");
    item.presentation = { ...item.presentation, enabled: false };

    const result = planCatalogPresentation({
      ordered_product_codes: ["APTO-CENTRO"],
      resolved_items: [item],
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "presentation_disabled", product_code: "APTO-CENTRO" },
    });
  });

  it("mantém título e texto do item na mesma mensagem física", () => {
    const item = apartamento("APTO-CENTRO");
    if (!item.presentation) throw new Error("fixture sem apresentação");
    item.presentation = {
      ...item.presentation,
      title: "Apartamento no Centro",
      text_content: "Duas suítes e varanda.",
      use_catalog_photos: false,
    };

    const plan = planFor([item.product_code], [item]);

    expect(plan.items[0]?.messages).toEqual([
      {
        product_id: "id-APTO-CENTRO",
        product_code: "APTO-CENTRO",
        kind: "text",
        purpose: "presentation",
        text: "Apartamento no Centro\n\nDuas suítes e varanda.",
      },
    ]);
  });

  it("mantém título e áudio associados ao mesmo item", () => {
    const item = apartamento("APTO-JARDINS");
    if (!item.presentation) throw new Error("fixture sem apresentação");
    item.presentation = {
      ...item.presentation,
      kind: "audio",
      text_content: null,
      use_catalog_photos: false,
      audio_storage_path: "org/id-APTO-JARDINS/apresentacao.ogg",
      audio_mime: "audio/ogg;codecs=opus",
    };

    const plan = planFor([item.product_code], [item]);

    expect(plan.items[0]?.messages).toEqual([
      {
        product_id: "id-APTO-JARDINS",
        product_code: "APTO-JARDINS",
        kind: "text",
        purpose: "title",
        text: "Apartamento APTO-JARDINS",
      },
      {
        product_id: "id-APTO-JARDINS",
        product_code: "APTO-JARDINS",
        kind: "audio",
        storage_path: "org/id-APTO-JARDINS/apresentacao.ogg",
        mime: "audio/ogg;codecs=opus",
      },
    ]);
  });

  it("preserva a ordem cadastrada das fotos", () => {
    const plan = planFor(
      ["APTO-MOEMA"],
      [
        apartamento("APTO-MOEMA", {
          photo_storage_paths: ["moema/1-fachada.jpg", "moema/2-sala.jpg", "moema/3-suite.jpg"],
        }),
      ],
    );

    expect(
      plan.items[0]?.messages
        .filter((message) => message.kind === "image")
        .map((message) => [message.position, message.storage_path]),
    ).toEqual([
      [0, "moema/1-fachada.jpg"],
      [1, "moema/2-sala.jpg"],
      [2, "moema/3-suite.jpg"],
    ]);
  });

  it("omite preço quando show_price=false e usa o preço canônico quando true", () => {
    const withoutPrice = apartamento("APTO-CENTRO", { price_cents: 910_000_00 });
    const withPrice = apartamento("APTO-JARDINS", { price_cents: 1_250_000_00 });
    if (!withPrice.presentation) throw new Error("fixture sem apresentação");
    withPrice.presentation = { ...withPrice.presentation, show_price: true };

    const plan = planFor(
      [withoutPrice.product_code, withPrice.product_code],
      [withPrice, withoutPrice],
    );

    expect(plan.items[0]?.messages.some((message) => message.kind === "price")).toBe(false);
    expect(plan.items[1]?.messages.at(-1)).toEqual({
      product_id: "id-APTO-JARDINS",
      product_code: "APTO-JARDINS",
      kind: "price",
      price_cents: 1_250_000_00,
      currency: "BRL",
    });
  });

  it("conta as mensagens físicas por item e no plano", () => {
    const text = apartamento("APTO-CENTRO");
    const audio = apartamento("APTO-MOEMA", {
      photo_storage_paths: ["moema/fachada.jpg"],
    });
    if (!audio.presentation) throw new Error("fixture sem apresentação");
    audio.presentation = {
      ...audio.presentation,
      kind: "audio",
      text_content: null,
      show_price: true,
      audio_storage_path: "org/id-APTO-MOEMA/apresentacao.ogg",
      audio_mime: "audio/ogg;codecs=opus",
    };

    const plan = planFor([text.product_code, audio.product_code], [audio, text]);

    expect(plan.items.map((item) => item.physical_message_count)).toEqual([3, 4]);
    expect(plan.items.map((item) => item.messages.length)).toEqual([3, 4]);
    expect(plan.physical_message_count).toBe(7);
  });

  it("não mistura mídia entre itens", () => {
    const center = apartamento("APTO-CENTRO", {
      photo_storage_paths: ["centro/fachada.jpg", "centro/sala.jpg"],
    });
    const gardens = apartamento("APTO-JARDINS", {
      photo_storage_paths: ["jardins/fachada.jpg"],
    });

    const plan = planFor([center.product_code, gardens.product_code], [gardens, center]);
    const mediaByItem = plan.items.map((item) =>
      item.messages
        .filter((message) => message.kind === "image" || message.kind === "audio")
        .map((message) => message.storage_path),
    );

    expect(mediaByItem).toEqual([
      ["centro/fachada.jpg", "centro/sala.jpg"],
      ["jardins/fachada.jpg"],
    ]);
    for (const item of plan.items) {
      expect(item.messages.every((message) => message.product_code === item.product_code)).toBe(
        true,
      );
      expect(item.messages.every((message) => message.product_id === item.product_id)).toBe(true);
    }
  });
});
