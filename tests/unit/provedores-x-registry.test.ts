/**
 * A LISTA QUE A TELA OFERECE E O REGISTRY QUE EXECUTA SÃO A MESMA LISTA.
 *
 * A migration 0127 tirou do banco os CHECKs que prendiam `provider` em três
 * valores. Isso era necessário (eles impediam a OpenRouter de existir), mas
 * transferiu uma garantia do Postgres para o TypeScript — e garantia
 * transferida sem guarda é garantia perdida.
 *
 * Os dois modos de divergir têm sintomas opostos e ambos são ruins:
 *
 *  - **Na lista, fora do registry:** a tela oferece um provedor, o operador
 *    escolhe, salva, e toda chamada daquele ponto morre com
 *    `LlmProviderUnknownError`. Antes, o banco recusava na hora de salvar.
 *  - **No registry, fora da lista:** o sistema sabe executar um provedor que
 *    ninguém consegue escolher pela tela — trabalho feito e inalcançável, que é
 *    a forma como funcionalidade morre neste produto.
 */
import { describe, expect, it } from "vitest";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import {
  ehProvedorSuportado,
  IDS_DE_PROVEDOR,
  PROVEDORES,
  PROVEDOR_POR_ID,
} from "@/lib/ai/pontos/provedores";

const registry = createDefaultRegistry();

describe("lista de provedores × registry", () => {
  it("o registry tem entrada (controle positivo)", () => {
    // Um registry vazio faria os dois testes abaixo passarem por vacuidade.
    expect(Object.keys(registry).length).toBeGreaterThanOrEqual(4);
  });

  it("todo provedor oferecido na tela é executável", () => {
    const semExecucao = PROVEDORES.filter((p) => registry[p.id] === undefined).map((p) => p.id);
    expect(
      semExecucao,
      "a tela ofereceria um provedor que toda chamada recusaria com llm_provider_unknown",
    ).toEqual([]);
  });

  it("todo provedor executável é oferecido na tela", () => {
    const semPorta = Object.keys(registry).filter((id) => !ehProvedorSuportado(id));
    expect(
      semPorta,
      "o sistema saberia usar um provedor que ninguém consegue escolher — trabalho inalcançável",
    ).toEqual([]);
  });
});

describe("a OpenRouter entrou de fato", () => {
  it("está na lista e no registry", () => {
    expect(ehProvedorSuportado("openrouter")).toBe(true);
    expect(registry["openrouter"]).toBeTypeOf("function");
  });

  it("é declarada como sincronizável — é o que justifica o cron de catálogo", () => {
    expect(PROVEDOR_POR_ID.get("openrouter")?.catalogoSincronizavel).toBe(true);
  });

  it("aceita endpoint próprio — é o que prepara o modelo local", () => {
    expect(PROVEDOR_POR_ID.get("openrouter")?.aceitaEndpointProprio).toBe(true);
  });
});

