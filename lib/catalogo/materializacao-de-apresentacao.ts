import { createHash } from "node:crypto";

import {
  audioPertenceAoProduto,
  BUCKET_DA_APRESENTACAO,
  isOggOpus,
  MIME_DO_AUDIO_DA_APRESENTACAO,
} from "@/lib/catalogo/apresentacao";
import {
  BUCKET_DAS_FOTOS,
  farejarTipo,
  fotoPertenceAoProduto,
  mimeDaFoto,
} from "@/lib/catalogo/fotos";
import {
  prepareCatalogPresentationPayloads,
  type CatalogPresentationPreparationFailure,
  type PreparedCatalogPresentationPayload,
} from "@/lib/catalogo/preparo-de-apresentacao";
import {
  catalogPresentationSnapshotSchema,
  type CatalogPresentationSnapshotResult,
} from "@/lib/catalogo/snapshot-de-apresentacao";
import { kindFromMime } from "@/lib/messaging/media/upload-validation";
import { createAdminClient } from "@/lib/supabase/admin";

export const BUCKET_DA_MIDIA_DA_CONVERSA = "whatsapp-media";

type MediaPayload = Extract<PreparedCatalogPresentationPayload, { kind: "audio" | "image" }>;

interface StorageError {
  message: string;
  status?: number;
  statusCode?: number | string;
}

export interface CatalogPresentationStorage {
  download(
    bucket: string,
    path: string,
  ): Promise<{ data: Blob | null; error: StorageError | null }>;
  copy(input: {
    source_bucket: string;
    source_path: string;
    destination_bucket: typeof BUCKET_DA_MIDIA_DA_CONVERSA;
    destination_path: string;
  }): Promise<{ error: StorageError | null }>;
}

export interface MaterializedCatalogPresentationPayload {
  /** A referência preserva a identidade e a ordem produzidas pelo preflight. */
  payload: PreparedCatalogPresentationPayload;
  materialized_media?: {
    kind: "audio" | "image";
    mime: string;
    source_bucket: string;
    source_storage_path: string;
    storage_path: string;
  };
}

export interface MaterializedCatalogPresentation {
  payloads: MaterializedCatalogPresentationPayload[];
  physical_payload_count: number;
}

interface MediaLocation {
  product_id: string;
  product_code: string;
  item_index: number;
  step_index: number;
  media_kind: "audio" | "image";
  source_bucket: string;
  source_storage_path: string;
}

export type CatalogPresentationMaterializationFailure =
  | { code: "snapshot_not_persisted" }
  | { code: "invalid_snapshot" }
  | { code: "invalid_send_limit" }
  | {
      code: "max_sends_per_turn";
      required: number;
      remaining: number;
    }
  | { code: "preparation_failed"; error: CatalogPresentationPreparationFailure }
  | ({
      code: "unsafe_media_reference";
      reason: "source_bucket" | "ownership" | "mime" | "media_kind";
      mime: string;
    } & MediaLocation)
  | ({ code: "source_unavailable"; detail: string } & MediaLocation)
  | ({
      code: "source_content_mismatch";
      reason: "mime" | "signature";
      expected_mime: string;
      actual_mime: string | null;
    } & MediaLocation)
  | ({ code: "copy_failed"; detail: string; destination_path: string } & MediaLocation)
  | ({ code: "copy_conflict_not_idempotent"; destination_path: string } & MediaLocation);

export type CatalogPresentationMaterializationResult =
  | { ok: true; materialized: MaterializedCatalogPresentation }
  | { ok: false; error: CatalogPresentationMaterializationFailure };

interface ValidatedMedia {
  payload: MediaPayload;
  location: MediaLocation;
  bytes: Uint8Array;
  destinationPath: string;
}

function canonicalMime(mime: string): string {
  return mime.split(";", 1)[0]!.trim().toLowerCase();
}

function validCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mediaLocation(payload: MediaPayload): MediaLocation {
  return {
    product_id: payload.product_id,
    product_code: payload.product_code,
    item_index: payload.item_index,
    step_index: payload.step_index,
    media_kind: payload.kind,
    source_bucket: payload.media.bucket,
    source_storage_path: payload.media.storage_path,
  };
}

