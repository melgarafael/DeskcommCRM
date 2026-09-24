import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/products/:id/fotos — sobe UMA foto (multipart `file`) e a põe no fim.
 * PUT  /api/v1/products/:id/fotos — `{ fotos: string[] }`: reordena e remove.
 *
 * Ideia de @vgamkt, a partir do #1130: o produto ganha foto, e o agente de IA a
 * manda junto quando apresenta o produto (`send_message` com `produto_codigo`).
 *
 * O arquivo vai para `catalog-photos` pelo service role (o bucket não tem policy
 * nenhuma); é o `requireRole("manager")` daqui que autoriza. O caminho é gerado
 * AQUI, nunca aceito do cliente — e o PUT só aceita caminhos que já estão na
 * linha. Regras e tetos em `lib/catalogo/fotos.ts`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  BUCKET_DAS_FOTOS,
  conferirNovaOrdem,
  extensaoDe,
  farejarTipo,
  MAXIMO_DE_FOTOS,
  TAMANHO_MAXIMO_DA_FOTO,
} from "@/lib/catalogo/fotos";
import { apagarDoBucket } from "@/lib/catalogo/fotos-no-bucket";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const ordemSchema = z.object({ fotos: z.array(z.string().min(1).max(300)).max(MAXIMO_DE_FOTOS) });

/** As fotos gravadas HOJE, lidas pela sessão do usuário (RLS + org do cookie). */
async function fotosAtuais(orgId: string, id: string): Promise<string[] | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("catalog_products")
    .select("fotos")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  return data ? ((data as { fotos: string[] | null }).fotos ?? []) : null;
}

async function gravarFotos(orgId: string, id: string, fotos: string[]): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("catalog_products")
    .update({ fotos })
    .eq("organization_id", orgId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  return !error && data !== null;
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

  const atuais = await fotosAtuais(orgId, id);
  if (atuais === null) return fail("not_found", t("Produto não encontrado."), 404, { requestId });
  if (atuais.length >= MAXIMO_DE_FOTOS) {
    return fail("validation_failed", t("Cada produto tem no máximo 5 fotos."), 422, { requestId });
  }

  // Recusa pelo Content-Length declarado ANTES de bufferizar o corpo (como a rota de
  // mídia da conversa); o file.size abaixo continua sendo o check autoritativo.
  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > TAMANHO_MAXIMO_DA_FOTO + 1_048_576) {
    return fail("payload_too_large", t("A foto precisa ter até 5 MB."), 413, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, { requestId });
  }
  if (file.size > TAMANHO_MAXIMO_DA_FOTO) {
    return fail("payload_too_large", t("A foto precisa ter até 5 MB."), 413, { requestId });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const tipo = farejarTipo(bytes);
  if (!tipo) {
    return fail("unsupported_media_type", t("A foto precisa ser JPG ou PNG."), 415, {
      requestId,
      details: { content_type_declarado: file.type || null },
    });
  }

  const caminho = `${orgId}/${id}/${randomUUID()}.${extensaoDe(tipo)}`;
  const { error: erroUp } = await createAdminClient()
    .storage.from(BUCKET_DAS_FOTOS)
    .upload(caminho, bytes, { contentType: tipo, upsert: false });
  if (erroUp) {
    logger.error("[produtos/fotos] upload falhou", { detalhe: erroUp.message, requestId });
    return fail("internal_error", "Erro ao subir a foto.", 500, { requestId });
  }

  // ponytail: ler-e-gravar sem trava — dois uploads no MESMO segundo para o
  // MESMO produto podem perder um caminho (o arquivo fica órfão no bucket, o
  // produto segue íntegro). Se virar queixa, `array_append` numa RPC.
  const fotos = [...atuais, caminho];
  if (!(await gravarFotos(orgId, id, fotos))) {
    await apagarDoBucket(orgId, id, [caminho], requestId);
    return fail("internal_error", "Erro ao salvar a foto.", 500, { requestId });
  }

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.photo_added",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
  });

  return ok({ fotos }, { requestId });
}

export async function PUT(
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

  const parsed = ordemSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const atuais = await fotosAtuais(orgId, id);
  if (atuais === null) return fail("not_found", t("Produto não encontrado."), 404, { requestId });

  const conferida = conferirNovaOrdem(atuais, parsed.data.fotos);
  if (!conferida.ok) {
    // A tela está atrás do banco (outra aba mexeu) ou o corpo foi forjado.
    return fail("conflict", t("As fotos mudaram. Recarregue a página."), 409, { requestId });
  }

  if (!(await gravarFotos(orgId, id, parsed.data.fotos))) {
    return fail("internal_error", "Erro ao salvar as fotos.", 500, { requestId });
  }
  await apagarDoBucket(orgId, id, conferida.removidas, requestId);

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.photos_updated",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
  });

  return ok({ fotos: parsed.data.fotos }, { requestId });
}
