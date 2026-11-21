/**
 * O comportamento da janela do chat no site (`public/webchat-janela.js`, spec 36, F2, Task 5).
 *
 * O arquivo é JavaScript de navegador, sem módulo. Carregado com `createRequire`, expõe as
 * funções por `module.exports` e NÃO se inicia sozinho. O teste de tela monta a estrutura de
 * `lib/channels/webchat/janela-html.ts` no jsdom (ambiente padrão deste repositório) e dirige
 * `iniciar` com um `fetch` falso.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Modulo {
  aceitarMensagemDoPai: (evento: unknown, pai?: unknown) => boolean;
  montarMensagem: (
    texto: string,
    anterior?: { id: string; texto: string },
  ) => { ok: boolean; id?: string; texto?: string; motivo?: string };
  lerEventos: (
    leitor: { read: () => Promise<{ done: boolean; value?: unknown }> },
    aoEvento: (ev: { evento: string; dados: string }) => void,
  ) => Promise<void>;
  validarColeta: unknown;
  normalizarContexto: unknown;
  iniciar: (opcoes: Record<string, unknown>) => unknown;
}

const requerer = createRequire(import.meta.url);
const CAMINHO = fileURLToPath(new URL("../../public/webchat-janela.js", import.meta.url));
const modulo = requerer(CAMINHO) as Modulo;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("aceitarMensagemDoPai", () => {
  it("aceita só a mensagem do pai com tipo contexto", () => {
    expect(modulo.aceitarMensagemDoPai({ source: window.parent, data: { tipo: "contexto" } })).toBe(
      true,
    );
  });

  it("recusa source que não é o pai", () => {
    expect(modulo.aceitarMensagemDoPai({ source: {}, data: { tipo: "contexto" } })).toBe(false);
  });

  it("recusa outro tipo vindo do pai, ou sem dados", () => {
    expect(
      modulo.aceitarMensagemDoPai({ source: window.parent, data: { tipo: "nao-lidas", n: 1 } }),
    ).toBe(false);
    expect(modulo.aceitarMensagemDoPai({ source: window.parent, data: null })).toBe(false);
  });
});

describe("montarMensagem", () => {
  it("gera um mensagem_id UUID v4 novo para cada texto", () => {
    const a = modulo.montarMensagem("oi");
    const b = modulo.montarMensagem("tudo bem");
    expect(a.ok).toBe(true);
    expect(a.id).toMatch(UUID_V4);
    expect(b.id).toMatch(UUID_V4);
    expect(a.id).not.toBe(b.id);
  });

  it("apara o texto e recusa vazio", () => {
    const r = modulo.montarMensagem("   ");
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("vazio");
    expect(modulo.montarMensagem("  oi  ").texto).toBe("oi");
  });

  it("recusa texto acima de 2000 caracteres e aceita exatamente 2000", () => {
    expect(modulo.montarMensagem("a".repeat(2001)).motivo).toBe("longo");
    expect(modulo.montarMensagem("a".repeat(2000)).ok).toBe(true);
  });

  it("reaproveita o mensagem_id no reenvio da mesma mensagem, e não em outra", () => {
    const primeira = modulo.montarMensagem("oi");
    const reenvio = modulo.montarMensagem(" oi ", { id: primeira.id!, texto: "oi" });
    expect(reenvio.id).toBe(primeira.id);
    const outra = modulo.montarMensagem("outra", { id: primeira.id!, texto: "oi" });
    expect(outra.id).not.toBe(primeira.id);
  });
});

describe("lerEventos", () => {
  function leitorDe(pedacos: string[]) {
    let i = 0;
    return {
      read: () =>
        Promise.resolve(
          i < pedacos.length ? { done: false, value: pedacos[i++] } : { done: true, value: undefined },
        ),
    };
  }

  it("junta um evento cortado no meio entre dois pedaços", async () => {
    const recebidos: Array<{ evento: string; dados: string }> = [];
    await modulo.lerEventos(
      leitorDe(['event: mensagem\ndata: {"id":"1",', '"texto":"oi"}\n', "\n"]),
      (ev) => recebidos.push(ev),
    );
    expect(recebidos).toEqual([{ evento: "mensagem", dados: '{"id":"1","texto":"oi"}' }]);
  });

  it("entrega cada evento uma vez e ignora comentário", async () => {
    const recebidos: Array<{ evento: string; dados: string }> = [];
    await modulo.lerEventos(
      leitorDe([
        ': conectado\n\nevent: mensagem\ndata: {"id":"a"}\n\nevent: mensagem\ndata: {"id":"b"}\n\n: ping\n\n',
      ]),
      (ev) => recebidos.push(ev),
    );
    expect(recebidos.map((ev) => ev.dados)).toEqual(['{"id":"a"}', '{"id":"b"}']);
  });
});

// ---------- A janela no DOM ----------

const FIXTURE = `
<div id="webchat-app">
<header class="cabecalho"><div class="marca"><strong>Loja</strong><span>Atendimento</span></div></header>
<main id="webchat-mensagens" class="mensagens" aria-live="polite"></main>
<footer class="rodape">
<p class="aviso"></p>
<form id="webchat-form" class="entrada">
<input id="webchat-texto" type="text" maxlength="2000" autocomplete="off" aria-label="Mensagem">
<button id="webchat-enviar" type="submit">Enviar</button>
</form>
</footer>
</div>
<script type="application/json" id="webchat-config"></script>`;

const CONFIG_PADRAO = {
  chave: "wck_teste",
  titulo: "Atendimento",
  saudacao: "Olá!",
  cor: "#123456",
  coleta: { nome: "obrigatorio", telefone: "opcional", email: "oculto" },
  versaoDoAviso: "v1",
  controlador: { razaoSocial: "Loja Exemplo Ltda", politicaUrl: "https://loja.exemplo.com.br/privacidade" },
};

const SOMENTE_CONVERSA = {
  ...CONFIG_PADRAO,
  coleta: { nome: "oculto", telefone: "oculto", email: "oculto" },
};

interface Chamada {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

function json(status: number, corpo: unknown, cabecalhos: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (nome: string) => cabecalhos[nome] ?? null },
    json: () => Promise.resolve(corpo),
    body: null,
  };
}

function stream(pedacos: string[]) {
  let i = 0;
  const leitor = {
    read: () =>
      Promise.resolve(
        i < pedacos.length ? { done: false, value: pedacos[i++] } : { done: true, value: undefined },
      ),
  };
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: () => Promise.resolve(null),
    body: { getReader: () => leitor },
  };
}

/** Roteia as rotas da janela. `mensagens` decide a resposta de cada envio (n = 1, 2, ...). */
function roteador(
  mensagens?: (corpo: { mensagem_id: string }, n: number) => unknown,
  eventos: string[] = [],
) {
  const chamadas: Chamada[] = [];
  let n = 0;
  const fn = (url: string, init: Chamada["init"] = {}) => {
    chamadas.push({ url, init });
    if (url.endsWith("/sessao")) {
      return Promise.resolve(json(200, { data: { token: "T1", visitante_id: "v1", configuracao: {} } }));
    }
    if (url.endsWith("/eventos")) return Promise.resolve(stream(eventos));
    if (url.endsWith("/mensagens")) {
      const corpo = JSON.parse(String(init.body)) as { mensagem_id: string };
      n += 1;
      return Promise.resolve(
        mensagens
          ? mensagens(corpo, n)
          : json(201, { data: { mensagem_id: corpo.mensagem_id, status: "queued" } }),
      );
    }
    return Promise.reject(new Error("rota inesperada: " + url));
  };
  return { fn, chamadas };
}

