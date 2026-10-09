import { afterEach, describe, expect, it, vi } from "vitest";

import { CONVERSAS_IGNORADAS, WahaClient } from "@/lib/waha/client";

/**
 * A SESSÃO NASCIA SEM O ACERVO — e o histórico do número não tinha por onde chegar.
 *
 * ─── O que se mediu (issue #999) ────────────────────────────────────────────
 *
 * Numa instalação real, um número vinculado pelo CRM produziu 3 conversas no
 * inbox e um `store.sqlite3` de 1 MB; a mesma vinculação com o acervo pedido
 * trouxe 825 conversas e 57 MB. O que chegava era só o que acontecia depois da
 * vinculação: o passado do número ficava no aparelho.
 *
 * ─── Por que o teste olha o CORPO ENVIADO ───────────────────────────────────
 *
 * `store` não é campo nosso: é um pedido ao canal, e a única prova de que o
 * pedido foi feito é o corpo que sai de `lib/waha/client.ts` na criação da
 * sessão. O padrão da engine é `store { enabled: false, fullSync: false }` e
 * não existe variável de ambiente que o mude — quem não pede, não tem. Por
 * isso `fullSync` está na asserção junto: ligar só `enabled` deixaria o
 * passado de fora, o mesmo defeito com outra roupa.
 *
 * ─── Desligado por padrão: a decisão do mantenedor está no teste também ─────
 *
 * A #999 reabriu com a decisão "desligado por padrão, com opção por conexão"
 * (comentário do mantenedor na issue). Então o teste tem DUAS asserções de
 * corpo, e não uma: com a opção ligada o `noweb.store` tem de estar lá (é o
 * defeito do título), e sem ela o corpo tem de continuar sendo o de sempre —
 * sem esta, o conserto viraria ligar o acervo de todo mundo, que é
 * exatamente o que o #1000 fez e o #1021 desfez.
 *
 * ─── A CLASSE: ligar depois não pode apagar o resto da config ───────────────
 *
 * `convergirConfigDaSessao` faz PUT, e o PUT de sessão do canal "updates a
 * session with a FULL new configuration" — troca a config inteira. Gravar o
 * acervo em cima disso tem de preservar filtro e `webhooks`, e desligar tem de
 * fazer o mesmo caminho. Um PUT que reescrevesse a config a partir do que ele
 * mesmo quer derrubaria o webhook e deixaria a sessão de pé sem entregar
 * mensagem nenhuma — a pior forma de falhar, porque nada fica vermelho.
 */
interface Chamada {
  metodo: string;
  caminho: string;
  corpo: Record<string, unknown> | null;
}

/** A sessão que o dublê "tem" do lado do canal. `null` = ainda não existe. */
interface SessaoDoDuble {
  name: string;
  status: string;
  engine: string;
  config: Record<string, unknown> | null;
}

/**
 * Dublê do canal que guarda o que recebeu. Sem estado, o encadeamento
 * criação → verificação → start de uma sessão existente não teria como ser
 * exercitado: o GET devolveria sempre a mesma coisa e o PUT não teria efeito.
 */
