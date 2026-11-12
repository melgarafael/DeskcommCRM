/**
 * GET  /api/v1/servicos — os serviços da organização ativa, com as variações.
 * POST /api/v1/servicos — cadastra um serviço (ou uma variação de um).
 *
 * Issue #3372, fatia B, no desenho do doc 212: serviço é o MÓDULO OPCIONAL
 * `catalogo_servicos` (ADR-0002). Com o módulo desligado na instalação esta rota
 * não existe (404), e nenhuma consulta alcança `catalog_service_details`.
 *
 * O serviço é um item do catálogo: nome, código e preço ficam em
 * `catalog_products`; tipo, unidade, prazo e sinal ficam no detalhe do módulo.
 * O `POST /api/v1/products` continua sendo o cadastro do produto de prateleira.
 *
 * Leitura pela sessão, sob RLS. Escrita pelo client de serviço, porque a tabela
 * do módulo não aceita escrita de sessão: a organização vem do cookie validado,
 * e `fn_catalogo_servicos_salvar` grava item e detalhe juntos, com a família
 * travada e o sinal conferido no estado final.
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
import { paginaPedida } from "@/lib/catalogo/busca-da-tela";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { montarServicos } from "@/lib/catalogo/servicos";
import {
  MODULO_SERVICOS,
  SERVICOS_POR_PAGINA,
  camposDaRecusa,
  detalheDoItem,
  lerFamilias,
  listarServicos,
  salvarServico,
} from "@/lib/catalogo/servicos-supabase";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { servicoCreateSchema } from "@/lib/schemas/servicos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

async function seModuloDesligado(requestId: string): Promise<Response | null> {
  if (await moduloLigado(createAdminClient(), MODULO_SERVICOS)) return null;
  return fail("not_found", "Not found.", 404, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;

  // A página conta SERVIÇOS (principais), e cada um vem com a família inteira.
  const pagina = paginaPedida(req.nextUrl.searchParams.get("pagina")) ?? 1;
  try {
    const { linhas, principais, temMais } = await listarServicos(await createClient(), authz.org.orgId, pagina);
    const ordem = new Map(principais.map((id, i) => [id, i]));
    const servicos = montarServicos(linhas).sort((a, b) => (ordem.get(a.id) ?? 0) - (ordem.get(b.id) ?? 0));
    return ok(servicos, {
      requestId,
      meta: { pagina, por_pagina: SERVICOS_POR_PAGINA, has_more: temMais },
    });
  } catch {
    return fail("internal_error", "Erro ao listar os serviços.", 500, { requestId });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = servicoCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const input = parsed.data;
  const org = authz.org.orgId;
  const supabase = await createClient();

  // A variação precisa de um PRINCIPAL desta organização. A leitura é pela
  // sessão: principal de outra organização não existe para quem cadastra, e a
  // resposta é 422 — não 403, que revelaria que o id existe em outro lugar.
  if (input.pai_id) {
    const pai = await detalheDoItem(supabase, org, input.pai_id).catch(() => null);
    if (!pai || pai.pai_product_id !== null) {
      return fail("validation_failed", t("Serviço principal não encontrado para esta variação."), 422, {
        requestId,
        details: { pai_id: ["serviço principal inexistente ou que já é variação"] },
      });
    }
  }

  const ehVariacao = Boolean(input.pai_id);
  const moeda = await moedaDaOrganizacao(supabase, org);
  const r = await salvarServico(createAdminClient(), org, null, {
    item: {
      codigo: input.codigo,
      nome: input.nome,
      descricao: input.descricao ?? null,
      preco_cents: input.preco_cents,
      moeda,
    },
    // A variação não carrega detalhe de serviço: tipo, unidade, prazo, sinal e
    // instruções moram no principal (o CHECK do banco recusa o contrário).
    detalhe: ehVariacao
      ? { pai_product_id: input.pai_id, ia_oferece: input.ia_oferece }
      : {
          tipo: input.tipo,
          unidade: input.unidade,
          prazo_dias_uteis: input.prazo_dias_uteis ?? null,
          sinal_tipo: input.sinal?.tipo ?? null,
          sinal_percentual: input.sinal?.tipo === "percentual" ? input.sinal.valor : null,
          sinal_cents: input.sinal?.tipo === "fixo" ? input.sinal.valor : null,
          instrucoes_ia: input.instrucoes_ia ?? null,
          ia_oferece: input.ia_oferece,
        },
  });

  if (!r.ok) {
    if (r.motivo === "codigo_repetido") {
      return fail("conflict", t("Já existe um item com esse código."), 409, { requestId });
    }
    if (r.motivo === "nao_encontrado") {
      return fail("validation_failed", t("Serviço principal não encontrado para esta variação."), 422, {
        requestId,
        details: { pai_id: ["serviço principal inexistente ou que já é variação"] },
      });
    }
    return fail("validation_failed", t("Este serviço não passou nas regras do cadastro."), 422, {
      requestId,
      details: camposDaRecusa(r.detalhe),
    });
  }

  await audit({
    organizationId: org,
    actorUserId: authz.user.id,
    action: ehVariacao ? "catalog_service.variation_created" : "catalog_service.created",
    resourceType: "catalog_products",
    resourceId: r.productId,
    requestId,
  });

  const servico = montarServicos(await lerFamilias(supabase, org, [r.principalId]).catch(() => []))[0];
  return ok(servico ?? { id: r.productId, revision: r.revision }, { requestId, status: 201 });
}
