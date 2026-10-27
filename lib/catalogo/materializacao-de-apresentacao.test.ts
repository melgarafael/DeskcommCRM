import { describe, expect, it, vi } from "vitest";

import { MIME_DO_AUDIO_DA_APRESENTACAO } from "@/lib/catalogo/apresentacao";
import {
  BUCKET_DA_MIDIA_DA_CONVERSA,
  materializeCatalogPresentationSnapshotMedia,
  type CatalogPresentationStorage,
} from "@/lib/catalogo/materializacao-de-apresentacao";
import {
  planCatalogPresentation,
  type ResolvedCatalogPresentation,
} from "@/lib/catalogo/plano-de-apresentacao";
import type { CatalogPresentationSnapshotResult } from "@/lib/catalogo/snapshot-de-apresentacao";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTRA_ORG = "aaaaaaaa-0000-4000-8000-000000000002";
const CONVERSA = "bbbbbbbb-0000-4000-8000-000000000001";
const PRODUTO_FOTO = "cccccccc-0000-4000-8000-000000000001";
const PRODUTO_AUDIO = "cccccccc-0000-4000-8000-000000000002";
const FOTO_JPG = `${ORG}/${PRODUTO_FOTO}/11111111-2222-4333-8444-555555555555.jpg`;
const FOTO_PNG = `${ORG}/${PRODUTO_FOTO}/66666666-7777-4888-8999-000000000000.png`;
const AUDIO = `${ORG}/${PRODUTO_AUDIO}/99999999-aaaa-4bbb-8ccc-dddddddddddd.ogg`;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const OGG_OPUS = (() => {
  const bytes = new Uint8Array(48);
  bytes.set([0x4f, 0x67, 0x67, 0x53], 0);
  bytes.set(
    Array.from("OpusHead", (character) => character.charCodeAt(0)),
    12,
  );
  return bytes;
})();

function blob(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type });
}

function productWithPhotos(path = FOTO_JPG): ResolvedCatalogPresentation {
  return {
    product_id: PRODUTO_FOTO,
    product_code: "FOTO",
    product_name: "Produto com foto",
    price_cents: 1000,
    currency: "BRL",
    photo_storage_paths: [path, FOTO_PNG],
    presentation: {
      enabled: true,
      kind: "text",
      title: null,
      text_content: "Descrição",
      use_catalog_photos: true,
      show_price: false,
      audio_storage_path: null,
      audio_mime: null,
    },
  };
}

function productWithAudio(mime = MIME_DO_AUDIO_DA_APRESENTACAO): ResolvedCatalogPresentation {
  return {
    product_id: PRODUTO_AUDIO,
    product_code: "AUDIO",
    product_name: "Produto com áudio",
    price_cents: 2000,
    currency: "BRL",
    photo_storage_paths: [],
    presentation: {
      enabled: true,
      kind: "audio",
      title: null,
      text_content: null,
      use_catalog_photos: false,
      show_price: false,
      audio_storage_path: AUDIO,
      audio_mime: mime,
    },
  };
}

function persisted(
  products: ResolvedCatalogPresentation[] = [productWithPhotos(), productWithAudio()],
  codes: string[] = ["FOTO", "AUDIO"],
): Extract<CatalogPresentationSnapshotResult, { ok: true }> {
  const planned = planCatalogPresentation({
    ordered_product_codes: codes,
    resolved_items: products,
  });
  if (!planned.ok) throw new Error(planned.error.code);
  return {
    ok: true,
    reused: false,
    snapshot: {
      schema_version: 1,
      agent_operation: {organizationId:ORG,agentId:"99999999-0000-4000-8000-000000000001",versionId:"99999999-0000-4000-8000-000000000002",revision:"3"},
      sends_already_counted: 0,
      ordered_product_codes: codes,
      plan: planned.plan,
    },
  };
}