function destinationFor(
  organizationId: string,
  conversationId: string,
  payload: MediaPayload,
): string {
  const identity = `${payload.media.bucket}\u0000${payload.media.storage_path}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  const extension =
    payload.kind === "audio" ? "ogg" : payload.media.mime === "image/png" ? "png" : "jpg";
  return `${organizationId}/${conversationId}/catalogo-apresentacao-${digest}.${extension}`;
}

function isConflict(error: StorageError): boolean {
  return Number(error.statusCode ?? error.status) === 409;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function productionStorage(): CatalogPresentationStorage {
  const admin = createAdminClient();
  return {
    async download(bucket, path) {
      const result = await admin.storage.from(bucket).download(path);
      return result as { data: Blob | null; error: StorageError | null };
    },
    async copy(input) {
      const result = await admin.storage
        .from(input.source_bucket)
        .copy(input.source_path, input.destination_path, {
          destinationBucket: input.destination_bucket,
        });
      return result as { error: StorageError | null };
    },
  };
}

function validateMediaContract(
  payload: MediaPayload,
  organizationId: string,
): CatalogPresentationMaterializationFailure | null {
  const location = mediaLocation(payload);
  const expectedBucket = payload.kind === "audio" ? BUCKET_DA_APRESENTACAO : BUCKET_DAS_FOTOS;
  if (payload.media.bucket !== expectedBucket) {
    return {
      code: "unsafe_media_reference",
      reason: "source_bucket",
      mime: payload.media.mime,
      ...location,
    };
  }

  const owned =
    payload.kind === "audio"
      ? audioPertenceAoProduto(payload.media.storage_path, organizationId, payload.product_id)
      : fotoPertenceAoProduto(payload.media.storage_path, organizationId, payload.product_id);
  if (!owned) {
    return {
      code: "unsafe_media_reference",
      reason: "ownership",
      mime: payload.media.mime,
      ...location,
    };
  }

  const expectedMime =
    payload.kind === "audio"
      ? MIME_DO_AUDIO_DA_APRESENTACAO
      : mimeDaFoto(payload.media.storage_path);
  if (payload.media.mime !== expectedMime) {
    return {
      code: "unsafe_media_reference",
      reason: "mime",
      mime: payload.media.mime,
      ...location,
    };
  }
  if (kindFromMime(payload.media.mime) !== payload.kind) {
    return {
      code: "unsafe_media_reference",
      reason: "media_kind",
      mime: payload.media.mime,
      ...location,
    };
  }
  return null;
}

async function validateSource(
  storage: CatalogPresentationStorage,
  payload: MediaPayload,
  organizationId: string,
  conversationId: string,
): Promise<
  | { ok: true; media: ValidatedMedia }
  | { ok: false; error: CatalogPresentationMaterializationFailure }
> {
  const location = mediaLocation(payload);
  const downloaded = await storage.download(payload.media.bucket, payload.media.storage_path);
  if (downloaded.error || !downloaded.data) {
    return {
      ok: false,
      error: {
        code: "source_unavailable",
        detail: downloaded.error?.message.slice(0, 160) ?? "storage_returned_no_data",
        ...location,
      },
    };
  }

  const expectedMime = canonicalMime(payload.media.mime);
  const actualMime = downloaded.data.type ? canonicalMime(downloaded.data.type) : null;
  if (actualMime !== expectedMime) {
    return {
      ok: false,
      error: {
        code: "source_content_mismatch",
        reason: "mime",
        expected_mime: expectedMime,
        actual_mime: actualMime,
        ...location,
      },
    };
  }

  const bytes = await blobBytes(downloaded.data);
  const signatureMatches =
    payload.kind === "audio" ? isOggOpus(bytes) : farejarTipo(bytes) === payload.media.mime;
  if (!signatureMatches) {
    return {
      ok: false,
      error: {
        code: "source_content_mismatch",
        reason: "signature",
        expected_mime: expectedMime,
        actual_mime: actualMime,
        ...location,
      },
    };
  }

  return {
    ok: true,
    media: {
      payload,
      location,
      bytes,
      destinationPath: destinationFor(organizationId, conversationId, payload),
    },
  };
}

async function copyValidated(
  storage: CatalogPresentationStorage,
  media: ValidatedMedia,
): Promise<CatalogPresentationMaterializationFailure | null> {
  const copied = await storage.copy({
    source_bucket: media.payload.media.bucket,
    source_path: media.payload.media.storage_path,
    destination_bucket: BUCKET_DA_MIDIA_DA_CONVERSA,
    destination_path: media.destinationPath,
  });
  if (!copied.error) return null;
  if (!isConflict(copied.error)) {
    return {
      code: "copy_failed",
      detail: copied.error.message.slice(0, 160),
      destination_path: media.destinationPath,
      ...media.location,
    };
  }

  const existing = await storage.download(BUCKET_DA_MIDIA_DA_CONVERSA, media.destinationPath);
  if (existing.error || !existing.data) {
    return {
      code: "copy_conflict_not_idempotent",
      destination_path: media.destinationPath,
      ...media.location,
    };
  }
  const existingBytes = await blobBytes(existing.data);
  const existingMime = existing.data.type ? canonicalMime(existing.data.type) : null;
  return sameBytes(media.bytes, existingBytes) &&
    existingMime === canonicalMime(media.payload.media.mime)
    ? null
    : {
        code: "copy_conflict_not_idempotent",
        destination_path: media.destinationPath,
        ...media.location,
      };
}

/**
 * Materializa a mídia de um snapshot que já voltou do commit do job.
 *
 * Toda a estrutura, o teto, ownership, bucket, MIME e bytes de TODAS as fontes
 * são conferidos antes da primeira cópia. Depois disso, as cópias seguem a ordem
 * dos payloads do snapshot. Uma falha pode deixar prefixos já copiados, mas o
 * destino determinístico torna o retry seguro e a comparação de bytes prova o
 * único conflito que pode ser tratado como sucesso.
 */
export async function materializeCatalogPresentationSnapshotMedia(
  persisted: CatalogPresentationSnapshotResult,
  input: {
    organizationId: string;
    conversationId: string;
    sendsAlreadyCounted: number;
    maxSendsPerTurn: number;
  },
  storage: CatalogPresentationStorage = productionStorage(),
): Promise<CatalogPresentationMaterializationResult> {
  if (!persisted.ok) return { ok: false, error: { code: "snapshot_not_persisted" } };
  if (!validCount(input.sendsAlreadyCounted) || !validCount(input.maxSendsPerTurn)) {
    return { ok: false, error: { code: "invalid_send_limit" } };
  }

  const parsed = catalogPresentationSnapshotSchema.safeParse(persisted.snapshot);
  if (
    !parsed.success ||
    !arraysEqual(
      parsed.data.ordered_product_codes,
      parsed.data.plan.items.map((item) => item.product_code),
    )
  ) {
    return { ok: false, error: { code: "invalid_snapshot" } };
  }

  const preparation = prepareCatalogPresentationPayloads(parsed.data.plan);
  if (!preparation.ok) {
    return { ok: false, error: { code: "preparation_failed", error: preparation.error } };
  }
  const remaining = Math.max(0, input.maxSendsPerTurn - input.sendsAlreadyCounted);
  if (preparation.prepared.physical_payload_count > remaining) {
    return {
      ok: false,
      error: {
        code: "max_sends_per_turn",
        required: preparation.prepared.physical_payload_count,
        remaining,
      },
    };
  }

  const mediaPayloads = preparation.prepared.payloads.filter(
    (payload): payload is MediaPayload => payload.kind === "audio" || payload.kind === "image",
  );
  for (const payload of mediaPayloads) {
    const invalid = validateMediaContract(payload, input.organizationId);
    if (invalid) return { ok: false, error: invalid };
  }

  const validatedByIdentity = new Map<string, ValidatedMedia>();
  for (const payload of mediaPayloads) {
    const key = `${payload.media.bucket}\u0000${payload.media.storage_path}`;
    if (validatedByIdentity.has(key)) continue;
    const validated = await validateSource(
      storage,
      payload,
      input.organizationId,
      input.conversationId,
    );
    if (!validated.ok) return validated;
    validatedByIdentity.set(key, validated.media);
  }

  for (const media of validatedByIdentity.values()) {
    const failure = await copyValidated(storage, media);
    if (failure) return { ok: false, error: failure };
  }

  return {
    ok: true,
    materialized: {
      physical_payload_count: preparation.prepared.physical_payload_count,
      payloads: preparation.prepared.payloads.map((payload) => {
        if (payload.kind !== "audio" && payload.kind !== "image") return { payload };
        const key = `${payload.media.bucket}\u0000${payload.media.storage_path}`;
        const media = validatedByIdentity.get(key)!;
        return {
          payload,
          materialized_media: {
            kind: payload.kind,
            mime: payload.media.mime,
            source_bucket: payload.media.bucket,
            source_storage_path: payload.media.storage_path,
            storage_path: media.destinationPath,
          },
        };
      }),
    },
  };
}
