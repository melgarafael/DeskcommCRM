/**
 * Passo "Configurar IA" do onboarding — o que acontece quando a publicação da
 * 1ª versão NÃO pode ser decidida.
 *
 * O defeito: `listSelectableChannels` lança em qualquer erro de banco (decisão
 * correta lá — seletor que devolve lista vazia por falha convida a parear de
 * novo um número que já está no ar), e a action a chamava sem `try`. O throw
 * furava o `CreateAgentResult` e o desfecho era o pior possível para quem acabou
 * de instalar: a linha em `ai_agents` JÁ existia, `patchOnboardingState`, audit
 * e `event_log` NÃO rodavam, a tela não dizia nada — e o segundo clique criava
 * OUTRO agente.
 *
 * Por isso os testes daqui dirigem a action REAL contra um banco de mentira que
 * GUARDA o que foi escrito: sem estado que sobrevive entre as chamadas, o
 * segundo clique não teria como duplicar nada e o teste passaria por vacuidade.
 * `listSelectableChannels` é a de verdade — é o throw dela que está sob teste.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Consulta {
  table: string;
  op: "select" | "insert" | "update";
  payload: Record<string, unknown> | null;
  filtros: Record<string, unknown>;
  /**
   * As colunas pedidas no `select`. Existe porque duas leituras diferentes
   * batem em `organizations` no mesmo fluxo — o estado do onboarding e o
   * provedor de IA da instalação — e um dublê que responde igual às duas não
   * consegue exercitar a falha de UMA delas.
   */
  colunas: string;
}
type ErroDb = { code?: string; message: string } | null;
interface Resposta {
  data: unknown;
  error: ErroDb;
}

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

const redirects: string[] = [];
let responder: (c: Consulta) => Resposta;
let responderRpc: (nome: string, args: Record<string, unknown>) => Resposta;

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    // O `redirect` do Next interrompe a execução lançando; um dublê que
    // simplesmente retornasse deixaria a action seguir por um caminho que em
    // produção não existe.
    const err = new Error(`NEXT_REDIRECT: ${url}`);
    (err as { digest?: string }).digest = `NEXT_REDIRECT;replace;${url}`;
    throw err;
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  loadAuthUser: vi.fn(async () => ({ id: USER, email: "dono@qa.local", full_name: "Dono" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "QA", role: "admin" })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteFalso() }));

import { createDefaultAgent, type CreateAgentResult } from "@/app/actions/onboarding/createDefaultAgent";

/**
 * Construtor de consulta no formato do PostgREST: encadeável, thenable, e com
 * `single`/`maybeSingle`. Cada `from()` abre uma consulta nova — reaproveitar um
 * thenable já resolvido reenviaria a requisição (é por isso que o helper de
 * `archived_at` recebe duas closures, e não um builder mutável).
 */
function clienteFalso() {
  const abrir = (table: string) => {
    const c: Consulta = { table, op: "select", payload: null, filtros: {}, colunas: "" };
    const resolver = () => Promise.resolve(responder(c));
    const b = {
      select: (colunas?: string) => {
        if (typeof colunas === "string") c.colunas = colunas;
        return b;
      },
      insert: (payload: Record<string, unknown>) => {
        c.op = "insert";
        c.payload = payload;
        return b;
      },
      update: (payload: Record<string, unknown>) => {
        c.op = "update";
        c.payload = payload;
        return b;
      },
      // O ponteiro da memória da organização é gravado por upsert (uma linha
      // por org). Sem este método o dublê fingia que a tabela não existia.
      upsert: (payload: Record<string, unknown>) => {
        c.op = "insert";
        c.payload = payload;
        return b;
      },
      eq: (coluna: string, valor: unknown) => {
        c.filtros[coluna] = valor;
        return b;
      },
      is: (coluna: string, valor: unknown) => {
        c.filtros[coluna] = valor;
        return b;
      },
      // A busca da credencial da organização usa `.not("validated_at","is",null)`:
      // credencial que o provedor ainda não confirmou não é utilizável pelo turno.
      not: (coluna: string, _op: string, valor: unknown) => {
        c.filtros[`not:${coluna}`] = valor;
        return b;
      },
      order: () => b,
      limit: () => b,
      single: () => resolver(),
      maybeSingle: () => resolver(),
      then: (ok: (r: Resposta) => unknown, no?: (e: unknown) => unknown) => resolver().then(ok, no),
    };
    return b;
  };
  return {
    from: abrir,
    rpc: (nome: string, args: Record<string, unknown>) =>
      Promise.resolve(responderRpc(nome, args)),
  } as never;
}

