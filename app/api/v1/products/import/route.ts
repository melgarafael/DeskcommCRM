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
 * `imagem_url` e `ativo` ficam de fora de propósito — quem escreveu a descrição
 * pela tela não pode perdê-la porque alguém reimportou a lista de preços.
 *
 * ─── A foto por URL (#3587) segue a mesma regra, e por isso é uma coluna ────
 *
 * A planilha pode trazer a coluna de foto, com um link ou até 5 separados por
 * `|` (o primeiro é a capa). O servidor BAIXA cada link, guarda em
 * `catalog-photos` e grava o CAMINHO em `fotos` — o mesmo formato que a tela
 * grava e o único que o agente aceita na hora de apresentar o produto. A URL
 * não é gravada em coluna nenhuma: link de anúncio sai do ar quando o carro é
 * vendido, e aí a foto do cliente some junto.
 *
 * A linha que traz foto manda nas fotos DAQUELE produto (as anteriores saem do
 * bucket); célula vazia não fala nada e deixa o que a tela gravou em paz. E a
 * linha que declara uma foto que não dá para baixar é RECUSADA inteira, como a
 * do preço ilegível — produto no catálogo com a foto errada é o defeito que
 * esta fatia existe para não ter.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { chaveDoCodigo, lerPlanilha, type ErroDaLinha } from "@/lib/catalogo/planilha";
import { guardarFotosPorUrl } from "@/lib/catalogo/fotos-por-url";
import { apagarDoBucket } from "@/lib/catalogo/fotos-no-bucket";
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
  /**
   * O que já está gravado: `id` e `fotos` além do código.
   *
   * O `id` é o que nomeia a pasta da foto no bucket (`<org>/<id>/…`) — sem ele
   * não há como guardar a foto de um produto que já existe. E as `fotos` de
   * hoje são o que a planilha vai substituir: sem elas, o arquivo trocado fica
   * órfão no bucket em toda reimportação.
   */
  const conhecidos: Array<{ id: string; codigo: string; fotos: string[] | null }> = [];
  // Avança pelo que VEIO, não pelo que pediu, e para na página vazia: uma
  // instalação com `max_rows` menor que a página não fica com o catálogo cortado.
  for (;;) {
    const { data, error } = await supabase
      .from("catalog_products")
      .select("id, codigo, fotos")
      .eq("organization_id", orgId)
      .order("codigo")
      .range(conhecidos.length, conhecidos.length + PAGINA - 1);
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
    conhecidos.push(...(data as Array<{ id: string; codigo: string; fotos: string[] | null }>));
  }
  const cadastrados = conhecidos.map((r) => r.codigo);
  const antigos = new Set(cadastrados);
  const idPorCodigo = new Map(conhecidos.map((r) => [r.codigo, r.id]));
  const fotosPorCodigo = new Map(conhecidos.map((r) => [r.codigo, r.fotos ?? []]));
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
  /** Os códigos que REALMENTE entraram — a limpeza das fotos antigas depende disso. */
  const gravadosPorCodigo = new Set<string>();

  // A moeda vem da organização, igual ao cadastro manual — mas só entra na
  // linha de produto NOVO. Um upsert do PostgREST monta UMA sentença
  // `ON CONFLICT ... DO UPDATE SET col = EXCLUDED.col` para o lote inteiro: se
  // a linha de um produto já existente também carregasse `moeda`, reimportar a
  // MESMA planilha depois de trocar a moeda da organização reescreveria a
  // moeda de todo produto já cadastrado — o oposto do que `descricao`,
  // `imagem_url` e `ativo` já protegem (comentário no topo do arquivo). Por
  // isso os grupos são upserts SEPARADOS, nunca misturados no mesmo lote: um
  // shape por chamada (novo × existente, com foto × sem foto), sem depender de
  // o PostgREST tratar chave ausente linha a linha.
  const moeda = await moedaDaOrganizacao(supabase, orgId);

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
  });

  /**
   * ─── A foto é baixada ANTES da gravação, e a linha que falha não entra ─────
   *
   * O caminho no bucket é `<org>/<produto>/<uuid>.<ext>`: sem o id do produto
   * não há onde guardar. O do produto que já existe vem da leitura do catálogo;
   * o do produto novo nasce aqui, e é por isso que ele — e só ele — leva `id`
   * no shape (ver o grupo `novo+foto` em `gravarEmLotes`).
   *
   * Guardar depois de gravar seria mais barato e produziria o pior relatório:
   * "a linha 5 falhou" para um produto que ENTROU sem a foto que a planilha
   * anunciava. Baixar antes faz a recusa ser inteira, como a do preço ilegível.
   */
  const preparadas: Array<(typeof lido.produtos)[number] & { fotos?: string[]; id?: string }> = [];
  for (const p of aceitos) {
    if (!p.fotos || p.fotos.length === 0) {
      preparadas.push(p);
      continue;
    }
    const idExistente = idPorCodigo.get(p.codigo);
    const produtoId = idExistente ?? randomUUID();
    const guardadas = await guardarFotosPorUrl({ orgId, produtoId, urls: p.fotos, t });
    if (!guardadas.ok) {
      erros.push({ linha: p.linha, motivo: guardadas.motivo });
      continue;
    }
    preparadas.push(
      idExistente
        ? { ...p, fotos: guardadas.caminhos }
        : { ...p, id: produtoId, fotos: guardadas.caminhos },
    );
  }

  const paraGravar = preparadas.map((p) => {
    const existente = antigos.has(p.codigo);
    return {
      ...base(p),
      ...(existente ? {} : { moeda }),
      ...(p.id ? { id: p.id } : {}),
      ...(p.fotos ? { fotos: p.fotos } : {}),
    };
  });

  /** Grava um grupo de shape uniforme, em lotes, com reteste linha a linha no que falhar. */
  async function gravarEmLotes(
    itens: typeof paraGravar,
    modo: "upsert" | "insert",
  ): Promise<void> {
    const enviar = (linhas: Array<Record<string, unknown>>) =>
      modo === "insert"
        ? supabase.from("catalog_products").insert(linhas)
        : supabase.from("catalog_products").upsert(linhas, { onConflict: "organization_id,codigo" });

    for (let i = 0; i < itens.length; i += LOTE) {
      const lote = itens.slice(i, i + LOTE);
      const { error } = await enviar(lote.map(semALinha));

      if (!error) {
        gravados += lote.length;
        for (const linha of lote) gravadosPorCodigo.add(linha.codigo);
        continue;
      }

      // O lote é tudo-ou-nada. Uma linha ruim não pode derrubar as outras 199, e
      // o relatório precisa nomear QUAL linha — então o lote que falhou é
      // refeito produto a produto.
      for (const produto of lote) {
        const { error: individual } = await enviar([semALinha(produto)]);
        if (individual) {
          erros.push({ linha: produto.linha, motivo: `"${produto.nome}": ${individual.message}` });
          continue;
        }
        gravados += 1;
        gravadosPorCodigo.add(produto.codigo);
      }
    }
  }

  /**
   * O grupo `novo+foto` NÃO é upsert: o `id` que ele carrega é o da pasta da
   * foto, e num upsert a chave presente também é escrita no `DO UPDATE` — um
   * código já existente (corrida entre a leitura do catálogo e esta gravação)
   * teria a CHAVE PRIMÁRIA trocada, e as fotos do produto em uso passariam a
   * apontar para uma pasta que não é mais dele. Com `insert`, esse caso vira o
   * erro de código repetido que a linha já sabe relatar.
   */
  const grupos = new Map<string, typeof paraGravar>();
  for (const linha of paraGravar) {
    const chave = `${antigos.has(linha.codigo) ? "existente" : "novo"}${"fotos" in linha ? "+foto" : ""}`;
    grupos.set(chave, [...(grupos.get(chave) ?? []), linha]);
  }
  for (const [chave, linhas] of grupos) {
    await gravarEmLotes(linhas, chave === "novo+foto" ? "insert" : "upsert");
  }

  // A foto que a planilha substituiu sai do bucket — a mesma limpeza que o PUT
  // da tela faz. Só de quem REALMENTE entrou: apagar o arquivo de um produto
  // cuja gravação falhou deixaria a linha apontando para foto que não existe.
  for (const p of preparadas) {
    if (!p.fotos || !gravadosPorCodigo.has(p.codigo)) continue;
    const id = p.id ?? idPorCodigo.get(p.codigo);
    if (!id) continue;
    const antigas = (fotosPorCodigo.get(p.codigo) ?? []).filter((c) => !p.fotos!.includes(c));
    await apagarDoBucket(orgId, id, antigas, requestId);
  }

  const existentes = paraGravar.filter((p) => antigos.has(p.codigo));
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

/**
 * GET devolve o modelo de planilha, para a pessoa não ter de adivinhar as colunas.
 *
 * A coluna `foto` vem no cabeçalho e VAZIA nas duas linhas: o modelo tem de
 * importar limpo como vem, que é o primeiro gesto de quem testa a importação.
 * Um link de exemplo ali seria baixado de verdade — de um domínio de terceiros —
 * e a linha voltaria recusada. O formato `link1|link2` é explicado na tela de
 * Produtos, ao lado do link do modelo.
 */
export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;

  const modelo = [
    "codigo,nome,marca,categoria,preco,custo,estoque,foto",
    "IP15-128,iPhone 15 128GB,Apple,Celular,5499.00,4100.00,3,",
    "PERF-212,212 VIP Men 100ml,Carolina Herrera,Perfume,449.90,280.00,7,",
  ].join("\n");

  return new Response(`﻿${modelo}\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="modelo-catalogo.csv"',
      "x-request-id": requestId,
    },
  });
}