describe("forma de cada provedor", () => {
  it("cada um explica quando usar, em português de gente", () => {
    for (const p of PROVEDORES) {
      expect(p.rotulo.trim().length, `${p.id} sem rótulo`).toBeGreaterThan(0);
      expect(p.quandoUsar.trim().length, `${p.id} sem explicação`).toBeGreaterThan(20);
      expect(p.ondePegarAChave, `${p.id} sem link da chave`).toMatch(/^https:\/\//);
    }
  });

  it("ids são únicos", () => {
    const ids = PROVEDORES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a OpenAI segue na lista e é declarada como necessária além do chat", () => {
    // Áudio e indexação usam OpenAI mesmo com o resto em outro provedor. Se
    // essa frase sumir, o operador que migrar tudo para outro provedor perde
    // transcrição e busca sem entender por quê — o defeito medido em VPS.
    const openai = PROVEDOR_POR_ID.get("openai");
    expect(openai).toBeDefined();
    expect(openai?.quandoUsar.toLowerCase()).toMatch(/áudio|transcre|indexar/);
  });
});

describe("o endpoint próprio chega até a fábrica", () => {
  it("a fábrica da OpenRouter aceita o terceiro argumento", () => {
    // A assinatura precisa aceitar baseUrl, senão `ai_purpose_bindings.base_url`
    // seria uma coluna que a tela preenche e o runtime ignora — configuração
    // que não configura nada.
    const modelo = registry["openrouter"]!(
      "chave-de-teste",
      "meta-llama/llama-3.3-70b-instruct",
      "https://gateway.exemplo/v1",
    );
    expect(modelo).toBeDefined();
  });

  it("sem o terceiro argumento, usa o endpoint canônico", () => {
    const modelo = registry["openrouter"]!("chave-de-teste", "meta-llama/llama-3.3-70b-instruct");
    expect(modelo).toBeDefined();
  });
});

/**
 * A LISTA TAMBÉM PRECISA VALER NOS PONTOS DE ESCRITA.
 *
 * O par lista × registry acima é a metade que já concordava. A outra metade —
 * as portas por onde um provider ENTRA no sistema — tinha, cada uma, a sua
 * cópia da lista de três: o `z.enum` da rota de credenciais, o `PROVIDERS` da
 * validação de versão de agente, o `Provider` do hook da tela, o `z.enum` do
 * diálogo, o `Set` da rota de modelos e o tipo do ModelPicker.
 *
 * O efeito era o desenho inteiro do PR não funcionar: a 0127 abriu o banco para
 * a OpenRouter, o painel a oferecia, e não havia como cadastrar a chave — a
 * tela de Credenciais só listava três, a API devolvia 422, e `agent_turn` /
 * `operator_turn` nunca podiam ser OpenRouter porque o schema de versão de
 * agente também não a conhecia.
 *
 * Estes casos casam a lista com CADA porta. É a comparação que faltava — e é
 * textual porque essas portas são declarações estáticas; o que não pode
 * acontecer de novo é uma delas envelhecer sozinha.
 */
describe("lista de provedores × os pontos de ESCRITA", () => {
  const ids = PROVEDORES.map((p) => p.id).sort();

  it("o schema de versão de agente aceita a lista inteira", async () => {
    const { PROVIDERS } = await import("@/lib/ai/agents/validation");
    expect(
      [...PROVIDERS].sort(),
      "um provedor fora daqui não pode ser publicado num agente — os dois pontos que respondem o cliente ficam fora do alcance dele",
    ).toEqual(ids);
  });

  it("o validador de chave sabe validar todo provedor da lista", async () => {
    const validators = await import("@/lib/ai/provider-validators");
    // `validateProviderKey` despacha por `switch`; o que se mede aqui é que
    // existe um ramo por provedor, e não o `default` que devolve
    // `unknown_provider` — cadastrar a chave devolveria "provedor
    // desconhecido" com o provedor na lista da tela.
    //
    // É uma chamada de rede DE VERDADE por provedor (de propósito — casa o
    // `switch` com o endpoint real, não um mock que também erraria sozinho).
    // Com 10 provedores e até 5s de timeout cada (`TIMEOUT_MS` de
    // provider-validators.ts) o pior caso passa fácil dos 15s padrão do
    // vitest — daí o timeout maior aqui, não no `TIMEOUT_MS` de produção.
    const semValidador: string[] = [];
    for (const id of ids) {
      const r = await validators.validateProviderKey(
        id as Parameters<typeof validators.validateProviderKey>[0],
        "",
      );
      if (!r.ok && r.error.startsWith("unknown_provider")) semValidador.push(id);
    }
    expect(semValidador).toEqual([]);
  }, 60000);

  it("nenhuma cópia da lista de três sobrou no código de provedor", async () => {
    // A sonda é grosseira de propósito: qualquer lugar que ainda enumere
    // exatamente anthropic/openai/google à mão é uma porta que a OpenRouter não
    // atravessa. A allowlist existe para os casos onde os três SÃO o assunto
    // (ex.: derivar provider do prefixo de um id de modelo legado).
    const { readFileSync } = await import("node:fs");
    const { relative } = await import("node:path");
    const { RAIZ_DO_REPO, arquivosDeCodigo } = await import("./helpers/varrer-codigo");

    const PERMITIDOS = new Set([
      // Deriva o provedor do PREFIXO de um id de modelo legado — não é uma
      // lista de provedores suportados, é um mapa de prefixos históricos.
      "lib/ai/log-invocation.ts",
      "supabase/baseline.sql",
    ]);
    const TRINCA = /["']anthropic["']\s*,\s*["']openai["']\s*,\s*["']google["']/;

    const arquivos = arquivosDeCodigo(["app", "lib", "components", "hooks"]);
    expect(arquivos.length, "a varredura não enxergou o código").toBeGreaterThan(200);

    const sobras = arquivos
      .map((a) => relative(RAIZ_DO_REPO, a))
      .filter((caminho) => !PERMITIDOS.has(caminho))
      .filter((caminho) => TRINCA.test(readFileSync(caminho, "utf8")));

    expect(
      sobras,
      "estes arquivos ainda enumeram os três provedores à mão — derive de lib/ai/pontos/provedores.ts",
    ).toEqual([]);
  });
});

/**
 * A MUTAÇÃO DO PAINEL PRECISA DEIXAR LINHA DE AUDITORIA.
 *
 * `api_audit_log.resource_id` é **uuid**. A rota mandava `corpo.purpose`
 * (`"stage_classifier"`), o INSERT falhava com 22P02 e — como o audit é
 * fire-and-forget — o erro ia só para o log do servidor:
 *
 *     [audit] insert error invalid input syntax for type uuid: "stage_classifier"
 *
 * Ou seja: NENHUMA troca de modelo era auditada, num painel cujo efeito é mudar
 * para onde vão o dinheiro e os dados do cliente. Achado dirigindo a tela — o
 * DoD 5 do repo exige audit em toda mutação e nada assertava a linha.
 */
describe("PUT /api/v1/ai/providers — auditoria", () => {
  it("o resourceId é o id da linha, não o purpose", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync("app/api/v1/ai/providers/route.ts", "utf8");
    const bloco = fonte.slice(fonte.indexOf("ai.purpose_binding_updated"));

    expect(
      bloco,
      "resourceId voltou a receber o purpose — `resource_id` é uuid e o insert do audit morre com 22P02",
    ).not.toMatch(/resourceId:\s*corpo\.purpose/);
    expect(bloco).toMatch(/resourceId:\s*\(gravado as \{ id\?: string \}\)\.id/);
    // E o purpose continua registrado — no metadata, onde texto é aceito.
    expect(bloco).toMatch(/purpose:\s*corpo\.purpose/);
  });

  it("o upsert traz o id de volta (senão o resourceId seria sempre null)", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync("app/api/v1/ai/providers/route.ts", "utf8");
    expect(fonte).toMatch(/\.select\("id, purpose, provider, model_id/);
  });
});

/**
 * OS DOIS PONTOS CEGOS DO INVARIANTE ACIMA.
 *
 * "Todo provedor oferecido na tela é executável" mede `PROVEDORES` contra
 * `createDefaultRegistry` — a lista canônica contra o registry de PRODUÇÃO.
 * Nenhum dos dois lados é o que o usuário encontra:
 *
 *  1. Quem executa o botão **Teste** do agente não é o registry de produção, e
 *     sim `buildModel()` em `lib/ai/runtime/agent.ts` — um segundo switch, que
 *     ficou com três casos. Com o agente em OpenRouter, a mensagem real é
 *     respondida (worker) e o ensaio na tela morre em `unsupported_provider`:
 *     o dono testa antes de confiar, vê erro, e conclui que o produto não
 *     funciona no exato momento em que ele funciona.
 *  2. Quem oferece o provedor na tela do agente não é `PROVEDORES`, e sim três
 *     `<SelectItem>` literais em `AgentForm.tsx`. O invariante passa medindo a
 *     constante enquanto o JSX oferece outra coisa — e um agente publicado em
 *     OpenRouter abre com o campo em branco, porque nenhum item casa com o
 *     valor.
 *
 * Os dois testes abaixo fecham a corrente: lista → registry de produção →
 * runtime de ensaio → o que a tela realmente renderiza.
 */
describe("a corrente inteira: lista × execução × tela", () => {
  it("o runtime de ENSAIO executa todo provedor da lista", async () => {
    const { buildModel } = await import("@/lib/ai/runtime/agent");
    const recusados: string[] = [];
    for (const id of IDS_DE_PROVEDOR) {
      try {
        buildModel(id, "chave-de-teste", "modelo/qualquer");
      } catch {
        recusados.push(id);
      }
    }
    expect(
      recusados,
      "a aba Teste do agente recusaria um provedor que a tela oferece e o worker executa",
    ).toEqual([]);
  });

  it("e continua recusando provedor que ninguém declarou (a catraca não virou peneira)", async () => {
    // Sem isto, trocar o switch por um `createOpenAI` universal faria o teste
    // acima passar e aceitaria qualquer string como provedor.
    const { buildModel } = await import("@/lib/ai/runtime/agent");
    expect(() => buildModel("provedor-que-nao-existe", "k", "m")).toThrow(/unsupported_provider/);
  });

  it("a tela do agente DERIVA a lista, em vez de repetir os provedores à mão", async () => {
    // Guarda de construção: enquanto o seletor for montado a partir de
    // PROVEDORES, "a tela oferece todos" é verdade por construção e o
    // invariante do topo deste arquivo passa a valer para o que se vê.
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync("app/app/ai/agents/[id]/_components/AgentForm.tsx", "utf8");

    const literais = [...fonte.matchAll(/<SelectItem\s+value="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((v): v is string => typeof v === "string" && ehProvedorSuportado(v));

    expect(
      literais,
      "o seletor voltou a listar provedores à mão — o próximo provedor da lista nasce invisível na tela",
    ).toEqual([]);
    expect(fonte).toMatch(/from "@\/lib\/ai\/pontos\/provedores"/);
  });
});
