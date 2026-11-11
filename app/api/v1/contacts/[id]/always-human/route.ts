import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * CONTATO "SEMPRE ATENDIMENTO HUMANO" — marcar e desmarcar (issue 2379).
 *
 * ## Por que esta rota existe
 *
 * Quem usa o mesmo WhatsApp para o negócio e para a vida não tem, pela tela, um
 * jeito de dizer "este contato a IA nunca atende" que **sobreviva** à devolução
 * automática. A trava de handoff (`contacts.force_human`) resolve a passagem
 * TEMPORÁRIA: ela nasce da escalação e morre no primeiro retorno
 * (`devolverAtendimentoAoAgente`, o único escritor de `force_human = false` do
 * repositório) — inclusive no retorno automático do cron `handoff-devolucao`,
 * que ninguém clicou.
 *
 * A marca nova é `contacts.ai_opt_out` (migration 0624): permanente, explícita
 * e separada da trava de handoff de propósito — misturar os dois faria toda
 * escalação automática virar permanente.
 *
 * ## O que o marcar faz
 *
 * 1) `contacts.ai_opt_out = true` — a marca que a devolução NÃO desfaz;
 * 2) `contacts.force_human = true` — a trava que os guards de envio já leem
 *    (worker nativo, harness, `before-send`), para a IA parar na hora sem
 *    depender de ninguém reprocessar a conversa.
 *
 * Quem marcou e quando fica na auditoria (`contacts.always_human_marked`).
 *
 * ## O que o desmarcar faz
 *
 * Só limpa `ai_opt_out`. Ele NÃO devolve o atendimento: a conversa continua com
 * a trava de handoff de quem a pôs, e devolvê-la é o gesto explícito do botão
 * "Devolver ao automático" (`lib/escalacao/retomada.ts`). Desmarcar devolvendo
 * o comando esconderia uma decisão atrás de outra.
 *
 * ## Por que `manager`
 *
 * Espelha o contato pessoal (spec 21, decisão 1): é decisão operacional, não
 * cadastro. Atendente recebe 403.
 */
export async function POST(req: NextRequest, ctx: Context): Promise<Response> {
  // A guarda de efeito fica DENTRO de cada handler de propósito: o gate
  // `suporte-cobertura-de-efeitos` lê o corpo de POST/DELETE e não enxerga
  // através de uma função compartilhada — indireção opaca falharia aberto.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  return trocar(req, ctx, true);
}

export async function DELETE(req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  return trocar(req, ctx, false);
}

async function trocar(req: NextRequest, ctx: Context, ligar: boolean): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  // Sessão OU token de integração (Spec 33, R2): `manager` na sessão; no token,
  // `mcp:write` e papel `manager` na linha dele. A organização sai da sessão ou
  // da LINHA DO TOKEN, nunca do path nem do corpo.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "contacts",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  // A rota está em PUBLIC_PATHS: o teto de escrita do token é o único que conta.
  const teto = await tetoDeEscritaDoToken(authz, "contacts", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }

  const orgId = authz.organizationId;
  const admin = createAdminClient();
  // Admin client bypassa RLS: o filtro por organização é PROGRAMÁTICO e
  // obrigatório (CLAUDE.md, anti-pattern 10).
  const { data: contato, error: leituraErro } = await admin
    .from("contacts")
    .select("id, display_name, ai_opt_out")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (leituraErro) {
    return fail("internal_error", t("Não foi possível alterar a marca de atendimento humano."), 500, {
      requestId,
    });
  }
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });

  const jaLigado = (contato as { ai_opt_out?: boolean }).ai_opt_out === true;
  // Idempotente na PROVA (mesma regra do contato pessoal): repetir o gesto não
  // gera nova linha de auditoria, mas o UPDATE roda de novo — ele é a garantia
  // de que uma marca pela metade (ai_opt_out ligado sem force_human) se cura.
  const valores = ligar ? { ai_opt_out: true, force_human: true } : { ai_opt_out: false };

  const { data: alterado, error: updateErro } = await admin
    .from("contacts")
    .update(valores)
    .eq("organization_id", orgId)
    .eq("id", id)
    .select("id, display_name, ai_opt_out")
    .maybeSingle();
  if (updateErro || !alterado) {
    return fail("internal_error", t("Não foi possível alterar a marca de atendimento humano."), 500, {
      requestId,
    });
  }

  if (jaLigado === ligar) {
    return ok({ data: alterado }, { requestId });
  }

  await audit({
    action: ligar ? "contacts.always_human_marked" : "contacts.always_human_unmarked",
    // O id de um token não é pessoa: só a sessão assina como usuário.
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    // Sem nome: auditoria é append-only e a anonimização (LGPD) não a alcança —
    // o `contact_id` já identifica (mesma regra do contato pessoal).
    metadata: { contact_id: id, origem: "tela_do_contato" },
  });

  return ok({ data: alterado }, { requestId });
}
