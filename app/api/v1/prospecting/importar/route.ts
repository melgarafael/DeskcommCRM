import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import {
  IMPORT_MAX_BYTES,
  isCsvFilename,
  isXlsxFilename,
  parseImportFile,
} from "@/lib/planilha/ler-arquivo";
import { ProspectingError } from "@/lib/prospecting/provider";
import { importarPlanilhaCamposSchema } from "@/lib/prospecting/schema";
import type { PreviaDaImportacao } from "@/lib/prospecting/importacao-previa";
import { lerPlanilhaDeProspeccao, PLANILHA_MAX_LINHAS } from "@/lib/prospecting/planilha";
import { importarPlanilha, previaDaPlanilha } from "@/lib/prospecting/store";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
/** Quantas recusadas voltam na resposta; o total vai à parte. */
const MAX_RECUSADAS_NA_RESPOSTA = 100;

/**
 * POST /api/v1/prospecting/importar — cria uma campanha em rascunho a partir de uma planilha
 * (.csv ou .xlsx) do operador. Multipart, por isso fora da união JSON de `/api/v1/prospecting`.
 *
 * Só sessão: a rota NÃO está em `lib/auth/public-paths.ts` (o bearer fica de fora de propósito,
 * como em `reanalisar_site`) e, se um token chegar mesmo assim, leva 403. Nada do formulário
 * vira organização: ela vem da autenticação.
 */
