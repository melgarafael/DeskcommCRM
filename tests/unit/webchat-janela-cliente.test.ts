/**
 * O comportamento da janela do chat no site (`public/webchat-janela.js`, spec 36, F2, Task 5).
 *
 * O arquivo é JavaScript de navegador, sem módulo. Carregado com `createRequire`, expõe as
 * funções por `module.exports` e NÃO se inicia sozinho. O DOM da janela sai de `montarJanela`
 * (lib/channels/webchat/janela-html.ts), o mesmo HTML que o servidor entrega, e `iniciar` é
 * dirigido com um `fetch` falso no jsdom (ambiente padrão deste repositório).
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";
import { montarJanela } from "@/lib/channels/webchat/janela-html";

vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.example.com" } }));
vi.mock("@/lib/webhooks/url-publica", () => ({ enderecoDaPropriaMaquina: () => false }));

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
  iniciar: (opcoes: Record<string, unknown>) => unknown;
}

// import.meta.url não é um file: dentro do jsdom; a raiz do repositório é o cwd do vitest.
const CAMINHO = resolve(process.cwd(), "public/webchat-janela.js");
const requerer = createRequire(CAMINHO);
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
  function leitorDe(pedacos: unknown[]) {
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

  it("lê Uint8Array e junta um caractere acentuado partido entre dois chunks", async () => {
    const bytes = new TextEncoder().encode('event: mensagem\ndata: {"id":"1","texto":"ação"}\n\n');
    const meio = bytes.indexOf(0xc3) + 1; // corta o "ç" no meio dos dois bytes
    const recebidos: Array<{ evento: string; dados: string }> = [];
    await modulo.lerEventos(leitorDe([bytes.slice(0, meio), bytes.slice(meio)]), (ev) =>
      recebidos.push(ev),
    );
    expect(recebidos).toHaveLength(1);
    expect((JSON.parse(recebidos[0]!.dados) as { texto: string }).texto).toBe("ação");
  });
});

// ---------- A janela no DOM ----------

const MARCA: MarcaDeSaida = {
  nome: "Loja Exemplo",
  logoUrl: null,
  accent: "#506d48",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};

/** Configuração completa, como a rota a entrega em `#webchat-config`. */
const CONFIG_PADRAO = {
  chave: "wck_teste",
  titulo: "Atendimento",
  saudacao: "Olá!",
  cor: "#123456",
  coleta: { nome: "obrigatorio", telefone: "opcional", email: "oculto" },
  versaoDoAviso: "v1",
  controlador: { razaoSocial: "Loja Exemplo Ltda", politicaUrl: "https://loja.exemplo.com.br/privacidade" },
  avatar: "https://exemplo.com.br/avatar.png",
  autoAbrirSegundos: 30,
  som: true,
  respostasRapidas: ["Sim", "Não"],
};

const SOMENTE_CONVERSA = {
  ...CONFIG_PADRAO,
  coleta: { nome: "oculto", telefone: "oculto", email: "oculto" },
};

/** HTML real da janela, gerado por `montarJanela`. */
interface ConfigDoHtml {
  titulo: string;
  saudacao: string;
  coleta: unknown;
  controlador: { razaoSocial: string; politicaUrl: string | null };
  /** Campos dos ajustes (avatar, autoAbrirSegundos, som, respostasRapidas): o HTML não os usa, o teste os troca no JSON. */
  [outro: string]: unknown;
}

function htmlDaJanela(config: ConfigDoHtml): string {
  return montarJanela({
    chave: "wck_teste",
    marca: MARCA,
    config: { titulo: config.titulo, saudacao: config.saudacao, coleta: config.coleta } as never,
    controlador: config.controlador,
    origens: [],
  }).html;
}

/** Troca o conteúdo do body pelo documento gerado pelo servidor, sem a propriedade de HTML bruto. */
function montarDom(html: string) {
  const documento = new DOMParser().parseFromString(html, "text/html");
  document.body.textContent = "";
  Array.from(documento.body.childNodes).forEach((no) =>
    document.body.appendChild(document.importNode(no, true)),
  );
}

interface Chamada {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

type Fetch = (url: string, init?: Chamada["init"]) => Promise<unknown>;

function json(status: number, corpo: unknown, cabecalhos: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (nome: string) => cabecalhos[nome] ?? null },
    json: () => Promise.resolve(corpo),
    body: null,
  };
}

