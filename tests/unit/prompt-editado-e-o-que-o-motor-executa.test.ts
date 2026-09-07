/**
 * O PROMPT QUE A TELA SALVA É O QUE O MOTOR EXECUTA (issue #456).
 *
 * ─── O defeito, medido em c5b45b24 ──────────────────────────────────────────
 *
 * Editar o System Prompt de um agente JÁ PUBLICADO, salvar, e o texto aparece
 * atualizado na tela — enquanto o agente continua respondendo no WhatsApp com o
 * prompt anterior. Duas colunas divergem depois do Salvar:
 *
 *   ai_agents.system_prompt      -> atualizada com o texto novo
 *   ai_agent_versions.system_prompt (na linha apontada por
 *     ai_agents.published_version_id, que é a que o motor lê) -> intacta
 *
 * A causa NÃO é a hipotetizada na issue (`is_default`): é o `kind`. A cadeia:
 *
 *   page.tsx:74     if ((agent.kind ?? "rag_bot") !== "mcp_agent") -> editor legado
 *   AgentEditor:83  patch.system_prompt = current.system_prompt
 *   useAgent:65     PATCH /api/v1/ai/agents/:id
 *   route.ts:135    update.system_prompt = patch.system_prompt   (em ai_agents)
 *
 * ─── Por que a régua certa é `published_version_id`, e não `kind` ───────────
 *
 * `lib/ai/agents/no-ar.ts` já decidiu isto para o RUNTIME, e escreveu por quê:
 * `published_version_id != null` significa "no ar pela versão", e `kind` só
 * entra quando NÃO há versão publicada. A tela era o único lugar que ainda
 * perguntava `kind` primeiro — e por isso oferecia um campo que o motor ignora.
 *
 * O próprio banco já sabia: `fn_ai_agent_version_content_immutable` recusa
 * mudar conteúdo de versão publicada com "mudança de conteúdo = versão draft
 * nova; publica". A rota é que não seguia a mesma regra.
 *
 * ─── As duas metades, e por que uma sozinha não serve ───────────────────────
 *
 * A ROTA falhando fechada mata a divergência para todo chamador. Sozinha, ela
 * deixaria quem tem versão publicada sem NENHUM caminho para editar o prompt —
 * trocaria uma mentira por uma parede. Por isso a TELA passa a mandar quem tem
 * versão publicada para o editor de versões, que grava onde o motor lê.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const AGENT = "55555555-5555-4555-8555-555555555555";
const VERSAO = "99999999-9999-4999-8999-999999999999";
const PROMPT_ANTIGO = "Você é o Tobias, atendente da loja.";

/** O que foi efetivamente escrito em `ai_agents`. `null` = nada. */
let gravado: Record<string, unknown> | null;

function agente(over: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    organization_id: ORG,
    name: "Tobias",
    description: null,
    model: "anthropic/claude-sonnet-4-6",
    system_prompt: PROMPT_ANTIGO,
    is_active: true,
    is_default: true,
    kind: "rag_bot",
    priority: 0,
    published_version_id: null,
    archived_at: null,
    config: {},
    guardrails: [],
    active_kb_version_id: null,
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
    ...over,
  };
}

function admin(linha: Record<string, unknown>) {
  const q = (op: "select" | "update", patch?: Record<string, unknown>) => {
    const enc = {
      select: () => enc,
      eq: () => enc,
      is: () => enc,
      maybeSingle: async () => ({ data: linha, error: null }),
      single: async () => {
        if (op === "update") {
          gravado = patch ?? {};
          return { data: { ...linha, ...patch }, error: null };
        }
        return { data: linha, error: null };
      },
    };
    return enc;
  };
  return {
    from: () => ({
      select: () => q("select"),
      update: (patch: Record<string, unknown>) => q("update", patch),
    }),
  };
}

function autenticar() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111" },
    org: { orgId: ORG, name: "Org", role: "admin" as const },
  } as never);
}

async function patch(corpo: Record<string, unknown>, linha: Record<string, unknown>) {
  autenticar();
  vi.mocked(createAdminClient).mockReturnValue(admin(linha) as never);
  const { PATCH } = await import("@/app/api/v1/ai/agents/[id]/route");
  const req = new NextRequest(`http://localhost/api/v1/ai/agents/${AGENT}`, {
    method: "PATCH",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: AGENT }) } as never);
  return { status: res.status, corpo: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  gravado = null;
});