interface Estado {
  /** Versões da memória da organização — as "regras da casa". */
  memoria: Record<string, unknown>[];
  /** Para onde o ponteiro da memória aponta (vazio = nenhuma publicada). */
  ponteiroDaMemoria: string;
  agentes: Record<string, unknown>[];
  versoes: Record<string, unknown>[];
  eventos: Record<string, unknown>[];
  onboardingState: Record<string, unknown>;
}

interface Mundo {
  /**
   * A credencial VALIDADA da organização para o provedor escolhido. `null` =
   * não tem nenhuma, e aí a versão nasce com `credential_id: null`, que
   * significa "usa a chave da instalação".
   */
  credencial?: { id: string } | null;
  /**
   * A instalação tem chave deste provedor no ambiente? É o caso mais comum do
   * kit — a pessoa cola a chave no `.env` e nunca abre a tela de Credenciais.
   */
  chaveDaInstalacao?: boolean;
  /** O que a consulta de canais responde — é aqui que mora o defeito. */
  canais?: Resposta;
  /** Erro na gravação da versão (o `return` mudo de antes). */
  erroVersao?: ErroDb;
  agentes?: Record<string, unknown>[];
  versoes?: Record<string, unknown>[];
  /**
   * O que o instalador gravou em `organizations.settings`. Numa VPS que
   * escolheu OpenRouter no menu, é `{llm:{provider:"openrouter", ...}}`.
   * Ausente = organização que nunca passou pelo instalador.
   */
  settings?: Record<string, unknown>;
  /** Erro ao LER o settings da org (só essa leitura, não o estado do wizard). */
  erroSettings?: ErroDb;
  /**
   * O modelo curado (`is_default_for_provider`) de cada provedor. O default
   * cobre só a Anthropic de propósito: é o retrato do catálogo que o
   * `baseline.sql` semeia, onde a OpenRouter tem ZERO linhas até o cron diário
   * rodar. Um dublê que respondesse modelo para qualquer provedor esconderia
   * exatamente o estado de uma instalação nova.
   */
  modelosPorProvedor?: Record<string, string>;
  /**
   * O funil de entrada da organização. Toda org nasce com um (criado por
   * gatilho no INSERT de `organizations`); `null` cobre a instalação em que a
   * consulta não acha nada, e o agente tem de nascer com escopo VAZIO em vez de
   * chutar um funil.
   */
  funilPadrao?: { id: string } | null;
  /** Erro ao gravar as regras da casa. */
  erroMemoria?: ErroDb;
}

const CANAL = {
  id: "canal-1",
  display_name: "Vendas",
  status: "WORKING",
  phone_number: "5511999999999",
  waha_session_name: "org_2222_aaa",
};

