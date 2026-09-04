/**
 * O EDITOR DE AGENTE TEM DE SALVAR O QUE ELE DEIXA EDITAR.
 *
 * ─── O defeito, medido na fonte ─────────────────────────────────────────────
 *
 * Em `/app/ai/agents/[id]`, os campos **Nome**, **Descrição** e **Ordem de
 * preferência** aceitavam digitação, tinham validação própria e habilitavam o
 * botão "Salvar rascunho" — e o envio os descartava inteiros.
 *
 * A causa é de uma linha: em modo edição, o único construtor do envio era
 * `toVersionPayload()`, que monta as colunas de `ai_agent_versions`. Os três
 * campos moram em `ai_agents`, tabela que a server action só LIA (o SELECT de
 * sanidade) e nunca escrevia. Publicar também não os copia:
 * `fn_publish_ai_agent_version` toca `published_version_id` e `updated_at`.
 *
 * O que torna isso caro é que nada falha: a validação passa, o aviso verde diz
 * "Rascunho vN salvo." e a publicação responde sucesso. Todas as frases são
 * verdadeiras — a respeito da VERSÃO, a única coisa gravada. Numa auditoria de
 * instalação self-host: 8 `ai_agent.published`, 7 `ai_agent.version_created`,
 * ZERO `ai_agent.updated`.
 *
 * E `priority` é o desempate que o motor usa (`order by a.priority desc`, em
 * `lib/agent-engine/agent/agent-config.ts`): numa organização com dois agentes,
 * o dono não conseguia escolher qual atende o cliente.
 *
 * ─── O que cada bloco vigia ────────────────────────────────────────────────
 *
 * 1. A TELA — clicar em "Salvar rascunho" leva os três campos ao servidor.
 *    É o defeito relatado, exercitado pelo DOM: digita, clica, e se cobra o que
 *    saiu daqui.
 * 2. O SERVIDOR — a action grava em `ai_agents` filtrando a organização, e só
 *    quando algo mudou (rodada sem efeito não é mutação e não vira auditoria).
 *    Inclui a ORDEM: escopo inválido não pode deixar o nome já trocado.
 * 3. A CLASSE — todo campo do formulário sai em ALGUM payload. É a guarda
 *    contra a repetição: o próximo campo que alguém acrescentar ao estado sem
 *    acrescentar ao envio reprova aqui, e não em produção.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGENTE = "44444444-4444-4444-8444-444444444444";
const CREDENCIAL = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

const acoes = vi.hoisted(() => ({ salvar: vi.fn(), publicar: vi.fn(), criar: vi.fn() }));
/** Estado do dublê de escopo. Içado junto com o `vi.mock` que o lê. */
const cena = vi.hoisted(() => ({ escopo: { ok: true } as { ok: boolean } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => `/app/ai/agents/${AGENTE}`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/app/app/ai/agents/[id]/_actions", () => ({
  saveAgentDraftAction: acoes.salvar,
  publishAgentAction: acoes.publicar,
  createMcpAgentAction: acoes.criar,
}));

// Dependências da server action (bloco 2). Ficam no topo porque `vi.mock` é
// içado; o bloco 1 não as toca.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "user-1", email: "u@example.com" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Org", role: "admin" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ai/agents/escopo", () => ({
  validarEscopoDaVersao: vi.fn(async () => cena.escopo),
  mensagemDoEscopo: () => "Escopo inválido.",
}));

import { AgentForm } from "@/app/app/ai/agents/[id]/_components/AgentForm";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

// ---------------------------------------------------------------------------
// 1. A TELA
// ---------------------------------------------------------------------------

const CREDENCIAIS = [
  { id: CREDENCIAL, provider: "anthropic", label: "chave da casa", is_active: true },
];
const SESSOES = [{ id: CANAL, label: "WhatsApp da clínica", status: "WORKING" }];

