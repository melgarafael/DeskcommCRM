/**
 * POST /api/v1/products/import — o catálogo a partir da planilha que a loja já tem.
 *
 * ─── Reimportar ATUALIZA, não duplica ───────────────────────────────────────
 *
 * É o gesto real: o dólar mudou, a loja corrige os preços na mesma planilha e
 * manda de novo. Se isso criasse linhas novas, o catálogo dobraria de tamanho
 * na segunda importação e o agente passaria a ver dois preços para o mesmo
 * produto — que é o desfecho que não se pode ter numa conversa com cliente.
 *
 * Por isso o `upsert` casa por `(organization_id, codigo)`, e por isso o
 * mapeador usa o NOME como código quando a planilha não traz um: sem
 * identidade estável não há como atualizar.
 *
 * ⚠️ O upsert grava só as colunas que a planilha carrega. `descricao`,
 * `imagem_url` e `ativo` ficam de fora de propósito — quem escreveu a descrição
 * pela tela não pode perdê-la porque alguém reimportou a lista de preços.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { lerPlanilha, type ErroDaLinha } from "@/lib/catalogo/planilha";
import { CSV_MAX_BYTES, CSV_MAX_DATA_ROWS } from "@/lib/contacts/csv";
import { COLUNAS_DO_PRODUTO } from "@/lib/schemas/produtos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Lote grande o bastante para uma planilha de loja caber em 3 idas ao banco. */
const LOTE = 200;

/**
 * A linha da planilha acompanha o produto até o insert — é o que permite dizer
 * QUAL linha o banco recusou —, mas não é coluna da tabela.
 */
function semALinha<T extends { linha: number }>({ linha: _linha, ...resto }: T): Omit<T, "linha"> {
  return resto;
}

interface ResumoDaImportacao {
  total_linhas: number;
  criados: number;
  atualizados: number;
  erros: ErroDaLinha[];
  colunas_ignoradas: string[];
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // Preço de venda é escrita de gestão: o mesmo papel do POST unitário.
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  let arquivo: File;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) throw new Error("sem arquivo");
    arquivo = f;
  } catch {
    return fail("validation_failed", "Envie o arquivo no campo 'file'.", 422, { requestId });
  }

  const nome = arquivo.name ?? "";
  const tipoOk =
    nome.toLowerCase().endsWith(".csv") ||
    arquivo.type === "text/csv" ||
    arquivo.type === "application/vnd.ms-excel";
  if (!tipoOk) {
    return fail(
      "validation_failed",
      "Formato não suportado — envie um arquivo .csv. No Excel use 'Salvar como' → 'CSV UTF-8'.",
      422,
      { requestId },
    );
  }
  if (arquivo.size > CSV_MAX_BYTES) {
    return fail(
      "validation_failed",
      `Arquivo maior que ${Math.floor(CSV_MAX_BYTES / 1024 / 1024)}MB.`,
      413,
      { requestId },
    );
  }

  const lido = lerPlanilha(await arquivo.text());
  // Problema do ARQUIVO (falta a coluna de preço) é 422 com a frase inteira —
  // e não um relatório com 300 erros idênticos.
  if ("erro" in lido) return fail("validation_failed", lido.erro, 422, { requestId });

  const totalLinhas = lido.produtos.length + lido.erros.length;
  if (totalLinhas > CSV_MAX_DATA_ROWS) {
    return fail(
      "validation_failed",
      `Máximo de ${CSV_MAX_DATA_ROWS} produtos por importação — divida a planilha.`,
      422,
      { requestId },
    );
  }
  if (lido.produtos.length === 0) {
    return ok(
      {
        total_linhas: totalLinhas,
        criados: 0,
        atualizados: 0,
        erros: lido.erros,
        colunas_ignoradas: lido.colunasIgnoradas,
      } satisfies ResumoDaImportacao,
      { requestId },
    );
  }

  const supabase = await createClient();

  // Quem já existia, para o resumo dizer "3 novos, 12 atualizados" em vez de um
  // número só. É a diferença entre a pessoa confiar no que aconteceu e ter de
  // conferir o catálogo linha a linha depois.
  const { data: jaExistiam } = await supabase
    .from("catalog_products")
    .select("codigo")
    .eq("organization_id", orgId)
    .in(
      "codigo",
      lido.produtos.map((p) => p.codigo),
    );
  const antigos = new Set((jaExistiam ?? []).map((r) => (r as { codigo: string }).codigo));

  const erros: ErroDaLinha[] = [...lido.erros];
  let gravados = 0;

  const paraGravar = lido.produtos.map((p) => ({
    linha: p.linha,
    organization_id: orgId,
    codigo: p.codigo,
    nome: p.nome,
    preco_cents: p.preco_cents,
    custo_cents: p.custo_cents,
    marca: p.marca ?? null,
    categoria: p.categoria ?? null,
    controla_estoque: p.controla_estoque,
    quantidade: p.quantidade,
    origem: "planilha",
  }));

  for (let i = 0; i < paraGravar.length; i += LOTE) {
    const lote = paraGravar.slice(i, i + LOTE);
    const { error } = await supabase
      .from("catalog_products")
      .upsert(lote.map(semALinha), { onConflict: "organization_id,codigo" });

    if (!error) {
      gravados += lote.length;
      continue;
    }

    // O lote é tudo-ou-nada. Uma linha ruim não pode derrubar as outras 199, e
    // o relatório precisa nomear QUAL linha — então o lote que falhou é
    // refeito produto a produto.
    for (const produto of lote) {
      const { error: individual } = await supabase
        .from("catalog_products")
        .upsert([semALinha(produto)], { onConflict: "organization_id,codigo" });
      if (individual) {
        erros.push({ linha: produto.linha, motivo: `"${produto.nome}": ${individual.message}` });
        continue;
      }
      gravados += 1;
    }
  }

  const atualizados = paraGravar.filter((p) => antigos.has(p.codigo)).length;
  const criados = Math.max(0, gravados - atualizados);

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.imported",
    resourceType: "catalog_products",
    resourceId: null,
    requestId,
    metadata: {
      actor_type: "user",
      total_linhas: totalLinhas,
      criados,
      atualizados,
      erros: erros.length,
    },
  });

  return ok(
    {
      total_linhas: totalLinhas,
      criados,
      atualizados,
      erros,
      colunas_ignoradas: lido.colunasIgnoradas,
    } satisfies ResumoDaImportacao,
    { requestId },
  );
}

/** GET devolve o modelo de planilha, para a pessoa não ter de adivinhar as colunas. */
export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;

  const modelo = [
    "codigo,nome,marca,categoria,preco,custo,estoque",
    "IP15-128,iPhone 15 128GB,Apple,Celular,5499.00,4100.00,3",
    "PERF-212,212 VIP Men 100ml,Carolina Herrera,Perfume,449.90,280.00,7",
  ].join("\n");

  return new Response(`﻿${modelo}\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="modelo-catalogo.csv"',
      "x-request-id": requestId,
    },
  });
}