function montarBanco(mundo: Mundo = {}): Estado {
  const estado: Estado = {
    memoria: [],
    ponteiroDaMemoria: "",
    agentes: mundo.agentes ?? [],
    versoes: mundo.versoes ?? [],
    eventos: [],
    onboardingState: {},
  };
  const canais = mundo.canais ?? { data: [CANAL], error: null };

  const modelos = mundo.modelosPorProvedor ?? { anthropic: "claude-sonnet-9" };

  responderRpc = (nome, args) => {
    if (nome !== "fn_publish_ai_agent_version") {
      throw new Error(`rpc não dublada no teste: ${nome}`);
    }
    const versao = estado.versoes.find(
      (v) =>
        v.id === args.p_version_id &&
        v.agent_id === args.p_agent_id &&
        v.organization_id === args.p_org_id,
    );
    if (!versao) return { data: null, error: { message: "version_not_found" } };
    if (
      args.p_expected_provenance &&
      versao.provisioning_origin !== args.p_expected_provenance
    ) {
      return { data: null, error: { message: "existing_version_requires_review" } };
    }
    const agente = estado.agentes.find(
      (a) => a.id === args.p_agent_id && a.organization_id === args.p_org_id,
    );
    if (!agente) return { data: null, error: { message: "agent_not_found" } };
    const anterior = (agente.published_version_id as string | null | undefined) ?? null;
    versao.status = "published";
    agente.published_version_id = versao.id;
    return {
      data: [{
        agent_id: agente.id,
        version_id: versao.id,
        previous_version_id: anterior,
        published_at: "2026-09-06T12:00:00.000Z",
      }],
      error: null,
    };
  };

  // A chave da instalação é lida do `process.env` por `chaveDePlataforma`. O
  // default é TER a chave, que é o retrato de quem instalou pelo kit — e é a
  // precondição dos casos que exercitam OUTRA coisa. Um teste que rodasse sem
  // ela mediria "publicação sem chave" achando que mede o canal.
  const temChave = mundo.chaveDaInstalacao !== false;
  for (const v of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]) {
    if (temChave) process.env[v] = "sk-de-teste";
    else delete process.env[v];
  }

  responder = (c) => {
    if (c.table === "channel_sessions") return canais;
    if (c.table === "ai_models") {
      // Consciente do filtro: antes respondia o MESMO modelo para qualquer
      // provedor, e por isso um agente publicado em OpenRouter com um id da
      // Anthropic passava verde aqui.
      //
      // Devolve LISTA porque a escolha do modelo deixou de ser "pegue o
      // marcado como padrão" — a OpenRouter chega com centenas de modelos e
      // NENHUM marcado, e a regra agora olha ferramentas e preço.
      const provider = String(c.filtros.provider ?? "");
      const modelId = modelos[provider];
      return {
        data: modelId
          ? [
              {
                model_id: modelId,
                is_default_for_provider: true,
                supports_tools: true,
                input_price_per_million_cents: 100,
                output_price_per_million_cents: 200,
              },
            ]
          : [],
        error: null,
      };
    }

    if (c.table === "ai_agents") {
      if (c.op === "insert") {
        const linha = { id: `agente-${estado.agentes.length + 1}`, published_version_id: null, ...c.payload };
        estado.agentes.push(linha);
        return { data: { id: linha.id, published_version_id: null }, error: null };
      }
      // `is_default` no filtro = a busca pelo agente padrão da org (reaproveitar).
      const alvo =
        c.filtros.is_default === true
          ? estado.agentes.find((a) => a.is_default === true && a.organization_id === c.filtros.organization_id)
          : estado.agentes.find((a) => a.id === c.filtros.id);
      if (!alvo) return { data: null, error: null };
      if (c.op === "update") Object.assign(alvo, c.payload);
      return { data: { id: alvo.id, published_version_id: alvo.published_version_id ?? null }, error: null };
    }

    if (c.table === "ai_agent_versions") {
      if (c.op === "insert") {
        if (mundo.erroVersao) return { data: null, error: mundo.erroVersao };
        const colide = estado.versoes.some(
          (v) => v.agent_id === c.payload?.agent_id && v.version_number === c.payload?.version_number,
        );
        // `ai_agent_versions_unique_number UNIQUE (agent_id, version_number)`.
        if (colide) {
          return {
            data: null,
            error: {
              code: "23505",
              message: 'duplicate key value violates unique constraint "ai_agent_versions_unique_number"',
            },
          };
        }
        const linha = { id: `versao-${estado.versoes.length + 1}`, ...c.payload };
        estado.versoes.push(linha);
        return { data: { id: linha.id }, error: null };
      }
      const candidatas = estado.versoes.filter(
        (v) =>
          v.agent_id === c.filtros.agent_id &&
          (!c.filtros.organization_id || v.organization_id === c.filtros.organization_id),
      );
      if (c.filtros.id) {
        return { data: candidatas.find((v) => v.id === c.filtros.id) ?? null, error: null };
      }
      if (c.filtros.version_number !== undefined) {
        const achada = candidatas.find((v) => v.version_number === c.filtros.version_number);
        return { data: achada ? { id: achada.id } : null, error: null };
      }
      return { data: candidatas, error: null };
    }

    if (c.table === "organizations") {
      if (c.op === "update") {
        estado.onboardingState = (c.payload?.onboarding_state as Record<string, unknown>) ?? {};
        return { data: null, error: null };
      }
      // A leitura do provedor da instalação é OUTRA consulta, com outras
      // colunas, e pode falhar sozinha — é o caso em que não se sabe qual
      // provedor usar, e publicar com um chute seria o defeito original de
      // roupa nova.
      if (c.colunas.includes("settings")) {
        if (mundo.erroSettings) return { data: null, error: mundo.erroSettings };
        return { data: { settings: mundo.settings ?? null }, error: null };
      }
      return { data: { onboarding_state: estado.onboardingState, onboarded_at: null }, error: null };
    }

    if (c.table === "org_memory_versions") {
      if (c.op === "insert") {
        if (mundo.erroMemoria) return { data: null, error: mundo.erroMemoria };
        const linha: Record<string, unknown> = {
          id: `mem-${estado.memoria.length + 1}`,
          ...c.payload,
        };
        estado.memoria.push(linha);
        return { data: { id: linha.id, version_number: linha.version_number }, error: null };
      }
      // select-max da versão anterior
      const ultima = estado.memoria[estado.memoria.length - 1];
      return { data: ultima ? { version_number: ultima.version_number } : null, error: null };
    }

    if (c.table === "org_memory_pointers") {
      estado.ponteiroDaMemoria = String((c.payload as { version_id?: unknown })?.version_id ?? "");
      return { data: null, error: null };
    }



    if (c.table === "ai_provider_credentials") {
      return { data: mundo.credencial ?? null, error: null };
    }

    if (c.table === "crm_pipelines") {
      const funil = mundo.funilPadrao === undefined ? { id: "funil-1" } : mundo.funilPadrao;
      return { data: funil, error: null };
    }

    if (c.table === "event_log") {
      estado.eventos.push(c.payload ?? {});
      return { data: null, error: null };
    }

    throw new Error(`tabela não dublada no teste: ${c.table}`);
  };

  return estado;
}

