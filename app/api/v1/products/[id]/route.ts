import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/products/:id — muda o que veio, não encosta no resto.
 * DELETE /api/v1/products/:id — remove do catálogo.
 *
 * O id vai no PATH, não no corpo, e o DELETE confere que a linha existia ANTES
 * de auditar: sem isso, um DELETE barrado pela RLS devolveria sucesso e gravaria
 * auditoria de uma mutação que não aconteceu.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { removeCatalogPresentationAudio } from "@/lib/catalogo/apresentacao-no-bucket";
import { apagarDoBucket } from "@/lib/catalogo/fotos-no-bucket";
import { guardarFotosPorUrl } from "@/lib/catalogo/fotos-por-url";
import { MODULO_SERVICOS, sinaisFixosQueTravamPreco } from "@/lib/catalogo/servicos-supabase";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { COLUNAS_DO_PRODUTO, produtoPatchSchema } from "@/lib/schemas/produtos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const parsed = produtoPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  if (Object.keys(parsed.data).length === 0) {
    return fail("validation_failed", t("Nada para alterar."), 422, { requestId });
  }

  // `fotos` é URL de ENTRADA, não coluna: sai do corpo antes do update, igual ao
  // POST. O que entra na coluna são os caminhos dos arquivos baixados.
  const { fotos, ...campos } = parsed.data;

  const supabase = await createClient();

  // A porta do módulo de serviços (doc 212): este item pode ser serviço ou
  // variação de um, e a família pode ter sinal FIXO. O preço novo não fica
  // abaixo dele. Com o módulo desligado, nada é consultado. Sem conseguir
  // conferir, nada é gravado.
  if (campos.preco_cents !== undefined && (await moduloLigado(createAdminClient(), MODULO_SERVICOS))) {
    let sinal: number | undefined;
    try {
      sinal = (await sinaisFixosQueTravamPreco(supabase, authz.org.orgId, [id])).get(id);
    } catch {
      return fail("internal_error", "Erro ao salvar o produto.", 500, { requestId });
    }
    if (sinal !== undefined && campos.preco_cents < sinal) {
      return fail("validation_failed", t("O preço ficaria abaixo do sinal fixo do serviço."), 422, {
        requestId,
        details: { preco_cents: [t("O preço ficaria abaixo do sinal fixo do serviço.")] },
      });
    }
  }

  /**
   * ─── PATCH com `fotos` SUBSTITUI o conjunto, não acrescenta ───────────────
   *
   * É o que quem integra espera ("estas são as fotos deste carro") e é o que a
   * planilha faz na releitura do arquivo: a lista nova vira a lista da linha, e
   * o arquivo que saiu do produto sai do bucket (senão o Storage acumula foto
   * que ninguém referencia, e a capa antiga continua assinável por URL).
   *
   * `fotos: []` limpa as fotos — lista vazia é uma instrução, não ausência; o
   * campo AUSENTE é o que diz "não encoste nas fotos" (é assim que o PATCH de
   * preço continua não tocando nelas).
   *
   * A linha é lida antes do download por duas razões: 404 cedo (sem baixar nem
   * guardar arquivo de um id que não é desta organização) e a lista ANTIGA, sem
   * a qual não há como apagar o que foi substituído.
   */
  let caminhos: string[] | undefined;
  let antigas: string[] = [];
  if (fotos !== undefined) {
    const { data: atual, error: erroDaLeitura } = await supabase
      .from("catalog_products")
      .select("id, fotos")
      .eq("organization_id", authz.org.orgId)
      .eq("id", id)
      .maybeSingle();
    if (erroDaLeitura) return fail("internal_error", "Erro ao salvar o produto.", 500, { requestId });
    if (!atual) return fail("not_found", t("Produto não encontrado."), 404, { requestId });
    antigas = ((atual as { fotos: string[] | null }).fotos ?? []).slice();

    const guardadas = await guardarFotosPorUrl({ orgId: authz.org.orgId, produtoId: id, urls: fotos, t });
    if (!guardadas.ok) {
      return fail("validation_failed", guardadas.motivo, 422, {
        requestId,
        details: { fotos: [guardadas.motivo] },
      });
    }
    caminhos = guardadas.caminhos;
  }

  const { data, error } = await supabase
    .from("catalog_products")
    .update({ ...campos, ...(caminhos ? { fotos: caminhos } : {}) })
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select(COLUNAS_DO_PRODUTO)
    .maybeSingle();

  if (error) {
    // O update falhou depois do upload: os arquivos novos não são de ninguém.
    if (caminhos?.length) await apagarDoBucket(authz.org.orgId, id, caminhos, requestId);
    if (error.code === "23505") {
      return fail("conflict", t("Já existe um produto com esse código."), 409, { requestId });
    }
    return fail("internal_error", "Erro ao salvar o produto.", 500, { requestId });
  }
  // `maybeSingle` devolve null quando a RLS barrou ou o id não é desta org — os
  // dois são "não existe para você", e 404 é a resposta honesta.
  if (!data) {
    if (caminhos?.length) await apagarDoBucket(authz.org.orgId, id, caminhos, requestId);
    return fail("not_found", t("Produto não encontrado."), 404, { requestId });
  }

  // A foto que a lista nova não trouxe sai do bucket — a mesma limpeza que a
  // reimportação da planilha faz depois de gravar.
  if (caminhos) {
    const substituidas = antigas.filter((c) => !caminhos!.includes(c));
    await apagarDoBucket(authz.org.orgId, id, substituidas, requestId);
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.updated",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
  });

  return ok(data, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const supabase = await createClient();
  // O FK apaga a configuração, mas Storage não conhece cascata: guarde o
  // caminho antes do DELETE para não deixar o áudio permanente órfão.
  const { data: apresentacao } = await supabase
    .from("catalog_product_presentations")
    .select("audio_storage_path")
    .eq("organization_id", authz.org.orgId)
    .eq("catalog_product_id", id)
    .maybeSingle();
  const { data, error } = await supabase
    .from("catalog_products")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id, fotos")
    .maybeSingle();

  if (error) return fail("internal_error", "Erro ao remover o produto.", 500, { requestId });
  if (!data) return fail("not_found", t("Produto não encontrado."), 404, { requestId });
  // As fotos saem junto: a linha era a única referência a elas.
  await apagarDoBucket(authz.org.orgId, id, (data as { fotos: string[] | null }).fotos ?? [], requestId);
  await removeCatalogPresentationAudio(
    authz.org.orgId,
    id,
    (apresentacao as { audio_storage_path?: string | null } | null)?.audio_storage_path,
    requestId,
  );

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.deleted",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
