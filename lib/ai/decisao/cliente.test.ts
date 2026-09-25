/**
 * O CLIENTE DO SYSTEM ONE NUNCA LANÇA — e isso é o contrato, não um detalhe.
 *
 * Toda decisão que passa por aqui tem um caminho atual do lado (regex, heurística,
 * LLM). Se o cliente lançasse, cada call site precisaria lembrar de um try/catch, e
 * o primeiro que esquecesse derrubaria um turno de atendimento por causa de um
 * fornecedor em early access. Devolvendo `{ ok: false, motivo }`, o compilador
 * obriga quem chama a tratar a ausência de resposta — o fallback deixa de depender
 * de disciplina.
 *
 * O `motivo` é tipado porque ele vira `llm_calls.error_code`. E a falha carrega
 * dois eixos: `exigeAcao` (não passa sozinho — chave recusada, sem crédito,
 * pergunta ruim) e `defeitoNosso` (só a pergunta ruim). Silenciar os primeiros
 * junto com a indisponibilidade passageira transformaria uma chave revogada em
 * degradação permanente e invisível.
 */
import { describe, expect, it, vi } from "vitest";

// A base vem de `env`; este mock é quem decide se a variável existe em cada
// caso, para o `.env` de quem roda o teste não mandar no resultado.
const envMock = vi.hoisted(() => ({ JEV_API_BASE_URL: "" as string | undefined }));
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));

import { decidir, MODELO_DO_JEV, TETO_PADRAO_MS } from "@/lib/ai/decisao/cliente";

const CHAVE = "tsk_teste";
const PERGUNTAS = {
  clima: { tipo: "score", instrucao: "Qual o clima?", criterios: ["péssimo", "neutro", "ótimo"] },
} as const;

function respostaHttp(status: number, corpo: unknown, cabecalhos: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json", ...cabecalhos },
  });
}

const CORPO_OK = {
  model: "jev-1.13.0",
  answers: {
    clima: {
      type: "score",
      score: 1.4,
      legend: { "0": "péssimo", "1": "neutro", "2": "ótimo" },
      probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 },
      confidence: 0.82,
    },
  },
  usage: { input_tokens: 412, output_tokens: 0 },
};

