import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #855 — o worker de mídia ignorava a `base_url` do binding de visão.
 *
 * O ponto `visao_de_imagem` aceita um endpoint próprio (é o que o painel de
 * Provedores oferece para quem aponta para um gateway compatível) e o turno do
 * agente honra esse endereço: `run-model-call` chama
 * `factory(config.apiKey, model, decisao.baseUrl ?? undefined)`. O worker de
 * mídia montava o mesmo binding e chamava `factory(apiKey, model)` — sem o
 * terceiro argumento —, então a derivação caía no endpoint padrão do provedor
 * (no roteador, `OPENROUTER_ENDPOINT`) enquanto o chat do mesmo binding
 * funcionava.
 *
 * O que estes casos exercitam: as deps que o worker entrega ao
 * `deriveMediaText` recebem a `base_url` do binding, e é ELA que chega ao
 * factory. Sem a correção, o primeiro caso fica vermelho.
 */

const downloadMock = vi.fn();
const updateEqMock = vi.fn();
const inboxInsertMock = vi.fn();
/** O factory do provedor — é o que a issue diz estar sem o endereço do binding. */
const factoryMock = vi.fn(() => "modelo-de-mentira");
const transcribeDoSvcMock = vi.fn(async () => "transcrição de mentira");
const provedorDeTranscricaoMock = vi.fn((_cfg: unknown) => ({
  transcribe: transcribeDoSvcMock,
}));

// O guarda de destino resolve o nome antes de julgar (é o "inclusive depois da
// resolução de DNS" do requisito). Aqui a resolução é controlada por variável:
// por padrão um IP público, e cada teste escolhe a resposta que quiser.
const dns = vi.hoisted(() => ({
  resposta: [] as Array<{ address: string; family: number }>,
  erro: null as Error | null,
}));
vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async () => {
    if (dns.erro) throw dns.erro;
    return dns.resposta;
  });
  // O default é obrigatório: sem ele o vitest recusa o mock na coleta.
  return { lookup, default: { lookup } };
});

/**
 * Duas formas de binding: com o endereço que o operador configurou, e sem ele
 * (o caso "não mexi em nada", em que o padrão do provedor continua valendo).
 */
const BINDING_COM_ENDPOINT = {
  provider: "openrouter",
  model_id: "acme/visao-1",
  credential_id: "cred-1",
  base_url: "https://gateway.interno.exemplo/v1",
};
const BINDING_SEM_ENDPOINT = { ...BINDING_COM_ENDPOINT, base_url: null };

let bindingDaVez: typeof BINDING_COM_ENDPOINT | typeof BINDING_SEM_ENDPOINT | null = BINDING_COM_ENDPOINT;

/** A linha da mensagem: trocada de tipo conforme o caso (imagem / áudio). */
let linhaDaMensagem = {
  id: "msg1",
  organization_id: "org1",
  type: "image" as string,
  media_mime: "image/jpeg",
  media_storage_path: "org1/conv1/msg1.jpg",
  media_derived_status: null as string | null,
};

// O dublê de `admin` responde por TABELA (mensagem / binding / Central) e deixa
// qualquer encadeamento passar — o worker filtra o binding com três `.eq`.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha =
        tabela === "ai_purpose_bindings"
          ? bindingDaVez
          : tabela === "agent_inbox_items"
            ? null
            : linhaDaMensagem;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const terminais: any = {
        maybeSingle: async () => ({ data: linha, error: null }),
        single: async () => ({ data: linha, error: null }),
        insert: async (row: Record<string, unknown>) => {
          if (tabela === "agent_inbox_items") inboxInsertMock(row);
          return { error: null };
        },
        update: (patch: Record<string, unknown>) => {
          updateEqMock(patch);
          return { eq: () => ({ eq: async () => ({ error: null }) }) };
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: linha ? [linha] : [], error: null }).then(resolve),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(terminais, {
        get: (alvo, prop) => (prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain),
      });
      return chain;
    },
    storage: { from: () => ({ download: downloadMock }) },
  }),
}));

