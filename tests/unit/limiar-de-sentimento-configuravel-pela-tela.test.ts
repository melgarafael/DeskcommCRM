/**
 * O LIMIAR DE SENTIMENTO TEM LEITOR NO WORKER E NENHUMA PORTA DE ENTRADA
 * (issue #2209).
 *
 * ─── O que foi medido ──────────────────────────────────────────────────────
 *
 * Numa instalação real de advocacia, a segunda mensagem de um lead — "Fui
 * bloqueado na Uber", resposta direta à pergunta de qualificação — disparou o
 * handoff `low_sentiment`. Frase sem irritação nenhuma, e no nicho relatar o
 * problema é o conteúdo normal da conversa. O contorno que funcionou em
 * conversa real foi gravar `sentiment_threshold` 0.1 direto no `config` do
 * `ai_agents`, por SQL.
 *
 * A chave já tem leitor: `workers/ai-sentiment-worker.ts` lê
 * `agentConfig["sentiment_threshold"]` e cai no `DEFAULT_SENTIMENT_THRESHOLD`
 * (0.3) quando ela não existe. O que faltava era a PORTA: `agentConfigSchema`
 * não declarava a chave, então o Zod a descartava — e um
 * `PATCH /api/v1/ai/agents/{id}` com `config.sentiment_threshold` respondia
 * 200 sem gravar nada. Tela alguma oferecia o campo.
 *
 * ─── Por que o teste cobre rota, worker e tela juntos ──────────────────────
 *
 * O defeito é uma CORRENTE: a chave só vale se sobreviver ao schema do PATCH,
 * chegar ao jsonb gravado, reler pela rota e ser a MESMA que o worker lê. Cada
 * elo sozinho passava antes do conserto (o worker lia uma chave que ninguém
 * gravava; a rota respondia 200 sem gravar). Então o caso principal faz o
 * caminho inteiro — PATCH, releitura por GET, conferência da chave — e os
 * outros casos prendem cada elo separadamente, inclusive a tela, que é a única
 * porta que uma pessoa de verdade usa.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { AGENT_CONFIG_DEFAULTS, agentPatchSchema } from "@/lib/ai/guardrails-schema";
import { DEFAULT_SENTIMENT_THRESHOLD } from "@/lib/ai/prompts/sentiment";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// Isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));

const ORG = "33333333-3333-4333-8333-333333333333";
const AGENT = "77777777-7777-4777-8777-777777777777";

/** A linha de `ai_agents` — MUTÁVEL, para a releitura ver o que o PATCH gravou. */
let linha: Record<string, unknown>;
/** O patch que chegou ao `update`, para conferir o jsonb que saiu da rota. */
let gravado: Record<string, unknown> | null;

function agente(config: Record<string, unknown>) {
  return {
    id: AGENT,
    organization_id: ORG,
    name: "Escritório Souza",
    description: "Atendimento de contas bloqueadas",
    model: "anthropic/claude-sonnet-4-6",
    system_prompt: "Você é o assistente do escritório. Responda com clareza.",
    is_active: true,
    is_default: true,
    kind: "mcp_agent",
    priority: 0,
    published_version_id: "99999999-9999-4999-8999-999999999999",
    archived_at: null,
    config,
    guardrails: [],
    active_kb_version_id: null,
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
  };
}

/**
 * Mini-Supabase: MESMA linha para `admin` (rota PATCH) e para `createClient`
 * (rota GET). O `update` escreve na linha, então a releitura mede o que de
 * verdade ficou gravado — um dublê que devolvesse o payload do request
 * aprovaria a rota que responde 200 sem gravar, que é o defeito.
 */
function banco() {
  const enc = (patch?: Record<string, unknown>) => ({
    select: () => enc(patch),
    update: (p: Record<string, unknown>) => enc(p),
    eq: () => enc(patch),
    is: () => enc(patch),
    maybeSingle: async () => ({ data: { ...linha }, error: null }),
    single: async () => {
      if (patch) {
        Object.assign(linha, patch);
        gravado = patch;
      }
      return { data: { ...linha }, error: null };
    },
  });
  return { from: () => enc() };
}

async function chamar(method: "GET" | "PATCH", corpo?: unknown) {
  const req = new NextRequest(`http://localhost/api/v1/ai/agents/${AGENT}`, {
    method,
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    headers: { "content-type": "application/json" },
  });
  const rota = await import("@/app/api/v1/ai/agents/[id]/route");
  return rota[method](req, { params: Promise.resolve({ id: AGENT }) } as never);
}

async function patch(corpo: Record<string, unknown>, configInicial: Record<string, unknown>) {
  linha = agente(configInicial);
  gravado = null;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111" },
    org: { orgId: ORG, name: "Org", role: "admin" as const },
  } as never);
  vi.mocked(createAdminClient).mockReturnValue(banco() as never);
  vi.mocked(createClient).mockResolvedValue(banco() as never);
  return chamar("PATCH", corpo);
}

