/**
 * GET /api/v1/voip/trunk — configuração do trunk SIP da org ativa (manager+),
 *                           via view segura (nunca expõe a senha cifrada).
 * PUT /api/v1/voip/trunk — cria ou atualiza (admin). Uma linha por
 *                           organização (upsert em organization_id).
 *
 * Aplicar no Asterisk (asterisk/pjsip.conf) continua MANUAL nesta fase — ver
 * migration 0349. `password` no body é opcional numa atualização (mantém a
 * senha já cifrada se omitida), obrigatório na primeira vez.
 */
import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { guardarTrunk } from "@/lib/voip/guardar-trunk";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "organization_id, host, port, username, password_last4, from_domain, endpoint_name, is_active, updated_by, created_at, updated_at";

const putSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(5060),
  username: z.string().trim().min(1).max(100),
  password: z.string().trim().min(4).max(200).optional(),
  from_domain: z.string().trim().max(255).nullable().optional(),
  is_active: z.boolean().default(true),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "voip_trunk_settings" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("voip_trunk_settings_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (error) return fail("internal_error", "Erro ao consultar o trunk SIP.", 500, { requestId });
  return ok(data ?? null, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  // Guarda de EFEITO do acompanhamento administrativo, ANTES do RBAC e do
  // client de service role: quem está só ACOMPANHANDO a organização de outra
  // pessoa não escreve por ela. Sem esta linha, um acompanhamento somente
  // leitura originava ligação, cadastrava número e trocava a credencial do
  // tronco — em nome do cliente, com a trilha apontando para ele.
  const acompanhamentoNegado = await requireSupportWrite();
  if (acompanhamentoNegado) return acompanhamentoNegado;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "voip_trunk_settings" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = putSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  const input = parsed.data;

  const guardado = await guardarTrunk({
    admin: createAdminClient(),
    orgId: activeOrg.orgId,
    userId: authUser.id,
    host: input.host,
    port: input.port,
    username: input.username,
    password: input.password,
    fromDomain: input.from_domain ?? null,
    isActive: input.is_active,
  });

  if (!guardado.ok) {
    if (guardado.motivo === "senha_obrigatoria_na_criacao") {
      return fail("password_required", "Senha é obrigatória ao cadastrar o trunk pela primeira vez.", 422, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao salvar o trunk SIP.", 500, { requestId, details: guardado.detalhe });
  }

  const { data: created } = await createAdminClient()
    .from("voip_trunk_settings_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .single();

  return ok(created, { requestId });
}