function instrumentarWaha(inicial: SessaoDoDuble | null) {
  let sessao = inicial;
  const chamadas: Chamada[] = [];

  const corpo = (init?: RequestInit): Record<string, unknown> | null =>
    init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;

  const fetchFalso = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const caminho = new URL(String(url)).pathname;
    const metodo = (init?.method ?? "GET").toUpperCase();
    const enviado = corpo(init);
    chamadas.push({ metodo, caminho, corpo: enviado });

    const responder = (status: number, dados: unknown) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => dados }) as unknown as Response;

    if (metodo === "POST" && caminho === "/api/sessions") {
      if (sessao) {
        return responder(422, {
          statusCode: 422,
          error: "Unprocessable Entity",
          message: `Session '${sessao.name}' already exists. Use PUT to update it.`,
        });
      }
      sessao = {
        name: String(enviado?.name ?? ""),
        status: "SCAN_QR_CODE",
        engine: "NOWEB",
        config: (enviado?.config as Record<string, unknown> | undefined) ?? null,
      };
      return responder(201, sessao);
    }

    if (metodo === "GET" && caminho.startsWith("/api/sessions/")) {
      if (!sessao) return responder(404, { statusCode: 404, error: "Not Found", message: "Session not found" });
      return responder(200, sessao);
    }

    if (metodo === "PUT" && caminho.startsWith("/api/sessions/")) {
      if (!sessao) return responder(404, { statusCode: 404, error: "Not Found", message: "Session not found" });
      sessao = { ...sessao, config: (enviado?.config as Record<string, unknown> | undefined) ?? null };
      return responder(200, sessao);
    }

    if (metodo === "POST" && caminho.endsWith("/start")) {
      if (!sessao) return responder(404, { statusCode: 404, error: "Not Found", message: "Session not found" });
      sessao = { ...sessao, status: "WORKING" };
      return responder(200, sessao);
    }

    return responder(500, { erro: `rota não dublada: ${metodo} ${caminho}` });
  });

  vi.stubGlobal("fetch", fetchFalso);
  return { chamadas, sessaoAtual: () => sessao };
}

const CLIENTE = () => new WahaClient("http://canal.local", "chave-de-teste");
const ACERVO = { store: { enabled: true, fullSync: true } };
const ACERVO_DESLIGADO = { store: { enabled: false, fullSync: false } };
const WEBHOOKS = [{ url: "https://crm.local/webhook", events: ["message.any"] }];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a criação da sessão do WhatsApp", () => {
  it("COM a opção ligada, o corpo leva o acervo do histórico junto com o filtro", async () => {
    const { chamadas } = instrumentarWaha(null);

    await CLIENTE().startSession("s1", { guardarHistorico: true });

    const criacao = chamadas.find((c) => c.metodo === "POST" && c.caminho === "/api/sessions");
    expect(criacao?.corpo?.config).toEqual({
      ignore: CONVERSAS_IGNORADAS,
      noweb: ACERVO,
    });
  });

  it("SEM a opção (padrão), o corpo continua sem store nenhum — a decisão da #999", async () => {
    const { chamadas } = instrumentarWaha(null);

    await CLIENTE().startSession("s1");

    const criacao = chamadas.find((c) => c.metodo === "POST" && c.caminho === "/api/sessions");
    expect(criacao?.corpo?.config).toEqual({ ignore: CONVERSAS_IGNORADAS });
    expect(JSON.stringify(criacao?.corpo)).not.toContain("noweb");
  });

  it("o createSession direto também leva o acervo quando a conexão pediu", async () => {
    const { chamadas } = instrumentarWaha(null);

    await CLIENTE().createSession("s2", { guardarHistorico: true });

    const criacao = chamadas.find((c) => c.metodo === "POST" && c.caminho === "/api/sessions");
    expect((criacao?.corpo?.config as Record<string, unknown>)?.noweb).toEqual(ACERVO);
  });
});

