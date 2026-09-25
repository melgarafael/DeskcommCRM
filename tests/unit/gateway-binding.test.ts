/**
 * O PAINEL ALCANÇA A PILHA ANTIGA — o furo do "botão que não controla nada".
 *
 * Três pontos do registro (`sentiment_classify`, `bot_respond` e o ensaio de
 * agente) resolviam modelo por `lib/ai/gateway.ts`, que não conhecia
 * `ai_purpose_bindings`. A tela os OFERECIA, aceitava a escolha e dizia
 * "salvo" — e nenhuma chamada a respeitava.
 *
 * É pior que a ausência: um ponto que a tela não mostrasse deixaria o operador
 * procurando; um que ela mostra e ignora faz ele concluir que configurou, e
 * seguir depurando o lugar errado. E era invisível para
 * `pontos-de-ia-completude.test.ts`, porque aquele teste casa a LISTA com o
 * código, não a EXECUÇÃO com a configuração.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const bindings = vi.hoisted(() => ({ linha: null as Record<string, unknown> | null }));
const credenciais = vi.hoisted(() => ({ linha: null as Record<string, unknown> | null }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const alvo = tabela === "ai_purpose_bindings" ? bindings : credenciais;
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        maybeSingle: async () => ({ data: alvo.linha }),
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: () => "chave-decifrada-da-organizacao",
  byteaToBuffer: (v: unknown) => v,
}));

vi.mock("@/lib/ai/gateway", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    // O padrão devolve um objeto reconhecível, para os testes distinguirem
    // "caiu no padrão" de "usou o binding" sem depender do SDK.
    resolveLanguageModel: (m: string) => ({ __padrao: true, modelId: m }),
  };
});

const { resolverModeloDoPonto } = await import("@/lib/ai/gateway-binding");

const ORG = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  bindings.linha = null;
  credenciais.linha = null;
});

describe("sem binding e sem credencial da organização, vale a chave da instalação", () => {
  it("cai no padrão e diz que caiu", async () => {
    // A recíproca de tudo abaixo: sem ela, um resolvedor que sempre ignorasse o
    // binding passaria em metade deste arquivo.
    const r = await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");
    expect(r?.origem).toBe("padrao");
    expect(r?.modelId).toBe("anthropic/claude-haiku-4-5");
  });
});

describe("com binding, o painel manda", () => {
  it("usa o modelo e o provedor escolhidos na tela", async () => {
    bindings.linha = {
      provider: "openrouter",
      credential_id: "cred-1",
      model_id: "meta-llama/llama-3.3-70b-instruct",
      base_url: null,
    };
    credenciais.linha = { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" };

    const r = await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");
    expect(r?.origem).toBe("binding");
    expect(r?.modelId).toBe("meta-llama/llama-3.3-70b-instruct");
    // E NÃO é o objeto do padrão — se fosse, o teste acima passaria igual e
    // este aqui estaria medindo só o rótulo.
    expect((r?.model as { __padrao?: boolean }).__padrao).toBeUndefined();
  });

  it("o modelo do binding é o que vai para o log de custo", async () => {
    // `modelId` alimenta a linha de ai_invocations. Reportar a constante padrão
    // faria a conta do mês atribuir o gasto ao modelo errado.
    bindings.linha = {
      provider: "openai",
      credential_id: "cred-1",
      model_id: "gpt-5-mini",
      base_url: null,
    };
    credenciais.linha = { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" };
    const r = await resolverModeloDoPonto("bot_respond", ORG, "anthropic/claude-sonnet-5");
    expect(r?.modelId).toBe("gpt-5-mini");
  });
});

describe("o binding quebrado NÃO derruba o atendimento", () => {
  it("binding sem credencial utilizável cai no padrão", async () => {
    // Credencial revogada depois de configurada. Derrubar aqui deixaria o
    // cliente sem resposta por causa de uma tela.
    bindings.linha = {
      provider: "openai",
      credential_id: "cred-que-sumiu",
      model_id: "gpt-5-mini",
      base_url: null,
    };
    credenciais.linha = null;
    const r = await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");
    expect(r?.origem).toBe("padrao");
  });

  it("provider desconhecido cai no padrão, não em outro provedor", async () => {
    // Fallback silencioso para um provedor VIZINHO mandaria a chave de um para
    // o endpoint de outro — a forma exata do defeito do PR #151.
    bindings.linha = {
      provider: "provedor-que-nao-existe",
      credential_id: "cred-1",
      model_id: "x/y",
      base_url: null,
    };
    credenciais.linha = { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" };
    const r = await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");
    expect(r?.origem).toBe("padrao");
    expect(r?.modelId).toBe("anthropic/claude-haiku-4-5");
  });

  it("binding sem credencial NENHUMA (null) usa a chave da instalação", async () => {
    // `credential_id` nulo é escolha legítima na tela: "usar a chave que veio
    // na instalação". Não pode ser tratado como binding quebrado.
    bindings.linha = {
      provider: "anthropic",
      credential_id: null,
      model_id: "claude-haiku-4-5",
      base_url: null,
    };
    const r = await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");
    expect(r?.origem).toBe("padrao");
  });
});

describe("cada ponto lê o SEU binding", () => {
  it("a consulta é escopada por organização e por ponto", async () => {
    // Sem os dois filtros, o binding de um ponto vazaria para todos os outros —
    // e, pior, o de uma organização para outra.
    const chamadas: string[] = [];
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => ({
        from: (t: string) => {
          chamadas.push(t);
          const chain = {
            select: () => chain,
            eq: (col: string, val: unknown) => {
              chamadas.push(`${col}=${String(val)}`);
              return chain;
            },
            not: () => chain,
            maybeSingle: async () => ({ data: null }),
          };
          return chain;
        },
      }),
    }));
    vi.resetModules();
    const mod = await import("@/lib/ai/gateway-binding");
    await mod.resolverModeloDoPonto("jailbreak_detect", ORG, "anthropic/claude-haiku-4-5");
    expect(chamadas).toContain("ai_purpose_bindings");
    expect(chamadas).toContain(`organization_id=${ORG}`);
    expect(chamadas).toContain("purpose=jailbreak_detect");
  });
});

/**
 * SEM BINDING, A CREDENCIAL DA ORGANIZAÇÃO VEM ANTES DA CHAVE DA INSTALAÇÃO.
 *
 * Medido em produção (05/09/2026, org "MKT ARQ E ENG"): `ai_purpose_bindings`
 * vazio, duas credenciais OpenRouter ativas e validadas na tela — e o
 * `sentiment_classify` falhando com 401 `{"message":"User not found."}` porque
 * caía direto na `OPENROUTER_API_KEY` do `.env` da VPS, que estava revogada.
 * Os pontos do agent-engine, que passam por `resolveOrgLlmConfig`, usavam a
 * credencial da org e iam bem no mesmo instante.
 *
 * A chave da instalação é o ÚLTIMO degrau em `resolveOrgLlmConfig`
 * (lib/agent-engine/edge/llm/credentials.ts): credencial escolhida, senão a
 * mais recente ativa/validada do provider da org, senão o env. A pilha antiga
 * pulava o degrau do meio — e uma organização que cadastrou a própria chave
 * ficava refém de uma chave de instalação que não é dela.
 */