function storageFixture() {
  const objects = new Map<string, Blob>([
    [`catalog-photos\u0000${FOTO_JPG}`, blob(JPEG, "image/jpeg")],
    [`catalog-photos\u0000${FOTO_PNG}`, blob(PNG, "image/png")],
    [`catalog-presentation-media\u0000${AUDIO}`, blob(OGG_OPUS, "audio/ogg")],
  ]);
  const downloads: Array<[string, string]> = [];
  const copies: Array<Parameters<CatalogPresentationStorage["copy"]>[0]> = [];
  const download: CatalogPresentationStorage["download"] = vi.fn(
    async (bucket: string, path: string) => {
      downloads.push([bucket, path]);
      const data = objects.get(`${bucket}\u0000${path}`) ?? null;
      return data
        ? { data, error: null }
        : { data: null, error: { message: "not found", statusCode: 404 } };
    },
  );
  const copy: CatalogPresentationStorage["copy"] = vi.fn(async (input) => {
    copies.push(input);
    const destinationKey = `${input.destination_bucket}\u0000${input.destination_path}`;
    if (objects.has(destinationKey)) {
      return { error: { message: "already exists", statusCode: "409" } };
    }
    const source = objects.get(`${input.source_bucket}\u0000${input.source_path}`);
    if (!source) return { error: { message: "source missing", statusCode: "404" } };
    objects.set(destinationKey, source);
    return { error: null };
  });
  return {
    storage: { download, copy },
    objects,
    downloads,
    copies,
  };
}

const input = {
  organizationId: ORG,
  conversationId: CONVERSA,
  sendsAlreadyCounted: 0,
  maxSendsPerTurn: 10,
};