beforeEach(() => {
  vi.clearAllMocks();
  gravado = null;
});

describe("PATCH /api/v1/ai/agents/:id — sentiment_threshold é aceito e persistido", () => {
  it("responde 200 e o valor aparece na releitura pela rota", async () => {
    // O caso principal, caminho inteiro: o schema não pode descartar a chave,
    // a rota tem de gravá-la no jsonb e o GET tem de devolvê-la. Antes do
    // conserto o status era 200 e a releitura seguia sem a chave — o sintoma
    // medido na issue (200 sem gravação).
    const res = await patch(
      { config: { sentiment_threshold: 0.1 } },
      { aceita_comandos_celular: true, temperature: 0.9 },
    );
    expect(res.status).toBe(200);

    const releitura = await chamar("GET");
    expect(releitura.status).toBe(200);
    // `ok()` devolve o envelope `{ data: … }` — a releitura é o que a rota
    // lê do banco DEPOIS do PATCH, não o payload do request.
    const corpo = (await releitura.json()) as { data: { config: Record<string, unknown> } };
    expect(
      corpo.data.config["sentiment_threshold"],
      "o PATCH respondeu 200 e o valor não está na releitura — a chave foi descartada como desconhecida",
    ).toBe(0.1);
    // Guarda de regressão da junção: gravar o limiar não pode regravar o resto.
    expect(corpo.data.config).toMatchObject({
      aceita_comandos_celular: true,
      temperature: 0.9,
    });
    expect(gravado?.["config"]).toMatchObject({ sentiment_threshold: 0.1 });
  });

  it("fora da faixa 0–1 o PATCH responde 422, não um 200 que ignora", async () => {
    // O campo tem leitor; aceitar 1.4 em silêncio seria um controle que mente
    // de outro jeito — o worker usaria o valor sem nenhuma régua.
    const res = await patch({ config: { sentiment_threshold: 1.4 } }, {});
    expect(res.status).toBe(422);
    expect(gravado).toBeNull();
  });

  it("o schema do PATCH não descarta a chave como desconhecida", () => {
    // O elo que estava rompido: `agentConfigPatchSchema` nem sabia da chave.
    const config = agentPatchSchema.parse({ config: { sentiment_threshold: 0.1 } }).config;
    expect(config).toEqual({ sentiment_threshold: 0.1 });
  });

  it("o default declarado é o mesmo que o worker usa quando a chave falta", () => {
    // Duas fontes de 0.3 seria um terceiro defeito esperando: a tela mostraria
    // um número e o worker usaria outro.
    expect(AGENT_CONFIG_DEFAULTS.sentiment_threshold).toBe(DEFAULT_SENTIMENT_THRESHOLD);
  });

  it("o valor gravado é exatamente a chave que o worker lê", () => {
    // Une as duas pontas: o que a rota grava tem de ser o que
    // `workers/ai-sentiment-worker.ts` consulta antes de decidir a passagem.
    const worker = readFileSync(
      path.join(__dirname, "..", "..", "workers", "ai-sentiment-worker.ts"),
      "utf8",
    );
    expect(worker).toContain('agentConfig["sentiment_threshold"]');
  });
});

describe("a tela do agente é a porta que uma pessoa usa", () => {
  const RAIZ = path.join(__dirname, "..", "..");
  const COMPONENTE = path.join(
    RAIZ,
    "app",
    "app",
    "ai",
    "agents",
    "[id]",
    "_components",
    "LimiarDeSentimento.tsx",
  );

  it("o cartão existe, grava a chave pela rota e a tela do agente o renderiza", () => {
    const fonte = readFileSync(COMPONENTE, "utf8");
    expect(fonte).toContain("sentiment_threshold");
    expect(fonte).toContain("/api/v1/ai/agents/");

    const formulario = readFileSync(
      path.join(RAIZ, "app", "app", "ai", "agents", "[id]", "_components", "AgentForm.tsx"),
      "utf8",
    );
    expect(formulario).toContain("LimiarDeSentimento");
  });

  it("o rótulo está em português e tem espanhol no dicionário", () => {
    // A chave do `t()` É o português (regra do dicionário); o que se cobra aqui
    // é o espanhol — sem ele, quem escolheu espanhol cai para PT.
    const fonte = readFileSync(COMPONENTE, "utf8");
    const chaves = [...fonte.matchAll(/t\(\s*"([^"]{10,})"/g)].map((m) => m[1] as string);
    expect(chaves.length, "cartão sem nenhuma frase de tela").toBeGreaterThan(2);
    for (const chave of chaves) {
      expect(
        DICIONARIO[chave]?.es,
        `frase sem espanhol no dicionário: ${chave.slice(0, 60)}`,
      ).toBeTruthy();
    }
  });
});
