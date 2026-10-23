/**
 * A LINHA DE `llm_calls` DIZ O PROVEDOR EFETIVO — não a adivinha pelo id (#3098).
 *
 * ## O defeito, medido pelo autor (1.86.0)
 *
 * O ponto `sentiment_classify` estava ligado a um provedor `custom` (Groq,
 * `qwen/qwen3.8-27b`). O log do worker confirmava o par inteiro —
 * `provider: custom`, `origem_da_configuracao: binding` — e a linha em
 * `llm_calls` saía com `provider = 'openrouter'`: o caminho não entregava o
 * provedor ao log, e `providerDoModelo()` trata qualquer id COM BARRA como
 * OpenRouter. A divisão de custo por provedor ficava errada, e a instalação
 * parecia usar um provedor que a empresa tinha decidido não usar.
 *
 * ## O que este arquivo prova, e por quê assim
 *
 * O caminho é o de PRODUÇÃO: o binding sai do resolvedor REAL
 * (`resolverModeloDoPonto`, com o provedor do painel), atravessa a função de log
 * e é afirmado na LINHA que o banco de brinquedo recebeu — não no que o
 * chamador pediu que fosse gravado. O id de modelo é o da instalação real
 * (`qwen/qwen3.8-27b`), que é justamente o que faz o palpite errar.
 *
 * Os quatro casos do critério, na ordem:
 *
 *  1. binding `custom` com id COM BARRA → grava `custom` (é o defeito);
 *  2. binding `openrouter` → continua gravando `openrouter` (quem de fato usa
 *     OpenRouter não pode ser quebrado pelo conserto);
 *  3. sem provedor informado → o palpite por barra PERMANECE (controle de
 *     compatibilidade, e é ele que dá sentido aos dois primeiros: sem o
 *     controle, um `provedorDaChamada` que devolvesse a constante `custom`
 *     passaria nos dois e estaria mentindo em todo o resto);
 *  4. o ponto de visão de imagem, que escreve pela MESMA régua — o
 *     `purpose` dele (`visao_de_imagem`) não cabe em `logInvocation`
 *     (`InvocationKind` espelha o CHECK de `ai_invocations`), então a linha
 *     sai pelo escritor irmão, e os dois agora importam a régua de lá.
 *
 * E um quinto, que fecha o ramo sem binding: quando quem atende é a chave do
 * `.env` (origem `padrao`), o provedor configurado na organização não é o
 * executor, e a resolução devolve `provider` vazio para o palpite decidir.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Dublês ───────────────────────────────────────────────────────────────────
//
// O resolvedor real lê `ai_purpose_bindings` e decifra a credencial; o log
// grava em `llm_calls`. Uma linha por tabela consultada, e as linhas gravadas
// ficam guardadas para as asserções.

const bindings = vi.hoisted(() => ({ linha: null as Record<string, unknown> | null }));
const credenciais = vi.hoisted(() => ({ linha: null as Record<string, unknown> | null }));
const organizacao = vi.hoisted(() => ({ linha: null as Record<string, unknown> | null }));
/** O `.env` da instalação: vazio por padrão, cada caso põe só a chave que mede. */
const envDaInstalacao = vi.hoisted(() => ({}) as Record<string, string>);
const gravadas = vi.hoisted(() => ({ llm_calls: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "llm_calls") {
        return {
          insert: (linha: Record<string, unknown>) => {
            gravadas.llm_calls.push(linha);
            return Promise.resolve({ error: null });
          },
        };
      }
      const alvo =
        tabela === "ai_purpose_bindings" ? bindings : tabela === "organizations" ? organizacao : credenciais;
      const cadeia = {
        select: () => cadeia,
        eq: () => cadeia,
        not: () => cadeia,
        order: () => cadeia,
        limit: () => cadeia,
        maybeSingle: () => Promise.resolve({ data: alvo.linha, error: null }),
      };
      return cadeia;
    },
  }),
}));

vi.mock("@/lib/env", () => ({
  get env() {
    return envDaInstalacao;
  },
}));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: () => "chave-decifrada-da-organizacao",
  byteaToBuffer: (v: unknown) => v,
}));