function memoria() {
  const mapa = new Map<string, string>();
  return {
    mapa,
    getItem: (k: string) => mapa.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mapa.set(k, v);
    },
    removeItem: (k: string) => {
      mapa.delete(k);
    },
  };
}

const esperarTudo = () => new Promise<void>((r) => setTimeout(r, 0));

/** Troca o conteúdo do body por um fixture estático, sem passar pela propriedade de HTML bruto. */
function montarDom(html: string) {
  const fixture = new DOMParser().parseFromString(html, "text/html");
  document.body.textContent = "";
  Array.from(fixture.body.childNodes).forEach((no) => document.body.appendChild(document.importNode(no, true)));
}

async function abrirJanela(
  fetchFn: (url: string, init?: Chamada["init"]) => Promise<unknown>,
  config: Record<string, unknown> = CONFIG_PADRAO,
  extras: Record<string, unknown> = {},
) {
  montarDom(FIXTURE);
  document.getElementById("webchat-config")!.textContent = JSON.stringify(config);
  const agendados: number[] = [];
  const pai = { postMessage: vi.fn() };
  const armazenamento = memoria();
  modulo.iniciar({
    documento: document,
    janela: window,
    pai,
    fetch: fetchFn,
    agendar: (_fn: () => void, ms: number) => {
      agendados.push(ms);
    },
    armazenamento,
    caminho: "/chat/wck_teste",
    ...extras,
  });
  await esperarTudo();
  return { pai, armazenamento, agendados };
}

function botao(texto: string): HTMLButtonElement {
  const achado = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === texto,
  );
  if (!achado) throw new Error("botão ausente: " + texto);
  return achado;
}

function digitarEEnviar(texto: string) {
  const campo = document.getElementById("webchat-texto") as HTMLInputElement;
  campo.value = texto;
  campo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

function corposDeMensagens(chamadas: Chamada[]) {
  return chamadas
    .filter((c) => c.url.endsWith("/mensagens"))
    .map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);
}

