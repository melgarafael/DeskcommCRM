import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { lerCorpoComTeto } from "@/lib/api/corpo-com-teto";
import { fail, ok } from "@/lib/api/wrappers";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  IMPORT_MAX_BYTES,
  isCsvFilename,
  isXlsxFilename,
  parseImportFile,
} from "@/lib/planilha/ler-arquivo";
import { chaveDoArquivo } from "@/lib/tabela-de-valores/importacao";
import { lerPlanilhaDaTabelaDeValores } from "@/lib/tabela-de-valores/planilha";
import {
  arquivoJaImportado,
  buscarTabelaDeValores,
  importarTabelaDeValores,
  previaDaPlanilha,
} from "@/lib/tabela-de-valores/store";
import { TABELA_MAX_LINHAS } from "@/lib/tabela-de-valores/tipos";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
/** Quantas recusadas voltam na resposta; o total vai à parte. */
const MAX_RECUSADAS_NA_RESPOSTA = 100;

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/tabelas-de-valores/{id}/importar — a planilha da tabela de valores.
 *
 * Multipart: o arquivo no campo `file` e `somente_previa=true` para a PRÉVIA.
 *
 * ─── A prévia é obrigatória de verdade, não uma sugestão ─────────────────
 *
 * Sem `somente_previa`, a rota grava. Com ele, NADA é escrito: nem item, nem o
 * registro da importação. É a mesma chamada com o mesmo leitor — o que o
 * operador vê na prévia é exatamente o que entra na confirmação, porque as duas
 * passadas usam o mesmo `lerPlanilhaDaTabelaDeValores` e o mesmo `montarPrevia`.
 *
 * ─── A mesma planilha duas vezes ─────────────────────────────────────────
 *
 * A chave é o SHA-256 dos bytes do arquivo. Na confirmação, a importação devolve
 * `repetida: true`, não grava nada e responde com as contagens da primeira —
 * em vez de duplicar procedimento. O `unique (tabela_id, codigo)` no banco é a
 * segunda cerca, para quando o mesmo conteúdo chega com outro nome de arquivo.
 *
 * Só sessão (como a importação de prospecção): um token Bearer leva 403, porque
 * importar planilha é operação de tela.
 */
