import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  obterClienteBlingAutenticado,
  obterConfiguracaoBling,
  registrarLogBling,
} from "@/lib/integrations/bling/store";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "bling_products_sync" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const orgId = authz.org.orgId;

  const config = await obterConfiguracaoBling(admin, orgId);
  if (!config || !config.is_enabled) {
    return fail(
      "validation_failed",
      "A integração com o Bling precisa estar ativada para sincronizar produtos.",
      400,
      { requestId },
    );
  }

  const { client, error } = await obterClienteBlingAutenticado(admin, orgId);
  if (error || !client) {
    return fail("validation_failed", error || "Cliente Bling indisponível", 400, {
      requestId,
    });
  }

  // 1. Listar produtos no Bling
  const resBling = await client.listarProdutos(1, 100);
  if (!resBling.ok || !resBling.produtos) {
    await registrarLogBling(admin, orgId, {
      operation: "sync_products",
      direction: "outbound",
      status: "failed",
      details: { error: resBling.error },
      error_message: resBling.error ?? "Falha ao buscar produtos na API do Bling",
    });

    return fail("integration_error", resBling.error || "Falha ao buscar produtos no Bling", 400, {
      requestId,
    });
  }

  const produtosBling = resBling.produtos;
  let totalProcessados = 0;

  // 2. Mapear e salvar no catálogo do CRM (catalog_products)
  for (const item of produtosBling) {
    const sku = item.codigo ? String(item.codigo).trim() : `BLING-${item.id}`;
    if (!sku) continue;

    const precoNumber = Number(item.preco ?? item.precoVenda ?? 0);
    const precoCents = Math.round(precoNumber * 100);
    const fotoPrincipal =
      item.imagemURL ||
      item.midia?.imagens?.externas?.[0]?.link ||
      item.midia?.imagens?.internas?.[0]?.link ||
      null;

    const payloadProduto = {
      organization_id: orgId,
      codigo: sku,
      nome: item.nome || "Produto sem nome",
      descricao: item.descricaoCurta || item.descricao || null,
      preco_cents: precoCents > 0 ? precoCents : 0,
      moeda: "BRL",
      controla_estoque: true,
      quantidade: 10,
      ativo: item.situacao !== "I",
      origem: "bling",
      imagem_url: fotoPrincipal,
      fotos: fotoPrincipal ? [fotoPrincipal] : [],
      updated_at: new Date().toISOString(),
    };

    const { error: erroUpsert } = await admin
      .from("catalog_products")
      .upsert(payloadProduto, { onConflict: "organization_id, codigo" });

    if (!erroUpsert) {
      totalProcessados++;
    }
  }

  // 3. Registrar log e auditoria
  await registrarLogBling(admin, orgId, {
    operation: "sync_products",
    direction: "outbound",
    status: "success",
    details: { totalBling: produtosBling.length, totalProcessados },
    error_message: null,
  });

  audit({
    action: "bling.updated",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "catalog_products",
    resourceId: orgId,
    requestId,
    metadata: {
      operacao: "sync_products",
      totalSincronizados: totalProcessados,
    },
  });

  return ok(
    {
      totalBling: produtosBling.length,
      totalSincronizados: totalProcessados,
      mensagem: `${totalProcessados} produto(s) sincronizados do Bling para o catálogo com sucesso!`,
    },
    { requestId },
  );
}