// `deriveMediaText` é a fronteira: os casos leem as deps que o worker passou.
vi.mock("@/lib/messaging/media/derive", () => ({
  deriveMediaText: vi.fn(async () => "derivado de mentira"),
  // O tipo `DeriveDeps` continua vindo do módulo real (import type abaixo).
}));

// A credencial do binding resolve — o que está sob teste é o que o worker faz
// com ela, não a resolução em si.
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(async () => ({
    provider: "openrouter",
    apiKey: "chave-do-binding",
    defaultModel: "gpt-5",
    params: {},
    enabledModels: [],
    orcamento: { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 },
    orcamentoIndisponivelPorque: null,
  })),
}));

// Registro de provedores com um factory espionável em todos os nomes.
vi.mock("@/lib/agent-engine/edge/llm/providers", () => ({
  createDefaultRegistry: () => ({
    openrouter: factoryMock,
    openai: factoryMock,
    anthropic: factoryMock,
    google: factoryMock,
  }),
}));

// Num roteador `visaoEmVigor` consultaria o catálogo no banco; aqui a pergunta
// não é o assunto — o modelo é dado como capaz para que a chamada chegue ao
// factory, que é onde a `base_url` tem de aparecer.
vi.mock("@/lib/ai/pontos/capacidade-em-vigor", () => ({
  visaoEmVigor: vi.fn(async () => ({ enxerga: true, sabemos: true })),
}));

// `generateText` é mockado só para o caminho não sair para a rede.
vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({ text: "descrição de mentira" })),
}));

vi.mock("@/lib/messaging/media/transcription", () => ({
  // A referência é resolvida na CHAMADA, não na fábrica: `vi.mock` é içado para
  // o topo do arquivo e um `const` de módulo ainda não existe nesse momento.
  apiTranscriptionProvider: (cfg: unknown) => provedorDeTranscricaoMock(cfg),
}));

// O worker lê o trio da transcrição pelo `env` — a régua do app (`lib/env.ts`)
// —, e não pelo `process.env` cru: `vi.stubEnv` já não alcança esse caminho. O
// módulo real continua inteiro; só as três chaves da transcrição passam a vir
// de um objeto que cada caso controla.
const transcricaoDoEnv = vi.hoisted(() => ({ apiKey: "", baseUrl: "", model: "" }));
vi.mock("@/lib/env", async (importOriginal) => {
  const real = await importOriginal<{ env: Env }>();
  return {
    env: {
      ...real.env,
      get TRANSCRIPTION_API_KEY() {
        return transcricaoDoEnv.apiKey;
      },
      get TRANSCRIPTION_BASE_URL() {
        return transcricaoDoEnv.baseUrl;
      },
      get TRANSCRIPTION_MODEL() {
        return transcricaoDoEnv.model;
      },
    },
  };
});

/**
 * O trio da transcrição, do jeito que o `env` o entrega.
 *
 * Sem argumento, é o default do schema (vazio) — o caso "não configurei
 * serviço nenhum", que segue transcrevendo pela chave da OpenAI.
 */
function comTranscricaoNoEnv(t: Partial<typeof transcricaoDoEnv> = {}): void {
  Object.assign(transcricaoDoEnv, { apiKey: "", baseUrl: "", model: "" }, t);
}

import { deriveMessageMedia } from "@/workers/media-derive-worker";
import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";
import type { Env } from "@/lib/env";

function eventRow(attempts = 0) {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "media.derive_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts,
  };
}

