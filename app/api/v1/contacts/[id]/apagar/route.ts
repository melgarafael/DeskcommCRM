import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * DELETE /api/v1/contacts/:id/apagar (atendente, C-104)
 *
 * Apaga TUDO do contato — contato, conversas, mensagens, interesses, lead,
 * fluxo, fila — como o `limpar-tudo.sh` faz por telefone. É a ponta de SERVIDOR
 * do botão "Limpar conversa" da tela da conversa.
 *
 * ─── Por que uma rota nova e não o DELETE /contacts/:id que já existe ───────
 *
 * O `DELETE /api/v1/contacts/:id` (`deleteContactHandler`) apaga só messages →
 * conversations → contacts e deixa o resto cascatear. Isto aqui precisa deixar
 * ZERO resíduo (o agente não pode "lembrar" o cliente), então usa o motor
 * completo de `lib/settings/apagar-dados-do-contato.ts`.
 *
 * ─── Duas portas, uma trava ─────────────────────────────────────────────────
 *
 * A UI esconde o botão com `config.permite_limpeza_atendente`, mas esconder
 * botão não é controle de acesso: a rota recheca a MESMA flag e recusa (403) se
 * estiver desligada. Fail-closed: sem agente publicado, a flag lê `false`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { configDeLimpezaDoAgente } from "@/lib/escalacao/limpeza-de-conversa";
import { apagarDadosDoContato } from "@/lib/settings/apagar-dados-do-contato";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const admin = createAdminClient();

  // O contato precisa existir NA ORG da sessão: o client é service role e
  // bypassa RLS, então o filtro é a única separação entre organizações.
  const { data: contato } = await admin
    .from("contacts")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });

  const cfg = await configDeLimpezaDoAgente(admin, org.orgId);
  if (!cfg.permiteAtendente) {
    return fail(
      "forbidden",
      t("A limpeza de conversa pelo atendente está desligada nas configurações do agente."),
      403,
      { requestId },
    );
  }

  const resultado = await apagarDadosDoContato(admin, {
    organizationId: org.orgId,
    contactId: id,
  });

  await audit({
    action: "contact.erased_by_agent",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    // SEM PII: nunca o telefone nem o nome.
    metadata: { ok: resultado.ok, counts: resultado.counts },
  });

  if (!resultado.ok) {
    return fail("internal_error", t("Não consegui apagar todos os dados do contato."), 500, {
      requestId,
      details: { tabelas: resultado.falhas.map((f) => f.tabela) },
    });
  }

  return ok({ counts: resultado.counts }, { requestId });
}