const AGENTE_ROW = {
  id: AGENTE,
  organization_id: ORG,
  name: "Recepção",
  description: "atende quem chega",
  priority: 3,
  model: "claude-sonnet-5",
  system_prompt: "x",
  is_active: true,
  is_default: false,
  config: {},
  guardrails: [],
  active_kb_version_id: null,
  kind: "mcp_agent",
  published_version_id: "v1",
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const VERSAO = {
  id: "v1",
  organization_id: ORG,
  agent_id: AGENTE,
  version_number: 1,
  status: "published",
  system_prompt: "Você é a recepção da clínica. Atenda com educação.",
  provider: "anthropic",
  model: "claude-sonnet-5",
  credential_id: CREDENCIAL,
  tool_ids: [],
  channel_session_id: CANAL,
  max_steps: 10,
  token_budget: 50000,
  cost_budget_cents: 50,
  history_message_window: 20,
  history_token_window: 8000,
  handoff_keywords: [],
  handoff_tool_enabled: true,
  cases_enabled: false,
  split_messages: false,
  split_max_chars: 600,
  followup: { enabled: false, flow_pointer_ids: [] },
  operator_enabled: false,
  operator_model: null,
  operator_tool_ids: [],
  pipeline_ids: [],
  knowledge_source_ids: [],
  trigger_config: null,
  published_at: "2026-01-01T00:00:00Z",
  superseded_at: null,
  created_at: "2026-01-01T00:00:00Z",
  created_by: null,
};

function abrirEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <AgentForm
        mode="edit"
        agent={AGENTE_ROW as never}
        credentials={CREDENCIAIS as never}
        channelSessions={SESSOES as never}
        draft={null}
        published={VERSAO as never}
        base={VERSAO as never}
        draftObsoleto={null}
      />
    </QueryClientProvider>,
  );
  const campo = (id: string) => {
    const el = container.querySelector(`#${id}`);
    if (!el) throw new Error(`campo #${id} não existe na tela`);
    return el as HTMLInputElement | HTMLTextAreaElement;
  };
  return { campo };
}

async function salvarRascunho() {
  fireEvent.click(screen.getByRole("button", { name: /salvar rascunho/i }));
  await waitFor(() => expect(acoes.salvar).toHaveBeenCalled());
  // O cadastro é o SEGUNDO argumento; antes do conserto só existia o primeiro.
  return acoes.salvar.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
}

describe("editor de agente — a tela", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acoes.salvar.mockResolvedValue({ ok: true, data: { version_id: "v2", version_number: 2 } });
  });

  it("leva o nome novo ao servidor quando a pessoa salva o rascunho", async () => {
    const { campo } = abrirEditor();
    fireEvent.change(campo("name"), { target: { value: "Vitória da Recepção" } });
    const cadastro = await salvarRascunho();
    expect(
      cadastro,
      "o envio não levou o cadastro: a pessoa digita o nome, vê 'Rascunho salvo.' e o nome continua o antigo",
    ).toBeDefined();
    expect(cadastro).toHaveProperty("name", "Vitória da Recepção");
  });

  it("leva também a descrição e a ordem de preferência", async () => {
    const { campo } = abrirEditor();
    fireEvent.change(campo("description"), { target: { value: "cuida do primeiro contato" } });
    fireEvent.change(campo("priority"), { target: { value: "700" } });
    const cadastro = await salvarRascunho();
    expect(cadastro).toMatchObject({
      description: "cuida do primeiro contato",
      // A `priority` é o desempate do motor: sem ela gravada, quem tem dois
      // agentes não escolhe qual atende.
      priority: 700,
    });
  });

  it("deixa apagar a descrição — vazio na tela é nulo no banco, não a antiga", async () => {
    const { campo } = abrirEditor();
    fireEvent.change(campo("description"), { target: { value: "   " } });
    const cadastro = await salvarRascunho();
    expect(cadastro).toHaveProperty("description", null);
  });

  it("recusa uma ordem de preferência fora de 0..1000 pela mesma régua do servidor", async () => {
    // A rota REST já cobra `0..1000`. Sem a mesma régua aqui, o número inválido
    // só reprovaria no servidor, e o aviso chegaria como erro genérico.
    const { campo } = abrirEditor();
    fireEvent.change(campo("priority"), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: /salvar rascunho/i }));
    await waitFor(() =>
      expect(screen.getByText(/ordem de preferência vai de 0 a 1000/i)).toBeInTheDocument(),
    );
    expect(acoes.salvar, "mandou um valor que o servidor recusa").not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. O SERVIDOR
// ---------------------------------------------------------------------------