function formulario(nome = "Atendente IA", regras?: string): FormData {
  const fd = new FormData();
  fd.set("name", nome);
  fd.set("prompt_template", "ecommerce_friendly");
  if (regras !== undefined) fd.set("regras_da_casa", regras);
  return fd;
}

/** A action redireciona LANÇANDO; quem chama precisa distinguir isso de defeito. */
async function clicar(nome?: string, regras?: string): Promise<CreateAgentResult | "redirecionou"> {
  try {
    return await createDefaultAgent(formulario(nome, regras));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("NEXT_REDIRECT")) return "redirecionou";
    throw err;
  }
}

const FALHA_AO_LISTAR: Resposta = {
  data: null,
  error: { code: "42501", message: "permission denied for table channel_sessions" },
};

beforeEach(() => {
  redirects.length = 0;
});

describe("onboarding: publicação impossível não pode terminar em silêncio", () => {
  it("erro ao listar canais vira motivo na resposta — não estoura por cima do contrato", async () => {
    const estado = montarBanco({ canais: FALHA_AO_LISTAR });

    const res = await clicar();

    expect(res).not.toBe("redirecionou");
    const r = res as CreateAgentResult;
    expect(r.ok).toBe(true);
    expect(r.ok && r.publish_error).toMatch(/permission denied for table channel_sessions/);
    // Nada publicado: publicar sem saber o canal seria chute.
    expect(estado.versoes).toHaveLength(0);
    expect(estado.agentes[0]?.published_version_id ?? null).toBeNull();
    // ...e o wizard NÃO avança calado: a tela é a única pista que a pessoa tem.
    expect(redirects).toEqual([]);
  });

  it("o passo fica gravado mesmo sem publicar — estado, evento e agente existem", async () => {
    const estado = montarBanco({ canais: FALHA_AO_LISTAR });

    await clicar();

    const ai = (estado.onboardingState.ai ?? {}) as { agent_id?: string };
    expect(ai.agent_id).toBe(estado.agentes[0]?.id);
    expect(estado.eventos).toHaveLength(1);
    expect(estado.eventos[0]?.payload).toMatchObject({ source: "onboarding", published: false });
  });

  it("segundo clique NÃO cria um segundo agente — o dano real da falha", async () => {
    const estado = montarBanco({ canais: FALHA_AO_LISTAR });

    const primeiro = (await clicar("Atendente IA")) as CreateAgentResult;
    const segundo = (await clicar("Atendente IA")) as CreateAgentResult;

    expect(estado.agentes).toHaveLength(1);
    expect(primeiro.ok && primeiro.agent_id).toBe(segundo.ok && segundo.agent_id);
    // E o único agente continua sendo o padrão da org (o índice único permite um).
    expect(estado.agentes.filter((a) => a.is_default === true)).toHaveLength(1);
  });

  it("repetir com o nome trocado edita o mesmo agente, em vez de multiplicar", async () => {
    const estado = montarBanco({ canais: FALHA_AO_LISTAR });

    await clicar("Atendente IA");
    await clicar("Sofia do Suporte");

    expect(estado.agentes).toHaveLength(1);
    expect(estado.agentes[0]?.name).toBe("Sofia do Suporte");
  });

  it("com canal disponível: publica e segue o wizard (o caminho que não pode ter quebrado)", async () => {
    const estado = montarBanco();

    const res = await clicar();

    expect(res).toBe("redirecionou");
    // O destino é o ROTEADOR, não um passo. Fixar o passo aqui foi o que
    // deixou o wizard pular "Ver ele atender" quando ele nasceu: o teste
    // continuava verde porque media a intenção antiga.
    expect(redirects).toEqual(["/onboarding"]);
    expect(estado.versoes).toHaveLength(1);
    expect(estado.versoes[0]).toMatchObject({ channel_session_id: "canal-1", status: "published" });
    expect(estado.agentes[0]?.published_version_id).toBe("versao-1");
  });

  it("sem canal nenhum é rascunho CONHECIDO: segue o wizard e não alarma", async () => {
    const estado = montarBanco({ canais: { data: [], error: null } });

    const res = await clicar();

    // Quem pulou o WhatsApp não tem número — tratar isso como erro seria mentir
    // sobre um caminho normal. É o `failed` do teste anterior que é diferente.
    expect(res).toBe("redirecionou");
    expect(estado.versoes).toHaveLength(0);
    expect(estado.eventos[0]?.payload).toMatchObject({ published: false });
  });

  it("versão do próprio onboarding já gravada: concluir o retry sem duplicar", async () => {
    const estado = montarBanco({
      agentes: [{ id: "agente-1", organization_id: ORG, is_default: true, published_version_id: null }],
      versoes: [{
        id: "versao-1",
        organization_id: ORG,
        agent_id: "agente-1",
        version_number: 1,
        provisioning_origin: "onboarding",
        status: "draft",
        provider: "anthropic",
        credential_id: null,
      }],
    });

    const res = await clicar();

    expect(res).toBe("redirecionou");
    expect(estado.versoes).toHaveLength(1);
    expect(estado.versoes[0]?.status).toBe("published");
    expect(estado.agentes[0]?.published_version_id).toBe("versao-1");
  });

  it("rascunho criado por uma pessoa não é publicado pelo retry do onboarding", async () => {
    const estado = montarBanco({
      agentes: [{ id: "agente-1", organization_id: ORG, is_default: true, published_version_id: null }],
      versoes: [{
        id: "versao-1",
        organization_id: ORG,
        agent_id: "agente-1",
        version_number: 1,
        provisioning_origin: null,
        status: "draft",
        provider: "anthropic",
        credential_id: null,
      }],
    });

    const res = await clicar();

    expect(res).not.toBe("redirecionou");
    const r = res as CreateAgentResult;
    expect(r.ok).toBe(true);
    expect(r.ok && r.publish_error).toBe("existing_version_requires_review");
    expect(estado.versoes).toHaveLength(1);
    expect(estado.versoes[0]?.status).toBe("draft");
    expect(estado.agentes[0]?.published_version_id ?? null).toBeNull();
  });

  it("falha ao gravar a versão também chega à tela (era um return mudo)", async () => {
    montarBanco({ erroVersao: { code: "42501", message: "permission denied for table ai_agent_versions" } });

    const res = (await clicar()) as CreateAgentResult;

    expect(res.ok && res.publish_error).toMatch(/permission denied for table ai_agent_versions/);
    expect(redirects).toEqual([]);
  });
});

