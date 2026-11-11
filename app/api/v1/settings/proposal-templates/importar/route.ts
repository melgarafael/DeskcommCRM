// app/api/v1/settings/proposal-templates/importar/route.ts
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { lerCorpoComTeto } from "@/lib/api/corpo-com-teto";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { env } from "@/lib/env";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { LlmBudgetExceededError, LlmModelNotEnabledError, LlmProviderUnknownError } from "@/lib/agent-engine/edge/llm/run-model-call";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { PdfExtractError, extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import { extractMarkdownText } from "@/lib/ai/rag/extractors/markdown";
import { resolverExtensao } from "@/lib/ai/rag/ingest/documento";
import { traduzir } from "@/lib/i18n/dicionario";
import { gerarModeloDoTexto } from "@/lib/propostas/modelos/importar";
import { validarModelo } from "@/lib/propostas/modelos/validar-modelo";
import { sePropostasDesligadas } from "@/lib/propostas/porta";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const TAMANHO_MAXIMO = 5 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "proposal_templates" });
  if (!authz.ok) return authz.response;
  const desligada = await sePropostasDesligadas(authz.org.orgId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  // 64 KB de folga para o envelope multipart; o tamanho do arquivo é conferido abaixo.
  const corpo = await lerCorpoComTeto(req, TAMANHO_MAXIMO + 64 * 1024, {
    requestId,
    idioma: authz.user.idioma,
    acimaDoTeto: t("O arquivo passa de 5 MB."),
  });
  if (!corpo.ok) return corpo.response;

  let form: FormData;
  try {
    form = await corpo.corpo.formData();
  } catch {
    return fail("invalid_request", t("Falha ao processar o envio do arquivo."), 400, { requestId });
  }
  const arquivo = form.get("file");
  if (!(arquivo instanceof File)) return fail("invalid_request", t("Nenhum arquivo foi enviado."), 400, { requestId });
  if (arquivo.size > TAMANHO_MAXIMO) return fail("payload_too_large", t("O arquivo passa de 5 MB."), 413, { requestId });

  const extensaoBruta = arquivo.name.split(".").pop()?.toLowerCase() ?? "";
  if (extensaoBruta === "docx" || extensaoBruta === "doc") {
    return fail("unsupported_media_type", t("Não leio Word diretamente — no Word use \"Salvar como\" → PDF e envie o PDF."), 415, { requestId });
  }
  const extensao = resolverExtensao(arquivo.name, arquivo.type);
  if (extensao !== "pdf" && extensao !== "md" && extensao !== "txt") {
    return fail("unsupported_media_type", t("Envie a proposta em PDF, Markdown (.md) ou texto (.txt)."), 415, { requestId });
  }

  const buffer = Buffer.from(await arquivo.arrayBuffer());
  let texto: string;
  try {
    texto = extensao === "pdf" ? await extractPdfText(buffer) : extractMarkdownText(buffer);
  } catch (erro) {
    if (erro instanceof PdfExtractError) {
      return fail("validation_failed", t("Não encontrei texto neste arquivo. Se for um PDF escaneado, exporte a proposta original como PDF com texto."), 422, { requestId });
    }
    return fail("validation_failed", t("Não consegui ler este arquivo."), 422, { requestId });
  }
  if (texto.trim().length < 50) {
    return fail("validation_failed", t("Não encontrei texto neste arquivo. Se for um PDF escaneado, exporte a proposta original como PDF com texto."), 422, { requestId });
  }

  try {
    const modelo = await gerarModeloDoTexto({
      texto,
      pool: getSkillsPool(),
      cfg: llmEdgeConfigFromEnv(env),
      tenantId: authz.org.orgId,
    });
    if (!modelo) return ok({ disponivel: true, modelo: null, erros: [] }, { requestId });
    const erros = validarModelo({ nome: modelo.nome, descricao: null, sections: modelo.sections, sectionOrder: modelo.sectionOrder });
    void audit({
      action: "proposal_template.imported",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "proposal_templates",
      resourceId: null,
      requestId,
      metadata: { extensao, bytes: arquivo.size, secoes: modelo.sections.length },
    });
    return ok({ disponivel: true, modelo, erros }, { requestId });
  } catch (err) {
    if (err instanceof LlmBudgetExceededError || err instanceof LlmProviderUnknownError || err instanceof LlmModelNotEnabledError) {
      return ok({ disponivel: false, motivo: err.message }, { requestId });
    }
    throw err;
  }
}
