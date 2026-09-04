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
    // Aqui `ai_agents.system_prompt` É a fonte legítima: é o que
    // `workers/ai-response-worker.ts` lê. Endurecer isto seria regressão na
    // instalação nova, que é o estado mais comum do produto self-host.
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

describe("a TELA manda quem tem versão publicada para o editor que grava onde o motor lê", () => {
  const fonte = readFileSync(
    join(process.cwd(), "app/app/ai/agents/[id]/page.tsx"),
    "utf8",
  );

  it("o instrumento está vivo: acha o desvio de editor (controle positivo)", () => {
    // Sem isto, um arquivo reescrito faria as asserções abaixo passarem por
    // vacuidade — procurando um trecho que não existe mais.
    expect(fonte).toContain("AgentEditorClient");
    expect(fonte).toContain('!== "mcp_agent"');
  });

  it("⭐ o desvio para o editor legado consulta published_version_id", () => {
    // A régua do runtime (`lib/ai/agents/no-ar.ts`) é: versão publicada manda,
    // e `kind` só decide quando NÃO há versão. A tela era o último lugar que
    // perguntava `kind` primeiro — e por isso oferecia um campo decorativo.
    // A condição contém parênteses (`agent.kind ?? "rag_bot"`), então recortar
    // por `[^)]*` pararia no primeiro fecha — e devolveria string vazia, que
    // passaria por vacuidade. Recorta-se a LINHA do desvio até o `{`.
    const desvio = /if \(.*!== "mcp_agent".*\) \{/.exec(fonte)?.[0] ?? "";
    expect(
      desvio,
      "o desvio de editor ignora published_version_id: agente publicado cai no editor legado, que grava em ai_agents — a coluna que o motor NÃO lê",
    ).toContain("published_version_id");
  });
});
