import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/products — o catálogo da organização ativa. `?busca=` filtra no
 *      servidor; `?pagina=N` (opcional) devolve 50 por página com `meta.total`.
 * POST /api/v1/products — cadastra um produto.
 *
 * `fotos` (lista de URLs, até 5, na ordem da capa) é aceita no corpo: o
 * servidor BAIXA cada uma e guarda o arquivo, e a URL deixa de ser a fonte —
 * o mesmo caminho da planilha (`lib/catalogo/fotos-por-url.ts`). O campo não é
 * coluna: sai do corpo antes do insert e entra como caminhos do bucket.
 *
 * Escrita exige `manager`: preço de venda não se altera com papel de leitura, e
 * é o motivo de este catálogo não morar na tabela da Nuvemshop, cuja policy é
 * org-flat sem checagem de papel.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  FAIXA_ALEM_DO_FIM,
  filtroDaBuscaDoCatalogo,
  intervaloDaPagina,
  paginaPedida,
  PRODUTOS_POR_PAGINA,
} from "@/lib/catalogo/busca-da-tela";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { guardarFotosPorUrl } from "@/lib/catalogo/fotos-por-url";
import { apagarDoBucket } from "@/lib/catalogo/fotos-no-bucket";
import { capacidadesDaOrganizacao } from "@/lib/organizacao/capacidades";
import { COLUNAS_DO_PRODUTO, produtoCreateSchema } from "@/lib/schemas/produtos";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;

  const params = req.nextUrl.searchParams;
  const filtro = filtroDaBuscaDoCatalogo(params.get("busca"));
  // Paginação é OPCIONAL: sem `pagina`, a resposta é a de sempre (até 500
  // linhas, sem `meta`) — o seletor de produtos da proposta lê esta rota assim.
  // `?pagina=` inválido (`0`, `abc`) conta como ausente: responder `meta.pagina:
  // 1` para uma URL que pediu outra coisa seria a resposta mentir sobre a pergunta.
  const pedida = paginaPedida(params.get("pagina"));
  const paginado = pedida !== null;
  const pagina = pedida ?? 1;

  // Termo digitado abaixo do piso (`"c"`, `", ,"`, `"()"`) NÃO vai ao banco e
  // devolve lista vazia — o desfecho da busca de contatos
  // (`app/api/v1/contacts/_handler.ts`). Sem esta guarda, `filtro === null`
  // consultava SEM filtro, e o seletor de produtos da proposta, que busca a
  // cada tecla, mostrava até 500 produtos sem relação com a primeira letra.
  if (filtro === null && (params.get("busca")?.trim() ?? "") !== "") {
    if (!paginado) return ok([], { requestId });
    return ok([], { requestId, meta: { total: 0, pagina, por_pagina: PRODUTOS_POR_PAGINA, has_more: false } });
  }

  const supabase = await createClient();

  let q = supabase
    .from("catalog_products")
    .select(COLUNAS_DO_PRODUTO, paginado ? { count: "exact" } : undefined)
    .eq("organization_id", authz.org.orgId);

  // A régua do termo (vírgula, parêntese, `%`, termo só de pontuação) mora em
  // `filtroDaBuscaDoCatalogo` — a mesma que a tela usa.
  if (filtro) q = q.or(filtro);

  q = q.order("ativo", { ascending: false }).order("nome").order("id");
  const { data, error, count } = paginado ? await q.range(...intervaloDaPagina(pagina)) : await q.limit(500);

  if (paginado && error?.code === FAIXA_ALEM_DO_FIM) {
    // Página além da última: o PostgREST responde 416, não lista vazia. A
    // resposta diz quantos há, para quem chamou voltar a uma página que existe.
    let contagem = supabase
      .from("catalog_products")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", authz.org.orgId);
    if (filtro) contagem = contagem.or(filtro);
    const { count: agora } = await contagem;
    return ok([], {
      requestId,
      meta: { total: agora ?? null, pagina, por_pagina: PRODUTOS_POR_PAGINA, has_more: false },
    });
  }
  if (error) return fail("internal_error", "Erro ao listar os produtos.", 500, { requestId });
  if (!paginado) return ok(data ?? [], { requestId });
  const total = count ?? null;
  return ok(data ?? [], {
    requestId,
    meta: {
      total,
      pagina,
      por_pagina: PRODUTOS_POR_PAGINA,
      has_more: total !== null && pagina * PRODUTOS_POR_PAGINA < total,
    },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = produtoCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  if (
    parsed.data.capacidade &&
    !(await capacidadesDaOrganizacao(supabase, authz.org.orgId)).includes("capacidade_do_produto")
  ) {
    return fail("validation_failed", t("A capacidade do produto está desligada nesta empresa."), 422, { requestId });
  }

  // A moeda vem da organização, nunca do corpo — ver `moedaDaOrganizacao()`.
  const moeda = await moedaDaOrganizacao(supabase, authz.org.orgId);

  // `fotos` é URL de ENTRADA e NÃO é coluna: sai do corpo antes do insert, como
  // a moeda sai antes de qualquer decisão. Ver o comentário do campo em
  // `lib/schemas/produtos.ts`.
  const { fotos, ...campos } = parsed.data;
  const urls = fotos ?? [];

  /**
   * ─── A foto é baixada ANTES de o produto existir na tabela ────────────────
   *
   * O caminho no bucket é `<org>/<produto>/<uuid>.<ext>`, então o id precisa
   * existir antes do download — daí o `id` gerado aqui e enviado no insert.
   * É o mesmo desenho da planilha (`import/route.ts`, grupo `novo+foto`), e
   * pelo mesmo motivo: gravar primeiro e baixar depois produziria o pior
   * desfecho, um 201 para um produto que ENTROU sem a foto que quem chamou
   * pediu. Baixar antes faz a recusa ser inteira.
   *
   * O downloader é o MESMO da planilha (teto por item, assinatura dos bytes,
   * guarda anti-SSRF, limpeza do que já subiu quando uma falha): um segundo
   * baixador aqui divergiria do primeiro na primeira correção de segurança.
   */
  const produtoId = urls.length > 0 ? randomUUID() : undefined;
  let caminhos: string[] | undefined;
  if (produtoId) {
    const guardadas = await guardarFotosPorUrl({ orgId: authz.org.orgId, produtoId, urls, t });
    if (!guardadas.ok) {
      // 422 e não 500: o corpo é que está errado (link morto, arquivo que não é
      // foto, acima de 5 MB), e quem lê é quem integrou.
      return fail("validation_failed", guardadas.motivo, 422, {
        requestId,
        details: { fotos: [guardadas.motivo] },
      });
    }
    caminhos = guardadas.caminhos;
  }

  const { data, error } = await supabase
    .from("catalog_products")
    .insert({
      ...campos,
      ...(produtoId ? { id: produtoId } : {}),
      ...(caminhos ? { fotos: caminhos } : {}),
      moeda,
      organization_id: authz.org.orgId,
      origem: "manual",
    })
    .select(COLUNAS_DO_PRODUTO)
    .single();

  if (error) {
    // Os arquivos já subiram e a linha não existe: sem esta limpeza, um código
    // repetido deixaria fotos órfãs no bucket pagas por ninguém.
    if (produtoId && caminhos?.length) {
      await apagarDoBucket(authz.org.orgId, produtoId, caminhos, requestId);
    }
    // 23505 = já existe produto com este código nesta organização. A recusa
    // nomeia o campo porque quem lê é quem digitou.
    if (error.code === "23505") {
      return fail("conflict", t("Já existe um produto com esse código."), 409, { requestId });
    }
    return fail("internal_error", "Erro ao salvar o produto.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.created",
    resourceType: "catalog_products",
    resourceId: (data as unknown as { id: string }).id,
    requestId,
  });

  return ok(data, { requestId, status: 201 });
}