describe("materialização de mídia do snapshot de apresentação", () => {
  it("não toca o storage sem o recibo de snapshot persistido", async () => {
    const f = storageFixture();

    const result = await materializeCatalogPresentationSnapshotMedia(
      { ok: false, error: { code: "invalid_selection" } },
      input,
      f.storage,
    );

    expect(result).toEqual({ ok: false, error: { code: "snapshot_not_persisted" } });
    expect(f.storage.download).not.toHaveBeenCalled();
    expect(f.storage.copy).not.toHaveBeenCalled();
  });

  it("materializa fotos e áudio na ordem do snapshot, com bucket e identidade preservados", async () => {
    const f = storageFixture();
    const snapshot = persisted();

    const result = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(
      result.materialized.payloads.map(({ payload }) => [
        payload.product_code,
        payload.item_index,
        payload.step_index,
        payload.kind,
      ]),
    ).toEqual([
      ["FOTO", 0, 0, "text"],
      ["FOTO", 0, 1, "image"],
      ["FOTO", 0, 2, "image"],
      ["AUDIO", 1, 0, "text"],
      ["AUDIO", 1, 1, "audio"],
    ]);
    expect(f.copies.map((copy) => [copy.source_bucket, copy.source_path])).toEqual([
      ["catalog-photos", FOTO_JPG],
      ["catalog-photos", FOTO_PNG],
      ["catalog-presentation-media", AUDIO],
    ]);
    expect(f.copies.every((copy) => copy.destination_bucket === BUCKET_DA_MIDIA_DA_CONVERSA)).toBe(
      true,
    );
    expect(f.copies.every((copy) => copy.destination_path.startsWith(`${ORG}/${CONVERSA}/`))).toBe(
      true,
    );
    expect(
      result.materialized.payloads
        .filter(({ materialized_media }) => materialized_media)
        .map(({ materialized_media }) => materialized_media?.kind),
    ).toEqual(["image", "image", "audio"]);
  });

  it("faz o preflight do teto antes de ler ou copiar qualquer objeto", async () => {
    const f = storageFixture();

    const result = await materializeCatalogPresentationSnapshotMedia(
      persisted(),
      { ...input, maxSendsPerTurn: 4 },
      f.storage,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "max_sends_per_turn", required: 5, remaining: 4 },
    });
    expect(f.storage.download).not.toHaveBeenCalled();
    expect(f.storage.copy).not.toHaveBeenCalled();
  });

  it("isola tenants e produtos antes de tocar o storage", async () => {
    const f = storageFixture();
    const alheia = `${OUTRA_ORG}/${PRODUTO_FOTO}/11111111-2222-4333-8444-555555555555.jpg`;

    const result = await materializeCatalogPresentationSnapshotMedia(
      persisted([productWithPhotos(alheia)], ["FOTO"]),
      input,
      f.storage,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsafe_media_reference", reason: "ownership", media_kind: "image" },
    });
    expect(f.storage.download).not.toHaveBeenCalled();
    expect(f.storage.copy).not.toHaveBeenCalled();
  });

  it("recusa MIME de áudio fora do contrato antes de tocar o storage", async () => {
    const f = storageFixture();

    const result = await materializeCatalogPresentationSnapshotMedia(
      persisted([productWithAudio("audio/mpeg")], ["AUDIO"]),
      input,
      f.storage,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsafe_media_reference", reason: "mime", media_kind: "audio" },
    });
    expect(f.storage.download).not.toHaveBeenCalled();
    expect(f.storage.copy).not.toHaveBeenCalled();
  });

  it("valida MIME e assinatura de todas as fontes antes da primeira cópia", async () => {
    const f = storageFixture();
    f.objects.set(`catalog-presentation-media\u0000${AUDIO}`, blob(JPEG, "audio/ogg"));

    const result = await materializeCatalogPresentationSnapshotMedia(persisted(), input, f.storage);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "source_content_mismatch",
        reason: "signature",
        media_kind: "audio",
      },
    });
    expect(f.storage.download).toHaveBeenCalledTimes(3);
    expect(f.storage.copy).not.toHaveBeenCalled();
  });

  it("retry e cópia repetida usam o mesmo destino e aceitam 409 somente com bytes idênticos", async () => {
    const f = storageFixture();
    const snapshot = persisted([productWithPhotos()], ["FOTO"]);

    const first = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);
    const firstDestinations = f.copies.map((copy) => copy.destination_path);
    const second = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(f.copies.slice(2).map((copy) => copy.destination_path)).toEqual(firstDestinations);
    expect(f.downloads.filter(([bucket]) => bucket === BUCKET_DA_MIDIA_DA_CONVERSA)).toHaveLength(
      2,
    );
  });

  it("não chama conflito com bytes diferentes de idempotente", async () => {
    const f = storageFixture();
    const snapshot = persisted([productWithPhotos()], ["FOTO"]);
    const first = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);
    expect(first.ok).toBe(true);
    const destination = f.copies[0]!.destination_path;
    f.objects.set(`${BUCKET_DA_MIDIA_DA_CONVERSA}\u0000${destination}`, blob(PNG, "image/png"));

    const retry = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);

    expect(retry).toMatchObject({
      ok: false,
      error: { code: "copy_conflict_not_idempotent", destination_path: destination },
    });
  });

  it("recusa 409 com MIME igual e bytes diferentes", async () => {
    const f = storageFixture();
    const snapshot = persisted([productWithPhotos()], ["FOTO"]);
    const first = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);
    expect(first.ok).toBe(true);
    const destination = f.copies[0]!.destination_path;
    f.objects.set(
      `${BUCKET_DA_MIDIA_DA_CONVERSA}\u0000${destination}`,
      blob(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]), "image/jpeg"),
    );

    const retry = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);

    expect(retry).toMatchObject({
      ok: false,
      error: { code: "copy_conflict_not_idempotent", destination_path: destination },
    });
  });

  it("não chama conflito com MIME diferente de idempotente mesmo se os bytes forem iguais", async () => {
    const f = storageFixture();
    const snapshot = persisted([productWithPhotos()], ["FOTO"]);
    const first = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);
    expect(first.ok).toBe(true);
    const destination = f.copies[0]!.destination_path;
    f.objects.set(
      `${BUCKET_DA_MIDIA_DA_CONVERSA}\u0000${destination}`,
      blob(JPEG, "application/octet-stream"),
    );

    const retry = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);

    expect(retry).toMatchObject({
      ok: false,
      error: { code: "copy_conflict_not_idempotent", destination_path: destination },
    });
  });

  it("para na falha de cópia e o retry reaproveita apenas o prefixo comprovado", async () => {
    const f = storageFixture();
    const originalCopy = f.storage.copy;
    let failSecondOnce = true;
    f.storage.copy = vi.fn(async (copyInput) => {
      if (copyInput.source_path === FOTO_PNG && failSecondOnce) {
        failSecondOnce = false;
        return { error: { message: "storage indisponível", statusCode: 503 } };
      }
      return originalCopy(copyInput);
    });

    const failed = await materializeCatalogPresentationSnapshotMedia(
      persisted([productWithPhotos()], ["FOTO"]),
      input,
      f.storage,
    );
    const retried = await materializeCatalogPresentationSnapshotMedia(
      persisted([productWithPhotos()], ["FOTO"]),
      input,
      f.storage,
    );

    expect(failed).toMatchObject({ ok: false, error: { code: "copy_failed" } });
    expect(retried.ok).toBe(true);
  });

  it.each([
    ["foto", [productWithPhotos()], ["FOTO"], `catalog-photos\u0000${FOTO_JPG}`],
    ["áudio", [productWithAudio()], ["AUDIO"], `catalog-presentation-media\u0000${AUDIO}`],
  ] as const)(
    "falha fechado se a origem de %s sumiu apesar do destino existente",
    async (_kind, products, codes, sourceKey) => {
      const f = storageFixture();
      const snapshot = persisted([...products], [...codes]);
      const first = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);
      expect(first.ok).toBe(true);
      const copiesAfterFirstRun = f.copies.length;
      f.objects.delete(sourceKey);

      const replay = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);

      expect(replay).toMatchObject({ ok: false, error: { code: "source_unavailable" } });
      expect(f.copies).toHaveLength(copiesAfterFirstRun);
      expect(f.downloads.filter(([bucket]) => bucket === BUCKET_DA_MIDIA_DA_CONVERSA)).toHaveLength(
        0,
      );
    },
  );

  it("não aceita destino com bytes diferentes mesmo que MIME e assinatura sejam válidos", async () => {
    const f = storageFixture();
    const snapshot = persisted([productWithPhotos()], ["FOTO"]);
    const first = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);
    expect(first.ok).toBe(true);
    const destination = f.copies[0]!.destination_path;
    f.objects.delete(`catalog-photos\u0000${FOTO_JPG}`);
    f.objects.set(
      `${BUCKET_DA_MIDIA_DA_CONVERSA}\u0000${destination}`,
      blob(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]), "image/jpeg"),
    );

    const replay = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);

    expect(replay).toMatchObject({
      ok: false,
      error: { code: "source_unavailable" },
    });
    expect(f.copies).toHaveLength(2);
  });

  it("não reutiliza objeto materializado no caminho de outro tenant", async () => {
    const f = storageFixture();
    const snapshot = persisted([productWithPhotos()], ["FOTO"]);
    const first = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);
    expect(first.ok).toBe(true);
    const destination = f.copies[0]!.destination_path;
    const object = f.objects.get(`${BUCKET_DA_MIDIA_DA_CONVERSA}\u0000${destination}`)!;
    f.objects.delete(`catalog-photos\u0000${FOTO_JPG}`);
    f.objects.delete(`${BUCKET_DA_MIDIA_DA_CONVERSA}\u0000${destination}`);
    f.objects.set(
      `${BUCKET_DA_MIDIA_DA_CONVERSA}\u0000${destination.replace(ORG, OUTRA_ORG)}`,
      object,
    );

    const replay = await materializeCatalogPresentationSnapshotMedia(snapshot, input, f.storage);

    expect(replay).toMatchObject({ ok: false, error: { code: "source_unavailable" } });
    expect(f.copies).toHaveLength(2);
  });
});
