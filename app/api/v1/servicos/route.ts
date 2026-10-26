/**
 * GET  /api/v1/servicos — os serviços da organização ativa, com as variações.
 * POST /api/v1/servicos — cadastra um serviço (ou uma variação de um).
 *
 * Issue #3372, fatia B. O serviço é um item do catálogo: esta rota é o contrato
 * que sabe falar de `tipo_servico`, `unidade_cobranca`, prazo e sinal; o
 * `POST /api/v1/products` continua sendo o cadastro do produto de prateleira e
 * continua ignorando esses campos (o Zod dele os descarta).
 *
 * Escrita exige `manager`, como no catálogo: preço de venda não se altera com
 * papel de leitura. Um serviço é preço.
 */
import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DO_SERVICO, montarServicos, type LinhaDoCatalogo } from "@/lib/catalogo/servicos";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { servicoCreateSchema } from "@/lib/schemas/servicos";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  // `or` e não dois `eq`: a variação NÃO tem tipo (o CHECK a proíbe) e precisa
  // vir na mesma leitura para o principal mostrar os preços dela. Filtrar só
  // por `tipo_servico is not null` devolveria serviços sem variação nenhuma.
  const { data, error } = await supabase
    .from("catalog_products")
    .select(COLUNAS_DO_SERVICO)
    .eq("organization_id", authz.org.orgId)
    .or("tipo_servico.not.is.null,pai_id.not.is.null")
    .order("nome")
    .order("id")
    .limit(500);

  if (error) return fail("internal_error", "Erro ao listar os serviços.", 500, { requestId });

  return ok(montarServicos((data ?? []) as unknown as LinhaDoCatalogo[]), { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = servicoCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const input = parsed.data;
  const supabase = await createClient();

  // A variação precisa de um principal DESTA organização. A leitura é pela
  // sessão (não pelo admin client): variação de outra organização não existe
  // para quem está cadastrando, e a resposta é 422 — não 403, que revelaria que
  // o id existe em outro lugar.
  if (input.pai_id) {
    const { data: pai } = await supabase
      .from("catalog_products")
      .select("id, tipo_servico, pai_id, sinal_tipo, sinal_cents")
      .eq("organization_id", authz.org.orgId)
      .eq("id", input.pai_id)
      .maybeSingle();

    if (!pai || !pai.tipo_servico || pai.pai_id) {
      return fail(
        "validation_failed",
        t("Serviço principal não encontrado para esta variação."),
        422,
        {
          requestId,
          details: { pai_id: ["serviço principal inexistente ou que já é variação"] },
        },
      );
    }
  }

  const moeda = await moedaDaOrganizacao(supabase, authz.org.orgId);
  const ehVariacao = Boolean(input.pai_id);

  const { data, error } = await supabase
    .from("catalog_products")
    .insert({
      organization_id: authz.org.orgId,
      codigo: input.codigo,
      nome: input.nome,
      descricao: input.descricao ?? null,
      preco_cents: input.preco_cents,
      moeda,
      origem: "manual",
      // Serviço nunca controla estoque (#2497) — e o CHECK do banco recusa o
      // contrário. Não é escolha do corpo da requisição.
      controla_estoque: false,
      quantidade: 0,
      // A variação não carrega detalhe de serviço: tipo, unidade, prazo e sinal
      // moram no principal. Mandar `null` explícito é o que faz o CHECK
      // `catalog_products_servico_variacao_check` valer também para quem
      // chamar a rota por fora da tela.
      tipo_servico: ehVariacao ? null : input.tipo,
      unidade_cobranca: ehVariacao ? null : input.unidade,
      prazo_dias_uteis: ehVariacao ? null : (input.prazo_dias_uteis ?? null),
      sinal_tipo: ehVariacao ? null : (input.sinal?.tipo ?? null),
      sinal_percentual: ehVariacao
        ? null
        : input.sinal?.tipo === "percentual"
          ? input.sinal.valor
          : null,
      sinal_cents: ehVariacao ? null : input.sinal?.tipo === "fixo" ? input.sinal.valor : null,
      instrucoes_ia: ehVariacao ? null : (input.instrucoes_ia ?? null),
      ia_oferece: input.ia_oferece,
      ia_agenda: ehVariacao ? false : input.ia_agenda,
      pai_id: input.pai_id ?? null,
    })
    .select(COLUNAS_DO_SERVICO)
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", t("Já existe um item com esse código."), 409, { requestId });
    }
    // 23514 = CHECK, 23503 = FK/gatilho da variação. A mensagem do banco nomeia
    // o motivo; quem digitou precisa saber QUAL regra recusou.
    if (error.code === "23514" || error.code === "23503") {
      return fail("validation_failed", t("Este serviço não passou nas regras do cadastro."), 422, {
        requestId,
        details: { banco: [error.message] },
      });
    }
    return fail("internal_error", "Erro ao salvar o serviço.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: ehVariacao ? "catalog_service.variation_created" : "catalog_service.created",
    resourceType: "catalog_products",
    resourceId: (data as unknown as { id: string }).id,
    requestId,
  });

  return ok(data, { requestId, status: 201 });
}
