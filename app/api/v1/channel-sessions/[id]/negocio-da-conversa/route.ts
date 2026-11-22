import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNA_DA_CHAVE, lerNegocioDoCanal, salvarNegocioDoCanal } from "@/lib/channels/negocio-da-conversa";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/**
 * A opção por conexão da #4670: as conversas novas deste número criam negócio
 * no funil?
 *
 * LIGADA por padrão, e o padrão é o banco (`not null default true`, migration
 * 9459): a rota não decide nada quando a coluna não veio — só a ausência de
 * leitura vira erro.
 *
 * Mesma porta de admin da tela de conexões (`ai-access`, `acervo`): leitura para
 * admin (o `allowPlatformAdmin: "leitura"` do suporte), escrita auditada. O
 * `organization_id` sai da sessão, nunca do corpo, e vai no filtro da leitura e
 * da gravação — é o que impede uma organização de ler ou escrever a chave de
 * outra.
 */
export async function GET(_req: NextRequest, { params }: Context): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: "leitura" });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  const valor = await lerNegocioDoCanal(createAdminClient(), auth.org.orgId, id);
  if (valor === null) return fail("not_found", "Canal não encontrado.", 404, { requestId });
  return ok({ [COLUNA_DA_CHAVE]: valor }, { requestId });
}

export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  // A chave é literal aqui (e não `COLUNA_DA_CHAVE`) para o zod dar o tipo
  // exato: com chave computada o `noUncheckedIndexedAccess` devolveria
  // `boolean | undefined`, e "ausente" não existe depois do `safeParse`.
  const parsed = z
    .object({ conversa_nova_cria_negocio: z.boolean() })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail(
      "validation_failed",
      "Informe se as conversas novas deste número devem criar negócio no funil.",
      422,
      { requestId },
    );
  const salvo = await salvarNegocioDoCanal(
    createAdminClient(),
    auth.org.orgId,
    id,
    parsed.data[COLUNA_DA_CHAVE],
  );
  if (salvo === null) return fail("not_found", "Canal não encontrado.", 404, { requestId });
  void audit({
    action: "channel.negocio_da_conversa_updated",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    // O valor novo E o anterior ficam no registro? Não: o anterior exigiria uma
    // leitura a mais só para a trilha. O que a auditoria precisa responder é
    // "quem desligou a criação neste número e quando" — e é isso que fica.
    metadata: { [COLUNA_DA_CHAVE]: salvo },
  });
  return ok({ [COLUNA_DA_CHAVE]: salvo }, { requestId });
}