const { logInvocation, providerDoModelo, provedorDaChamada } = await import(
  "@/lib/ai/log-invocation"
);
const { registrarChamadaDeIa } = await import("@/lib/ai/usage/registrar-chamada");
const { resolverModeloDoPonto } = await import("@/lib/ai/gateway-binding");
const { createAdminClient } = await import("@/lib/supabase/admin");

const ORG = "11111111-1111-4111-8111-111111111111";
const CREDENCIAL = "22222222-2222-4222-8222-222222222222";
/** O id REAL da instalação que abriu a issue: provedor personalizado servindo
 *  um id de agregador. Sem a barra, o defeito não existiria. */
const MODELO_DO_GROQ = "qwen/qwen3.8-27b";
const MODELO_DA_OPENROUTER = "meta-llama/llama-3.3-70b-instruct";

/** O log é fire-and-forget (`queueMicrotask`): dá o tick para ele gravar. */
async function drenar(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * O binding do PAINEL para um ponto, e o resolvedor REAL por cima dele.
 *
 * O `base_url` é o mesmo do provedor personalizado (compatível com a OpenAI) —
 * sem ele o degrau do binding não tem para onde ir e a resolução cai no padrão,
 * o que faria os casos abaixo medirem o caminho errado.
 */
async function comBinding(
  purpose: string,
  provider: string,
  modelId: string,
): Promise<Awaited<ReturnType<typeof resolverModeloDoPonto>>> {
  bindings.linha = {
    provider,
    credential_id: CREDENCIAL,
    model_id: modelId,
    base_url: "https://api.groq.com/openai/v1",
  };
  credenciais.linha = { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" };
  return resolverModeloDoPonto(purpose, ORG, "anthropic/claude-haiku-4-5");
}

beforeEach(() => {
  bindings.linha = null;
  credenciais.linha = null;
  organizacao.linha = null;
  for (const k of Object.keys(envDaInstalacao)) delete envDaInstalacao[k];
  gravadas.llm_calls.length = 0;
});

describe("o provedor efetivo do binding vence o palpite por barra (#3098)", () => {
  it("binding `custom` com id de modelo que tem barra: a linha sai `custom`, não `openrouter`", async () => {
    const resolvido = await comBinding("sentiment_classify", "custom", MODELO_DO_GROQ);

    // O par que o worker confirma ao operador no log estruturado.
    expect(resolvido?.origem, "o binding do painel não atendeu o ponto").toBe("binding");
    expect(resolvido?.modelId).toBe(MODELO_DO_GROQ);
    expect(resolvido?.provider, "a resolução não diz de quem é o endereço").toBe("custom");
    // E o palpite sozinho MENTIRIA neste id — é o defeito da issue, e é o que dá
    // sentido a este caso. Sem esta linha, um `custom` fixo passaria igual.
    expect(providerDoModelo(MODELO_DO_GROQ)).toBe("openrouter");

    logInvocation({
      organization_id: ORG,
      agent_id: null,
      conversation_id: null,
      message_id: null,
      invocation_kind: "sentiment_classify",
      provider: resolvido!.provider,
      model: resolvido!.modelId,
      prompt_tokens: 120,
      completion_tokens: 14,
      latency_ms: 380,
      cost_cents: 0,
      finish_reason: null,
    });
    await drenar();

    expect(gravadas.llm_calls).toHaveLength(1);
    expect(gravadas.llm_calls[0]).toMatchObject({
      purpose: "sentiment_classify",
      provider: "custom",
      model: MODELO_DO_GROQ,
      status: "ok",
    });
  });

  it("binding `openrouter`: continua gravando `openrouter` (o conserto não quebra quem usa OpenRouter)", async () => {
    const resolvido = await comBinding("bot_respond", "openrouter", MODELO_DA_OPENROUTER);

    expect(resolvido?.origem).toBe("binding");
    expect(resolvido?.provider).toBe("openrouter");

    logInvocation({
      organization_id: ORG,
      agent_id: null,
      conversation_id: null,
      message_id: null,
      invocation_kind: "bot_respond",
      provider: resolvido!.provider,
      model: resolvido!.modelId,
      prompt_tokens: 900,
      completion_tokens: 120,
      latency_ms: 1400,
      cost_cents: 4,
      finish_reason: "stop",
    });
    await drenar();

    expect(gravadas.llm_calls[0]).toMatchObject({
      purpose: "bot_respond",
      provider: "openrouter",
      model: MODELO_DA_OPENROUTER,
    });
  });

  it("sem provedor informado, o palpite por barra PERMANECE (controle de compatibilidade)", async () => {
    // O caminho de quem não sabe o provedor (chamador antigo, coluna vazia) não
    // muda de comportamento: quem usa OpenRouter de verdade não pode perder a
    // atribuição por causa deste conserto.
    logInvocation({
      organization_id: ORG,
      agent_id: null,
      conversation_id: null,
      message_id: null,
      invocation_kind: "triage_classify",
      model: MODELO_DA_OPENROUTER,
      prompt_tokens: 30,
      completion_tokens: 3,
      latency_ms: 210,
      cost_cents: null,
      finish_reason: null,
    });
    await drenar();

    expect(gravadas.llm_calls[0]).toMatchObject({
      provider: "openrouter",
      model: MODELO_DA_OPENROUTER,
    });
    // A régua inteira, no caso em que ninguém informa: `null`, `undefined` e
    // string vazia caem no palpite — e o id sem barra e sem fabricante segue
    // `desconhecido` (lacuna declarada, nunca um chute).
    expect(provedorDaChamada(undefined, MODELO_DA_OPENROUTER)).toBe("openrouter");
    expect(provedorDaChamada(null, MODELO_DA_OPENROUTER)).toBe("openrouter");
    expect(provedorDaChamada("   ", MODELO_DA_OPENROUTER)).toBe("openrouter");
    expect(provedorDaChamada(undefined, "modelo-sem-fabricante")).toBe("desconhecido");
    // E quem informa vence, inclusive contra um id que o palpite leria errado.
    expect(provedorDaChamada("custom", MODELO_DO_GROQ)).toBe("custom");
  });

  it("o ponto de visão de imagem: o binding dele também grava o provedor efetivo", async () => {
    // `visao_de_imagem` escreve pelo escritor irmão (`registrarChamadaDeIa`),
    // porque o `purpose` dele não cabe em `logInvocation`. Os dois passam a
    // compartilhar a régua — é o que impede o ponto de mídia de voltar a ser
    // atribuído à OpenRouter por causa da barra no id do modelo.
    const resolvido = await comBinding("visao_de_imagem", "custom", MODELO_DO_GROQ);

    expect(resolvido?.origem, "o binding do painel não atendeu a visão").toBe("binding");
    expect(resolvido?.provider).toBe("custom");

    await registrarChamadaDeIa(createAdminClient(), {
      organization_id: ORG,
      agent_id: null,
      contact_id: null,
      purpose: "visao_de_imagem",
      provider: resolvido!.provider,
      model: resolvido!.modelId,
      input_tokens: 812,
      output_tokens: 48,
      cost_cents: 1,
      latency_ms: 900,
      erro: null,
    });

    expect(gravadas.llm_calls[0]).toMatchObject({
      purpose: "visao_de_imagem",
      provider: "custom",
      model: MODELO_DO_GROQ,
      status: "ok",
    });
  });

  it("sem binding nem credencial da organização, quem atende é a chave da instalação: o provedor configurado NÃO vai para a linha", async () => {
    // A organização escolheu `openrouter` no painel, mas não cadastrou chave
    // validada; a instalação só tem a `ANTHROPIC_API_KEY` do install.sh. Quem
    // decide o destino é o ambiente (`resolveLanguageModel`), e o destino é a
    // Anthropic direta. Gravar `openrouter` aqui seria o sintoma da #3098 por
    // outro caminho.
    organizacao.linha = { settings: { llm: { provider: "openrouter" } } };
    credenciais.linha = null;
    envDaInstalacao.ANTHROPIC_API_KEY = "sk-ant-da-instalacao";

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, "anthropic/claude-sonnet-4-6");

    expect(resolvido?.origem, "a chave da instalação não atendeu o ponto").toBe("padrao");

    logInvocation({
      organization_id: ORG,
      agent_id: null,
      conversation_id: null,
      message_id: null,
      invocation_kind: "bot_respond",
      provider: resolvido!.provider,
      model: resolvido!.modelId,
      prompt_tokens: 900,
      completion_tokens: 120,
      latency_ms: 1400,
      cost_cents: 4,
      finish_reason: "stop",
    });
    await drenar();

    expect(gravadas.llm_calls[0]).toMatchObject({
      purpose: "bot_respond",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-6",
    });
  });
});
