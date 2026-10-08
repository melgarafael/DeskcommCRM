/**
 * PATCH /api/v1/admin/cobranca/planos/[id] — editar, marcar como plano do
 * cadastro, arquivar e desarquivar (spec da cobrança do revendedor §2.2, §7g).
 *
 * Preço e intervalo NÃO mudam enquanto houver assinatura apontando para o
 * plano (em `plano_id` ou `plano_agendado_id`): 409 `plano_com_assinantes`,
 * "arquive e crie outro". Nome, limites, dias de teste e o padrão do cadastro
 * mudam sempre. Limite novo vale para quem já assina: é a alavanca de "limite
 * errado: edita o plano" (§13).
 *
 * `arquivado: true` grava `arquivado_em`: o plano sai do cadastro e da troca, e
 * quem já assina segue nele. Dois planos do cadastro → 409 `state_conflict`.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { COLUNAS_DO_PLANO, edicaoDoPlanoSchema } from "@/lib/schemas/cobranca-plano";
import { createAdminClient } from "@/lib/supabase/admin";

interface PlanoAtual {
  id: string;
  preco_cents: number;
  intervalo: string;
  arquivado_em: string | null;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const admin = createAdminClient();
  const { id } = await params;
  // O id entra no filtro `.or()` abaixo como TEXTO: só uuid passa daqui.
  if (!(await moduloLigado(admin, "cobranca")) || !z.string().uuid().safeParse(id).success) {
    return fail("not_found", "Plano não encontrado", 404, { requestId });
  }

  const corpo = edicaoDoPlanoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", "Edição de plano inválida", 400, { requestId, details: corpo.error.flatten() });
  }

  const { data: lido, error: erroDeLeitura } = await admin
    .from("cobranca_planos")
    .select("id, preco_cents, intervalo, arquivado_em")
    .eq("id", id)
    .maybeSingle();
  if (erroDeLeitura) return fail("internal_error", "Não foi possível ler o plano", 500, { requestId });
  const atual = lido as PlanoAtual | null;
  if (!atual) return fail("not_found", "Plano não encontrado", 404, { requestId });

  const { arquivado, ...campos } = corpo.data;
  const mudaACobranca =
    (campos.preco_cents !== undefined && campos.preco_cents !== Number(atual.preco_cents)) ||
    (campos.intervalo !== undefined && campos.intervalo !== atual.intervalo);
  if (mudaACobranca) {
    // ponytail: conferido na rota, sem gatilho. Uma atribuição que entre entre
    // esta contagem e o UPDATE passa; gatilho em cobranca_planos se isso aparecer.
    const { count, error } = await admin
      .from("cobranca_assinaturas")
      .select("organization_id", { count: "exact", head: true })
      .or(`plano_id.eq.${id},plano_agendado_id.eq.${id}`);
    if (error) return fail("internal_error", "Não foi possível conferir os assinantes", 500, { requestId });
    if ((count ?? 0) > 0) {
      return fail(
        "plano_com_assinantes",
        "Este plano tem assinantes: o preço e o intervalo não mudam mais. Arquive-o e crie outro.",
        409,
        { requestId, details: { assinantes: count } },
      );
    }
  }

  const agora = new Date().toISOString();
  const arquivadoEm =
    arquivado === undefined ? {} : { arquivado_em: arquivado ? (atual.arquivado_em ?? agora) : null };
  const { data: plano, error } = await admin
    .from("cobranca_planos")
    .update({ ...campos, ...arquivadoEm, updated_at: agora, updated_by: adminCtx.user.id })
    .eq("id", id)
    .select(COLUNAS_DO_PLANO)
    .single();
  if (error?.code === "23505") {
    return fail("state_conflict", "Já existe um plano do cadastro. Desmarque o outro antes.", 409, { requestId });
  }
  if (error || !plano) return fail("internal_error", "Não foi possível salvar o plano", 500, { requestId });

  const arquivou = arquivado === true && atual.arquivado_em === null;
  void audit({
    action: arquivou ? "cobranca.plano_arquivado" : "cobranca.plano_salvo",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    resourceType: "cobranca_plano",
    resourceId: id,
    requestId,
    metadata: { ...corpo.data },
  });
  return ok(plano, { requestId });
}
