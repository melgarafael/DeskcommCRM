/**
 * NOME REPETIDO NA MESMA ORGANIZAÇÃO — issue #3952.
 *
 * ─── O que acontecia ──────────────────────────────────────────────────────
 *
 * `POST /api/v1/ai/agents` com um nome que já existe na organização furava o
 * índice `ai_agents_name_unique` e o `23505` cru virava `500 internal_error`
 * ("Erro ao criar agent."). Quem cria pela tela vê um erro de sistema para um
 * problema de digitação; quem chama pela API não tem como distinguir "nome
 * repetido" de "banco fora do ar".
 *
 * ─── O que este arquivo prende ────────────────────────────────────────────
 *
 * 1. duplicado no MESMO índice → **409** `agent_name_taken`, com o envelope
 *    `{ error: { code, message } }` de `lib/api/wrappers.ts` e frase de gente;
 * 2. `23505` de OUTRO índice → continua **500**: tratar todo `23505` como
 *    "nome repetido" mentiria sobre o motivo e esconderia defeito de verdade;
 * 3. erro que NÃO é duplicidade (`23503`, FK) → continua **500 tratado**;
 * 4. o mesmo nome em OUTRA organização → **cria** (201). O índice é composto
 *    (`organization_id`, `name`) — medido em `supabase/baseline.sql`, e o
 *    último teste deste arquivo relê a definição para a premissa não envelhecer;
 * 5. a frase sai traduzida: `pt-BR` é a chave, `es` vem do dicionário.
 *
 * ─── Sobre o dublê do banco ───────────────────────────────────────────────
 *
 * O `admin` aqui é falso e EMULA o índice composto: a chave é
 * `organização|nome`, e o `23505` devolvido carrega a mensagem e o `details`
 * que o Postgres/PostgREST devolvem de verdade (o nome do índice vai na
 * `message`, o par no `details`). A definição real do índice não fica só na
 * emulação: o último `it` lê o `baseline.sql` e reprova se ela mudar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  support: vi.fn(),
  authz: vi.fn(),
  teto: vi.fn(),
  admin: vi.fn(),
  audit: vi.fn(),
  escopo: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: deps.authz,
  tetoDeEscritaDoToken: deps.teto,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/ai/agents/escopo", () => ({
  validarEscopoDaVersao: deps.escopo,
  codigoDoEscopo: () => "validation_failed",
  mensagemDoEscopo: () => "Escopo inválido.",
}));

import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_VIZINHA = "22222222-2222-4222-8222-222222222222";

/** Corpo do formato `version` (Mode B) — o caminho que a tela usa. */
const CORPO = {
  name: "Recepção",
  version: {
    system_prompt: "Você é a recepção da clínica. Atenda com educação.",
    provider: "anthropic",
    model: "claude-sonnet-5",
    credential_id: null,
    channel_session_id: null,
  },
};

type ErroDoBanco = { code: string; message: string; details?: string; hint?: string | null };

/**
 * Admin falso que emula o índice composto `(organization_id, name)` de
 * `ai_agents` — e devolve, no `23505`, o mesmo texto que o banco devolve.
 */
function bancoFake(erroForcado?: ErroDoBanco) {
  const porChave = new Map<string, string>();
  const insercoes: Array<{ tabela: string; payload: Record<string, unknown> }> = [];
  let seq = 0;

  const from = (tabela: string) => ({
    insert: (payload: Record<string, unknown>) => {
      insercoes.push({ tabela, payload });
      let resposta: { data: unknown; error: ErroDoBanco | null };
      if (tabela !== "ai_agents") {
        resposta = { data: { id: `versao-${++seq}` }, error: erroForcado ?? null };
      } else if (erroForcado) {
        resposta = { data: null, error: erroForcado };
      } else {
        const chave = `${String(payload.organization_id)}|${String(payload.name)}`;
        const existente = porChave.get(chave);
        if (existente) {
          resposta = {
            data: null,
            error: {
              code: "23505",
              message: 'duplicate key value violates unique constraint "ai_agents_name_unique"',
              details: `Key (organization_id, name)=(${chave}) already exists.`,
              hint: null,
            },
          };
        } else {
          const id = `agente-${++seq}`;
          porChave.set(chave, id);
          resposta = { data: { id, ...payload }, error: null };
        }
      }
      return { select: () => ({ single: async () => resposta }) };
    },
    update: () => ({ eq: () => ({ eq: async () => ({ data: null, error: null }) }) }),
  });

  return { from, insercoes, porChave };
}