describe("cliente do System One", () => {
  it("monta a requisição no contrato do fornecedor", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respostaHttp(200, CORPO_OK));
    await decidir(
      { chave: CHAVE, estado: "cliente disse: adorei!", perguntas: PERGUNTAS },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${CHAVE}`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // A versão FIXADA, nunca o apelido móvel: o limiar de passagem para humano
    // foi calibrado sobre ela, e o apelido anda sozinho.
    expect(body.model).toBe("jev-1.13.0");
    expect(MODELO_DO_JEV).toBe("jev-1.13.0");
    expect(body.state).toBe("cliente disse: adorei!");
    expect(body.questions).toEqual({
      clima: { type: "score", instructions: "Qual o clima?", criteria: ["péssimo", "neutro", "ótimo"] },
    });
  });

  it("devolve a resposta tipada, com o uso para a telemetria", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respostaHttp(200, CORPO_OK));
    const r = await decidir({ chave: CHAVE, estado: "x", perguntas: PERGUNTAS }, { fetchImpl });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const clima = r.respostas.clima;
    expect(clima?.tipo).toBe("score");
    if (clima?.tipo !== "score") return;
    expect(clima.score).toBe(1.4);
    expect(clima.confianca).toBe(0.82);
    expect(r.uso).toEqual({ tokensDeEntrada: 412, tokensDeSaida: 0 });
    expect(r.modelo, "a versão que DE FATO respondeu vai à telemetria").toBe("jev-1.13.0");
  });

  it.each([
    // status, motivo, exigeAcao, defeitoNosso
    [401, "credencial_invalida", true, false],
    [403, "credencial_invalida", true, false],
    [402, "sem_credito", true, false],
    // 4xx que o fornecedor não documenta conta como crédito: o contrato só diz
    // que ele "pode recusar gerar", sem dizer com que status.
    [404, "sem_credito", true, false],
    [400, "contrato_invalido", true, true],
    [422, "contrato_invalido", true, true],
    [429, "limite_de_taxa", false, false],
    [529, "provedor_sobrecarregado", false, false],
    [500, "provedor_indisponivel", false, false],
    [503, "provedor_indisponivel", false, false],
  ] as const)(
    "HTTP %i não lança — motivo %s, exigeAcao %s, defeitoNosso %s",
    async (status, motivo, exigeAcao, defeitoNosso) => {
      const fetchImpl = vi.fn().mockResolvedValue(respostaHttp(status, { error: "x" }));
      const r = await decidir({ chave: CHAVE, estado: "x", perguntas: PERGUNTAS }, { fetchImpl });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.motivo).toBe(motivo);
      expect(r.exigeAcao).toBe(exigeAcao);
      expect(r.defeitoNosso).toBe(defeitoNosso);
      expect(r.status).toBe(status);
    },
  );

  it("o 401 NÃO é defeito nosso: chave revogada é ação do operador", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respostaHttp(401, {}));
    const r = await decidir({ chave: CHAVE, estado: "x", perguntas: PERGUNTAS }, { fetchImpl });
    expect(r.ok === false && r.defeitoNosso).toBe(false);
    expect(r.ok === false && r.exigeAcao).toBe(true);
  });

  it("repassa o retry-after (segundos) para o disjuntor", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respostaHttp(429, {}, { "retry-after": "30" }));
    const r = await decidir({ chave: CHAVE, estado: "x", perguntas: PERGUNTAS }, { fetchImpl });
    expect(r.ok === false && r.retryAfterMs).toBe(30_000);
  });

  it("repassa o retry-after em data HTTP", async () => {
    const daqui = new Date(Date.now() + 60_000).toUTCString();
    const fetchImpl = vi.fn().mockResolvedValue(respostaHttp(429, {}, { "retry-after": daqui }));
    const r = await decidir({ chave: CHAVE, estado: "x", perguntas: PERGUNTAS }, { fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // A data HTTP tem resolução de segundo: entre 58 e 60 s a partir de agora.
    expect(r.retryAfterMs).toBeGreaterThan(58_000);
    expect(r.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("sem retry-after, não inventa espera", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respostaHttp(429, {}));
    const r = await decidir({ chave: CHAVE, estado: "x", perguntas: PERGUNTAS }, { fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.retryAfterMs).toBeUndefined();
  });

  it("fornecedor lento é cortado no teto padrão de 1,5 s", async () => {
    expect(TETO_PADRAO_MS).toBe(1_500);
    vi.useFakeTimers();
    try {
      // O dublê só responde quando o sinal aborta — um fetch que nunca volta.
      const fetchImpl = vi.fn(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const promessa = decidir({ chave: CHAVE, estado: "x", perguntas: PERGUNTAS }, { fetchImpl });
      await vi.advanceTimersByTimeAsync(1_499);
      let terminou = false;
      void promessa.then(() => {
        terminou = true;
      });
      await Promise.resolve();
      expect(terminou, "não pode desistir antes do teto").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const r = await promessa;
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.motivo).toBe("provedor_indisponivel");
      expect(r.exigeAcao, "lentidão passa sozinha").toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a base da API vem da instalação (o dublê do e2e), e vazio vale o padrão", async () => {
    envMock.JEV_API_BASE_URL = "http://127.0.0.1:4010/";
    try {
      const fetchImpl = vi.fn().mockResolvedValue(respostaHttp(200, CORPO_OK));
      await decidir({ chave: CHAVE, estado: "x", perguntas: PERGUNTAS }, { fetchImpl });
      expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://127.0.0.1:4010/v1/systemone");
    } finally {
      envMock.JEV_API_BASE_URL = "";
    }
    const fetchImpl = vi.fn().mockResolvedValue(respostaHttp(200, CORPO_OK));
    await decidir({ chave: CHAVE, estado: "x", perguntas: PERGUNTAS }, { fetchImpl });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.typesafe.ai/v1/systemone");
  });

  it("falha de rede não lança", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const r = await decidir({ chave: CHAVE, estado: "x", perguntas: PERGUNTAS }, { fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("provedor_indisponivel");
  });

  it("corpo fora do contrato não lança e não inventa resposta", async () => {
    // O fornecedor promete "zero type errors by construction". Isso vale para o
    // modelo, não para a rede: um proxy, uma página de erro em HTML ou uma versão
    // nova do contrato chegam aqui igual. Confiar na promessa é o mesmo erro de
    // confiar em saída de LLM sem validar.
    const fetchImpl = vi.fn().mockResolvedValue(respostaHttp(200, { answers: { clima: { type: "?" } } }));
    const r = await decidir({ chave: CHAVE, estado: "x", perguntas: PERGUNTAS }, { fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("resposta_ilegivel");
  });

  it("200 com página HTML (proxy) é resposta ilegível, não 'fora do ar'", async () => {
    // "Fora do ar" diz "costuma se resolver sozinho"; um proxy que responde HTML
    // não passa sozinho.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const r = await decidir({ chave: CHAVE, estado: "x", perguntas: PERGUNTAS }, { fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("resposta_ilegivel");
    expect(r.status).toBe(200);
  });

  it("sem chave, nem sai da máquina", async () => {
    const fetchImpl = vi.fn();
    const r = await decidir({ chave: "", estado: "x", perguntas: PERGUNTAS }, { fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("sem_credencial");
    expect(fetchImpl, "sem credencial não se gasta requisição").not.toHaveBeenCalled();
  });

  it("o 422 é defeito nosso; a sobrecarga do fornecedor não é", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respostaHttp(422, { error: "malformed" }));
    const r = await decidir({ chave: CHAVE, estado: "x", perguntas: PERGUNTAS }, { fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.defeitoNosso, "422 sinaliza pergunta malformada nossa").toBe(true);

    const indisponivel = await decidir(
      { chave: CHAVE, estado: "x", perguntas: PERGUNTAS },
      { fetchImpl: vi.fn().mockResolvedValue(respostaHttp(529, {})) },
    );
    expect(indisponivel.ok).toBe(false);
    if (indisponivel.ok) return;
    expect(indisponivel.defeitoNosso).toBe(false);
  });
});