export async function POST(req: NextRequest) {
  const support = await requireSupportWrite();
  if (support) return support;
  const requestId = randomUUID();
  const auth = await resolveAuthDual(req, {
    requestId,
    resource: "prospecting",
    role: "admin",
    scope: "mcp:write",
  });
  if (!auth.ok) return auth.response;
  // A cerca da casa (`rotas-bearer-aplicam-teto-de-escrita`) exige o teto em toda rota com
  // `resolveAuthDual`; aqui o token é recusado logo abaixo, mas o teto vem antes, como nas irmãs.
  const teto = await tetoDeEscritaDoToken(auth, "prospecting", requestId);
  if (teto) return teto;
  if (auth.via === "token")
    return fail("forbidden", "Importar planilha exige a tela.", 403, { requestId, headers });
  const org = auth.organizationId;

  // `formData()` lê o corpo inteiro para a memória: o tamanho declarado é conferido antes.
  // A folga cobre o envelope multipart e os campos de texto além do arquivo.
  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (declarado > IMPORT_MAX_BYTES + 64 * 1024)
    return fail("validation_failed", "Arquivo grande demais (máximo de 2 MB).", 422, {
      requestId,
      headers,
    });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("validation_failed", "Envie o formulário com o arquivo da planilha.", 422, {
      requestId,
      headers,
    });
  }
  const file = form.get("file");
  if (!(file instanceof File))
    return fail("validation_failed", "Envie o arquivo no campo 'file'.", 422, {
      requestId,
      headers,
    });
  if (!isCsvFilename(file.name) && !isXlsxFilename(file.name))
    return fail("validation_failed", "Formato não suportado — envie .csv ou .xlsx.", 422, {
      requestId,
      headers,
    });
  // O `content-length` pode faltar (envio em partes): o arquivo é conferido de novo aqui.
  if (file.size > IMPORT_MAX_BYTES)
    return fail("validation_failed", "Arquivo grande demais (máximo de 2 MB).", 422, {
      requestId,
      headers,
    });

  const texto: Record<string, FormDataEntryValue> = {};
  for (const [chave, valor] of form.entries()) if (chave !== "file") texto[chave] = valor;
  const campos = importarPlanilhaCamposSchema.safeParse(texto);
  if (!campos.success)
    return fail(
      "validation_failed",
      "Confira os campos: nome da campanha, público ou segmento e de onde veio a lista.",
      422,
      { requestId, headers },
    );

  const lido = await parseImportFile(await file.arrayBuffer(), file.name, {
    maxLinhas: PLANILHA_MAX_LINHAS,
  });
  if (!lido.ok) return fail("validation_failed", lido.error, 422, { requestId, headers });
  const planilha = lerPlanilhaDeProspeccao(lido.sheet);
  if ("erro" in planilha)
    return fail("validation_failed", planilha.erro, 422, { requestId, headers });
  // A CLASSIFICAÇÃO ACONTECE ANTES DE QUALQUER ESCRITA. Aqui, e de novo dentro do lock da
  // importação: entre a prévia e o clique em "Importar" o telefone pode ter virado contato ou
  // o titular pode ter pedido a exclusão. Quem responde as duas perguntas é a mesma função
  // (`previaDaPlanilha`), então a prévia não pode prometer um número que a escrita não cumpre.
  const pool = getRequestPool();
  const { request_id, previa: somentePrevia, ...resto } = campos.data;
  let previa: PreviaDaImportacao;
  try {
    previa = await previaDaPlanilha(pool, org, planilha);
  } catch {
    return fail(
      "prospecting_unavailable",
      "Não foi possível conferir a planilha agora. Tente novamente.",
      500,
      { requestId, headers },
    );
  }
  const recusadas = previa.fora.slice(0, MAX_RECUSADAS_NA_RESPOSTA);

  // A prévia NÃO cria campanha, não audita e não escreve: é o operador conferindo o arquivo.
  if (somentePrevia)
    return ok(
      {
        previa: true as const,
        entram: previa.entram.length,
        recusadas,
        total_recusadas: previa.fora.length,
        total_linhas: previa.total_linhas,
        resumo: previa.resumo,
        colunas_ignoradas: planilha.colunasIgnoradas,
      },
      { requestId, headers },
    );

  if (previa.entram.length === 0)
    return fail(
      "validation_failed",
      "Nenhuma linha da planilha pode entrar: confira os motivos de cada linha recusada.",
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
    const resultado = await importarPlanilha(
      pool,
      org,
      request_id,
      {
        ...resto,
        arquivo_bytes: file.size,
        linhas: lido.sheet.rows.length,
      },
      planilha,
    );
    if (!resultado.repetida) {
      await audit({
        action: "prospecting.changed",
        organizationId: org,
        actorUserId: auth.actor.type === "user" ? auth.actor.id : null,
        resourceType: "prospecting",
        resourceId: resultado.campaign.id,
        // Contagens apenas: sem nome de arquivo (pode ter nome de pessoa) e sem dado de linha.
        // `motivos` guarda QUANTOS saíram por cada razão — o suficiente para a LGPD provar que
        // a supressão rodou, sem gravar telefone nem nome de quem ficou de fora.
        metadata: {
          operation: "importar_planilha",
          arquivo_bytes: file.size,
          linhas: lido.sheet.rows.length,
          inseridos: resultado.inseridos,
          ja_na_base: resultado.ja_na_base,
          recusadas: resultado.fora.length,
          motivos: resultado.resumo,
          classes_puras: resultado.classesPuras,
        },
        requestId,
      });
    }
    return ok(
      {
        campaign_id: resultado.campaign.id,
        inseridos: resultado.inseridos,
        ja_na_base: resultado.ja_na_base,
        recusadas: resultado.fora.slice(0, MAX_RECUSADAS_NA_RESPOSTA),
        total_recusadas: resultado.fora.length,
        total_linhas: resultado.total_linhas,
        resumo: resultado.resumo,
        colunas_ignoradas: planilha.colunasIgnoradas,
        repetida: resultado.repetida,
      },
      { requestId, headers },
    );
  } catch (error) {
    return fail(
      "prospecting_unavailable",
      error instanceof ProspectingError
        ? error.message
        : "Não foi possível importar a planilha. Tente novamente.",
      error instanceof ProspectingError ? error.status : 500,
      { requestId, headers },
    );
  }
}
