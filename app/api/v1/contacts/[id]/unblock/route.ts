import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * DESFAZ O DESCADASTRO DO CONTATO — o override que a regra W-02 prevê.
 *
 * ## Por que esta rota existe
 *
 * O pedido de descadastro (`is_blocked`) nasce da INGESTÃO, por palavra-chave, e
 * o motor o trata como parada dura: `before-send.ts` recusa com
 * `select (is_blocked or force_human) as stopped`, o funil não cria lead, o
 * follow-up não retoma, campanha e IA não enviam. É a regra W-03.
 *
 * Só que o gatilho é texto, e texto erra. O contato que escreveu "para de me
 * mandar" e mudou de ideia, ou o lead que caiu num falso positivo de nicho,
 * ficava PRESO: não havia tela, rota, action nem caminho de banco no produto
 * que desfizesse. Medido no SHA `aaabb02f`: `grep -rn 'is_blocked: false'`
 * devolve só arquivos de teste — nenhum escritor de produção.
 *
 * A regra de negócio já mandava existir. `docs/business-rules/00-business-rules-catalog.md`,
 * W-02: *"Override: Tenant admin pode desbloquear manualmente; ação auditada."*
 * Esta rota é essa frase.
 *
 * ## Por que `admin`, e não `agent`
 *
 * Editar cadastro é `agent+`. Desfazer um pedido de descadastro NÃO é edição de
 * cadastro: é reabrir um canal que o cliente fechou, com consequência jurídica
 * (é o direito de oposição do LGPD). A regra nomeia o admin, e é ele que
 * responde pela decisão — por isso `requireRole("admin")`.
 *
 * ## O que a rota NÃO faz
 *
 * Não apaga a linha de auditoria do bloqueio. O bloqueio aconteceu, foi um
 * fato, e `contact.blocked` continua no log ao lado de `contact.unblocked`.
 * Duas linhas contam a história inteira: quem pediu para sair e quem decidiu
 * reabrir. Apagar a primeira seria reescrever o passado.
 *
 * Não reativa follow-up nem campanha que o bloqueio cancelou. Quem quiser
 * retomar, retoma pelo fluxo normal — esta rota devolve o DIREITO de enviar,
 * não dispara envio nenhum.
 */
export async function POST(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }

  const admin = createAdminClient();
  // Admin client bypassa RLS: o filtro por organização é PROGRAMÁTICO e
  // obrigatório (CLAUDE.md, anti-pattern 10).
  const { data, error } = await admin
    .from("contacts")
    .update({ is_blocked: false, blocked_reason: null, blocked_at: null })
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id, display_name, phone_number, is_blocked, blocked_reason, blocked_at")
    .maybeSingle();

  if (error) {
    return fail("internal_error", t("Não foi possível desbloquear o contato."), 500, { requestId });
  }
  if (!data) return fail("not_found", t("Contato não encontrado."), 404, { requestId });

  // Espelha o registro do bloqueio (`lib/channels/pos-entrada.ts`): mesmo
  // `resourceType`, mesmo `contact_id` no metadata. O telefone NÃO entra —
  // auditoria não é lugar de dado pessoal, e o `contact_id` já identifica.
  await audit({
    action: "contact.unblocked",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: { contact_id: id, origem: "tela_do_contato" },
  });

  return ok(data, { requestId });
}