/** Resposta de fluxo: o corpo é um leitor de pedaços (texto ou bytes). */
function stream(pedacos: unknown[]) {
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

interface Rotas {
  sessao?: () => Promise<unknown>;
  mensagens?: (corpo: { mensagem_id: string }, n: number) => unknown;
  eventos?: () => Promise<unknown>;
}

/** Roteia as rotas da janela. `n` conta os envios de mensagem (1, 2, ...). */
function roteador(rotas: Rotas = {}, eventos: string[] = []) {
  const chamadas: Chamada[] = [];
  let n = 0;
  const fn: Fetch = (url, init = {}) => {
    chamadas.push({ url, init });
    if (url.endsWith("/sessao")) {
      return rotas.sessao
        ? rotas.sessao()
        : Promise.resolve(json(200, { data: { token: "T1", visitante_id: "v1", configuracao: {} } }));
    }
    if (url.endsWith("/eventos")) {
      return rotas.eventos ? rotas.eventos() : Promise.resolve(stream(eventos));
    }
    if (url.endsWith("/mensagens")) {
      const corpo = JSON.parse(String(init.body)) as { mensagem_id: string };
      n += 1;
      return Promise.resolve(
        rotas.mensagens
          ? rotas.mensagens(corpo, n)
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

interface Agendado {
  fn: () => void;
  ms: number;
}

async function abrirJanela(
  fetchFn: Fetch,
  config: typeof CONFIG_PADRAO | typeof SOMENTE_CONVERSA = CONFIG_PADRAO,
  extras: Record<string, unknown> = {},
  configBruta?: string,
  htmlConfig: ConfigDoHtml = CONFIG_PADRAO,
) {
  montarDom(htmlDaJanela(htmlConfig));
  document.getElementById("webchat-config")!.textContent = configBruta ?? JSON.stringify(config);
  const agendados: Agendado[] = [];
  const pai = { postMessage: vi.fn() };
  const armazenamento = memoria();
  modulo.iniciar({
    documento: document,
    janela: window,
    pai,
    fetch: fetchFn,
    agendar: (fn: () => void, ms: number) => {
      agendados.push({ fn, ms });
    },
    armazenamento,
    caminho: "/chat/wck_teste",
    ...extras,
  });
  await esperarTudo();
  return { pai, armazenamento, agendados };
}

function botao(texto: string): HTMLButtonElement {
  const achado = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === texto);
  if (!achado) throw new Error("botão ausente: " + texto);
  return achado;
}

function temTexto(texto: string): boolean {
  return document.body.textContent !== null && document.body.textContent.includes(texto);
}

function digitarEEnviar(texto: string) {
  const campo = document.getElementById("webchat-texto") as HTMLTextAreaElement;
  campo.value = texto;
  campo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

function enviarColeta() {
  (document.querySelector("form.coleta") as HTMLFormElement).dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
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
    const malicioso = JSON.stringify({ id: "m1", texto: "<img src=x onerror=alert(1)>", em: "2026-11-21T10:00:00Z" });
    const r = roteador({}, [`event: mensagem\ndata: ${malicioso}\n\n`]);
    await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();

    const texto = Array.from(document.querySelectorAll(".msg-texto")).find(
      (p) => p.textContent === "<img src=x onerror=alert(1)>",
    );
    expect(texto).toBeDefined();
    expect(texto!.children.length).toBe(0);
    expect(document.querySelector(".msg-texto img")).toBeNull();
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
    await abrirJanela(roteador().fn, CONFIG_PADRAO, { armazenamento: quebrado });
    expect(botao("Aceitar e continuar")).toBeDefined();
  });

  it("sessão com 404 mostra Chat indisponível e não reconecta", async () => {
    const chamadas: string[] = [];
    const { agendados } = await abrirJanela((url) => {
      chamadas.push(url);
      return Promise.resolve(json(404, { error: { code: "not_found", message: "Not found." } }));
    });
    expect(temTexto("Chat indisponível")).toBe(true);
    expect(agendados).toHaveLength(0);
    expect(chamadas.filter((u) => u.endsWith("/sessao"))).toHaveLength(1);
  });

  it("campo obrigatório vazio impede o envio e mostra o aviso", async () => {
    const r = roteador();
    await abrirJanela(r.fn);
    botao("Aceitar e continuar").click();
    await esperarTudo();
    enviarColeta();
    await esperarTudo();

    expect(corposDeMensagens(r.chamadas)).toHaveLength(0);
    expect(temTexto("Informe seu nome.")).toBe(true);
  });

  it("campo oculto não aparece no formulário de coleta", async () => {
    await abrirJanela(roteador().fn);
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
    enviarColeta();
    await esperarTudo();

    digitarEEnviar("Oi");
    await esperarTudo();
    digitarEEnviar("Tudo bem?");
    await esperarTudo();

    const [primeira, segunda] = corposDeMensagens(r.chamadas);
    expect(primeira!.aceite).toEqual({ versao: "v1" });
    expect(primeira!.contato).toEqual({ nome: "Ana", telefone: "+5511999999999" });
    expect(segunda!.aceite).toBeUndefined();
    expect(segunda!.contato).toBeUndefined();
  });

  it("gravar a flag iniciada após o primeiro envio aceito", async () => {
    const { armazenamento } = await abrirJanela(roteador().fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();
    digitarEEnviar("Oi");
    await esperarTudo();
    expect(armazenamento.mapa.get("webchat:wck_teste:iniciada")).toBe("1");
  });

  it("flag iniciada com token pula aviso e coleta, e não reenvia aceite nem contato", async () => {
    // Segunda abertura: a flag e o token guardados de antes.
    const armazenamento = memoria();
    armazenamento.mapa.set("webchat:wck_teste:iniciada", "1");
    armazenamento.mapa.set("webchat:wck_teste", "T0");
    const r = roteador();
    await abrirJanela(r.fn, CONFIG_PADRAO, { armazenamento });

    expect(document.querySelector("form.coleta")).toBeNull();
    expect(temTexto("Aceitar e continuar")).toBe(false);
    const sessao = r.chamadas.find((c) => c.url.endsWith("/sessao"));
    expect(sessao?.init.headers?.Authorization).toBe("Bearer T0");

    digitarEEnviar("Oi");
    await esperarTudo();
    const [envio] = corposDeMensagens(r.chamadas);
    expect(envio!.aceite).toBeUndefined();
    expect(envio!.contato).toBeUndefined();
  });

  it("flag sem token ainda pede o aviso", async () => {
    const r = roteador();
    const armazenamento = memoria();
    armazenamento.mapa.set("webchat:wck_teste:iniciada", "1");
    await abrirJanela(r.fn, CONFIG_PADRAO, { armazenamento });
    expect(botao("Aceitar e continuar")).toBeDefined();
  });

  it("422 na primeira mensagem volta à coleta com o que foi digitado, e o reenvio usa o MESMO mensagem_id", async () => {
    const r = roteador({
      mensagens: (_corpo, n) =>
        n === 1
          ? json(422, { error: { code: "validation_failed", message: "Dados inválidos." } })
          : json(201, { data: { mensagem_id: "x", status: "queued" } }),
    });
    await abrirJanela(r.fn);
    botao("Aceitar e continuar").click();
    await esperarTudo();
    (document.querySelector('input[name="nome"]') as HTMLInputElement).value = "Ana";
    enviarColeta();
    await esperarTudo();

    digitarEEnviar("Oi");
    await esperarTudo();
    expect(temTexto("Confira os dados e tente de novo.")).toBe(true);
    const campoNome = document.querySelector('input[name="nome"]') as HTMLInputElement | null;
    expect(campoNome).not.toBeNull();
    expect(campoNome!.value).toBe("Ana");

    // Confirma a coleta de novo: volta à conversa e a mensagem falha fica com "tentar de novo".
    enviarColeta();
    await esperarTudo();
    const falha = Array.from(document.querySelectorAll(".msg-estado")).find((el) =>
      el.textContent?.includes("tentar de novo"),
    ) as HTMLElement;
    expect(falha).toBeDefined();
    falha.click();
    await esperarTudo();

    const [primeira, reenvio] = corposDeMensagens(r.chamadas);
    expect(reenvio!.mensagem_id).toBe(primeira!.mensagem_id);
    expect(reenvio!.aceite).toEqual({ versao: "v1" });
    expect(reenvio!.contato).toEqual({ nome: "Ana" });
  });

  it("token_novo substitui o token usado na requisição seguinte", async () => {
    const r = roteador({
      mensagens: (corpo, n) =>
        n === 1
          ? json(201, { data: { mensagem_id: corpo.mensagem_id, status: "queued", token_novo: "T2" } })
          : json(201, { data: { mensagem_id: corpo.mensagem_id, status: "queued" } }),
    });
    const { armazenamento } = await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();
    digitarEEnviar("Oi");
    await esperarTudo();
    digitarEEnviar("Tudo bem?");
    await esperarTudo();

    const envios = r.chamadas.filter((c) => c.url.endsWith("/mensagens"));
    expect(envios[0]!.init.headers?.Authorization).toBe("Bearer T1");
    expect(envios[1]!.init.headers?.Authorization).toBe("Bearer T2");
    expect(armazenamento.mapa.get("webchat:wck_teste")).toBe("T2");
  });

  it("Esc manda { tipo: fechar } ao pai", async () => {
    const { pai } = await abrirJanela(roteador().fn);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(pai.postMessage).toHaveBeenCalledWith({ tipo: "fechar" }, "*");
  });

  it("o botão fechar do cabeçalho manda { tipo: fechar } ao pai", async () => {
    const { pai } = await abrirJanela(roteador().fn);
    (document.querySelector('button[aria-label="Fechar chat"]') as HTMLButtonElement).click();
    expect(pai.postMessage).toHaveBeenCalledWith({ tipo: "fechar" }, "*");
  });

  it("envia { tipo: pronto } ao pai ao iniciar", async () => {
    const { pai } = await abrirJanela(roteador().fn);
    expect(pai.postMessage).toHaveBeenCalledWith({ tipo: "pronto" }, "*");
  });

  it("401 no fluxo apaga o token guardado, mostra Chat indisponível e não reconecta", async () => {
    const r = roteador({ eventos: () => Promise.resolve(json(401, { error: { code: "unauthenticated", message: "x" } })) });
    const { armazenamento, agendados } = await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();

    expect(armazenamento.mapa.has("webchat:wck_teste")).toBe(false);
    expect(temTexto("Chat indisponível")).toBe(true);
    expect(agendados).toHaveLength(0);
  });

  it("429 no fluxo respeita Retry-After em segundos", async () => {
    let chamadas = 0;
    const r = roteador({
      eventos: () => {
        chamadas += 1;
        return Promise.resolve(json(429, { error: { code: "rate_limited", message: "x" } }, { "Retry-After": "7" }));
      },
    });
    const { agendados } = await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();

    expect(agendados.map((a) => a.ms)).toEqual([7000]);
    agendados[0]!.fn();
    await esperarTudo();
    expect(chamadas).toBe(2);
  });

  it("429 na sessão respeita Retry-After antes de tentar de novo", async () => {
    let chamadas = 0;
    const r = roteador({
      sessao: () => {
        chamadas += 1;
        return Promise.resolve(json(429, { error: { code: "rate_limited", message: "x" } }, { "Retry-After": "3" }));
      },
    });
    const { agendados } = await abrirJanela(r.fn);
    expect(agendados.map((a) => a.ms)).toEqual([3000]);
    agendados[0]!.fn();
    await esperarTudo();
    expect(chamadas).toBe(2);
  });

  it("falha de rede no fluxo espera 1 s, 2 s e 4 s, em sequência", async () => {
    const r = roteador({ eventos: () => Promise.reject(new Error("rede")) });
    const { agendados } = await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();
    expect(agendados.map((a) => a.ms)).toEqual([1000]);

    agendados[agendados.length - 1]!.fn();
    await esperarTudo();
    expect(agendados.map((a) => a.ms)).toEqual([1000, 2000]);

    agendados[agendados.length - 1]!.fn();
    await esperarTudo();
    expect(agendados.map((a) => a.ms)).toEqual([1000, 2000, 4000]);
  });

  it("fim normal do fluxo reconecta depois de 1 s, sem aviso", async () => {
    const r = roteador({}, []);
    const { agendados } = await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();

    expect(agendados.map((a) => a.ms)).toEqual([1000]);
    expect(temTexto("Reconectando")).toBe(false);
    agendados[0]!.fn();
    await esperarTudo();
    expect(r.chamadas.filter((c) => c.url.endsWith("/eventos"))).toHaveLength(2);
  });

  it("Reconectando aparece na tela enquanto a sessão ainda não abriu (fora do rodapé escondido)", async () => {
    await abrirJanela(roteador({ sessao: () => Promise.reject(new Error("rede")) }).fn);
    const status = Array.from(document.querySelectorAll('[role="status"]')).find(
      (p) => p.textContent === "Reconectando…",
    ) as HTMLElement | undefined;
    expect(status).toBeDefined();
    // O status não mora no rodapé (oculto até a sessão abrir): fica ao lado do "Conectando…" do passo, visível.
    expect(status!.closest(".rodape")).toBeNull();
    expect(temTexto("Conectando…")).toBe(true);
    expect((document.querySelector(".rodape") as HTMLElement).style.display).toBe("none");
  });

  it("o JS monta o link da política a partir da configuração, com target e rel seguros", async () => {
    // O HTML do servidor vem SEM link: o link que aparece tem de ter sido montado pelo script.
    await abrirJanela(roteador().fn, CONFIG_PADRAO, {}, JSON.stringify(CONFIG_PADRAO), {
      ...CONFIG_PADRAO,
      controlador: { razaoSocial: "Loja Exemplo Ltda", politicaUrl: null },
    });
    const link = document.querySelector(".aviso a") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("https://loja.exemplo.com.br/privacidade");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("o JS omite o link quando a política não é http(s), mesmo com o HTML trazendo link", async () => {
    await abrirJanela(roteador().fn, CONFIG_PADRAO, {}, JSON.stringify({
      ...CONFIG_PADRAO,
      controlador: { razaoSocial: "Loja", politicaUrl: "javascript:alert(1)" },
    }), CONFIG_PADRAO);
    expect(document.querySelector(".aviso a")).toBeNull();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it("a lista de mensagens tem role log", async () => {
    await abrirJanela(roteador().fn);
    expect(document.getElementById("webchat-mensagens")!.getAttribute("role")).toBe("log");
  });

  it("mensagem vazia é recusada na tela, sem chamada ao servidor", async () => {
    const r = roteador();
    await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();
    digitarEEnviar("   ");
    await esperarTudo();
    expect(temTexto("Digite uma mensagem para enviar.")).toBe(true);
    expect(corposDeMensagens(r.chamadas)).toHaveLength(0);
  });

  it("mensagem acima de 2000 caracteres é recusada na tela, com o limite", async () => {
    const r = roteador();
    await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();
    digitarEEnviar("a".repeat(2001));
    await esperarTudo();
    expect(temTexto("passou de 2000 caracteres")).toBe(true);
    expect(corposDeMensagens(r.chamadas)).toHaveLength(0);
  });

  it("Enter envia, Shift+Enter não envia e deixa a quebra de linha (não é cancelado)", async () => {
    const r = roteador();
    await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();
    const campo = document.getElementById("webchat-texto") as HTMLTextAreaElement;
    campo.value = "linha um";
    const naoCancelado = campo.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
    );
    await esperarTudo();
    expect(corposDeMensagens(r.chamadas)).toHaveLength(0);
    expect(campo.value).toBe("linha um");
    expect(naoCancelado).toBe(true);

    campo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await esperarTudo();
    expect(corposDeMensagens(r.chamadas)).toHaveLength(1);
  });

  it("Enter durante composição de IME não envia", async () => {
    const r = roteador();
    await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();
    const campo = document.getElementById("webchat-texto") as HTMLTextAreaElement;
    campo.value = "ni";
    campo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    await esperarTudo();
    expect(corposDeMensagens(r.chamadas)).toHaveLength(0);
  });

  it("422 com flag guardada (forjada ou obsoleta) apaga a flag, volta ao aviso/coleta e reenvia com aceite, contato e o MESMO mensagem_id", async () => {
    const armazenamento = memoria();
    armazenamento.mapa.set("webchat:wck_teste:iniciada", "1");
    armazenamento.mapa.set("webchat:wck_teste", "T0");
    const r = roteador({
      mensagens: (_corpo, n) =>
        n === 1
          ? json(422, { error: { code: "validation_failed", message: "x" } })
          : json(201, { data: { mensagem_id: "x", status: "queued" } }),
    });
    await abrirJanela(r.fn, CONFIG_PADRAO, { armazenamento });
    expect(temTexto("Aceitar e continuar")).toBe(false);

    digitarEEnviar("Oi");
    await esperarTudo();
    expect(armazenamento.mapa.has("webchat:wck_teste:iniciada")).toBe(false);
    expect(temTexto("Confira os dados e tente de novo.")).toBe(true);
    expect(document.querySelector("form.coleta")).not.toBeNull();

    (document.querySelector('input[name="nome"]') as HTMLInputElement).value = "Ana";
    enviarColeta();
    await esperarTudo();
    expect(temTexto("Confira os dados")).toBe(false);
    const falha = Array.from(document.querySelectorAll(".msg-estado")).find((el) =>
      el.textContent?.includes("tentar de novo"),
    ) as HTMLElement;
    falha.click();
    await esperarTudo();

    const [primeira, reenvio] = corposDeMensagens(r.chamadas);
    expect(primeira!.aceite).toBeUndefined();
    expect(reenvio!.mensagem_id).toBe(primeira!.mensagem_id);
    expect(reenvio!.aceite).toEqual({ versao: "v1" });
    expect(reenvio!.contato).toEqual({ nome: "Ana" });
  });

  it("a flag não é gravada após 5xx nem após 422", async () => {
    const armazenamento = memoria();
    await abrirJanela(roteador({
      mensagens: () => json(500, { error: { code: "internal_error", message: "x" } }),
    }).fn, SOMENTE_CONVERSA, { armazenamento });
    botao("Aceitar e continuar").click();
    await esperarTudo();
    digitarEEnviar("Oi");
    await esperarTudo();
    expect(armazenamento.mapa.has("webchat:wck_teste:iniciada")).toBe(false);
  });

  it("401 no envio apaga o token e a flag juntos", async () => {
    const armazenamento = memoria();
    armazenamento.mapa.set("webchat:wck_teste:iniciada", "1");
    armazenamento.mapa.set("webchat:wck_teste", "T0");
    await abrirJanela(roteador({
      mensagens: () => json(401, { error: { code: "unauthenticated", message: "x" } }),
    }).fn, CONFIG_PADRAO, { armazenamento });
    digitarEEnviar("Oi");
    await esperarTudo();
    expect(armazenamento.mapa.has("webchat:wck_teste")).toBe(false);
    expect(armazenamento.mapa.has("webchat:wck_teste:iniciada")).toBe(false);
    expect(temTexto("Chat indisponível")).toBe(true);
  });

  it("token guardado sem flag pede o aviso de novo", async () => {
    const armazenamento = memoria();
    armazenamento.mapa.set("webchat:wck_teste", "T0");
    await abrirJanela(roteador().fn, CONFIG_PADRAO, { armazenamento });
    expect(botao("Aceitar e continuar")).toBeDefined();
  });

  it("401 no envio marca a mensagem como não enviada antes de mostrar Chat indisponível", async () => {
    const r = roteador({
      mensagens: () => json(401, { error: { code: "unauthenticated", message: "x" } }),
    });
    await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();
    digitarEEnviar("Oi");
    await esperarTudo();
    expect(temTexto("não enviada — tentar de novo")).toBe(true);
    expect(temTexto("Chat indisponível")).toBe(true);
  });

  // ---------- Tarefa 10b: ajustes, avatar e respostas rápidas ----------

  it("mostrarResposta manda { tipo: resposta } ao pai", async () => {
    const evento = `event: mensagem\ndata: {"id":"r1","texto":"Oi","em":"2026-11-21T10:00:00Z"}\n\n`;
    const r = roteador({}, [evento]);
    const { pai } = await abrirJanela(r.fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();
    await esperarTudo();
    // a resposta do atendente chega pelo fluxo de eventos
    const chamadasResposta = pai.postMessage.mock.calls.filter((c) => c[0]?.tipo === "resposta");
    expect(chamadasResposta).toHaveLength(1);
    expect(chamadasResposta[0]![0]).toEqual({ tipo: "resposta" });
    expect(chamadasResposta[0]![1]).toBe("*");
  });

  it("ajustes sai depois de pronto com os valores da configuração", async () => {
    const { pai } = await abrirJanela(roteador().fn, SOMENTE_CONVERSA);
    const chamadas = pai.postMessage.mock.calls.map((c) => c[0]);
    const pronto = chamadas.find((c) => c.tipo === "pronto");
    const ajustes = chamadas.find((c) => c.tipo === "ajustes");
    expect(pronto).toEqual({ tipo: "pronto" });
    expect(ajustes).toEqual({ tipo: "ajustes", autoAbrirSegundos: 30, som: true });
    // ajustes vem depois de pronto
    expect(chamadas.indexOf(ajustes)).toBeGreaterThan(chamadas.indexOf(pronto));
  });

  it("ajustes usa padrões 0 e false quando ausentes ou de tipo errado", async () => {
    const { pai } = await abrirJanela(
      roteador().fn,
      CONFIG_PADRAO,
      {},
      JSON.stringify({ ...CONFIG_PADRAO, autoAbrirSegundos: "trinta", som: "sim", avatar: null, respostasRapidas: null }),
      { ...CONFIG_PADRAO, autoAbrirSegundos: "trinta", som: "sim", avatar: null, respostasRapidas: null },
    );
    const chamadas = pai.postMessage.mock.calls.map((c) => c[0]);
    const ajustes = chamadas.find((c) => c.tipo === "ajustes");
    expect(ajustes).toEqual({ tipo: "ajustes", autoAbrirSegundos: 0, som: false });
  });

  it("avatar https cria um img 28x28 no cabeçalho; avatar http e javascript não criam", async () => {
    await abrirJanela(roteador().fn, SOMENTE_CONVERSA);
    const img = document.querySelector(".cabecalho img") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("https://exemplo.com.br/avatar.png");
    expect(img!.getAttribute("alt")).toBe("");
    expect(img!.style.width).toBe("28px");
    expect(img!.style.height).toBe("28px");
    expect(img!.style.borderRadius).toBe("50%");
    expect(img!.style.objectFit).toBe("cover");

    // avatar http não cria (reabre com config diferente)
    document.body.textContent = "";
    await abrirJanela(
      roteador().fn,
      SOMENTE_CONVERSA,
      {},
      JSON.stringify({ ...SOMENTE_CONVERSA, avatar: "http://exemplo.com.br/a.png" }),
      { ...SOMENTE_CONVERSA, avatar: "http://exemplo.com.br/a.png" },
    );
    expect(document.querySelector(".cabecalho img")).toBeNull();

    // avatar javascript não cria
    document.body.textContent = "";
    await abrirJanela(
      roteador().fn,
      SOMENTE_CONVERSA,
      {},
      JSON.stringify({ ...SOMENTE_CONVERSA, avatar: "javascript:alert(1)" }),
      { ...SOMENTE_CONVERSA, avatar: "javascript:alert(1)" },
    );
    expect(document.querySelector(".cabecalho img")).toBeNull();
  });

  /** O elemento está visível se ele e nenhum ancestral (até o body) têm display none. */
  function estaVisivel(el: Element): boolean {
    let node: Element | null = el;
    while (node && node !== document.body) {
      if (window.getComputedStyle(node).display === "none") return false;
      node = node.parentElement;
    }
    return true;
  }

  /** Abre a janela sem coleta e passa pela tela do aceite, até a conversa. */
  async function irParaAConversa(config: typeof SOMENTE_CONVERSA) {
    const r = roteador();
    const aberta = await abrirJanela(r.fn, config, {}, JSON.stringify(config), config);
    botao("Aceitar e continuar").click();
    await esperarTudo();
    return { r, ...aberta };
  }

  function botoesDeResposta(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>(".rodape > div button"));
  }

  it("respostas rápidas aparecem como botões visíveis no rodapé, depois do aceite", async () => {
    await irParaAConversa(SOMENTE_CONVERSA);
    const container = document.querySelector(".rodape > div");
    expect(container).not.toBeNull();
    expect(estaVisivel(container!)).toBe(true);
    expect(botoesDeResposta().map((b) => b.textContent)).toEqual(["Sim", "Não"]);
  });

  it("resposta rápida com <b> aparece como texto literal, sem criar elemento", async () => {
    await irParaAConversa({ ...SOMENTE_CONVERSA, respostasRapidas: ["<b>x</b>"] });
    expect(botoesDeResposta().map((b) => b.textContent)).toEqual(["<b>x</b>"]);
    expect(document.querySelector(".rodape b")).toBeNull();
  });

  it("clicar numa resposta rápida envia o texto como mensagem normal e a fileira some", async () => {
    const { r } = await irParaAConversa(SOMENTE_CONVERSA);
    botoesDeResposta()[0]!.click();
    await esperarTudo();
    const corpos = corposDeMensagens(r.chamadas);
    expect(corpos).toHaveLength(1);
    expect(corpos[0]!.texto).toBe("Sim");
    expect(document.querySelector(".rodape > div")).toBeNull();
  });

  it("visitante que volta (flag + token) não vê a fileira de respostas rápidas", async () => {
    const armazenamento = memoria();
    armazenamento.mapa.set("webchat:wck_teste:iniciada", "1");
    armazenamento.mapa.set("webchat:wck_teste", "T0");
    const { pai } = await abrirJanela(roteador().fn, CONFIG_PADRAO, { armazenamento });

    // vai direto à conversa, sem aviso/coleta
    await esperarTudo();
    expect(document.querySelector(".rodape > div")).toBeNull();
    expect(temTexto("Aceitar e continuar")).toBe(false);

    // mas ainda manda ajustes ao pai
    const chamadas = pai.postMessage.mock.calls.map((c) => c[0]);
    expect(chamadas.find((c) => c.tipo === "ajustes")).toEqual({
      tipo: "ajustes",
      autoAbrirSegundos: 30,
      som: true,
    });
  });

  // ---------- F3: horário de atendimento e "Recebemos sua mensagem" ----------

  const RECEBIDA = "Recebemos sua mensagem. Nossa equipe responde por aqui.";

  /** Sessão que devolve o campo `atendimento` (F3). Só os testes deste bloco o usam. */
  function sessaoComAtendimento(atendimento: unknown) {
    return () =>
      Promise.resolve(
        json(200, { data: { token: "T1", visitante_id: "v1", configuracao: {}, atendimento } }),
      );
  }

  /** Linhas do registro cujo texto é exatamente o dado. */
  function linhasComTexto(texto: string): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(".msg-texto")).filter(
      (p) => p.textContent === texto,
    );
  }

  /** Abre a janela com a sessão dada (sem o campo, se omitida) e chega à conversa pelo aceite. */
  async function chegarAConversa(sessao?: () => Promise<unknown>) {
    await abrirJanela(roteador(sessao ? { sessao } : {}).fn, SOMENTE_CONVERSA);
    botao("Aceitar e continuar").click();
    await esperarTudo();
  }

  it("atendimento fechado com aviso mostra o aviso do agente ao abrir a conversa", async () => {
    await chegarAConversa(
      sessaoComAtendimento({
        estado: "fechado",
        abre_em: "2026-11-25T11:00:00.000Z",
        aviso: "Voltamos amanhã.",
      }),
    );
    expect(linhasComTexto("Voltamos amanhã.")).toHaveLength(1);
  });

  it("atendimento fechado sem aviso mostra o texto padrão com a hora de volta no relógio do aparelho", async () => {
    const abreEm = "2026-11-25T11:00:00.000Z";
    await chegarAConversa(sessaoComAtendimento({ estado: "fechado", abre_em: abreEm, aviso: null }));
    const d = new Date(abreEm);
    const dois = (n: number) => String(n).padStart(2, "0");
    const esperado =
      `Estamos fora do horário de atendimento. Voltamos às ${dois(d.getHours())}:${dois(d.getMinutes())}` +
      ` de ${dois(d.getDate())}/${dois(d.getMonth() + 1)} (no horário do seu aparelho).`;
    expect(linhasComTexto(esperado)).toHaveLength(1);
  });

  it("aviso do agente com marcação entra como texto, sem elemento filho", async () => {
    await chegarAConversa(
      sessaoComAtendimento({
        estado: "fechado",
        abre_em: "2026-11-25T11:00:00.000Z",
        aviso: "<b>x</b>",
      }),
    );
    expect(linhasComTexto("<b>x</b>")).toHaveLength(1);
    expect(document.querySelector(".msg-texto b")).toBeNull();
  });

  it("atendimento fora do formato (abre_em que não é data) é ignorado por inteiro", async () => {
    await chegarAConversa(
      sessaoComAtendimento({ estado: "fechado", abre_em: "nao-e-data", aviso: null }),
    );
    expect(temTexto("Estamos fora do horário")).toBe(false);
  });

  it("sem agente: a linha de recebido só aparece depois do primeiro envio aceito, e uma vez só", async () => {
    await chegarAConversa(sessaoComAtendimento({ estado: "sem_agente", abre_em: null, aviso: null }));
    expect(linhasComTexto(RECEBIDA)).toHaveLength(0);

    digitarEEnviar("Oi");
    await esperarTudo();
    await esperarTudo();
    expect(linhasComTexto(RECEBIDA)).toHaveLength(1);

    digitarEEnviar("Tudo bem?");
    await esperarTudo();
    await esperarTudo();
    expect(linhasComTexto(RECEBIDA)).toHaveLength(1);
  });

  it("atendimento aberto não mostra linha de horário nem de recebido", async () => {
    await chegarAConversa(sessaoComAtendimento({ estado: "aberto", abre_em: null, aviso: null }));
    digitarEEnviar("Oi");
    await esperarTudo();
    await esperarTudo();
    expect(temTexto("Estamos fora do horário")).toBe(false);
    expect(linhasComTexto(RECEBIDA)).toHaveLength(0);
  });

  it("sem o campo atendimento (servidor antigo) a janela segue como antes", async () => {
    await chegarAConversa();
    digitarEEnviar("Oi");
    await esperarTudo();
    await esperarTudo();
    expect(temTexto("Estamos fora do horário")).toBe(false);
    expect(linhasComTexto(RECEBIDA)).toHaveLength(0);
  });

  // ---------- F5: contexto da página na primeira mensagem ----------

  /** Entrega ao iframe a mensagem `contexto` da página de fora, com o pai como origem (como o navegador faz). */
  function enviarContextoDoPai(pai: object, dados: Record<string, unknown>) {
    const evento = new Event("message");
    Object.defineProperty(evento, "data", { value: { tipo: "contexto", ...dados } });
    Object.defineProperty(evento, "source", { value: pai });
    window.dispatchEvent(evento);
  }

  /** Abre a janela sem coleta, entrega o contexto do pai e aceita, chegando à conversa. */
  async function chegarAConversaComContexto(dados: Record<string, unknown> | null) {
    const r = roteador();
    const { pai } = await abrirJanela(r.fn, SOMENTE_CONVERSA);
    if (dados !== null) enviarContextoDoPai(pai, dados);
    botao("Aceitar e continuar").click();
    await esperarTudo();
    return r;
  }

  it("a primeira mensagem leva o contexto da página (href, referrer e utm) e a segunda não leva", async () => {
    const r = await chegarAConversaComContexto({
      href: "https://example.com/preco",
      referrer: "https://example.com/",
      utm: { utm_source: "ig" },
    });
    digitarEEnviar("Oi");
    await esperarTudo();
    digitarEEnviar("Tudo bem?");
    await esperarTudo();

    const [primeira, segunda] = corposDeMensagens(r.chamadas);
    expect(primeira!.contexto).toEqual({
      href: "https://example.com/preco",
      referrer: "https://example.com/",
      utm: { utm_source: "ig" },
    });
    expect("contexto" in segunda!).toBe(false);
  });

  it("sem contexto recebido do pai, a primeira mensagem não tem a chave contexto", async () => {
    const r = await chegarAConversaComContexto(null);
    digitarEEnviar("Oi");
    await esperarTudo();

    const [primeira] = corposDeMensagens(r.chamadas);
    expect("contexto" in primeira!).toBe(false);
  });

  it("contexto com href e referrer vazios e utm vazio não gera a chave contexto", async () => {
    const r = await chegarAConversaComContexto({ href: "", referrer: "", utm: {} });
    digitarEEnviar("Oi");
    await esperarTudo();

    const [primeira] = corposDeMensagens(r.chamadas);
    expect("contexto" in primeira!).toBe(false);
  });

  it("contexto só com utm leva contexto só com utm, sem href nem referrer", async () => {
    const r = await chegarAConversaComContexto({ href: "", referrer: "", utm: { utm_campaign: "natal" } });
    digitarEEnviar("Oi");
    await esperarTudo();

    const [primeira] = corposDeMensagens(r.chamadas);
    expect(primeira!.contexto).toEqual({ utm: { utm_campaign: "natal" } });
  });
});