describe("PATCH /api/v1/ai/agents/:id — conteúdo de versão publicada não se edita pelo cadastro", () => {
  it("⭐ recusa system_prompt quando o agente tem versão publicada", async () => {
    const r = await patch(
      { system_prompt: "Texto NOVO que o dono acredita ter publicado" },
      agente({ published_version_id: VERSAO }),
    );

    // O que não pode acontecer é 200: a tela conclui "salvou" e o motor segue
    // com o prompt anterior, sem erro em lugar nenhum.
    expect(r.status).toBe(409);
    expect(gravado, "gravou em ai_agents um prompt que o motor não lê").toBeNull();
    // A mensagem tem de ENSINAR o caminho, e é a mesma frase que o trigger do
    // banco já usa — duas frases diferentes para a mesma regra confundem.
    expect(String(r.corpo.error.message)).toMatch(/vers/i);
    expect(r.corpo.error.code).toBe("state_conflict");
  });

  it("recusa também o modelo — ele é conteúdo de versão do mesmo jeito", async () => {
    const r = await patch(
      { model: "anthropic/claude-haiku-4-5" },
      agente({ published_version_id: VERSAO }),
    );
    expect(r.status, JSON.stringify(r.corpo)).toBe(409);
    expect(gravado).toBeNull();
  });

  it("⭐ o rag_bot SEM versão publicada continua editando pelo cadastro", async () => {
    // Antes da primeira publicação o cadastro ainda preserva o prompt a ser
    // reconciliado. Depois dela, somente o editor de versões altera o texto
    // executável; o worker legado não volta a responder por esta permissão.
    const r = await patch({ system_prompt: "Texto novo do atendente, com pelo menos vinte caracteres." }, agente({ published_version_id: null }));

    expect(r.status, JSON.stringify(r.corpo)).toBe(200);
    expect(gravado).toMatchObject({ system_prompt: "Texto novo do atendente, com pelo menos vinte caracteres." });
  });

  it("o que NÃO é conteúdo de versão continua editável com versão publicada", async () => {
    // Nome, descrição e ligar/desligar moram em `ai_agents` e não têm par na
    // versão — recusá-los junto trocaria um defeito por outro.
    const r = await patch(
      { name: "Tobias II", is_active: false },
      agente({ published_version_id: VERSAO }),
    );

    expect(r.status).toBe(200);
    expect(gravado).toMatchObject({ name: "Tobias II", is_active: false });
    expect(gravado).not.toHaveProperty("system_prompt");
  });
});

function elementosDaPagina(fonte: string) {
  const ast = ts.createSourceFile("page.tsx", fonte, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const elements: ts.JsxSelfClosingElement[] = [];
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node)) elements.push(node);
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { ast, elements, calls };
}
function recoveryGuard(fonte: string): ts.Expression {
  const { elements } = elementosDaPagina(fonte);
  const recovery = elements.filter(n => n.tagName.getText() === "LegacyRecovery");
  expect(recovery).toHaveLength(1);
  let parent: ts.Node | undefined = recovery[0]!.parent;
  while (parent && !ts.isJsxExpression(parent)) parent = parent.parent;
  if (!parent || !ts.isJsxExpression(parent) || !parent.expression) throw new Error("recuperação sem condição");
  return parent.expression;
}
/** Evaluate only the Boolean UI guard, not arbitrary source or component code. */
function mostraRecuperacao(node: ts.Expression, agent: { kind: string | null; published_version_id: string | null }): unknown {
  if (ts.isParenthesizedExpression(node)) return mostraRecuperacao(node.expression, agent);
  if (ts.isJsxSelfClosingElement(node)) return true;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "agent") return agent[node.name.text as keyof typeof agent];
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return !mostraRecuperacao(node.operand, agent);
  if (ts.isBinaryExpression(node)) {
    const left = mostraRecuperacao(node.left, agent);
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.QuestionQuestionToken: return left ?? mostraRecuperacao(node.right, agent);
      case ts.SyntaxKind.AmpersandAmpersandToken: return left && mostraRecuperacao(node.right, agent);
      case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== mostraRecuperacao(node.right, agent);
    }
  }
  throw new Error(`Condição não reconhecida pelo instrumento: ${node.getText()}`);
}

describe("a TELA usa o editor de versões e limita recuperação ao legado não publicado", () => {
  const fonte = readFileSync(join(process.cwd(), "app/app/ai/agents/[id]/page.tsx"), "utf8");

  it("editor de versões recebe a seleção baseada no pointer publicado", () => {
    const { elements, calls } = elementosDaPagina(fonte);
    const tabs = elements.filter(n => n.tagName.getText() === "AgentTabs");
    expect(tabs).toHaveLength(1);
    const attrs = tabs[0]!.attributes.properties.filter(ts.isJsxAttribute);
    for (const name of ["agent", "draft", "published", "base", "versions"])
      expect(attrs.find(a => a.name.getText() === name)?.initializer?.getText()).toBe(`{${name}}`);
    const selector = calls.filter(c => c.expression.getText() === "escolherVersoesDaTela");
    expect(selector).toHaveLength(1);
    expect(selector[0]!.arguments[0]!.getText()).toBe("versions");
    expect(selector[0]!.arguments[1]!.getText()).toContain("agent.published_version_id");
    expect(elements.some(n => n.tagName.getText() === "AgentEditorClient")).toBe(false);
  });

  it("agente publicado de qualquer kind não volta à recuperação; legado sem versão continua alcançável", () => {
    const guard = recoveryGuard(fonte);
    for (const kind of ["rag_bot", "mcp_agent", null])
      expect(mostraRecuperacao(guard, { kind, published_version_id: VERSAO })).toBe(false);
    expect(mostraRecuperacao(guard, { kind: "rag_bot", published_version_id: null })).toBe(true);
    expect(mostraRecuperacao(guard, { kind: "mcp_agent", published_version_id: null })).toBe(false);
  });

  it("controle negativo: ignorar o pointer volta a oferecer recuperação a um agente publicado", () => {
    const sabotado = fonte.replace(/&&\s*!agent\.published_version_id/, "");
    expect(sabotado).not.toBe(fonte);
    expect(mostraRecuperacao(recoveryGuard(sabotado), { kind: "rag_bot", published_version_id: VERSAO })).toBe(true);
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