describe("sem binding, a credencial da organização manda", () => {
  function montarAdmin(
    orgSettings: unknown,
    credencial: Record<string, unknown> | null,
    espiao?: { tabelas: string[]; filtros: string[] },
  ) {
    return () => ({
      from: (tabela: string) => {
        espiao?.tabelas.push(tabela);
        const chain = {
          select: () => chain,
          eq: (col: string, val: unknown) => {
            espiao?.filtros.push(`${col}=${String(val)}`);
            return chain;
          },
          not: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({
            data:
              tabela === "ai_purpose_bindings"
                ? null
                : tabela === "organizations"
                  ? { settings: orgSettings }
                  : credencial,
          }),
        };
        return chain;
      },
    });
  }

  it("usa a credencial ativa do provider da organização, não a chave da instalação", async () => {
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: montarAdmin({ llm: { provider: "openrouter" } }, {
        api_key_encrypted: "x",
        api_key_iv: "y",
        api_key_tag: "z",
      }),
    }));
    vi.resetModules();
    const mod = await import("@/lib/ai/gateway-binding");
    const r = await mod.resolverModeloDoPonto(
      "sentiment_classify",
      ORG,
      "anthropic/claude-haiku-4-5",
    );
    expect(r?.origem).toBe("credencial_da_organizacao");
    // O modelo é o do call site — trocá-lo pelo `default_model` da org faria o
    // classificador barato virar o modelo de conversa da organização.
    expect(r?.modelId).toBe("anthropic/claude-haiku-4-5");
    // E não é o objeto do padrão: sem isto o teste mediria só o rótulo.
    expect((r?.model as { __padrao?: boolean }).__padrao).toBeUndefined();
  });

  it("a credencial é buscada escopada por organização e pelo provider da org", async () => {
    // Sem os dois filtros, a credencial de uma organização serviria a outra —
    // ou a chave de um provedor iria para o endpoint de outro (PR #151).
    const espiao = { tabelas: [] as string[], filtros: [] as string[] };
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: montarAdmin(
        { llm: { provider: "openrouter" } },
        { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" },
        espiao,
      ),
    }));
    vi.resetModules();
    const mod = await import("@/lib/ai/gateway-binding");
    await mod.resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");
    expect(espiao.tabelas).toContain("ai_provider_credentials");
    expect(espiao.filtros).toContain(`organization_id=${ORG}`);
    expect(espiao.filtros).toContain("provider=openrouter");
  });

  it("organização sem credencial do próprio provider cai na chave da instalação", async () => {
    // A recíproca: sem ela, um resolvedor que SEMPRE dissesse "credencial da
    // organização" passaria nos dois testes acima.
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: montarAdmin({ llm: { provider: "openrouter" } }, null),
    }));
    vi.resetModules();
    const mod = await import("@/lib/ai/gateway-binding");
    const r = await mod.resolverModeloDoPonto(
      "sentiment_classify",
      ORG,
      "anthropic/claude-haiku-4-5",
    );
    expect(r?.origem).toBe("padrao");
  });
});

