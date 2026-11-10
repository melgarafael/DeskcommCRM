import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/webhook-sources/[id] — atualiza campos (inclui is_active — switch da UI).
 * DELETE /api/v1/webhook-sources/[id] — remove a fonte.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail, noContent } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { autoriaDaMudanca } from "@/lib/operacao/autoria";
import { updateWebhookSourceSchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { opcaoSemAssinatura } from "@/lib/webhooks/assinatura-autorizacao";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { paginaDoToken } from "@/lib/leads/lead-ads/respostas-na-meta";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * A frase de cada opção que exige assinatura (#2316).
 *
 * Literal e no arquivo, e não montada com `opcao`: a chave do dicionário de i18n
 * é o TEXTO em português. Uma frase interpolada existiria só neste ponto do
 * código e a varredura de tradução não a veria — a tela em espanhol mostraria
 * português, e `i18n-espanhol-cobre-a-tela` só acusaria se alguém compusesse a
 * string em JSX.
 */
const FRASE_DA_OPCAO_SEM_ASSINATURA = {
  ai: "Configure a assinatura da fonte antes de autorizar IA. Para remover a assinatura, desligue primeiro a autorização de IA.",
  update_lead:
    "Configure a assinatura da fonte antes de deixar a integração atualizar o card. Para remover a assinatura, desligue primeiro a atualização pelo external_id.",
  reuse_lead:
    "Configure a assinatura da fonte antes de reaproveitar o card aberto do contato. Para remover a assinatura, desligue primeiro o reaproveitamento do card aberto.",
} as const;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "webhook_sources" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = updateWebhookSourceSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", t("Dados inválidos."), 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("webhook_sources")
    .select(
      "id, authorize_ai_on_capture, update_existing_lead_on_capture, reuse_open_lead_on_capture, secret_encrypted, meta_page_id, meta_page_token_encrypted, meta_lead_retrieval",
    )
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", t("Fonte não encontrada."), 404, { requestId });

  // ─── A página, o token e a busca são de ADMINISTRADOR (issue #3768) ───────
  //
  // O resto da fonte (nome, funil, etapa, opções) é do `manager`, como sempre
  // foi. O que entra aqui é CREDENCIAL e ROTEAMENTO: o token de página lê os
  // leads da página inteira, ligar a busca é o que faz esta instalação chamar a
  // Graph API com ele, e a página decide para qual fonte o lead vai. Por isso o
  // portão é um degrau acima, e só quando o corpo toca um dos três — quem edita
  // o funil da fonte não precisa ser admin para isso.
  const tocaCredencialDaPagina =
    parsed.data.meta_page_id !== undefined ||
    parsed.data.meta_page_token !== undefined ||
    parsed.data.meta_lead_retrieval !== undefined;
  if (tocaCredencialDaPagina) {
    const authzAdmin = await requireRole("admin", { requestId, resource: "webhook_sources" });
    if (!authzAdmin.ok) return authzAdmin.response;
  }

  // As opções que dependem de prova de origem (#2316, #3101) recusam pelo mesmo
  // lugar — e cada uma com a própria frase: uma mensagem só para todas faria
  // quem ligou a atualização de card ler "autorizar IA" e procurar o problema
  // na tela errada.
  const opcaoQuePedeAssinatura = opcaoSemAssinatura(existing, parsed.data);
  if (opcaoQuePedeAssinatura) {
    return fail(
      "signature_required",
      t(FRASE_DA_OPCAO_SEM_ASSINATURA[opcaoQuePedeAssinatura]),
      422,
      { requestId },
    );
  }

  // secret plaintext do input vira secret_encrypted (migration 0041); a coluna
  // em claro não existe mais. `secret: null` remove o segredo da fonte.
  //
  // `meta_page_token` segue a MESMA regra (migration 9320): sai do corpo como
  // texto claro, entra como `meta_page_token_encrypted` pela mesma RPC, e nunca
  // chega ao UPDATE com o nome do campo do input — um `...restPatch` inocente
  // tentaria gravar uma coluna que não existe.
  const { secret: patchedSecret, meta_page_token: patchedPageToken, ...restPatch } = parsed.data;

  // A BUSCA NÃO LIGA SEM TOKEN. A opção promete buscar as respostas; sem
  // credencial ela só produziria um `sem_token_da_pagina` por lead. A régua olha
  // o que vai FICAR gravado: o token que este PATCH traz, ou o que já está na
  // linha (round-trip da tela que não redigita o token).
  const buscaFicariaLigada = restPatch.meta_lead_retrieval ?? (existing.meta_lead_retrieval === true);
  const tokenFicariaGravado =
    patchedPageToken === undefined
      ? existing.meta_page_token_encrypted !== null
      : patchedPageToken !== null;
  if (buscaFicariaLigada && !tokenFicariaGravado) {
    return fail(
      "token_required",
      t(
        "Cole o token da página antes de ligar a busca dos leads. Sem ele, o aviso de formulário preenchido chega sem nome, telefone e e-mail e nenhum lead entra.",
      ),
      422,
      { requestId },
    );
  }

  // ─── A PÁGINA DA FONTE É A QUE O TOKEN LÊ ──────────────────────────────────
  //
  // O lead é roteado pela página (rota `webhooks/meta-lead-ads`), então uma
  // página declarada sem prova mandaria para esta fonte os avisos de quem é dono
  // de verdade. A regra: página gravada só com token gravado, e sempre a mesma
  // que o token lê (`/me`). Página em branco com token novo = a página do token.
  const tokenMuda = patchedPageToken !== undefined;
  const paginaMuda = restPatch.meta_page_id !== undefined;
  if (tokenMuda || paginaMuda) {
    const paginaFicaria = paginaMuda ? (restPatch.meta_page_id ?? null) : (existing.meta_page_id as string | null);
    const precisaLer = tokenMuda ? patchedPageToken !== null : paginaFicaria !== null;
    if (precisaLer) {
      const tokenEmClaro = tokenMuda
        ? patchedPageToken
        : existing.meta_page_token_encrypted
          ? await decryptWebhookSecret(createAdminClient(), existing.meta_page_token_encrypted as string)
          : null;
      if (!tokenEmClaro) {
        return fail(
          "token_required",
          t("Cole o token da página antes de ligar a página: é por ele que conferimos que a página é desta fonte."),
          422,
          { requestId },
        );
      }
      const lida = await paginaDoToken(tokenEmClaro);
      if (!lida.ok) {
        return fail(
          "page_token_unverified",
          t("Não conseguimos confirmar este token com a Meta. Confira se você copiou o token da página inteiro e se ele ainda vale."),
          422,
          { requestId, details: { motivo: lida.motivo, detalhe: lida.detalhe ?? null } },
        );
      }
      if (paginaFicaria !== null && paginaFicaria !== lida.pageId) {
        return fail(
          "page_mismatch",
          t("O token colado é de outra página. Deixe o campo da página em branco para usar a página do token, ou cole o token desta página."),
          422,
          { requestId, details: { pagina_do_token: lida.pageId } },
        );
      }
      if (paginaFicaria === null) restPatch.meta_page_id = lida.pageId;
    } else if (paginaFicaria !== null) {
      return fail(
        "token_required",
        t("Para remover o token, remova também a página: sem o token, não há como conferir que a página é desta fonte."),
        422,
        { requestId },
      );
    }
  }
  // A autoria vai junto de TODA escrita, pelo mesmo helper que o agente usa: a
  // tela precisa distinguir o que ela mesma mudou do que o assistente mudou, e
  // duas contas de "quem mexeu" divergiriam no primeiro ajuste (migration 0101).
  const patch: Record<string, unknown> = {
    ...restPatch,
    updated_at: new Date().toISOString(),
    ...autoriaDaMudanca({ type: "user", id: user.id, role: activeOrg.role }),
  };
  if (patchedSecret !== undefined) {
    if (patchedSecret === null) {
      patch.secret_encrypted = null;
    } else {
      const enc = await encryptWebhookSecret(createAdminClient(), patchedSecret);
      if (enc === null) {
        return fail(
          "encryption_unavailable",
          t("Não foi possível guardar o segredo com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave."),
          422,
          { requestId },
        );
      }
      patch.secret_encrypted = enc;
    }
  }

  // O token da página, pela MESMA cifra e com a MESMA recusa: sem chave mestra,
  // 422 e a frase que manda rodar o update.sh. Nunca texto claro na coluna.
  if (patchedPageToken !== undefined) {
    if (patchedPageToken === null) {
      patch.meta_page_token_encrypted = null;
    } else {
      const enc = await encryptWebhookSecret(createAdminClient(), patchedPageToken);
      if (enc === null) {
        return fail(
          "encryption_unavailable",
          t(
            "Não foi possível guardar o token da página com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave.",
          ),
          422,
          { requestId },
        );
      }
      patch.meta_page_token_encrypted = enc;
    }
  }

  // A página, o token e a busca só mudam pelo cliente do SERVIDOR: o gatilho
  // `trg_fonte_do_lead_ads_so_pelo_servidor` (migration 9320) recusa essas três
  // colunas pela sessão, para que a conferência acima não se contorne pelo
  // PostgREST. O filtro de organização abaixo é o da sessão já resolvida.
  const escritor = tocaCredencialDaPagina ? createAdminClient() : supabase;
  const { data: updated, error: updErr } = await escritor
    .from("webhook_sources")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select("*")
    .single();
  if (updErr) {
    // Página já reivindicada por outra fonte (`uniq_webhook_sources_meta_page`,
    // migration 9320). É 409 e não 500: a outra fonte pode ser de OUTRA
    // organização, então a resposta não diz qual — dizer seria vazar a existência
    // de outra empresa na instalação.
    if (updErr.code === "23505" && restPatch.meta_page_id !== undefined && restPatch.meta_page_id !== null) {
      return fail(
        "conflict",
        t(
          "Esta página já está ligada a outra fonte de captação. Desligue-a lá antes de ligar aqui — dois destinos para a mesma página escreveriam o lead na empresa errada.",
        ),
        409,
        { requestId },
      );
    }
    return fail("internal_error", updErr.message, 500, { requestId });
  }

  void audit({
    action: "webhook.source_updated",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "webhook_source",
    resourceId: id,
    requestId,
    // Nunca gravar o valor do secret no audit log — só o fato da troca.
    metadata: {
      ...restPatch,
      ...(patchedSecret !== undefined ? { secret_changed: true } : {}),
      ...(patchedPageToken !== undefined ? { meta_page_token_changed: true } : {}),
    },
  });

  // `meta_page_token_encrypted` nunca volta: a leitura diz que existe
  // (`has_meta_page_token`), como já faz com o segredo da fonte.
  const {
    secret_encrypted: encAfter,
    meta_page_token_encrypted: pageTokenAfter,
    ...updatedPublic
  } = updated as Record<string, unknown>;
  return ok(
    {
      ...updatedPublic,
      has_secret: encAfter !== null,
      has_meta_page_token: pageTokenAfter !== null && pageTokenAfter !== undefined,
    },
    { requestId },
  );
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "webhook_sources" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("webhook_sources")
    .select("id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", t("Fonte não encontrada."), 404, { requestId });

  const { error: delErr } = await supabase.from("webhook_sources").delete().eq("id", id);
  if (delErr) return fail("internal_error", delErr.message, 500, { requestId });

  void audit({
    action: "webhook.source_deleted",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "webhook_source",
    resourceId: id,
    requestId,
  });

  return noContent(requestId);
}