/**
 * O PROVEDOR DA INSTALAÇÃO — o passo publicava sempre "anthropic".
 *
 * O instalador pergunta qual IA vai atender e grava a escolha em
 * `organizations.settings.llm.provider`. O onboarding ignorava: buscava o
 * modelo com `.eq("provider","anthropic")` e gravava `provider:"anthropic"`
 * literal na versão publicada. Como o provider da VERSÃO vence o da
 * organização em `resolveOrgLlmConfig`, quem escolheu OpenRouter — a opção [1]
 * do menu — terminava o wizard com um agente "Publicado" que morria em TODA
 * mensagem, pedindo uma chave da Anthropic que ele nunca teve.
 *
 * O par provider+model vem sempre da MESMA origem. Emprestar só o id do modelo
 * de outro provedor é o defeito que `lib/ai/pontos/resolver.ts` documenta.
 */
describe("onboarding: o agente nasce no provedor que a instalação escolheu", () => {
  it("instalação em OpenRouter publica em OpenRouter — com o modelo DELE", async () => {
    const estado = montarBanco({
      settings: { llm: { provider: "openrouter", default_model: "claude-sonnet-5" } },
      modelosPorProvedor: { anthropic: "claude-sonnet-9", openrouter: "z-ai/glm-4.7" },
    });

    const res = await clicar();

    expect(res).toBe("redirecionou");
    expect(estado.versoes).toHaveLength(1);
    expect(estado.versoes[0]).toMatchObject({
      provider: "openrouter",
      model: "z-ai/glm-4.7",
      status: "published",
    });
  });

  it("o `default_model` do settings NÃO é a fonte do modelo", async () => {
    // Numa instalação OpenRouter ele vale um id da ANTHROPIC: o gatilho do
    // banco semeia o default da Anthropic e o instalador só sobrescreve
    // `{llm,provider}`. Usá-lo mandaria "claude-sonnet-5" ao endpoint da
    // OpenRouter — texto plausível, nenhum lead criado.
    // O `default_model` aqui é um id PLAUSÍVEL para a OpenRouter — e não o
    // curado. Fosse "claude-sonnet-5", este caso passaria por vacuidade: o
    // código de hoje já grava outro valor, e a implementação errada
    // ("lê o modelo do settings") não seria reprovada por ele.
    const estado = montarBanco({
      settings: { llm: { provider: "openrouter", default_model: "algum/modelo-do-settings" } },
      modelosPorProvedor: { anthropic: "claude-sonnet-9", openrouter: "z-ai/glm-4.7" },
    });

    await clicar();

    expect(estado.versoes[0]?.model).toBe("z-ai/glm-4.7");
    expect(estado.versoes[0]?.model).not.toBe("algum/modelo-do-settings");
  });

  it("VPS fresca em OpenRouter: sem modelo no catálogo, fica rascunho e DIZ por quê", async () => {
    // O estado real de uma instalação nova: o baseline semeia zero linhas de
    // OpenRouter e o catálogo só chega no cron diário. Publicar aqui exigiria
    // inventar um id de modelo — e um id inventado é o mesmo agente mudo com
    // outro carimbo.
    const estado = montarBanco({
      settings: { llm: { provider: "openrouter" } },
      modelosPorProvedor: { anthropic: "claude-sonnet-9" },
    });

    const res = await clicar();

    expect(res).not.toBe("redirecionou");
    const r = res as CreateAgentResult;
    expect(r.ok).toBe(true);
    expect(r.ok && r.publish_blocked_by).toBe("modelo");
    expect(estado.versoes).toHaveLength(0);
    expect(estado.agentes[0]?.published_version_id ?? null).toBeNull();
    // O wizard não avança calado: a tela é a única pista que a pessoa tem.
    expect(redirects).toEqual([]);
  });

  it("controle: instalação sem escolha registrada segue na Anthropic, e publica", async () => {
    // Sem este caso, um conserto que simplesmente parasse de publicar sempre
    // passaria nos três acima.
    const estado = montarBanco();

    const res = await clicar();

    expect(res).toBe("redirecionou");
    expect(estado.versoes[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-9" });
  });

  it("nasce podendo mexer no CRM: capacidades ligadas e funil no escopo", async () => {
    // O defeito: `tool_ids='{}'` faz o turno não montar ferramenta nenhuma, e
    // `pipeline_ids='{}'` recusa toda escrita de lead (vazio = NENHUM, falha
    // fechada). Juntos, entregam um funcionário que conversa e não toca no
    // produto — sem nada na tela dizendo isso.
    const estado = montarBanco();

    await clicar();

    const versao = estado.versoes[0] as { tool_ids?: string[]; pipeline_ids?: string[] };
    expect(versao.tool_ids?.length ?? 0).toBeGreaterThan(0);
    expect(versao.pipeline_ids).toEqual(["funil-1"]);
  });

  it("as capacidades gravadas são as do padrão — não uma lista paralela", async () => {
    const { capacidadesPadraoDoOnboarding } = await import("@/lib/ai/agents/capacidades-padrao");
    const estado = montarBanco();

    await clicar();

    expect((estado.versoes[0] as { tool_ids?: string[] }).tool_ids).toEqual(
      capacidadesPadraoDoOnboarding(),
    );
  });

  it("sem funil de entrada, o escopo nasce VAZIO — nunca um funil chutado", async () => {
    // Escopo errado é pior que escopo nenhum: o agente mexeria no funil de
    // outra operação achando que é o dele.
    const estado = montarBanco({ funilPadrao: null });

    await clicar();

    expect((estado.versoes[0] as { pipeline_ids?: string[] }).pipeline_ids).toEqual([]);
  });

  it("não dá para LER o provedor: não publica — publicar com chute é o defeito de origem", async () => {
    const estado = montarBanco({
      erroSettings: { code: "42501", message: "permission denied for table organizations" },
    });

    const res = await clicar();

    expect(res).not.toBe("redirecionou");
    const r = res as CreateAgentResult;
    expect(r.ok && r.publish_error).toMatch(/permission denied for table organizations/);
    expect(estado.versoes).toHaveLength(0);
  });
});

/**
 * AS REGRAS DA CASA.
 *
 * O passo perguntava só nome e jeito de falar. O que a pessoa sabe sobre o
 * próprio negócio — horário, o que nunca prometer, como chamar o cliente — não
 * tinha onde entrar, e o funcionário nascia sem saber uma linha sobre onde
 * trabalha.
 *
 * Elas vão para a MEMÓRIA DA ORGANIZAÇÃO, não para o prompt deste agente: valem
 * para qualquer agente que a empresa venha a ter, e é o mesmo lugar que a tela
 * de Memória edita depois. Enfiá-las no prompt faria a segunda contratação
 * nascer sem elas.
 */
describe("onboarding: o que o funcionário sabe sobre o negócio", () => {
  it("as regras escritas no passo viram memória da organização, publicada", async () => {
    const estado = montarBanco();

    await clicar("Atendente IA", "Horário: 9h às 18h. Nunca prometa desconto.");

    expect(estado.memoria).toHaveLength(1);
    expect(estado.memoria[0]).toMatchObject({
      organization_id: ORG,
      version_number: 1,
      content: "Horário: 9h às 18h. Nunca prometa desconto.",
    });
    // Gravar a versão sem mover o ponteiro deixaria o agente lendo a anterior.
    expect(estado.ponteiroDaMemoria).toBe("mem-1");
  });

  it("NÃO vão para o prompt do agente — senão o segundo agente nasce sem elas", async () => {
    const estado = montarBanco();

    await clicar("Atendente IA", "Nunca prometa desconto.");

    const prompt = String((estado.versoes[0] as { system_prompt?: string }).system_prompt ?? "");
    expect(prompt).not.toContain("Nunca prometa desconto");
  });

  it("campo em branco não publica memória vazia", async () => {
    // O campo é opcional de propósito: quem não sabe o que escrever no primeiro
    // dia não pode ficar preso no passo. Publicar vazio criaria uma versão que
    // apaga o que existia.
    const estado = montarBanco();

    await clicar("Atendente IA", "   ");

    expect(estado.memoria).toHaveLength(0);
  });

  it("falha ao gravar as regras NÃO derruba o passo — mas aparece na tela", async () => {
    // O agente já existe e o treinamento principal aconteceu. Redirecionar
    // calado apagaria da tela o único lugar onde aquele texto existia.
    const estado = montarBanco({
      erroMemoria: { code: "42501", message: "permission denied for table org_memory_versions" },
    });

    const res = await clicar("Atendente IA", "Horário: 9h às 18h.");

    expect(res).not.toBe("redirecionou");
    const r = res as CreateAgentResult;
    expect(r.ok && r.regras_nao_salvas).toMatch(/permission denied for table org_memory_versions/);
    // O agente foi publicado assim mesmo: o que falhou foi só a memória.
    expect(estado.versoes).toHaveLength(1);
    expect(redirects).toEqual([]);
  });

  it("o prompt sabe o nome do negócio (e não fala de loja online)", async () => {
    // Dois dos três jeitos de falar diziam "loja online"/"e-commerce" — numa
    // clínica, o atendente se apresentava como sendo de outro negócio.
    const estado = montarBanco();

    await clicar();

    const prompt = String((estado.versoes[0] as { system_prompt?: string }).system_prompt ?? "");
    expect(prompt).toContain("QA"); // o nome da organização do teste
    expect(prompt).not.toMatch(/loja online|e-commerce/i);
  });
});

describe("onboarding: qual chave o funcionário usa", () => {
  it("sem credencial cadastrada, a versão usa a chave da INSTALAÇÃO", () => {
    // `credential_id: null` é o contrato de "usa a do `.env`" — o caso mais
    // comum do kit, e o que fazia o editor novo recusar o formulário antes.
    const estado = montarBanco({ credencial: null, chaveDaInstalacao: true });
    return clicar().then(() => {
      expect(estado.versoes).toHaveLength(1);
      expect(estado.versoes[0]!.credential_id).toBeNull();
    });
  });

  it("com credencial validada da organização, é ELA que a versão aponta", async () => {
    // Quem colou a chave no wizard tem credencial e pode NÃO ter chave no
    // ambiente: apontar para a instalação publicaria um agente que morre em
    // toda mensagem.
    const estado = montarBanco({ credencial: { id: "cred-9" }, chaveDaInstalacao: false });
    await clicar();
    expect(estado.versoes).toHaveLength(1);
    expect(estado.versoes[0]!.credential_id).toBe("cred-9");
  });

  it("sem NENHUMA das duas, não publica — e a tela recebe a causa certa", async () => {
    // Falha fechada na ação, aberta na informação. Publicar aqui entregaria um
    // funcionário "no ar" que erra em toda mensagem, e o dono só descobriria com
    // o primeiro cliente de verdade.
    const estado = montarBanco({ credencial: null, chaveDaInstalacao: false });
    const r = await clicar();
    expect(r).not.toBe("redirecionou");
    const res = r as Exclude<CreateAgentResult, { ok: false }>;
    expect(res.publish_blocked_by).toBe("chave");
    expect(res.provider).toBe("anthropic");
    // O agente EXISTE (o passo aconteceu); o que não existe é a versão.
    expect(estado.agentes).toHaveLength(1);
    expect(estado.versoes).toHaveLength(0);
  });

  it("o funcionário nasce no formato ATUAL do produto, não no legado", async () => {
    // `ai_agents.kind` tem default 'rag_bot' no banco — de quando o produto só
    // tinha o formato antigo. Nascendo assim, o agente abria no editor legado
    // (Temperature, Top K, Similarity threshold) e as capacidades que ele
    // recebeu ligadas ficavam INVISÍVEIS para o dono.
    const estado = montarBanco({ credencial: null, chaveDaInstalacao: true });
    await clicar();
    expect(estado.agentes).toHaveLength(1);
    expect(estado.agentes[0]!.kind).toBe("mcp_agent");
  });
});
