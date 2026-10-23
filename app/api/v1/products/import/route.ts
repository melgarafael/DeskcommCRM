import { requireSupportWrite } from "@/lib/impersonate/support";
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
 * `imagem_url` e os campos fiscais e de medida só entram quando a planilha TEM
 * a coluna, e `ativo` fica sempre de fora — quem escreveu a descrição pela
 * tela não pode perdê-la porque alguém reimportou a lista de preços.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { chaveDoCodigo, lerPlanilha, OPCIONAIS_DA_PLANILHA, type ErroDaLinha } from "@/lib/catalogo/planilha";
import { traduzir } from "@/lib/i18n/dicionario";
import { CSV_MAX_BYTES, CSV_MAX_DATA_ROWS, decodificarCsv } from "@/lib/contacts/csv";
import { COLUNAS_DO_PRODUTO } from "@/lib/schemas/produtos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Lote grande o bastante para uma planilha de loja caber em 3 idas ao banco. */
const LOTE = 200;

/** O teto de linhas por resposta do PostgREST (`max_rows` em `supabase/config.toml`). */
const PAGINA = 1000;

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
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Preço de venda é escrita de gestão: o mesmo papel do POST unitário.
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let arquivo: File;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) throw new Error("sem arquivo");
    arquivo = f;
  } catch {
    return fail("validation_failed", t("Envie o arquivo no campo 'file'."), 422, { requestId });
  }

  const nome = arquivo.name ?? "";
  const tipoOk =
    nome.toLowerCase().endsWith(".csv") ||
    arquivo.type === "text/csv" ||
    arquivo.type === "application/vnd.ms-excel";
  if (!tipoOk) {
    return fail(
      "validation_failed",
      t("Formato não suportado — envie um arquivo .csv. No Excel use 'Salvar como' → 'CSV UTF-8'."),
      422,
      { requestId },
    );
  }
  if (arquivo.size > CSV_MAX_BYTES) {
    return fail(
      "validation_failed",
      t("Arquivo maior que ") + `${Math.floor(CSV_MAX_BYTES / 1024 / 1024)}MB.`,
      413,
      { requestId },
    );
  }

  // Os BYTES, não `arquivo.text()`: o Excel em pt-BR exporta cp1252 e
  // `File.text()` decodifica sempre como UTF-8 — o nome entrava corrompido no
  // catálogo sem um erro sequer, e é ele que o agente lê para o cliente (#483).
  const decodificado = decodificarCsv(await arquivo.arrayBuffer());
  if ("erro" in decodificado) {
    return fail("validation_failed", t(decodificado.erro), 422, { requestId });
  }
  const lido = lerPlanilha(decodificado.texto, t);
  // Problema do ARQUIVO (falta a coluna de preço) é 422 com a frase inteira —
  // e não um relatório com 300 erros idênticos.
  if ("erro" in lido) return fail("validation_failed", lido.erro, 422, { requestId });

  const totalLinhas = lido.produtos.length + lido.erros.length;
  if (totalLinhas > CSV_MAX_DATA_ROWS) {
    return fail(
      "validation_failed",
      `${t("Máximo de")} ${CSV_MAX_DATA_ROWS} ${t("produtos por importação — divida a planilha.")}`,
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

  // Os códigos já cadastrados na organização servem a duas coisas. Quem já
  // existia com o código IGUAL é atualizado, para o resumo dizer "3 novos, 12
  // atualizados" em vez de um número só. Quem existe com o código escrito em
  // OUTRA caixa ("IP15" no catálogo, "ip15" na planilha) é recusado: o índice
  // do banco criaria um segundo produto, e o agente veria os dois como um só,
  // com dois preços (`chaveDoCodigo`, #482). O índice compara o texto exato,
  // então a comparação sem caixa é feita aqui, em memória.
  // O teto conhecido: lê todos os códigos da organização (varredura do índice
  // `(organization_id, codigo)` só dela, nunca da tabela inteira). Serve a
  // catálogo de loja; com centenas de milhares de produtos, vira uma função no
  // banco com `lower(codigo)` e índice de expressão.
  const cadastrados: string[] = [];
  // Avança pelo que VEIO, não pelo que pediu, e para na página vazia: uma
  // instalação com `max_rows` menor que a página não fica com o catálogo cortado.
  for (;;) {
    const { data, error } = await supabase
      .from("catalog_products")
      .select("codigo")
      .eq("organization_id", orgId)
      .order("codigo")
      .range(cadastrados.length, cadastrados.length + PAGINA - 1);
    // Sem o catálogo atual não há como saber quem é repetido: seguir gravaria
    // exatamente a duplicata que esta conferência existe para impedir.
    if (error) {
      return fail(
        "internal_error",
        t("Não consegui conferir o que já está gravado, então nada foi alterado. Tente de novo em instantes."),
        500,
        { requestId },
      );
    }
    if (!data || data.length === 0) break;
    cadastrados.push(...data.map((r) => (r as { codigo: string }).codigo));
  }
  const antigos = new Set(cadastrados);
  const porChave = new Map<string, string[]>();
  for (const codigo of cadastrados) {
    const chave = chaveDoCodigo(codigo);
    porChave.set(chave, [...(porChave.get(chave) ?? []), codigo]);
  }

  const erros: ErroDaLinha[] = [...lido.erros];
  const aceitos = lido.produtos.filter((p) => {
    if (antigos.has(p.codigo)) return true;
    const outraCaixa = porChave.get(chaveDoCodigo(p.codigo));
    if (!outraCaixa) return true;
    erros.push({
      linha: p.linha,
      motivo:
        `"${p.codigo}"` +
        t(": este código já está no catálogo escrito ") +
        outraCaixa.map((c) => `"${c}"`).join(", ") +
        t(". Maiúsculas e minúsculas não mudam o código — escreva igual ao do catálogo para atualizar o produto."),
    });
    return false;
  });
  let gravados = 0;

  // A moeda vem da organização, igual ao cadastro manual — mas só entra na
  // linha de produto NOVO. Um upsert do PostgREST monta UMA sentença
  // `ON CONFLICT ... DO UPDATE SET col = EXCLUDED.col` para o lote inteiro: se
  // a linha de um produto já existente também carregasse `moeda`, reimportar a
  // MESMA planilha depois de trocar a moeda da organização reescreveria a
  // moeda de todo produto já cadastrado — o oposto do que `descricao`,
  // `imagem_url` e `ativo` já protegem (comentário no topo do arquivo). Por
  // isso os dois grupos são upserts SEPARADOS, nunca misturados no mesmo lote:
  // um shape por chamada, sem depender de o PostgREST tratar chave ausente
  // linha a linha.
  const moeda = await moedaDaOrganizacao(supabase, orgId);

  // Os campos opcionais seguem a mesma regra do shape: a coluna entra em TODAS
  // as linhas quando a planilha a traz (célula vazia vira null), e em nenhuma
  // quando não traz. Decidir linha a linha misturaria shapes no lote, e a
  // chave ausente numa linha viraria `EXCLUDED.col = NULL` — reimportar a lista
  // de preços apagaria o peso, o GTIN ou o preço "de" do produto.
  const presentes = OPCIONAIS_DA_PLANILHA.filter((c) => aceitos.some((p) => p[c] !== undefined));

  const base = (p: (typeof lido.produtos)[number]) => ({
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
    ...Object.fromEntries(presentes.map((c) => [c, p[c] ?? null])),
  });

  // A foto da planilha só vira a galeria do produto NOVO: no que já existe, a
  // galeria pode ter as fotos do armazenamento, e um link solto não as substitui.
  const comImagem = presentes.includes("imagem_url");
  const paraGravar = aceitos.map((p) =>
    antigos.has(p.codigo)
      ? base(p)
      : { ...base(p), moeda, ...(comImagem ? { fotos: p.imagem_url ? [p.imagem_url] : [] } : {}) },
  );

  /** Grava um grupo de shape uniforme, em lotes, com reteste linha a linha no que falhar. */
  async function gravarEmLotes(itens: typeof paraGravar): Promise<void> {
    for (let i = 0; i < itens.length; i += LOTE) {
      const lote = itens.slice(i, i + LOTE);
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
  }

  const novos = paraGravar.filter((p) => !antigos.has(p.codigo));
  const existentes = paraGravar.filter((p) => antigos.has(p.codigo));
  await gravarEmLotes(novos);
  await gravarEmLotes(existentes);

  const atualizados = existentes.length;
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

/** GET devolve o modelo de planilha nos formatos Padrão, Meta Catalog e Bling ERP. */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;

  const formato = req.nextUrl.searchParams.get("formato") ?? "padrao";

  let modelo = "";
  let filename = "modelo-catalogo.csv";

  if (formato === "meta") {
    filename = "modelo-catalogo-meta.csv";
    modelo = [
      "id,title,description,availability,condition,price,link,image_link,brand,gtin,google_product_category",
      "IP15-128,iPhone 15 128GB,Smartphone Apple com tela Super Retina XDR e câmera 48MP,in stock,new,5499.00 BRL,https://sualoja.com.br/produto/iphone-15,https://sualoja.com.br/fotos/iphone15.jpg,Apple,0195949038280,Electronics > Communications > Telephony > Mobile Phones",
      "PERF-212,212 VIP Men 100ml,Perfume masculino sofisticado e marcante,in stock,new,449.90 BRL,https://sualoja.com.br/produto/212-vip,https://sualoja.com.br/fotos/212.jpg,Carolina Herrera,8411061723760,Health & Beauty > Personal Care > Cosmetics > Perfumes",
    ].join("\n");
  } else if (formato === "bling") {
    filename = "modelo-catalogo-bling.csv";
    modelo = [
      "codigo,descricao,preco,custo,estoque,gtin,ncm,origem,peso_bruto,largura,altura,profundidade,marca,categoria",
      "IP15-128,iPhone 15 128GB,5499.00,4100.00,10,0195949038280,8517.13.00,0,171,8,15,1,Apple,Smartphones",
      "PERF-212,212 VIP Men 100ml,449.90,280.00,15,8411061723760,3303.00.10,2,400,10,18,8,Carolina Herrera,Perfumaria",
    ].join("\n");
  } else {
    filename = "modelo-catalogo.csv";
    modelo = [
      "codigo,nome,descricao,marca,categoria,preco,preco_de,custo,estoque,gtin,ncm,link_loja",
      "IP15-128,iPhone 15 128GB,Smartphone Apple com chip A16 Bionic e câmera de 48MP,Apple,Celular,5499.00,5999.00,4100.00,10,0195949038280,8517.13.00,https://sualoja.com.br/iphone-15",
      "PERF-212,212 VIP Men 100ml,Fragrância masculina exclusiva e marcante,Carolina Herrera,Perfume,449.90,499.90,280.00,7,8411061723760,3303.00.10,https://sualoja.com.br/212-vip",
    ].join("\n");
  }

  return new Response(`﻿${modelo}\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "x-request-id": requestId,
    },
  });
}