interface Gravacoes {
  cadastro: Record<string, unknown> | null;
  filtros: Array<[string, unknown]>;
  versao: Record<string, unknown> | null;
}

let gravado: Gravacoes;

function adminDuble(agente: Record<string, unknown>) {
  return {
    from: (tabela: string) => {
      if (tabela === "ai_agents") {
        const sel: Record<string, unknown> = {
          eq: () => sel,
          maybeSingle: async () => ({ data: agente, error: null }),
        };
        const upd = {
          eq: (col: string, val: unknown) => {
            gravado.filtros.push([col, val]);
            return upd;
          },
          then: (r: (v: { error: null }) => unknown) => r({ error: null }),
        };
        return {
          select: () => sel,
          update: (payload: Record<string, unknown>) => {
            gravado.cadastro = payload;
            return upd;
          },
        };
      }
      // ai_agent_versions. As DUAS consultas da action passam por aqui e se
      // distinguem pela FORMA de terminar: a LISTA de versões — de onde
      // `escolherVersoesDaTela` tira o rascunho vigente — é aguardada direto,
      // sem `.maybeSingle()`; a do maior número termina em `.maybeSingle()`.
      // Aqui a lista é VAZIA ("nenhuma versão ainda"), o que manda a action pelo
      // ramo da criação. Um dublê que devolvesse rascunho na lista a mandaria
      // pelo PATCH, e este arquivo mediria o caminho errado.
      //
      // O `then` é obrigatório e não enfeite: sem ele o `await` da lista devolve
      // o próprio objeto, `data` vem `undefined`, e o vazio acontece por
      // acidente — verde que não mede nada.
      const selDe = () => {
        const sel: Record<string, unknown> = {
          eq: () => sel,
          order: () => sel,
          limit: () => sel,
          maybeSingle: async () => ({ data: { version_number: 1 }, error: null }),
          then: (r: (v: { data: unknown[]; error: null }) => unknown) =>
            r({ data: [], error: null }),
        };
        return sel;
      };
      return {
        select: () => selDe(),
        insert: (payload: Record<string, unknown>) => {
          gravado.versao = payload;
          return {
            select: () => ({
              single: async () => ({ data: { id: "v2", version_number: 2 }, error: null }),
            }),
          };
        },
      };
    },
  };
}

const VERSION_PAYLOAD = {
  system_prompt: VERSAO.system_prompt,
  provider: "anthropic",
  model: "claude-sonnet-5",
  credential_id: CREDENCIAL,
  tool_ids: [],
  channel_session_id: CANAL,
  max_steps: 10,
  token_budget: 50000,
  cost_budget_cents: 50,
  history_message_window: 20,
  history_token_window: 8000,
  handoff_keywords: [],
  handoff_tool_enabled: true,
  cases_enabled: false,
  split_messages: false,
  split_max_chars: 600,
  followup: { enabled: false, flow_pointer_ids: [] },
  operator_enabled: false,
  operator_model: null,
  operator_tool_ids: [],
  pipeline_ids: [],
  knowledge_source_ids: [],
};

// `published_version_id` está aqui porque a action o PEDE no mesmo SELECT e o
// usa para decidir em qual rascunho escrever. Fixture sem a coluna faz a régua
// receber `undefined` e mediria um caminho que a produção não tem.
const CADASTRO_ATUAL = { id: AGENTE, kind: "mcp_agent", archived_at: null, name: "Recepção", description: "atende quem chega", priority: 3, published_version_id: null };

async function salvarNoServidor(cadastro: unknown, agente = CADASTRO_ATUAL) {
  vi.mocked(createAdminClient).mockReturnValue(adminDuble(agente) as never);
  const real = await vi.importActual<typeof import("@/app/app/ai/agents/[id]/_actions")>(
    "@/app/app/ai/agents/[id]/_actions",
  );
  return (real.saveAgentDraftAction as (a: string, b: unknown, c: unknown) => Promise<unknown>)(
    AGENTE,
    VERSION_PAYLOAD,
    cadastro,
  );
}

