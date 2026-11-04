import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PUT    /api/v1/products/:id — substitui o produto inteiro pelo corpo.
 * PATCH  /api/v1/products/:id — muda o que veio, não encosta no resto.
 * DELETE /api/v1/products/:id — remove do catálogo.
 *
 * Sessão OU `Authorization: Bearer dsk_…` (`lib/api/auth-dual.ts`), como o
 * `POST` da coleção: a automação do fornecedor sincroniza o catálogo todo dia
 * (GET, compara, PUT/POST/DELETE). Escrever pede `mcp:write` e papel manager.
 *
 * O id vai no PATH, não no corpo, e o DELETE confere que a linha existia ANTES
 * de auditar: sem isso, um DELETE barrado pela RLS devolveria sucesso e gravaria
 * auditoria de uma mutação que não aconteceu.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { resolverAtributos } from "@/lib/catalogo/atributos";
import { apagarDoBucket } from "@/lib/catalogo/fotos-no-bucket";
import { guardarFotosPorUrl } from "@/lib/catalogo/fotos-por-url";
import { controlaEstoquePadrao, modoDeEstoqueDaOrganizacao } from "@/lib/catalogo/modo-de-estoque";
import { COLUNAS_DO_PRODUTO, produtoCreateSchema, produtoPatchSchema } from "@/lib/schemas/produtos";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Os opcionais que o PUT zera quando não vêm: substituir é dizer o estado inteiro. */
const OPCIONAIS_ZERADOS_NO_PUT = {
  descricao: null,
  marca: null,
  categoria: null,
  cor: null,
  capacidade: null,
  custo_cents: null,
  imagem_url: null,
  atributos: {},
} as const;

function opcoesDeEscrita(requestId: string) {
  return { requestId, resource: "catalog_products", role: "manager", scope: "mcp:write" } as const;
}

type Autorizado = Extract<Awaited<ReturnType<typeof resolveAuthDual>>, { ok: true }>;

async function atualizar(
  req: NextRequest,
  { params }: Params,
  modo: "put" | "patch",
  authz: Autorizado,
  requestId: string,
): Promise<Response> {
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const { id } = await params;

  const corpo = await req.json().catch(() => null);
  const parsed = modo === "put" ? produtoCreateSchema.safeParse(corpo) : produtoPatchSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  if (Object.keys(parsed.data).length === 0) {
    return fail("validation_failed", t("Nada para alterar."), 422, { requestId });
  }
  // PUT sem `codigo` mantém o atual: ele é autopreenchido no cadastro e é a
  // chave que a automação usa para comparar listas.
  const { supabase, organizationId } = authz;
  // Atributos: o PUT substitui o objeto; o PATCH mescla as chaves que vieram.
  let atributos: Record<string, unknown> | undefined;
  if (parsed.data.atributos !== undefined) {
    const r = await resolverAtributos(
      supabase,
      organizationId,
      parsed.data.atributos,
      modo === "put" ? "substituir" : "mesclar",
      id,
    );
    if (!r.ok) {
      return fail("validation_failed", t("Atributo inválido."), 422, { requestId, details: { atributos: r.erros } });
    }
    atributos = r.atributos;
  }
  // `fotos` é URL de ENTRADA, não coluna: sai do corpo antes do update, igual ao
  // POST. O que entra na coluna são os caminhos dos arquivos baixados. Ausente
  // (também no PUT) = não encostar nas fotos.
  const { fotos, ...campos } = parsed.data;
  // PUT é o estado inteiro: sem `controla_estoque`, vale o mesmo padrão do POST.
  const dados =
    modo === "put"
      ? {
          ...OPCIONAIS_ZERADOS_NO_PUT,
          ...campos,
          controla_estoque:
            campos.controla_estoque ??
            controlaEstoquePadrao(await modoDeEstoqueDaOrganizacao(supabase, organizationId)),
        }
      : campos;
  const comAtributos = atributos === undefined ? dados : { ...dados, atributos };

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
      .eq("organization_id", organizationId)
      .eq("id", id)
      .maybeSingle();
    if (erroDaLeitura) return fail("internal_error", "Erro ao salvar o produto.", 500, { requestId });
    if (!atual) return fail("not_found", t("Produto não encontrado."), 404, { requestId });
    antigas = ((atual as { fotos: string[] | null }).fotos ?? []).slice();

    const guardadas = await guardarFotosPorUrl({ orgId: organizationId, produtoId: id, urls: fotos, t });
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
    .update({ ...comAtributos, ...(caminhos ? { fotos: caminhos } : {}) })
    .eq("organization_id", organizationId)
    .eq("id", id)
    .select(COLUNAS_DO_PRODUTO)
    .maybeSingle();

  if (error) {
    // O update falhou depois do upload: os arquivos novos não são de ninguém.
    if (caminhos?.length) await apagarDoBucket(organizationId, id, caminhos, requestId);
    if (error.code === "23505") {
      return fail("conflict", t("Já existe um produto com esse código."), 409, { requestId });
    }
    // 22P02 = id fora do formato uuid: para quem chama, é "não existe".
    if (error.code === "22P02") return fail("not_found", t("Produto não encontrado."), 404, { requestId });
    return fail("internal_error", "Erro ao salvar o produto.", 500, { requestId });
  }
  // `maybeSingle` devolve null quando a RLS barrou ou o id não é desta org — os
  // dois são "não existe para você", e 404 é a resposta honesta.
  if (!data) {
    if (caminhos?.length) await apagarDoBucket(organizationId, id, caminhos, requestId);
    return fail("not_found", t("Produto não encontrado."), 404, { requestId });
  }

  // A foto que a lista nova não trouxe sai do bucket — a mesma limpeza que a
  // reimportação da planilha faz depois de gravar.
  if (caminhos) {
    const substituidas = antigas.filter((c) => !caminhos!.includes(c));
    await apagarDoBucket(organizationId, id, substituidas, requestId);
  }

  await audit({
    organizationId,
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    action: "catalog_product.updated",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
  });

  return ok(data, { requestId });
}

export async function PUT(req: NextRequest, ctx: Params): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, opcoesDeEscrita(requestId));
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "produtos", requestId);
  if (teto) return teto;
  return atualizar(req, ctx, "put", authz, requestId);
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, opcoesDeEscrita(requestId));
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "produtos", requestId);
  if (teto) return teto;
  return atualizar(req, ctx, "patch", authz, requestId);
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, opcoesDeEscrita(requestId));
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "produtos", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const { id } = await params;

  const { supabase, organizationId } = authz;
  const { data, error } = await supabase
    .from("catalog_products")
    .delete()
    .eq("organization_id", organizationId)
    .eq("id", id)
    .select("id, fotos")
    .maybeSingle();

  if (error) {
    if (error.code === "22P02") return fail("not_found", t("Produto não encontrado."), 404, { requestId });
    return fail("internal_error", "Erro ao remover o produto.", 500, { requestId });
  }
  if (!data) return fail("not_found", t("Produto não encontrado."), 404, { requestId });
  // As fotos saem junto: a linha era a única referência a elas.
  await apagarDoBucket(organizationId, id, (data as { fotos: string[] | null }).fotos ?? [], requestId);

  await audit({
    organizationId,
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    action: "catalog_product.deleted",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
