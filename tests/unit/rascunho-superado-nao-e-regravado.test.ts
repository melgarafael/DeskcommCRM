/**
 * O SERVIDOR TEM DE ESCREVER NA MESMA VERSÃO QUE A TELA ABRIU.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * A pergunta "qual versão o editor está editando?" tinha DUAS respostas, e elas
 * discordavam justamente no estado que o produto nomeia na tela:
 *
 *   TELA     — `escolherVersoesDaTela`, chamada em `app/app/ai/agents/[id]/page.tsx`:
 *              rascunho **VIGENTE** > publicada > última versão. Um rascunho
 *              ANTERIOR à publicada foi superado por ela: não abre, não publica.
 *   SERVIDOR — `saveAgentDraftAction`: o rascunho de MAIOR `version_number`,
 *              sem perguntar se ele ainda vale.
 *
 * Com um rascunho superado no agente (v5 draft, v6 publicada), a tela hidrata da
 * v6, a pessoa edita, clica em "Salvar rascunho" — e o servidor grava na v5. As
 * duas consequências:
 *
 *   1. O TRABALHO SOME. A v5 continua anterior à v6, então a tela recarrega e
 *      volta a mostrar a v6. O aviso verde disse "Rascunho v5 salvo." e nada
 *      mudou no que a pessoa vê — o mesmo desfecho do defeito que o PR #502
 *      consertou, por outra porta. E não há como publicar: o botão de publicar
 *      lê `props.draft`, que é nulo enquanto o rascunho for superado.
 *   2. O HISTÓRICO SE PERDE, EM SILÊNCIO. A v5 é um retrato: a tela promete
 *      "ele continua no Histórico" (`AgentForm.tsx`, `title` do badge) e o
 *      `VersionHistory` a lista. Regravá-la faz a linha v5 do histórico passar a
 *      exibir um texto que ninguém rascunhou naquele momento. Nenhum erro,
 *      nenhum aviso, e o conteúdo original não volta.
 *
 * ─── Como o estado acontece de verdade ──────────────────────────────────────
 *
 * `revertToVersionAction` (botão "Reverter", aba Histórico) clona a versão alvo
 * em draft v(max+1) e a PUBLICA na hora. Todo rascunho não publicado que já
 * existia fica, a partir daí, com número menor que o da publicada. Ou seja:
 * quem tinha trabalho em andamento e reverteu cai neste estado.
 *
 * ─── MEDIDA VENCE PALPITE ───────────────────────────────────────────────────
 *
 * Quem é a publicada se decide por `ai_agents.published_version_id` — o ponteiro
 * que o motor executa (`agent-config.ts`) —, nunca por `status = 'published'`,
 * que é palpite: o cabeçalho de `versoes-da-tela.ts` registra a medição de
 * produção em que os dois discordam num mesmo agente. O último caso
 * deste arquivo é o que separa as duas réguas.
 *
 * Pré-condição de schema (conferida em `supabase/baseline.sql`):
 *   - `ai_agent_versions.status`         text NOT NULL default 'draft'  → nunca nulo
 *   - `ai_agent_versions.version_number` integer NOT NULL               → nunca nulo
 *   - `ai_agents.published_version_id`   uuid NULL, sem default         → nulo é
 *     um valor de verdade ("não há publicada"), e é diferente de `undefined`
 *     ("o SELECT não pediu a coluna"). Por isso a régua recebe o ponteiro
 *     explicitamente, com `?? null`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { escolherVersoesDaTela } from "@/lib/ai/agents/versoes-da-tela";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGENTE = "44444444-4444-4444-8444-444444444444";
const CREDENCIAL = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "user-1", email: "u@example.com" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Org", role: "admin" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ai/agents/escopo", () => ({
  validarEscopoDaVersao: vi.fn(async () => ({ ok: true })),
  mensagemDoEscopo: () => "Escopo inválido.",
}));

import { saveAgentDraftAction } from "@/app/app/ai/agents/[id]/_actions";
import { createAdminClient } from "@/lib/supabase/admin";

// ---------------------------------------------------------------------------
// Dublê: uma tabela de versões DE VERDADE (linhas em memória), porque o defeito
// é sobre QUAL linha recebe a escrita. Um dublê que devolve linha fixa por
// formato de `select` não consegue medir isso.
// ---------------------------------------------------------------------------

interface VersaoRow {
  id: string;
  organization_id: string;
  agent_id: string;
  version_number: number;
  status: string;
  system_prompt: string;
  [k: string]: unknown;
}

function versao(n: number, status: string, prompt: string): VersaoRow {
  return {
    id: `v${n}`,
    organization_id: ORG,
    agent_id: AGENTE,
    version_number: n,
    status,
    system_prompt: prompt,
  };
}

function aplicar(linhas: VersaoRow[], filtros: Array<[string, unknown]>) {
  return linhas.filter((l) => filtros.every(([c, v]) => l[c] === v));
}

function adminDuble(agente: Record<string, unknown>, versoes: VersaoRow[]) {
  return {
    from(tabela: string) {
      if (tabela === "ai_agents") {
        const sel: Record<string, unknown> = {
          eq: () => sel,
          maybeSingle: async () => ({ data: agente, error: null }),
        };
        const upd: Record<string, unknown> = {
          eq: () => upd,
          then: (r: (v: { error: null }) => unknown) => r({ error: null }),
        };
        return { select: () => sel, update: () => upd };
      }

      const construirSelect = () => {
        const filtros: Array<[string, unknown]> = [];
        let desc = false;
        let lim = Number.POSITIVE_INFINITY;
        const linhas = () => {
          const r = aplicar(versoes, filtros);
          r.sort((a, b) =>
            desc ? b.version_number - a.version_number : a.version_number - b.version_number,
          );
          return r.slice(0, lim);
        };
        const q: Record<string, unknown> = {
          eq: (c: string, v: unknown) => {
            filtros.push([c, v]);
            return q;
          },
          order: (_c: string, o?: { ascending?: boolean }) => {
            desc = o?.ascending === false;
            return q;
          },
          limit: (n: number) => {
            lim = n;
            return q;
          },
          maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
          single: async () => ({ data: linhas()[0] ?? null, error: null }),
          // Query sem `.maybeSingle()`/`.single()` é aguardada direto — é assim
          // que o supabase-js devolve a LISTA.
          then: (r: (v: { data: VersaoRow[]; error: null }) => unknown) =>
            r({ data: linhas(), error: null }),
        };
        return q;
      };

      return {
        select: construirSelect,
        update: (payload: Record<string, unknown>) => {
          const filtros: Array<[string, unknown]> = [];
          const upd: Record<string, unknown> = {
            eq: (c: string, v: unknown) => {
              filtros.push([c, v]);
              return upd;
            },
            select: () => upd,
            single: async () => {
              const alvo = aplicar(versoes, filtros);
              for (const l of alvo) Object.assign(l, payload);
              return { data: alvo[0] ?? null, error: alvo[0] ? null : { message: "sem linha" } };
            },
          };
          return upd;
        },
        insert: (payload: Record<string, unknown>) => {
          const nova = {
            id: `v${payload.version_number as number}`,
            ...payload,
          } as unknown as VersaoRow;
          versoes.push(nova);
          return {
            select: () => ({
              single: async () => ({
                data: { id: nova.id, version_number: nova.version_number },
                error: null,
              }),
            }),
          };
        },
      };
    },
  };
}

const PROMPT_NOVO = "Você é a recepção da clínica. Atenda com educação e agende.";

const VERSION_PAYLOAD = {
  system_prompt: PROMPT_NOVO,
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

function agenteCom(publishedVersionId: string | null) {
  return {
    id: AGENTE,
    kind: "mcp_agent",
    archived_at: null,
    name: "Recepção",
    description: "atende quem chega",
    priority: 3,
    published_version_id: publishedVersionId,
  };
}

async function salvar(versoes: VersaoRow[], publishedVersionId: string | null) {
  vi.mocked(createAdminClient).mockReturnValue(
    adminDuble(agenteCom(publishedVersionId), versoes) as never,
  );
  return (await saveAgentDraftAction(AGENTE, VERSION_PAYLOAD)) as {
    ok: boolean;
    data?: { version_id: string; version_number: number };
    error?: string;
    message?: string;
  };
}

describe("saveAgentDraftAction — em qual versão a escrita cai", () => {
  beforeEach(() => vi.clearAllMocks());

  it("não regrava o rascunho SUPERADO: ele é histórico e a tela promete que continua lá", async () => {
    const versoes = [
      versao(5, "draft", "trabalho antigo, parado no rascunho v5"),
      versao(6, "published", "o texto que atende hoje"),
    ];
    const res = await salvar(versoes, "v6");

    expect(res.ok, JSON.stringify(res)).toBe(true);
    const v5 = versoes.find((v) => v.id === "v5")!;
    expect(
      v5.system_prompt,
      "o rascunho superado foi regravado — o Histórico passou a mostrar um texto que ninguém rascunhou ali",
    ).toBe("trabalho antigo, parado no rascunho v5");
    expect(v5.status).toBe("draft");
  });

  it("cria um rascunho VIGENTE, que é o que a tela reabre e o botão publica", async () => {
    const versoes = [
      versao(5, "draft", "trabalho antigo, parado no rascunho v5"),
      versao(6, "published", "o texto que atende hoje"),
    ];
    const res = await salvar(versoes, "v6");

    expect(res.data?.version_number).toBe(7);
    const nova = versoes.find((v) => v.id === res.data!.version_id)!;
    expect(nova.system_prompt).toBe(PROMPT_NOVO);
    expect(nova.status).toBe("draft");

    // O acoplamento que fecha o laço: a versão em que o servidor escreveu é a
    // MESMA que a tela abre. Sem isto, "salvou" e "aparece" voltam a divergir.
    const tela = escolherVersoesDaTela(versoes, "v6");
    expect(
      tela.draft?.id,
      "o servidor escreveu numa versão que a tela não abre — a pessoa vê 'salvo' e nada muda",
    ).toBe(res.data!.version_id);
    // E a v5 continua lá, intocada, para o Histórico listar. Ela deixa de ser
    // "o rascunho superado" da tela porque quem ocupa esse lugar agora é o
    // rascunho novo — o que a régua nomeia é sempre o mais recente.
    expect(tela.draftObsoleto).toBeNull();
    expect(versoes.find((v) => v.id === "v5")!.system_prompt).toBe(
      "trabalho antigo, parado no rascunho v5",
    );
  });

  it("rascunho VIGENTE continua sendo regravado, sem inflar a sequência", async () => {
    const versoes = [
      versao(6, "published", "o texto que atende hoje"),
      versao(7, "draft", "rascunho em andamento"),
    ];
    const res = await salvar(versoes, "v6");

    expect(res.data?.version_id).toBe("v7");
    expect(versoes).toHaveLength(2);
    expect(versoes.find((v) => v.id === "v7")!.system_prompt).toBe(PROMPT_NOVO);
  });

  it("sem versão publicada (agente pausado), o rascunho existente é vigente e é regravado", async () => {
    // `published_version_id` é NULL de verdade no schema: significa "não há
    // publicada", não "não sei". Tratar todo rascunho como superado aqui criaria
    // uma versão nova a cada salvamento de agente pausado.
    const versoes = [
      versao(5, "draft", "rascunho do agente pausado"),
      versao(6, "superseded", "a que atendia antes de pausar"),
    ];
    const res = await salvar(versoes, null);

    expect(res.data?.version_id).toBe("v5");
    expect(versoes).toHaveLength(2);
    expect(versoes.find((v) => v.id === "v5")!.system_prompt).toBe(PROMPT_NOVO);
  });

  it("quem decide a publicada é o PONTEIRO, não a coluna status", async () => {
    // ⚠️ A ORDEM DAS LINHAS IMPORTA e é por isso que o dublê ordena `desc` como
    // a consulta real: `versoes.find(v => v.status === "published")` devolve o
    // PRIMEIRO da lista. Numa lista ascendente o palpite acertaria por acidente
    // e este caso ficaria verde sem medir nada.
    // Drift real: uma linha marcada `published` que o ponteiro não aponta. Pela
    // medida (ponteiro → v6) o rascunho v7 é vigente e se regrava; pelo palpite
    // (status → v8) ele pareceria superado e nasceria um v9 a cada salvamento.
    const versoes = [
      versao(6, "published", "a que o motor executa"),
      versao(7, "draft", "rascunho em andamento"),
      versao(8, "published", "linha em drift: marcada published, sem ponteiro"),
    ];
    const res = await salvar(versoes, "v6");

    expect(res.data?.version_id).toBe("v7");
    expect(versoes).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// A CLASSE — o palpite não pode voltar por uma porta nova
// ---------------------------------------------------------------------------
//
// `escolherVersoesDaTela(versoes)` — sem o segundo argumento — cai em
// `status === "published"`, que é o palpite. O argumento é opcional por
// história (havia UM chamador quando ele nasceu), e opcional é justamente o que
// faz o palpite ser o DEFAULT: quem escrever o terceiro chamador amanhã erra
// calado, e o erro é do tipo que nenhum teste de unidade do arquivo novo pega.
//
// Este bloco troca a regra escrita por mecanismo: todo chamador de PRODUÇÃO
// passa o ponteiro. Não vale para `tests/`, onde omitir o argumento é o próprio
// caso sob medição (`versoes-da-tela-do-agente.test.ts`).

/** Recorta a lista de argumentos de cada chamada, equilibrando parênteses. */
function argumentosDasChamadas(fonte: string): string[] {
  const chamadas: string[] = [];
  const alvo = "escolherVersoesDaTela(";
  let i = fonte.indexOf(alvo);
  while (i !== -1) {
    let profundidade = 0;
    let j = i + alvo.length - 1;
    for (; j < fonte.length; j++) {
      const c = fonte[j];
      if (c === "(") profundidade++;
      else if (c === ")") {
        profundidade--;
        if (profundidade === 0) break;
      }
    }
    chamadas.push(fonte.slice(i + alvo.length, j));
    i = fonte.indexOf(alvo, j);
  }
  return chamadas;
}