function pedido(corpo: unknown = CORPO) {
  return new NextRequest("http://localhost/api/v1/ai/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.teto.mockResolvedValue(null);
  deps.escopo.mockResolvedValue({ ok: true });
  deps.authz.mockResolvedValue({
    ok: true,
    organizationId: ORG,
    idioma: "pt-BR",
    actor: { type: "user", id: "usuario-1" },
    apiTokenId: null,
  });
});

describe("POST /api/v1/ai/agents — nome repetido na organização", () => {
  it("nome já usado na MESMA organização: 409 agent_name_taken, não 500", async () => {
    const banco = bancoFake();
    deps.admin.mockReturnValue(banco);

    const primeiro = await POST(pedido());
    expect(primeiro.status, "o primeiro create tem de passar").toBe(201);

    const segundo = await POST(pedido());
    expect(segundo.status, "nome repetido é conflito, não erro de sistema").toBe(409);

    const corpo = await segundo.json();
    expect(corpo).toMatchObject({
      error: { code: "agent_name_taken", message: "Já existe um agente com esse nome." },
    });
    // O envelope é o de `lib/api/wrappers.ts`: nada de chave solta no topo.
    expect(Object.keys(corpo)).toEqual(["error"]);
    expect(Object.keys(corpo.error).sort()).toEqual(["code", "message"]);
    // O 409 não pode ter criado a segunda linha.
    expect(banco.insercoes.filter((i) => i.tabela === "ai_agents")).toHaveLength(2);
    expect(banco.porChave.size).toBe(1);
    // E não audita criação que não houve.
    expect(deps.audit).toHaveBeenCalledTimes(1);
  });

  it("nome igual em OUTRA organização: cria (o índice é por organização)", async () => {
    const banco = bancoFake();
    deps.admin.mockReturnValue(banco);

    const meu = await POST(pedido());
    expect(meu.status).toBe(201);

    deps.authz.mockResolvedValue({
      ok: true,
      organizationId: ORG_VIZINHA,
      idioma: "pt-BR",
      actor: { type: "user", id: "usuario-2" },
      apiTokenId: null,
    });
    const vizinho = await POST(pedido());
    expect(vizinho.status, "409 aqui seria pior que o 500: a outra empresa pode ter o mesmo nome").toBe(
      201,
    );
    expect(banco.porChave.size).toBe(2);
  });

  it("23505 de OUTRO índice não vira 'nome repetido': continua 500 internal_error", async () => {
    deps.admin.mockReturnValue(
      bancoFake({
        code: "23505",
        message: 'duplicate key value violates unique constraint "ai_agents_slug_unique"',
        details: "Key (organization_id, slug)=(org, recepcao) already exists.",
      }),
    );

    const res = await POST(pedido());
    expect(res.status, "outra unicidade não é este conflito").toBe(500);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("internal_error");
    expect(corpo.error.message).not.toBe("Já existe um agente com esse nome.");
  });

  it("erro que não é duplicidade (23503, FK): continua 500 tratado", async () => {
    deps.admin.mockReturnValue(
      bancoFake({
        code: "23503",
        message:
          'insert or update on table "ai_agents" violates foreign key constraint "ai_agents_created_by_fkey"',
        details: "Key (created_by)=(usuario-1) is not present in table \"users\".",
      }),
    );

    const res = await POST(pedido());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("internal_error");
  });

  it("a frase sai traduzida quando quem chama está em espanhol", async () => {
    deps.authz.mockResolvedValue({
      ok: true,
      organizationId: ORG,
      idioma: "es",
      actor: { type: "user", id: "usuario-1" },
      apiTokenId: null,
    });
    const banco = bancoFake();
    deps.admin.mockReturnValue(banco);

    await POST(pedido());
    const segundo = await POST(pedido());
    expect(segundo.status).toBe(409);
    expect((await segundo.json()).error).toEqual({
      code: "agent_name_taken",
      message: "Ya existe un agente con este nombre.",
    });
  });
});

describe("a premissa do índice", () => {
  it("ai_agents_name_unique é (organization_id, name) — por organização, não global", () => {
    const baseline = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
    const linha = baseline
      .split("\n")
      .find((l) => l.includes('ADD CONSTRAINT "ai_agents_name_unique"'));
    expect(linha, "o índice mudou de nome ou sumiu do baseline").toBeDefined();
    expect(linha!.replace(/\s+/g, " ")).toContain(
      'UNIQUE ("organization_id", "name")',
    );
  });
});
