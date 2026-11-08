// app/api/v1/settings/proposal-templates/importar/route.test.ts
// @vitest-environment node
// (pragma da casa para rotas multipart: todo teste de upload — logo,
// contacts/import, products/import, skills/import — roda em node, onde
// `formData().get() instanceof File` vale; no jsdom há dois realms de File
// e a rota devolveria 400 "Nenhum arquivo foi enviado".)
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pedidoComTamanho } from "@/tests/helpers/pedido-com-tamanho";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mocks: Record<string, any> = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSupportWrite: vi.fn(),
  audit: vi.fn(),
  traduzir: vi.fn((txt: string) => txt),
  gerarModeloDoTexto: vi.fn(),
  extractPdfText: vi.fn(),
  getSkillsPool: vi.fn(() => ({})),
  llmEdgeConfigFromEnv: vi.fn(() => ({})),
}));

vi.mock("@/lib/propostas/porta", () => ({ sePropostasDesligadas: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.requireSupportWrite }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/i18n/dicionario", () => ({ traduzir: mocks.traduzir }));
vi.mock("@/lib/propostas/modelos/importar", () => ({ gerarModeloDoTexto: mocks.gerarModeloDoTexto }));
vi.mock("@/lib/ai/rag/extractors/pdf", () => ({
  PdfExtractError: class PdfExtractError extends Error {},
  extractPdfText: mocks.extractPdfText,
}));
vi.mock("@/lib/ai/skills/db", () => ({ getSkillsPool: mocks.getSkillsPool }));
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  llmEdgeConfigFromEnv: mocks.llmEdgeConfigFromEnv,
}));
// O import real de run-model-call puxa o SDK `ai`, que instala um segundo
// realm de File/Blob e quebra `instanceof File` no jsdom (a rota devolve 400
// "Nenhum arquivo foi enviado"). A rota só usa daqui as 3 classes de erro,
// então o mock as recria — o `instanceof` da rota e o do teste usam a mesma.
const errosLlm = vi.hoisted(() => {
  class LlmBudgetExceededError extends Error {}
  class LlmProviderUnknownError extends Error {}
  class LlmModelNotEnabledError extends Error {}
  return { LlmBudgetExceededError, LlmProviderUnknownError, LlmModelNotEnabledError };
});
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => errosLlm);
vi.mock("@/lib/env", () => ({ env: {} }));

import { LlmBudgetExceededError } from "@/lib/agent-engine/edge/llm/run-model-call";

import { POST } from "./route";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ROLE_RANK: Record<string, number> = { viewer: 1, agent: 2, manager: 3, admin: 4 };

function montarMundo(papel: keyof typeof ROLE_RANK = "manager") {
  const rank = ROLE_RANK[papel] ?? 0;
  mocks.requireRole.mockImplementation(async (minRole: keyof typeof ROLE_RANK) => {
    const minRank = ROLE_RANK[minRole] ?? 0;
    return rank < minRank
      ? { ok: false, response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }) }
      : { ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: ORG_ID } };
  });
  mocks.requireSupportWrite.mockResolvedValue(null);
}

function arquivo(nome: string, tipo: string, conteudo: string) {
  const file = new File([conteudo], nome, { type: tipo });
  const form = new FormData();
  form.append("file", file);
  return pedidoComTamanho("http://x", { method: "POST", body: form });
}

const TEXTO_LONGO = "texto ".repeat(20);

const MODELO_OK = {
  nome: "Portal imobiliário",
  sections: [{ id: "resumo", title: "Resumo", titleEs: null, body: "Texto.", bodyEs: null, required: true, conditional: false }],
  sectionOrder: ["resumo"],
};

describe("POST /api/v1/settings/proposal-templates/importar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    montarMundo();
    mocks.gerarModeloDoTexto.mockResolvedValue(MODELO_OK);
    mocks.extractPdfText.mockResolvedValue(TEXTO_LONGO);
  });

  it(".docx → 415 com Salvar como", async () => {
    const res = await POST(await arquivo("proposta.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x") as never);
    expect(res.status).toBe(415);
    expect(await res.text()).toContain("Salvar como");
    expect(mocks.gerarModeloDoTexto).not.toHaveBeenCalled();
  });

  it(".csv → 415", async () => {
    const res = await POST(await arquivo("planilha.csv", "text/csv", "a,b,c") as never);
    expect(res.status).toBe(415);
    expect(mocks.gerarModeloDoTexto).not.toHaveBeenCalled();
  });

  it("arquivo de 6 MB → 413", async () => {
    const res = await POST(await arquivo("proposta.txt", "text/plain", "x".repeat(6 * 1024 * 1024)) as never);
    expect(res.status).toBe(413);
    expect(mocks.gerarModeloDoTexto).not.toHaveBeenCalled();
  });

  it("PDF cujo extractPdfText lança PdfExtractError → 422 com PDF escaneado", async () => {
    const { PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    mocks.extractPdfText.mockRejectedValueOnce(new PdfExtractError("sem texto"));
    const res = await POST(await arquivo("proposta.pdf", "application/pdf", "%PDF sem texto") as never);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("PDF escaneado");
  });

  it(".txt válido → 200 com modelo e erros: [], audit sem o texto no metadata", async () => {
    const res = await POST(await arquivo("proposta.txt", "text/plain", TEXTO_LONGO) as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { modelo: unknown; erros: unknown[] } };
    expect(json.data.modelo).toBeTruthy();
    expect(json.data.erros).toEqual([]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "proposal_template.imported" }),
    );
    expect(JSON.stringify(mocks.audit.mock.calls[0][0])).not.toContain("texto ");
  });

  it("gerarModeloDoTexto lança LlmBudgetExceededError → 200 com disponivel: false", async () => {
    mocks.gerarModeloDoTexto.mockRejectedValueOnce(new LlmBudgetExceededError());
    const res = await POST(await arquivo("proposta.txt", "text/plain", TEXTO_LONGO) as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { disponivel: boolean } };
    expect(json.data.disponivel).toBe(false);
  });

  it("agent → 403 e gerarModeloDoTexto não chamado", async () => {
    montarMundo("agent");
    const res = await POST(await arquivo("proposta.txt", "text/plain", TEXTO_LONGO) as never);
    expect(res.status).toBe(403);
    expect(mocks.gerarModeloDoTexto).not.toHaveBeenCalled();
  });
});
