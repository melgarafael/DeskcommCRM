import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST   /api/v1/products/:id/video — Envia ou prepara upload assinado do vídeo do produto.
 * GET    /api/v1/products/:id/video — Retorna URL assinada do vídeo atual do produto.
 * DELETE /api/v1/products/:id/video — Remove o vídeo do produto.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as ReadableStreamDoNode } from "node:stream/web";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  BUCKET_DOS_VIDEOS,
  TAMANHO_MAXIMO_DO_VIDEO,
  TAMANHO_OTIMO_WHATSAPP_VIDEO,
  videoPertenceAoProduto,
} from "@/lib/catalogo/videos";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

async function videoAtual(orgId: string, id: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("catalog_products")
    .select("video_file_path")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  return (data as { video_file_path?: string | null })?.video_file_path ?? null;
}

async function gravarVideo(orgId: string, id: string, videoPath: string | null): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("catalog_products")
    .update({ video_file_path: videoPath })
    .eq("organization_id", orgId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  return !error && data !== null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", {
    requestId,
    resource: "catalog_products",
    allowPlatformAdmin: "leitura",
  });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const { id } = await params;

  const anterior = await videoAtual(orgId, id);
  if (!anterior) {
    return ok({ video_file_path: null, signedUrl: null }, { requestId });
  }

  const admin = createAdminClient();
  const { data: signed } = await admin.storage.from(BUCKET_DOS_VIDEOS).createSignedUrl(anterior, 3600);

  return ok({ video_file_path: anterior, signedUrl: signed?.signedUrl ?? null }, { requestId });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { id } = await params;

  const admin = createAdminClient();
  const { data: prodData } = await admin
    .from("catalog_products")
    .select("id, video_file_path")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();

  if (!prodData) {
    return fail("not_found", t("Produto não encontrado."), 404, { requestId });
  }

  const anterior = (prodData as { video_file_path?: string | null }).video_file_path ?? null;

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // Ramo 1: Prepara upload assinado direto no Storage (bypassa RAM do Node.js, até 300MB)
  if (action === "prepare") {
    const caminho = `${orgId}/${id}/${randomUUID()}.mp4`;
    const { data: signedUp, error: erroSign } = await admin.storage
      .from(BUCKET_DOS_VIDEOS)
      .createSignedUploadUrl(caminho, { upsert: true });

    if (erroSign || !signedUp) {
      logger.error("[produtos/video] erro ao gerar url de upload assinada", {
        erro: erroSign?.message,
        requestId,
      });
      return fail("internal_error", t("Erro ao gerar link de upload."), 500, { requestId });
    }

    const publicStorageUrl = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
    let uploadUrl = signedUp.signedUrl;
    if (!uploadUrl.startsWith("http")) {
      const cleanPath = uploadUrl.replace(/^\/?(storage\/v1\/?)?/, "");
      uploadUrl = `${publicStorageUrl}/storage/v1/${cleanPath}`;
    }

    return ok(
      {
        uploadUrl,
        path: caminho,
        token: signedUp.token,
      },
      { requestId },
    );
  }

  // Ramo 2: Confirma upload concluído diretamente no Storage
  if (action === "confirm") {
    const body = (await req.json().catch(() => null)) as { video_file_path?: string } | null;
    const caminho = body?.video_file_path;
    if (!caminho || typeof caminho !== "string" || !videoPertenceAoProduto(caminho, orgId, id)) {
      return fail("validation_failed", t("Caminho de vídeo inválido."), 422, { requestId });
    }

    if (!(await gravarVideo(orgId, id, caminho))) {
      await admin.storage.from(BUCKET_DOS_VIDEOS).remove([caminho]).catch(() => null);
      return fail("internal_error", t("Erro ao vincular o vídeo ao produto."), 500, { requestId });
    }

    if (anterior && anterior !== caminho && videoPertenceAoProduto(anterior, orgId, id)) {
      await admin.storage.from(BUCKET_DOS_VIDEOS).remove([anterior]).catch(() => null);
    }

    // Se o vídeo enviado diretamente for maior que o limite ideal do WhatsApp (16 MB), otimiza automaticamente
    try {
      const { data: fileBlob, error: downloadError } = await admin.storage
        .from(BUCKET_DOS_VIDEOS)
        .download(caminho);

      if (!downloadError && fileBlob && fileBlob.size > TAMANHO_OTIMO_WHATSAPP_VIDEO) {
        const tempIn = join(tmpdir(), `direct_in_${randomUUID()}.mp4`);
        const tempOut = join(tmpdir(), `direct_out_${randomUUID()}.mp4`);
        try {
          const buf = Buffer.from(await fileBlob.arrayBuffer());
          await writeFile(tempIn, buf);
          await execFileAsync(
            "ffmpeg",
            [
              "-y",
              "-nostats",
              "-loglevel",
              "error",
              "-i",
              tempIn,
              "-vf",
              "scale=min(1080\\,iw):-2",
              "-c:v",
              "libx264",
              "-pix_fmt",
              "yuv420p",
              "-preset",
              "veryfast",
              "-crf",
              "26",
              "-maxrate",
              "2.5M",
              "-bufsize",
              "5M",
              "-c:a",
              "aac",
              "-b:a",
              "128k",
              "-movflags",
              "+faststart",
              tempOut,
            ],
            { maxBuffer: 50 * 1024 * 1024, timeout: 180_000 },
          );
          const compressed = await readFile(tempOut);
          await admin.storage
            .from(BUCKET_DOS_VIDEOS)
            .upload(caminho, compressed, { upsert: true, contentType: "video/mp4" });
          logger.info("[produtos/video] video do upload direto otimizado com sucesso para WhatsApp", {
            tamanhoOriginal: fileBlob.size,
            tamanhoFinal: compressed.length,
            requestId,
          });
        } catch (transcodeErr) {
          logger.warn("[produtos/video] falha ao otimizar video direto com ffmpeg, mantendo original", {
            erro: transcodeErr instanceof Error ? transcodeErr.message : String(transcodeErr),
            requestId,
          });
        } finally {
          await unlink(tempIn).catch(() => null);
          await unlink(tempOut).catch(() => null);
        }
      }
    } catch (errCheck) {
      logger.warn("[produtos/video] erro ao checar tamanho do video direto", {
        erro: errCheck instanceof Error ? errCheck.message : String(errCheck),
        requestId,
      });
    }

    const { data: signed } = await admin.storage.from(BUCKET_DOS_VIDEOS).createSignedUrl(caminho, 3600);

    await audit({
      organizationId: orgId,
      actorUserId: authz.user.id,
      action: "catalog_product.updated",
      resourceType: "catalog_products",
      resourceId: id,
      requestId,
      metadata: { video_file_path: caminho, via: "direct_signed_upload" },
    });

    return ok({ video_file_path: caminho, signedUrl: signed?.signedUrl ?? null }, { requestId });
  }

  // Ramo 3: Upload tradicional multipart/form-data com streaming para disco
  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > TAMANHO_MAXIMO_DO_VIDEO + 5_242_880) {
    return fail("payload_too_large", t("O vídeo precisa ter até 300 MB."), 413, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, { requestId });
  }
  if (file.size > TAMANHO_MAXIMO_DO_VIDEO) {
    return fail("payload_too_large", t("O vídeo precisa ter até 300 MB."), 413, { requestId });
  }

  const tempInput = join(tmpdir(), `in_${randomUUID()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "")}`);
  const tempOutput = join(tmpdir(), `out_${randomUUID()}.mp4`);
  let tempFilesCreated = false;
  let finalPathToUpload = tempInput;

  try {
    const nodeStream = Readable.fromWeb(file.stream() as unknown as ReadableStreamDoNode);
    await pipeline(nodeStream, createWriteStream(tempInput));
    tempFilesCreated = true;

    // Se o vídeo for pesado ou não for mp4 otimizado, tenta comprimir com ffmpeg
    if (file.size > TAMANHO_OTIMO_WHATSAPP_VIDEO || !file.type.includes("mp4")) {
      try {
        await execFileAsync(
          "ffmpeg",
          [
            "-y",
            "-nostats",
            "-loglevel",
            "error",
            "-i",
            tempInput,
            "-vf",
            "scale='min(1920,iw)':-2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-crf",
            "26",
            "-maxrate",
            "2.5M",
            "-bufsize",
            "5M",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            tempOutput,
          ],
          {
            maxBuffer: 50 * 1024 * 1024,
            timeout: 180_000,
          },
        );
        finalPathToUpload = tempOutput;
        logger.info("[produtos/video] video otimizado com sucesso para WhatsApp (HD/Full HD)", {
          requestId,
        });
      } catch (transcodeErr) {
        logger.warn("[produtos/video] ffmpeg indisponivel ou falhou, mantendo original", {
          erro: transcodeErr instanceof Error ? transcodeErr.message : String(transcodeErr),
          requestId,
        });
      }
    }

    const caminho = `${orgId}/${id}/${randomUUID()}.mp4`;
    const finalBytes = await readFile(finalPathToUpload);

    const { error: erroUp } = await admin.storage
      .from(BUCKET_DOS_VIDEOS)
      .upload(caminho, finalBytes, { contentType: "video/mp4", upsert: true });

    if (erroUp) {
      logger.error("[produtos/video] upload falhou", { detalhe: erroUp.message, requestId });
      return fail("internal_error", t("Erro ao salvar o vídeo no storage."), 500, { requestId });
    }

    if (!(await gravarVideo(orgId, id, caminho))) {
      await admin.storage.from(BUCKET_DOS_VIDEOS).remove([caminho]);
      return fail("internal_error", t("Erro ao vincular o vídeo ao produto."), 500, { requestId });
    }

    if (anterior && anterior !== caminho && videoPertenceAoProduto(anterior, orgId, id)) {
      await admin.storage.from(BUCKET_DOS_VIDEOS).remove([anterior]).catch(() => null);
    }

    const { data: signed } = await admin.storage.from(BUCKET_DOS_VIDEOS).createSignedUrl(caminho, 3600);

    await audit({
      organizationId: orgId,
      actorUserId: authz.user.id,
      action: "catalog_product.updated",
      resourceType: "catalog_products",
      resourceId: id,
      requestId,
      metadata: { video_file_path: caminho, via: "multipart_stream" },
    });

    return ok({ video_file_path: caminho, signedUrl: signed?.signedUrl ?? null }, { requestId });
  } catch (err) {
    logger.warn("[produtos/video] erro durante processamento temporario de video", {
      erro: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return fail("internal_error", t("Falha no processamento do vídeo."), 500, { requestId });
  } finally {
    if (tempFilesCreated) {
      await unlink(tempInput).catch(() => null);
      await unlink(tempOutput).catch(() => null);
    }
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { id } = await params;

  const atual = await videoAtual(orgId, id);
  if (!atual) {
    return ok({ video_file_path: null }, { requestId });
  }

  if (videoPertenceAoProduto(atual, orgId, id)) {
    const admin = createAdminClient();
    await admin.storage.from(BUCKET_DOS_VIDEOS).remove([atual]).catch(() => null);
  }

  await gravarVideo(orgId, id, null);

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.updated",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
    metadata: { video_removed: true },
  });

  return ok({ video_file_path: null }, { requestId });
}

