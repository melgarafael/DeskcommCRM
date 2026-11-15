import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { desfazerSemInteresse, registrarSemInteresse } from "@/lib/lgpd/registrar-sem-interesse";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * "NÃO TEM INTERESSE" pela ficha do contato (decisão D3).
 *
 * POST grava a recusa de marketing com o motivo "sem interesse" e encerra o negócio
 * aberto e o follow-up da prospecção; DELETE desfaz a recusa (aba LGPD). A regra e os efeitos moram
 * em `lib/lgpd/registrar-sem-interesse.ts`, a mesma que a conversa de prospecção usa.
 *
 * ## Por que papéis diferentes
 *
 * Marcar é `agent`: é quem está na conversa e ouviu o "não". Gravar uma recusa só
 * diminui o que o sistema faz com o contato. Desfazer é `admin`, a mesma régua do
 * "Desbloquear": volta a permitir ofertas a quem disse que não quer, e quem clica
 * responde pela decisão. As duas ficam na auditoria (`lgpd.consent_changed`).
 */
export async function POST(_req: NextRequest, ctx: Context): Promise<Response> {
  // A guarda de efeito fica DENTRO de cada handler: o gate `suporte-cobertura-de-efeitos`
  // lê o corpo de POST/DELETE e não enxerga através de função compartilhada.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }

  const r = await registrarSemInteresse(createAdminClient(), {
    // A organização vem da sessão, nunca do corpo (CLAUDE.md, anti-pattern 10).
    organizationId: authz.org.orgId,
    contactId: id,
    origem: "ficha",
    actor: { type: "user", id: authz.user.id },
    requestId,
  });
  if (r.gravado) {
    return ok(
      { gravado: true, negocios_fechados: r.negociosFechados, followups_encerrados: r.followupsEncerrados },
      { requestId },
    );
  }
  if (r.motivo === "nao_encontrado") return fail("not_found", t("Contato não encontrado."), 404, { requestId });
  if (r.motivo === "anonimizado") {
    // A mesma recusa do PATCH da ficha para contato anonimizado.
    return fail("lgpd_anonymization_irreversible", t("Contato anonimizado — edição bloqueada (LGPD)."), 403, {
      requestId,
    });
  }
  if (r.motivo === "ja_recusado") {
    // Idempotente: a recusa já existe, e é ela que vale. O que ela alcança é encerrado
    // de novo (o fechamento da primeira vez pode ter falhado).
    return ok(
      { gravado: false, negocios_fechados: r.negociosFechados, followups_encerrados: r.followupsEncerrados },
      { requestId },
    );
  }
  return fail("internal_error", t("Não foi possível registrar que o contato não tem interesse."), 500, {
    requestId,
  });
}

export async function DELETE(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }

  const r = await desfazerSemInteresse(createAdminClient(), {
    organizationId: authz.org.orgId,
    contactId: id,
    actor: { type: "user", id: authz.user.id },
    requestId,
  });
  if (r.desfeito || r.motivo === "sem_recusa") {
    return ok({ desfeito: r.desfeito }, { requestId });
  }
  if (r.motivo === "nao_encontrado") return fail("not_found", t("Contato não encontrado."), 404, { requestId });
  return fail("internal_error", t("Não foi possível desfazer a recusa."), 500, { requestId });
}
