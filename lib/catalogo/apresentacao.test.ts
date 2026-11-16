import { describe, expect, it } from "vitest";

import {
  audioPertenceAoProduto,
  catalogProductPresentationPatchSchema,
  catalogProductPresentationPreview,
  isOggOpus,
  MAXIMO_DE_MENSAGENS_FISICAS_POR_ITEM,
} from "@/lib/catalogo/apresentacao";

const ORG = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333.ogg";

const base = {
  enabled: false,
  kind: "text" as const,
  title: null,
  text_content: null,
  use_catalog_photos: true,
  show_price: false,
  expected_updated_at: null,
};

describe("schema da apresentação", () => {
  it("ausência continua desativada e rascunho incompleto pode ser salvo", () => {
    expect(catalogProductPresentationPatchSchema.safeParse(base).success).toBe(true);
  });

  it("não ativa texto vazio", () => {
    expect(
      catalogProductPresentationPatchSchema.safeParse({ ...base, enabled: true }).success,
    ).toBe(false);
  });

  it("recusa campos desconhecidos e timestamp sem fuso", () => {
    expect(
      catalogProductPresentationPatchSchema.safeParse({ ...base, organization_id: ORG }).success,
    ).toBe(false);
    expect(
      catalogProductPresentationPatchSchema.safeParse({
        ...base,
        expected_updated_at: "2026-10-11T04:00:00",
      }).success,
    ).toBe(false);
  });
});

describe("Ogg/Opus e posse do path", () => {
  const oggOpus = new Uint8Array([
    ...Array.from("OggS", (char) => char.charCodeAt(0)),
    ...Array(24).fill(0),
    ...Array.from("OpusHead", (char) => char.charCodeAt(0)),
  ]);

  it("decide container e codec pelos bytes", () => {
    expect(isOggOpus(oggOpus)).toBe(true);
    expect(isOggOpus(new TextEncoder().encode("OggS isto não tem codec"))).toBe(false);
    expect(isOggOpus(new TextEncoder().encode("OpusHead sem container"))).toBe(false);
  });

  it("aceita somente o arquivo deste tenant e produto", () => {
    expect(audioPertenceAoProduto(`${ORG}/${PRODUCT}/${FILE}`, ORG, PRODUCT)).toBe(true);
    expect(audioPertenceAoProduto(`99999999-9999-4999-8999-999999999999/${PRODUCT}/${FILE}`, ORG, PRODUCT)).toBe(false);
    expect(audioPertenceAoProduto(`${ORG}/${PRODUCT}/../${FILE}`, ORG, PRODUCT)).toBe(false);
    expect(audioPertenceAoProduto(`${ORG}/${PRODUCT}/${FILE}.mp3`, ORG, PRODUCT)).toBe(false);
  });
});

describe("preview é o contrato visual da ordem futura", () => {
  it("texto combina título e corpo numa bolha, depois fotos e preço", () => {
    expect(
      catalogProductPresentationPreview({
        product_name: "Apartamento Vila Mariana",
        kind: "text",
        title: null,
        text_content: "Três dormitórios e varanda.",
        use_catalog_photos: true,
        show_price: true,
        has_audio: false,
        photo_count: 3,
      }),
    ).toEqual({
      effective_title: "Apartamento Vila Mariana",
      physical_message_count: 5,
      blockers: [],
    });
  });

  it("áudio ocupa um envio depois do título e expõe faltas", () => {
    expect(
      catalogProductPresentationPreview({
        product_name: "Apartamento Moema",
        kind: "audio",
        title: "",
        text_content: null,
        use_catalog_photos: true,
        show_price: false,
        has_audio: false,
        photo_count: 0,
      }),
    ).toEqual({
      effective_title: "Apartamento Moema",
      physical_message_count: 2,
      blockers: ["missing_audio", "missing_photos"],
    });
  });

  it("sinaliza plano acima do limite mesmo se o banco legado trouxer fotos demais", () => {
    const result = catalogProductPresentationPreview({
      product_name: "Apartamento Tatuapé",
      kind: "audio",
      title: null,
      text_content: null,
      use_catalog_photos: true,
      show_price: true,
      has_audio: true,
      photo_count: MAXIMO_DE_MENSAGENS_FISICAS_POR_ITEM,
    });
    expect(result.blockers).toContain("physical_limit_exceeded");
  });
});
