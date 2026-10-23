import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/products — o catálogo da organização ativa. `?busca=` filtra no
 *      servidor; `?pagina=N` (opcional) devolve 50 por página com `meta.total`.
 * POST /api/v1/products — cadastra um produto.
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
import { BUCKET_DAS_FOTOS, fotoPertenceAoProduto } from "@/lib/catalogo/fotos";
import { COLUNAS_DO_PRODUTO, produtoCreateSchema, type Produto } from "@/lib/schemas/produtos";
import { createAdminClient } from "@/lib/supabase/admin";
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

  const lista = (data ?? []) as unknown as Produto[];
  const fotosPrecisamAssinar: string[] = [];
  for (const p of lista) {
    if (p.fotos && Array.isArray(p.fotos)) {
      for (const f of p.fotos) {
        if (fotoPertenceAoProduto(f, authz.org.orgId, p.id)) {
          fotosPrecisamAssinar.push(f);
        }
      }
    } else if (!p.imagem_url && p.fotos?.[0] && fotoPertenceAoProduto(p.fotos[0], authz.org.orgId, p.id)) {
      fotosPrecisamAssinar.push(p.fotos[0]);
    }
  }

  if (fotosPrecisamAssinar.length > 0) {
    const { data: assinadas } = await createAdminClient()
      .storage.from(BUCKET_DAS_FOTOS)
      .createSignedUrls(fotosPrecisamAssinar, 86400 * 7);
    const mapaUrl: Record<string, string> = {};
    for (const a of assinadas ?? []) {
      const url = a.signedUrl || (a as unknown as { signedURL?: string }).signedURL;
      if (a.path && url) mapaUrl[a.path] = url;
    }
    for (const p of lista) {
      const urls: string[] = [];
      if (p.fotos && Array.isArray(p.fotos)) {
        for (const f of p.fotos) {
          if (mapaUrl[f]) urls.push(mapaUrl[f]!);
        }
      }
      p.fotos_urls = urls;
      if (!p.imagem_url && urls[0]) {
        p.imagem_url = urls[0];
      }
    }
  }

  const videosPrecisamAssinar: string[] = [];
  for (const p of lista) {
    if (p.video_file_path) {
      videosPrecisamAssinar.push(p.video_file_path);
    }
  }

  if (videosPrecisamAssinar.length > 0) {
    const { data: assinadasVideos } = await createAdminClient()
      .storage.from("catalog-videos")
      .createSignedUrls(videosPrecisamAssinar, 86400 * 7);
    const mapaVideoUrl: Record<string, string> = {};
    for (const a of assinadasVideos ?? []) {
      const url = a.signedUrl || (a as unknown as { signedURL?: string }).signedURL;
      if (a.path && url) mapaVideoUrl[a.path] = url;
    }
    for (const p of lista) {
      if (p.video_file_path && mapaVideoUrl[p.video_file_path]) {
        p.video_file_url = mapaVideoUrl[p.video_file_path]!;
      }
    }
  }

  if (!paginado) return ok(lista, { requestId });
  const total = count ?? null;
  return ok(lista, {
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
  // A moeda vem da organização, nunca do corpo — ver `moedaDaOrganizacao()`.
  const moeda = await moedaDaOrganizacao(supabase, authz.org.orgId);
  const { data, error } = await supabase
    .from("catalog_products")
    .insert({ ...parsed.data, moeda, organization_id: authz.org.orgId, origem: "manual" })
    .select(COLUNAS_DO_PRODUTO)
    .single();

  if (error) {
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