/**
 * O 2º argumento desta chamada, ou `null` se não houver.
 *
 * Corta na vírgula de nível 0 e devolve o resto sem comentários — `undefined`
 * escrito à mão satisfaz a sintaxe e cai no palpite do mesmo jeito que omitir,
 * então a guarda precisa enxergar o VALOR, não só a vírgula.
 */
function segundoArgumento(args: string): string | null {
  let profundidade = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === "(" || c === "[" || c === "{") profundidade++;
    else if (c === ")" || c === "]" || c === "}") profundidade--;
    else if (c === "," && profundidade === 0) {
      return args
        .slice(i + 1)
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,\s*$/, "")
        .trim();
    }
  }
  return null;
}

/** Varre `dir` recursivamente atrás de fontes .ts/.tsx (mesma forma de `branding.test.ts`). */
function fontesDe(raiz: string, dir: string, saida: string[] = []): string[] {
  for (const e of readdirSync(join(raiz, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      fontesDe(raiz, rel, saida);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      saida.push(rel);
    }
  }
  return saida;
}

describe("nenhum chamador de produção decide a publicada pelo palpite", () => {
  const raiz = process.cwd();
  const arquivos = ["app", "lib", "components", "hooks", "workers"]
    .flatMap((d) => fontesDe(raiz, d))
    .filter(
      (p) =>
        p !== "lib/ai/agents/versoes-da-tela.ts" &&
        readFileSync(join(raiz, p), "utf8").includes("escolherVersoesDaTela("),
    )
    .map((p) => relative(".", p));

  it("a sonda enxerga alguma coisa (controle positivo)", () => {
    // Sem isto, uma varredura que devolvesse zero arquivo — pasta renomeada,
    // filtro de extensão que parou de casar, arquivo movido — passaria como
    // "nenhum defeito". Ausência só vale se a sonda cobre a categoria.
    expect(arquivos.length, "a varredura não achou chamador nenhum: sonda cega").toBeGreaterThan(0);
    expect(arquivos).toContain("app/app/ai/agents/[id]/page.tsx");
    expect(arquivos).toContain("app/app/ai/agents/[id]/_actions.ts");
  });

  it.each(arquivos)("%s passa o ponteiro em toda chamada", (arquivo) => {
    const chamadas = argumentosDasChamadas(readFileSync(join(raiz, arquivo), "utf8"));
    expect(chamadas.length, `${arquivo}: recorte de chamada falhou`).toBeGreaterThan(0);
    for (const args of chamadas) {
      const ponteiro = segundoArgumento(args);
      expect(
        ponteiro,
        `${arquivo}: chamada sem o ponteiro — a publicada seria decidida por 'status', ` +
          `que é palpite. Passe \`published_version_id ?? null\`.`,
      ).not.toBeNull();
      expect(
        ponteiro,
        `${arquivo}: o ponteiro veio \`undefined\` — a régua cai no palpite igual a omitir. ` +
          `\`null\` é o dado "não há publicada"; \`undefined\` é "não perguntei".`,
      ).not.toBe("undefined");
    }
  });

  it("a action pede a coluna do ponteiro no SELECT que ela usa para decidir", () => {
    // Perda silenciosa: `published_version_id` sai do `.select()` numa
    // convergência independente, `agent.published_version_id` passa a ser
    // `undefined`, o `?? null` o transforma em "não há publicada" — e TODO
    // rascunho superado volta a ser regravável. Nenhum símbolo some, nenhum tipo
    // reclama (o retorno do supabase-js é frouxo aqui) e o dublê dos outros
    // casos devolve a linha inteira, então nada disto aparece em comportamento.
    const fonte = readFileSync(join(raiz, "app/app/ai/agents/[id]/_actions.ts"), "utf8");
    // O arquivo tem mais de um SELECT em `ai_agents`; o que importa é o do
    // cadastro — reconhecido por trazer `name` e `priority`, os campos que só
    // ele pede. Casar pelo primeiro `.from("ai_agents")` mediria o do revert.
    const selects = [...fonte.matchAll(/\.from\("ai_agents"\)\s*\n\s*\.select\("([^"]+)"\)/g)].map(
      (m) => m[1]!,
    );
    expect(selects.length, "não achei SELECT nenhum em ai_agents: sonda cega").toBeGreaterThan(0);
    const doCadastro = selects.filter((s) => s.includes("name") && s.includes("priority"));
    expect(doCadastro, "o SELECT do cadastro sumiu ou mudou de forma").toHaveLength(1);
    expect(doCadastro[0]).toContain("published_version_id");
  });
});