/**
 * O PAR PROVIDER+MODELO NÃO SE CRUZA — a lição do PR #151, no degrau novo.
 *
 * A credencial da organização traz o PROVIDER junto. Aplicá-la a um id que
 * pertence a outro provedor mandaria a chave de um para o endpoint do outro:
 * exatamente `gpt-5-mini` no endpoint da Anthropic, que matou o turno inteiro
 * em 2026-08-25. Quando o id não serve ao provider da organização, o certo é
 * seguir para `resolveLanguageModel`, que sabe rotear pelo prefixo.
 */
describe("a credencial da organização só vale para modelo que o provider dela executa", () => {
  function adminComOrg(provider: string) {
    return () => ({
      from: (tabela: string) => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          not: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({
            data:
              tabela === "ai_purpose_bindings"
                ? null
                : tabela === "organizations"
                  ? { settings: { llm: { provider } } }
                  : { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" },
          }),
        };
        return chain;
      },
    });
  }

  it("id de OUTRO provedor não usa a credencial da organização", async () => {
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: adminComOrg("anthropic") }));
    vi.resetModules();
    const mod = await import("@/lib/ai/gateway-binding");
    const r = await mod.resolverModeloDoPonto("bot_respond", ORG, "openai/gpt-5-mini");
    expect(r?.origem).toBe("padrao");
  });

  it("id do PRÓPRIO provedor entra sem o prefixo, que é nome de rota e não de modelo", async () => {
    // `createAnthropic()("anthropic/claude-haiku-4-5")` pede à Anthropic um
    // modelo cujo nome ela não conhece. O prefixo endereça o provedor; quem já
    // está dentro dele recebe só o nome.
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: adminComOrg("anthropic") }));
    vi.resetModules();
    const mod = await import("@/lib/ai/gateway-binding");
    const r = await mod.resolverModeloDoPonto(
      "sentiment_classify",
      ORG,
      "anthropic/claude-haiku-4-5",
    );
    expect(r?.origem).toBe("credencial_da_organizacao");
    expect((r?.model as { modelId?: string }).modelId).toBe("claude-haiku-4-5");
    // O log continua nomeando o id canônico — é ele que casa com o catálogo de
    // preço. Cortar o prefixo aqui atribuiria o gasto a um modelo sem tabela.
    expect(r?.modelId).toBe("anthropic/claude-haiku-4-5");
  });

  it("na OpenRouter o id canônico passa inteiro — lá o prefixo É a rota", async () => {
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: adminComOrg("openrouter") }));
    vi.resetModules();
    const mod = await import("@/lib/ai/gateway-binding");
    const r = await mod.resolverModeloDoPonto(
      "sentiment_classify",
      ORG,
      "anthropic/claude-haiku-4-5",
    );
    expect(r?.origem).toBe("credencial_da_organizacao");
    expect((r?.model as { modelId?: string }).modelId).toBe("anthropic/claude-haiku-4-5");
  });
});