describe("ligar (e desligar) depois, sem desconectar", () => {
  it("a convergência grava o store na sessão que já existe e preserva o resto da config", async () => {
    // Sessão já pareada, filtro já correto, SEM acervo: é todo número que o
    // operador quer ligar depois. O filtro certo não pode ser desculpa para não
    // fazer o PUT — é justamente o caso em que ele precisa acontecer.
    const { chamadas } = instrumentarWaha({
      name: "s1",
      status: "WORKING",
      engine: "NOWEB",
      config: { ignore: CONVERSAS_IGNORADAS, webhooks: WEBHOOKS },
    });

    const aplicou = await CLIENTE().convergirConfigDaSessao("s1", { guardarHistorico: true });

    expect(aplicou).toBe(true);
    const put = chamadas.find((c) => c.metodo === "PUT");
    expect(put?.corpo?.config).toEqual({
      ignore: CONVERSAS_IGNORADAS,
      noweb: ACERVO,
      webhooks: WEBHOOKS,
    });
  });

  it("desligar depois (false EXPLÍCITO, o PATCH da tela) tira o acervo pelo mesmo caminho, sem apagar filtro nem webhook", async () => {
    const { chamadas } = instrumentarWaha({
      name: "s1",
      status: "WORKING",
      engine: "NOWEB",
      config: { ignore: CONVERSAS_IGNORADAS, noweb: ACERVO, webhooks: WEBHOOKS },
    });

    const aplicou = await CLIENTE().convergirConfigDaSessao("s1", { guardarHistorico: false });

    expect(aplicou).toBe(true);
    const put = chamadas.find((c) => c.metodo === "PUT");
    expect(put?.corpo?.config).toEqual({
      ignore: CONVERSAS_IGNORADAS,
      noweb: ACERVO_DESLIGADO,
      webhooks: WEBHOOKS,
    });
  });

  it("quem está com o acervo ligado e reconecta NÃO leva um PUT à toa (sem restart)", async () => {
    const { chamadas } = instrumentarWaha({
      name: "s1",
      status: "STOPPED",
      engine: "NOWEB",
      config: { ignore: CONVERSAS_IGNORADAS, noweb: ACERVO },
    });

    const resultado = await CLIENTE().startSession("s1", { guardarHistorico: true });

    expect(resultado.status).toBe("WORKING");
    expect(chamadas.some((c) => c.metodo === "PUT")).toBe(false);
  });

  it("quem nunca ligou nada continua subindo sem PUT — número pareado não é afetado", async () => {
    const { chamadas } = instrumentarWaha({
      name: "s1",
      status: "STOPPED",
      engine: "NOWEB",
      config: { ignore: CONVERSAS_IGNORADAS },
    });

    const resultado = await CLIENTE().startSession("s1");

    expect(resultado.status).toBe("WORKING");
    expect(chamadas.some((c) => c.metodo === "PUT")).toBe(false);
  });

  it("a opção ligada num número já pareado chega pelo start, mesmo com o filtro certo", async () => {
    const { chamadas } = instrumentarWaha({
      name: "s1",
      status: "STOPPED",
      engine: "NOWEB",
      config: { ignore: CONVERSAS_IGNORADAS, webhooks: WEBHOOKS },
    });

    const resultado = await CLIENTE().startSession("s1", { guardarHistorico: true });

    expect(resultado.status).toBe("WORKING");
    const put = chamadas.find((c) => c.metodo === "PUT");
    expect(put?.corpo?.config).toEqual({
      ignore: CONVERSAS_IGNORADAS,
      noweb: ACERVO,
      webhooks: WEBHOOKS,
    });
  });
});

describe("sem a opção, o store fica como o canal o encontrou", () => {
  // A reconexão de quem NÃO tem `metadata.guardar_historico` chama startSession
  // sem a opção. A sessão pode ter o store ligado por fora — o repórter da #999
  // mediu assim, a janela do #1000 criou assim, o painel do canal liga assim. A
  // doc do NOWEB: "Do not change the values after you scanned QR, it can lead
  // to the loss of the chat history". Ausente não é `false`: só a tela desliga.
  it("store ligado por fora + reconexão sem a opção = nenhum PUT", async () => {
    const { chamadas } = instrumentarWaha({
      name: "s1",
      status: "STOPPED",
      engine: "NOWEB",
      config: { ignore: CONVERSAS_IGNORADAS, noweb: ACERVO },
    });

    const resultado = await CLIENTE().startSession("s1");

    expect(resultado.status).toBe("WORKING");
    expect(chamadas.some((c) => c.metodo === "PUT")).toBe(false);
  });

  it("sessão legada sem filtro + store ligado por fora: o PUT grava o filtro e preserva o store", async () => {
    const { chamadas } = instrumentarWaha({
      name: "s1",
      status: "STOPPED",
      engine: "NOWEB",
      config: { noweb: ACERVO, webhooks: WEBHOOKS },
    });

    await CLIENTE().startSession("s1");

    const put = chamadas.find((c) => c.metodo === "PUT");
    expect(put?.corpo?.config).toEqual({ ignore: CONVERSAS_IGNORADAS, noweb: ACERVO, webhooks: WEBHOOKS });
  });
});