describe("saveAgentDraftAction — o cadastro do agente", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cena.escopo = { ok: true };
    gravado = { cadastro: null, filtros: [], versao: null };
  });

  it("grava nome, descrição e ordem em ai_agents, filtrando a organização", async () => {
    const res = (await salvarNoServidor({
      name: "Vitória",
      description: "primeiro contato",
      priority: 700,
    })) as { ok: boolean };

    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(gravado.cadastro, "nada foi gravado no cadastro do agente").not.toBeNull();
    expect(gravado.cadastro).toMatchObject({
      name: "Vitória",
      description: "primeiro contato",
      priority: 700,
    });
    // Service role não tem RLS: o filtro de organização é manual e obrigatório.
    expect(
      gravado.filtros,
      "UPDATE em ai_agents sem filtro de organização — service role bypassa RLS",
    ).toContainEqual(["organization_id", ORG]);
    expect(gravado.filtros).toContainEqual(["id", AGENTE]);
    expect(vi.mocked(audit).mock.calls.map((c) => (c[0] as { action: string }).action)).toContain(
      "ai_agent.updated",
    );
    // Sem isto, o cartão da lista segue mostrando o nome antigo — o mesmo
    // sintoma do defeito, agora por cache.
    expect(vi.mocked(revalidatePath).mock.calls.flat()).toContain("/app/ai/agents");
  });

  it("não escreve nada quando o escopo da versão é inválido", async () => {
    // A ordem é o ponto: se o cadastro fosse gravado antes da validação de
    // escopo, um escopo inválido devolveria erro com o nome JÁ trocado — a
    // lista mostrando o novo e o editor o velho.
    cena.escopo = { ok: false };
    const res = (await salvarNoServidor({
      name: "Vitória",
      description: null,
      priority: 700,
    })) as { ok: boolean };

    expect(res.ok).toBe(false);
    expect(gravado.cadastro, "gravou o nome mesmo recusando o salvamento").toBeNull();
    expect(gravado.versao).toBeNull();
  });

  it("recusa uma ordem de preferência fora de 0..1000", async () => {
    const res = (await salvarNoServidor({
      name: "Vitória",
      description: null,
      priority: 5000,
    })) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe("validation_failed");
    expect(gravado.cadastro).toBeNull();
  });

  it("rodada que não mudou o cadastro não vira linha de auditoria", async () => {
    const res = (await salvarNoServidor({
      name: "Recepção",
      description: "atende quem chega",
      priority: 3,
    })) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(gravado.cadastro, "gravou um UPDATE que não mudou nada").toBeNull();
    expect(
      vi.mocked(audit).mock.calls.map((c) => (c[0] as { action: string }).action),
    ).not.toContain("ai_agent.updated");
  });
});

// ---------------------------------------------------------------------------
// 3. A CLASSE — nenhum campo do formulário fica de fora do envio
// ---------------------------------------------------------------------------

describe("todo campo do formulário viaja em algum payload", () => {
  it("as chaves de FormState são cobertas pelos construtores do envio", () => {
    const fonte = readFileSync(
      join(process.cwd(), "app/app/ai/agents/[id]/_components/AgentForm.tsx"),
      "utf8",
    );

    const bloco = (re: RegExp, rotulo: string) => {
      const m = re.exec(fonte);
      if (!m?.[1]) throw new Error(`não achei ${rotulo} em AgentForm.tsx`);
      return m[1];
    };

    const estado = bloco(/interface FormState \{\n([\s\S]*?)\n\}/, "interface FormState");
    const campos = [...estado.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
    // Controle positivo: se a forma do arquivo mudar, esta sonda estoura em vez
    // de devolver lista vazia e passar por vacuidade.
    expect(campos.length, "não li os campos de FormState").toBeGreaterThan(20);

    const enviados = new Set(
      [...fonte.matchAll(/function to\w*Payload\(s: FormState\) \{\n([\s\S]*?)\n\}/g)]
        .flatMap((m) => [...m[1]!.matchAll(/^ {4}(\w+):/gm)])
        .map((m) => m[1]!),
    );
    expect(enviados.size, "não li nenhum construtor de payload").toBeGreaterThan(20);

    const esquecidos = campos.filter((c) => !enviados.has(c));
    expect(
      esquecidos,
      `estes campos são editáveis na tela e NENHUM payload os leva ao servidor: ${esquecidos.join(", ")}`,
    ).toEqual([]);
  });
});
