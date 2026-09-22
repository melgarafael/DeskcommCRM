/**
 * POST /api/v1/shipments/[id]/orders/[orderId]/proof — anexa a foto da entrega.
 * GET  .../proof — redireciona para URL assinada (60s).
 *
 * Upload: FormData com `file` (imagem JPEG/PNG/WebP, até 10 MB) e
 * `observacao` opcional. Valida os BYTES mágicos — o `allowed_mime_types` do
 * bucket compara o header que quem sobe escolhe, então ele é backstop, não
 * decisão (precedente do logo, 0158). Upsert por pedido: reentrega com foto
 * nova substitui a anterior.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { detectarTipoImagem, mimeDaImagem } from "@/lib/comercial/imagem";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; orderId: string }> };

const MAX_BYTES = 10 * 1024 * 1024;

async function pertence(supabase: Awaited<ReturnType<typeof createClient>>, orgId: string, id: string, orderId: string) {
  const { data } = await supabase
    .from("shipment_orders")
    .select("id")
    .eq("shipment_id", id)
    .eq("order_id", orderId)
    .eq("organization_id", orgId)
    .maybeSingle();
  return Boolean(data);
}

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "shipment_proofs" });
  if (!authz.ok) return authz.response;

  const { id, orderId } = await params;
  const supabase = await createClient();
  if (!(await pertence(supabase, authz.org.orgId, id, orderId))) {
    return fail("not_found", "Pedido não está nesta carga.", 404, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const arquivo = form?.get("file");
  if (!(arquivo instanceof File)) {
    return fail("validation_failed", "Envie a foto em `file`.", 422, { requestId });
  }
  if (arquivo.size <= 0 || arquivo.size > MAX_BYTES) {
    return fail("validation_failed", "Foto de até 10 MB.", 422, { requestId });
  }
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  const ext = detectarTipoImagem(bytes);
  if (!ext) {
    return fail("validation_failed", "Só foto (JPEG, PNG ou WebP).", 422, { requestId });
  }
  const observacao = (form?.get("observacao") as string | null)?.trim().slice(0, 500) || null;

  const admin = createAdminClient();
  const caminho = `${authz.org.orgId}/${orderId}/${randomUUID()}.${ext}`;
  const { error: erroUpload } = await admin.storage
    .from("delivery-proofs")
    .upload(caminho, bytes, { contentType: mimeDaImagem(ext), upsert: false });
  if (erroUpload) {
    return fail("internal_error", "Erro ao guardar a foto.", 500, { requestId });
  }

  const { data, error } = await admin
    .from("shipment_proofs")
    .upsert(
      {
        organization_id: authz.org.orgId,
        shipment_id: id,
        order_id: orderId,
        storage_path: caminho,
        observacao,
        created_by: authz.user.id,
      },
      { onConflict: "order_id" },
    )
    .select("id")
    .single();

  if (error || !data) {
    await admin.storage.from("delivery-proofs").remove([caminho]);
    return fail("internal_error", "Erro ao registrar o comprovante.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "shipment.proof_uploaded",
    resourceType: "shipment_proofs",
    resourceId: (data as unknown as { id: string }).id,
    requestId,
  });

  return ok({ id: (data as unknown as { id: string }).id }, { requestId, status: 201 });
}

export async function GET(_req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "shipment_proofs" });
  if (!authz.ok) return authz.response;

  const { id, orderId } = await params;
  const supabase = await createClient();
  if (!(await pertence(supabase, authz.org.orgId, id, orderId))) {
    return fail("not_found", "Pedido não está nesta carga.", 404, { requestId });
  }

  const { data: prova } = await supabase
    .from("shipment_proofs")
    .select("storage_path")
    .eq("order_id", orderId)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const caminho = (prova as unknown as { storage_path: string } | null)?.storage_path;
  if (!caminho) return fail("not_found", "Sem comprovante para este pedido.", 404, { requestId });

  const admin = createAdminClient();
  const { data: assinada, error } = await admin.storage
    .from("delivery-proofs")
    .createSignedUrl(caminho, 300);
  if (error || !assinada?.signedUrl) {
    return fail("internal_error", "Erro ao abrir o comprovante.", 500, { requestId });
  }
  return NextResponse.redirect(assinada.signedUrl);
}