/**
 * A QUEDA PARA O PADRÃO DA ORGANIZAÇÃO — só quando pedida, e com o par inteiro.
 *
 * O clima pede um id da Anthropic. Numa empresa que atende pela OpenAI sem
 * modelo escolhido para ele, nem a credencial dela nem a chave da instalação
 * executam esse id, e o resolvedor devolvia `null`: clima mudo. Quem pede a
 * queda recebe o padrão da organização (provedor E modelo de `settings.llm`);
 * quem não pede — o agente que responde o cliente — segue recebendo `null`,
 * porque o modelo dele só muda pela publicação.
 */
describe("naFaltaUsarOPadraoDaOrganizacao", () => {
  function adminOpenAI() {
    return () => ({
      from: (tabela: string) => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          not: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({
            data:
              tabela === "ai_purpose_bindings"
                ? null
                : tabela === "organizations"
                  ? { settings: { llm: { provider: "openai", default_model: "gpt-5.6-terra" } } }
                  : { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" },
          }),
        };
        return chain;
      },
    });
  }

  async function importarSemChaveDeInstalacao() {
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: adminOpenAI() }));
    // Nenhuma chave de instalação executa o id da Anthropic.
    vi.doMock("@/lib/ai/gateway", async (orig) => ({
      ...((await orig()) as Record<string, unknown>),
      resolveLanguageModel: () => null,
    }));
    vi.resetModules();
    return import("@/lib/ai/gateway-binding");
  }

  it("sem a opção, o id de outro provedor sem chave nenhuma devolve null (controle)", async () => {
    const mod = await importarSemChaveDeInstalacao();
    expect(await mod.resolverModeloDoPonto("bot_respond", ORG, "anthropic/claude-haiku-4-5")).toBeNull();
  });

  it("com a opção, usa o padrão da organização com a credencial dela", async () => {
    const mod = await importarSemChaveDeInstalacao();
    const r = await mod.resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5", {
      naFaltaUsarOPadraoDaOrganizacao: true,
    });
    expect(r?.origem).toBe("credencial_da_organizacao");
    expect(r?.modelId).toBe("openai/gpt-5.6-terra");
    expect((r?.model as { modelId?: string }).modelId).toBe("gpt-5.6-terra");
  });
});

/**
 * O PAR QUE A INSTALAÇÃO GRAVOU PELA METADE — conserto na leitura.
 *
 * O gatilho `fn_seed_org_llm_defaults` semeia o par da Anthropic, e o
 * instalador trocava só o `provider`: `{openai, claude-sonnet-5}`. Montado como
 * `openai/claude-sonnet-5`, o id ia à OpenAI, que não o conhece — em todo ponto
 * que cai no padrão da empresa. Instalações que já têm o par quebrado não
 * recebem migration de dados; é a leitura que troca o modelo pelo do catálogo
 * daquele provedor, e só quando o gravado não é dele.
 */