export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const support = await requireSupportWrite();
  if (support) return support;
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "tabela_de_valores",
    role: "admin",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "tabela_de_valores", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  if (authz.via === "token")
    return fail("forbidden", t("Importar planilha exige a tela."), 403, { requestId, headers });

  const { id: tabelaId } = await ctx.params;
  const org = authz.organizationId;
  const pool = getRequestPool();
  const tabela = await buscarTabelaDeValores(pool, org, tabelaId);
  if (!tabela) return fail("not_found", t("Tabela de valores não encontrada."), 404, { requestId, headers });

  const corpo = await lerCorpoComTeto(req, IMPORT_MAX_BYTES + 64 * 1024, {
    requestId,
    headers,
    acimaDoTeto: t("Arquivo grande demais (máximo de 2 MB)."),
  });
  if (!corpo.ok) return corpo.response;

  let form: FormData;
  try {
    form = await corpo.corpo.formData();
  } catch {
    return fail("validation_failed", t("Envie o formulário com o arquivo da planilha."), 422, {
      requestId,
      headers,
    });
  }

  const arquivo = form.get("file");
  if (!(arquivo instanceof File))
    return fail("validation_failed", t("Envie o arquivo no campo 'file'."), 422, {
      requestId,
      headers,
    });
  if (!isCsvFilename(arquivo.name) && !isXlsxFilename(arquivo.name))
    return fail("validation_failed", t("Formato não suportado — envie .csv ou .xlsx."), 422, {
      requestId,
      headers,
    });
  if (arquivo.size > IMPORT_MAX_BYTES)
    return fail("validation_failed", t("Arquivo grande demais (máximo de 2 MB)."), 422, {
      requestId,
      headers,
    });

  const buffer = await arquivo.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const lido = await parseImportFile(buffer, arquivo.name, { maxLinhas: TABELA_MAX_LINHAS });
  if (!lido.ok) return fail("validation_failed", t(lido.error), 422, { requestId, headers });
  const leitura = lerPlanilhaDaTabelaDeValores(lido.sheet);
  if ("erro" in leitura) return fail("validation_failed", t(leitura.erro), 422, { requestId, headers });

  const chave = chaveDoArquivo(bytes);
  // A CLASSIFICAÇÃO ACONTECE ANTES DE QUALQUER ESCRITA, e a prévia e a
  // confirmação usam a mesma. Entre a prévia e o clique os códigos da tabela
  // podem ter mudado: a gravação não reclassifica, e quem segura o código que
  // entrou nesse meio-tempo é o `on conflict do nothing` (conta em `ja_existe`).
  const previa = await previaDaPlanilha(pool, org, tabelaId, leitura, chave);
  const recusadas = previa.fora.slice(0, MAX_RECUSADAS_NA_RESPOSTA);
  const somentePrevia = form.get("somente_previa") === "true";

  if (somentePrevia)
    return ok(
      {
        previa: true as const,
        chave_do_arquivo: chave,
        entram: previa.entram.map(({ linha, item }) => ({
          linha,
          codigo: item.codigo,
          descricao: item.descricao,
          valor_us_partida_cents: item.valor_us_partida_cents,
          valor_us_limite_cents: item.valor_us_limite_cents,
          valor_brl_partida_cents: item.valor_brl_partida_cents,
          valor_brl_limite_cents: item.valor_brl_limite_cents,
          unidade: item.unidade,
        })),
        total_entram: previa.entram.length,
        recusadas,
        total_recusadas: previa.fora.length,
        total_linhas: previa.total_linhas,
        resumo: previa.resumo,
        colunas_ignoradas: leitura.colunasIgnoradas,
      },
      { requestId, headers },
    );

  // A mesma planilha de novo: nenhuma linha "entra" (todas já existem), mas o
  // desfecho certo é `repetida: true`, que `importarTabelaDeValores` devolve sem
  // gravar. Só recusa com 422 a planilha NOVA em que nada pode entrar.
  if (previa.entram.length === 0 && !(await arquivoJaImportado(pool, org, tabelaId, chave)))
    return fail(
      "validation_failed",
      t("Nenhuma linha da planilha pode entrar: confira o motivo de cada linha recusada."),
      422,
      {
        requestId,
        headers,
        details: {
          recusadas,
          total_recusadas: previa.fora.length,
          resumo: previa.resumo,
        },
      },
    );

  try {
    const resultado = await importarTabelaDeValores(
      pool,
      org,
      tabelaId,
      {
        chave_do_arquivo: chave,
        nome_do_arquivo: arquivo.name,
        previa,
        linhas_lidas: previa.total_linhas,
      },
      authz.actor.type === "user" ? authz.actor.id : null,
    );
    if (!resultado.repetida) {
      await audit({
        action: "tabela_de_valores.importada",
        organizationId: org,
        actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
        resourceType: "tabela_de_valores",
        resourceId: tabelaId,
        // Contagens apenas: sem nome de arquivo (pode ter nome de pessoa) e sem
        // preço de linha. O bastante para provar depois o que entrou.
        metadata: {
          operation: "importar_planilha",
          chave_do_arquivo: chave,
          arquivo_bytes: arquivo.size,
          linhas_lidas: previa.total_linhas,
          inseridos: resultado.inseridos,
          ja_existe: resultado.ja_existe,
          recusadas: previa.fora.length,
          motivos: resultado.resumo,
        },
        requestId,
      });
    }
    return ok(
      {
        tabela_id: tabelaId,
        inseridos: resultado.inseridos,
        ja_existe: resultado.ja_existe,
        repetida: resultado.repetida,
        recusadas: resultado.fora.slice(0, MAX_RECUSADAS_NA_RESPOSTA),
        total_recusadas: resultado.fora.length,
        total_linhas: resultado.total_linhas,
        resumo: resultado.resumo,
        colunas_ignoradas: leitura.colunasIgnoradas,
      },
      { requestId, headers },
    );
  } catch (erro) {
    logger.error("[tabela-de-valores] importação falhou", {
      organizationId: org,
      tabelaId,
      requestId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return fail(
      "internal_error",
      t("Não foi possível importar a planilha. Tente novamente."),
      500,
      { requestId, headers },
    );
  }
}