/** As deps que o worker montou, ou erro explícito se a derivação nem começou. */
function depsDaChamada(): DeriveDeps {
  const chamada = vi.mocked(deriveMediaText).mock.calls[0];
  if (!chamada) throw new Error("deriveMediaText não foi chamado: a derivação parou antes das deps");
  const deps = chamada[3];
  if (!deps) throw new Error("deriveMediaText foi chamado sem deps");
  return deps;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  comTranscricaoNoEnv();
  dns.erro = null;
  dns.resposta = [{ address: "93.184.216.34", family: 4 }];
  bindingDaVez = BINDING_COM_ENDPOINT;
  linhaDaMensagem = {
    id: "msg1",
    organization_id: "org1",
    type: "image",
    media_mime: "image/jpeg",
    media_storage_path: "org1/conv1/msg1.jpg",
    media_derived_status: null,
  };
  downloadMock.mockResolvedValue({ data: { arrayBuffer: async () => new ArrayBuffer(8) }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("worker de mídia: base_url do binding de visão (#855)", () => {
  it("repassa a base_url do binding para o factory do provedor", async () => {
    await deriveMessageMedia(eventRow());

    expect(vi.mocked(deriveMediaText)).toHaveBeenCalledWith(
      "image",
      expect.any(Buffer),
      "image/jpeg",
      expect.any(Object),
    );

    await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(factoryMock).toHaveBeenCalledWith(
      "chave-do-binding",
      "acme/visao-1",
      "https://gateway.interno.exemplo/v1",
    );
  });

  it("sem base_url no binding, o factory fica com o endpoint padrão do provedor", async () => {
    bindingDaVez = BINDING_SEM_ENDPOINT;

    await deriveMessageMedia(eventRow());
    await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(factoryMock).toHaveBeenCalledWith("chave-do-binding", "acme/visao-1", undefined);
  });

  it("usa o serviço de transcrição do .env, quando ele está configurado", async () => {
    comTranscricaoNoEnv({
      apiKey: "chave-do-servico",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3",
    });
    linhaDaMensagem = {
      ...linhaDaMensagem,
      type: "audio",
      media_mime: "audio/ogg",
      media_storage_path: "org1/conv1/msg1.ogg",
    };

    await deriveMessageMedia(eventRow());

    expect(provedorDeTranscricaoMock).toHaveBeenCalledWith({
      apiKey: "chave-do-servico",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3",
    });
  });

  it("recusa endereço de metadados no binding da visão e não manda a chave", async () => {
    bindingDaVez = { ...BINDING_COM_ENDPOINT, base_url: "http://169.254.169.254/v1" };

    await deriveMessageMedia(eventRow());
    const texto = await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(factoryMock).not.toHaveBeenCalled();
    expect(texto).toBeTruthy();
    const corpos = inboxInsertMock.mock.calls.map((c) =>
      String((c[0] as { body?: string } | undefined)?.body ?? ""),
    );
    expect(corpos.some((b) => b.includes("unsafe_url:private_host"))).toBe(true);
  });

  it("com endereço da organização e chave da INSTALAÇÃO, recusa antes de a chave sair", async () => {
    // `resolveOrgLlmConfig` devolve "chave-do-binding" neste arquivo. Igualando
    // a chave do .env a ela, reproduzimos o degrau real da escada de
    // credenciais: a organização não tem credencial própria e o worker cai na
    // chave da INSTALAÇÃO — enquanto o endereço continua sendo o que a
    // organização escolheu no painel. É a combinação que manda a chave que paga
    // a conta de todas as empresas para um endereço escolhido por uma delas.
    vi.stubEnv("OPENROUTER_API_KEY", "chave-do-binding");
    bindingDaVez = { ...BINDING_COM_ENDPOINT, base_url: "https://gateway.publico.exemplo/v1" };
    dns.resposta = [{ address: "93.184.216.34", family: 4 }];

    await deriveMessageMedia(eventRow());
    const texto = await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    // O endereço é público e passa no guarda de destino: quem recusa aqui é a
    // regra de credencial, não a de SSRF.
    expect(factoryMock).not.toHaveBeenCalled();
    expect(texto).toBeTruthy();
    const corpos = inboxInsertMock.mock.calls.map((c) =>
      String((c[0] as { body?: string } | undefined)?.body ?? ""),
    );
    expect(corpos.some((b) => b.includes("cadastre a chave da empresa"))).toBe(true);
  });

  it("com endereço da organização e credencial DELA, segue enviando", async () => {
    // O controle que separa "recusa a combinação errada" de "recusou tudo":
    // sem a chave da instalação no ambiente, a chave resolvida é a da
    // organização e o endereço próprio continua valendo — que é o recurso que
    // o #855 veio consertar.
    vi.stubEnv("OPENROUTER_API_KEY", "");
    bindingDaVez = { ...BINDING_COM_ENDPOINT, base_url: "https://gateway.publico.exemplo/v1" };
    dns.resposta = [{ address: "93.184.216.34", family: 4 }];

    await deriveMessageMedia(eventRow());
    await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(factoryMock).toHaveBeenCalledWith(
      "chave-do-binding",
      "acme/visao-1",
      "https://gateway.publico.exemplo/v1",
    );
  });

  it("recusa nome de aparência pública que resolve para IP interno", async () => {
    bindingDaVez = { ...BINDING_COM_ENDPOINT, base_url: "https://coletor.exemplo/v1" };
    dns.resposta = [{ address: "10.1.2.3", family: 4 }];

    await deriveMessageMedia(eventRow());
    const texto = await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(factoryMock).not.toHaveBeenCalled();
    expect(texto).toBeTruthy();
    const corpos = inboxInsertMock.mock.calls.map((c) =>
      String((c[0] as { body?: string } | undefined)?.body ?? ""),
    );
    expect(corpos.some((b) => b.includes("unsafe_url:private_ip"))).toBe(true);
  });

  it("não manda a chave do serviço de transcrição para endereço interno", async () => {
    comTranscricaoNoEnv({
      apiKey: "chave-do-servico",
      baseUrl: "http://169.254.169.254/v1",
    });

    await deriveMessageMedia(eventRow());
    const texto = await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(transcribeDoSvcMock).not.toHaveBeenCalled();
    expect(texto).not.toContain("transcrição de mentira");
    const corpos = inboxInsertMock.mock.calls.map((c) =>
      String((c[0] as { body?: string } | undefined)?.body ?? ""),
    );
    expect(corpos.some((b) => b.includes("unsafe_url:private_host"))).toBe(true);
  });

  it("segue transcrevendo no serviço quando o endereço é aceito", async () => {
    comTranscricaoNoEnv({
      apiKey: "chave-do-servico",
      baseUrl: "https://api.groq.com/openai/v1",
    });

    await deriveMessageMedia(eventRow());
    const texto = await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(transcribeDoSvcMock).toHaveBeenCalledTimes(1);
    expect(texto).toBe("transcrição de mentira");
  });

  it("a chave só no ambiente não liga mais o serviço: a régua é o `env` (#964)", async () => {
    // Sabotagem: o `process.env` tem o trio inteiro, e é ele que a leitura ANTES
    // desta correção consultava — o serviço seria chamado com a chave e o
    // endereço crus. Agora quem responde é o `env` (o schema do app), e o
    // default dele é vazio: a transcrição segue pelo caminho de sempre.
    vi.stubEnv("TRANSCRIPTION_API_KEY", "chave-só-no-ambiente");
    vi.stubEnv("TRANSCRIPTION_BASE_URL", "https://api.groq.com/openai/v1");
    vi.stubEnv("TRANSCRIPTION_MODEL", "whisper-large-v3");
    comTranscricaoNoEnv();
    linhaDaMensagem = {
      ...linhaDaMensagem,
      type: "audio",
      media_mime: "audio/ogg",
      media_storage_path: "org1/conv1/msg1.ogg",
    };

    await deriveMessageMedia(eventRow());

    expect(provedorDeTranscricaoMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "chave-só-no-ambiente" }),
    );
    expect(provedorDeTranscricaoMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://api.groq.com/openai/v1" }),
    );
  });
});