describe("o padrão da organização com o par (provedor, modelo) incoerente", () => {
  const CATALOGO_OPENAI = [
    { provider: "openai", model_id: "gpt-5-mini", supports_tools: true, input_price_per_million_cents: 25, output_price_per_million_cents: 200 },
    {
      provider: "openai",
      model_id: "gpt-5.6-terra",
      is_default_for_provider: true,
      supports_tools: true,
      input_price_per_million_cents: 250,
      output_price_per_million_cents: 1000,
    },
  ];

  function admin(
    llm: Record<string, unknown>,
    catalogo: Array<Record<string, unknown>> | "falha",
    credencial: boolean,
  ) {
    return () => ({
      from: (tabela: string) => {
        const filtros: Record<string, unknown> = {};
        const doCatalogo = () =>
          catalogo === "falha"
            ? []
            : catalogo.filter((m) => m.provider === filtros.provider && (filtros.model_id === undefined || m.model_id === filtros.model_id));
        const erro = catalogo === "falha" && tabela === "ai_models" ? { message: "relation does not exist" } : null;
        const chain = {
          select: () => chain,
          eq: (coluna: string, valor: unknown) => {
            filtros[coluna] = valor;
            return chain;
          },
          not: () => chain,
          is: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({
            error: erro,
            data:
              tabela === "ai_purpose_bindings"
                ? null
                : tabela === "organizations"
                  ? { settings: { llm } }
                  : tabela === "ai_models"
                    ? (doCatalogo()[0] ?? null)
                    : credencial
                      ? { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" }
                      : null,
          }),
          // A leitura do catálogo inteiro (`escolherModeloNoCatalogo`) é
          // aguardada direto na cadeia, sem `maybeSingle`.
          then: (ok: (r: { data: unknown; error: unknown }) => void) => ok({ data: doCatalogo(), error: erro }),
        };
        return chain;
      },
    });
  }

  const PEDIDO = "anthropic/claude-haiku-4-5";

  async function resolver(
    llm: Record<string, unknown>,
    catalogo: Array<Record<string, unknown>> | "falha",
    credencial = true,
  ) {
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: admin(llm, catalogo, credencial) }));
    // Nenhuma chave executa o id PEDIDO; o do padrão da organização, a chave da
    // instalação executa — é o que deixa ver o modelo escolhido sem credencial.
    vi.doMock("@/lib/ai/gateway", async (orig) => ({
      ...((await orig()) as Record<string, unknown>),
      resolveLanguageModel: (m: string) => (m === PEDIDO ? null : { __padrao: true, modelId: m }),
    }));
    vi.resetModules();
    const mod = await import("@/lib/ai/gateway-binding");
    return mod.resolverModeloDoPonto("sentiment_classify", ORG, PEDIDO, {
      naFaltaUsarOPadraoDaOrganizacao: true,
    });
  }

  it("{openai, claude-sonnet-5} resolve o curado da OpenAI, não o id da Anthropic", async () => {
    const r = await resolver({ provider: "openai", default_model: "claude-sonnet-5" }, CATALOGO_OPENAI);
    expect(r?.modelId).toBe("openai/gpt-5.6-terra");
    expect((r?.model as { modelId?: string }).modelId).toBe("gpt-5.6-terra");
  });

  it("par coerente passa intacto, mesmo quando não é o curado", async () => {
    // Controle: sem ele, um resolvedor que SEMPRE trocasse pelo curado passaria
    // no caso acima e apagaria a escolha que alguém fez na tela.
    const r = await resolver({ provider: "openai", default_model: "gpt-5-mini" }, CATALOGO_OPENAI);
    expect(r?.modelId).toBe("openai/gpt-5-mini");
  });

  it("o id gravado com o prefixo do próprio provedor é conferido sem ele", async () => {
    const r = await resolver({ provider: "openai", default_model: "openai/gpt-5-mini" }, CATALOGO_OPENAI);
    expect(r?.modelId).toBe("openai/gpt-5-mini");
  });

  describe("na OpenRouter o id com barra é o id do catálogo", () => {
    // Sem credencial da organização: com ela, a OpenRouter executaria o id
    // PEDIDO direto (lá o prefixo é rota) e o padrão nem seria consultado.
    const CATALOGO_OPENROUTER = [
      { provider: "openrouter", model_id: "anthropic/claude-sonnet-5", supports_tools: true, input_price_per_million_cents: 300, output_price_per_million_cents: 1500 },
      { provider: "openrouter", model_id: "outro/barato", supports_tools: true, input_price_per_million_cents: 1, output_price_per_million_cents: 1 },
    ];

    it("e passa intacto quando está no catálogo", async () => {
      const r = await resolver({ provider: "openrouter", default_model: "anthropic/claude-sonnet-5" }, CATALOGO_OPENROUTER, false);
      expect(r?.modelId).toBe("anthropic/claude-sonnet-5");
    });

    it("o id bare da Anthropic, que a OpenRouter não conhece, vira o do catálogo dela", async () => {
      const r = await resolver({ provider: "openrouter", default_model: "claude-sonnet-5" }, CATALOGO_OPENROUTER, false);
      expect(r?.modelId).toBe("outro/barato");
    });
  });

  it("catálogo vazio do provedor mantém o de antes", async () => {
    // A OpenRouter chega com zero linhas até o cron de catálogo rodar: sem
    // modelo para escolher, nada é inventado.
    const r = await resolver({ provider: "openai", default_model: "claude-sonnet-5" }, []);
    expect(r?.modelId).toBe("openai/claude-sonnet-5");
  });

  it("catálogo ilegível mantém o de antes, sem lançar", async () => {
    const r = await resolver({ provider: "openai", default_model: "claude-sonnet-5" }, "falha");
    expect(r?.modelId).toBe("openai/claude-sonnet-5");
  });
});