describe("janela no DOM", () => {
  beforeEach(() => {
    document.body.textContent = "";
  });

  afterEach(() => {
    document.body.textContent = "";
  });

  it("texto de resposta com <img onerror> aparece como texto, sem elemento filho", async () => {
    const malicioso = JSON.stringify({
      id: "m1",
      texto: "<img src=x onerror=alert(1)>",
      em: "2026-11-21T10:00:00Z",
    });
    const r = roteador(undefined, [`event: mensagem\ndata: ${malicioso}\n\n`]);
    await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();

    const texto = Array.from(document.querySelectorAll(".msg-texto")).find(
      (p) => p.textContent === "<img src=x onerror=alert(1)>",
    );
    expect(texto).toBeDefined();
    expect(texto!.children.length).toBe(0);
    expect(document.querySelector("img")).toBeNull();
  });

  it("sem localStorage (lança) a janela continua funcionando", async () => {
    const quebrado = {
      getItem: () => {
        throw new Error("negado");
      },
      setItem: () => {
        throw new Error("negado");
      },
      removeItem: () => {
        throw new Error("negado");
      },
    };
    const r = roteador();
    await abrirJanela(r.fn, CONFIG_PADRAO, { armazenamento: quebrado });
    expect(botao("Aceitar e continuar")).toBeDefined();
  });

  it("sessão com 404 mostra Chat indisponível e não reconecta", async () => {
    const chamadas: string[] = [];
    const { agendados } = await abrirJanela((url) => {
      chamadas.push(url);
      return Promise.resolve(json(404, { error: { code: "not_found", message: "Not found." } }));
    });

    expect(document.body.textContent).toContain("Chat indisponível");
    expect(agendados).toHaveLength(0);
    expect(chamadas.filter((u) => u.endsWith("/sessao"))).toHaveLength(1);
  });

  it("campo obrigatório vazio impede o envio e mostra o aviso", async () => {
    const r = roteador();
    await abrirJanela(r.fn);
    botao("Aceitar e continuar").click();
    await esperarTudo();

    const form = document.querySelector("form.coleta") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await esperarTudo();

    expect(corposDeMensagens(r.chamadas)).toHaveLength(0);
    expect(document.body.textContent).toContain("Informe seu nome.");
  });

  it("campo oculto não aparece no formulário de coleta", async () => {
    const r = roteador();
    await abrirJanela(r.fn);
    botao("Aceitar e continuar").click();
    await esperarTudo();

    expect(document.querySelector('input[name="email"]')).toBeNull();
    expect(document.querySelector('input[name="nome"]')).not.toBeNull();
    expect(document.querySelector('input[name="telefone"]')).not.toBeNull();
  });

  it("a primeira mensagem leva aceite e contato, e a segunda não leva nenhum dos dois", async () => {
    const r = roteador();
    await abrirJanela(r.fn);
    botao("Aceitar e continuar").click();
    await esperarTudo();

    (document.querySelector('input[name="nome"]') as HTMLInputElement).value = "Ana";
    (document.querySelector('input[name="telefone"]') as HTMLInputElement).value = "+55 11 99999-9999";
    (document.querySelector("form.coleta") as HTMLFormElement).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await esperarTudo();

    digitarEEnviar("Oi");
    await esperarTudo();
    digitarEEnviar("Tudo bem?");
    await esperarTudo();

    const [primeira, segunda] = corposDeMensagens(r.chamadas);
    expect(primeira.aceite).toEqual({ versao: "v1" });
    expect(primeira.contato).toEqual({ nome: "Ana", telefone: "+5511999999999" });
    expect(segunda.aceite).toBeUndefined();
    expect(segunda.contato).toBeUndefined();
  });

  it("422 na primeira mensagem mostra a orientação e o reenvio usa o MESMO mensagem_id", async () => {
    const r = roteador((_corpo, n) =>
      n === 1
        ? json(422, { error: { code: "validation_failed", message: "Dados inválidos." } })
        : json(201, { data: { mensagem_id: "x", status: "queued" } }),
    );
    await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();

    digitarEEnviar("Oi");
    await esperarTudo();
    expect(document.body.textContent).toContain("Confira os dados e tente de novo.");

    digitarEEnviar("Oi");
    await esperarTudo();

    const [primeira, reenvio] = corposDeMensagens(r.chamadas);
    expect(reenvio.mensagem_id).toBe(primeira.mensagem_id);
    expect(reenvio.aceite).toEqual({ versao: "v1" });
  });

  it("token_novo substitui o token usado na requisição seguinte", async () => {
    const r = roteador((corpo, n) =>
      n === 1
        ? json(201, { data: { mensagem_id: corpo.mensagem_id, status: "queued", token_novo: "T2" } })
        : json(201, { data: { mensagem_id: corpo.mensagem_id, status: "queued" } }),
    );
    const { armazenamento } = await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();

    digitarEEnviar("Oi");
    await esperarTudo();
    digitarEEnviar("Tudo bem?");
    await esperarTudo();

    const envios = r.chamadas.filter((c) => c.url.endsWith("/mensagens"));
    expect(envios[0].init.headers?.Authorization).toBe("Bearer T1");
    expect(envios[1].init.headers?.Authorization).toBe("Bearer T2");
    expect(armazenamento.mapa.get("webchat:wck_teste")).toBe("T2");
  });
});
