import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { enviarPushDaOrg } from "@/lib/notifications/web_push";

const esquema = z
  .object({
    titulo: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    corpo: z.string().optional(),
    body: z.string().optional(),
    publicar_em: z.string().datetime({ offset: true }).optional().nullable(),
    publica_em: z.string().datetime({ offset: true }).optional().nullable(),
    publish_at: z.string().datetime({ offset: true }).optional().nullable(),
    expira_em: z.string().datetime({ offset: true }).optional().nullable(),
    expires_at: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .passthrough();

function normalizarData(valor: string | null | undefined): string | null {
  if (!valor) return null;
  return new Date(valor).toISOString();
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();

  const auth = await requireRole("admin", { requestId });
  if (!auth.ok) return auth.response;

  const corpo = esquema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_error", "Aviso inválido.", 400, {
      requestId,
      details: corpo.error.flatten(),
    });
  }

  const titulo = corpo.data.titulo ?? corpo.data.title;
  const texto = corpo.data.corpo ?? corpo.data.body ?? "";
  if (!titulo || !texto.trim()) {
    return fail("validation_error", "Título e corpo são obrigatórios.", 400, { requestId });
  }

  const publicarEm = normalizarData(
    corpo.data.publicar_em ?? corpo.data.publica_em ?? corpo.data.publish_at ?? null,
  );
  const expiraEm = normalizarData(
    corpo.data.expira_em ?? corpo.data.expires_at ?? null,
  );

  const admin = createAdminClient();
  const { data: aviso, error } = await admin
    .from("avisos")
    .insert({
      organization_id: auth.org.orgId,
      autor_id: auth.user.id,
      titulo,
      corpo: texto,
      publicar_em: publicarEm,
      expira_em: expiraEm,
    })
    .select("id, organization_id, autor_id, titulo, corpo, publicar_em, expira_em, created_at")
    .single();

  if (error || !aviso) {
    return fail("internal_error", "Não foi possível criar o aviso.", 500, {
      requestId,
      details: error?.message,
    });
  }

  const agora = new Date();
  const inicio = publicarEm ? new Date(publicarEm) : agora;
  const fim = expiraEm ? new Date(expiraEm) : null;
  const devePublicar = inicio <= agora && (!fim || fim > agora);

  if (devePublicar) {
    await enviarPushDaOrg(auth.org.orgId, {
      title: titulo,
      body: texto,
      tag: `aviso:${aviso.id}`,
      href: "/app/inbox",
    });
  }

  return ok(aviso, { status: 201, requestId });
}
