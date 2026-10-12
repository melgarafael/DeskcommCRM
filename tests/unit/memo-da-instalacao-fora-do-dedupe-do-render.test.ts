/**
 * ═══ NENHUM MEMO DA INSTALAÇÃO REAPROVEITA UMA LEITURA DE ANTES DA ESCRITA ═══
 *
 * Durante um render, o Next embrulha o `fetch` global numa deduplicação por
 * requisição (`next/dist/server/lib/dedupe-fetch.js`): o primeiro GET guarda a
 * resposta, e todo GET idêntico seguinte NA MESMA requisição recebe essa
 * resposta sem sair para a rede — a menos que leve um `signal`, o opt-out que a
 * própria fonte declara ("If we're passed a signal [...] opts out of caching").
 * O `postgrest-js` chama o `fetch` com `signal: undefined` quando ninguém chamou
 * `.abortSignal()`.
 *
 * Os memos abaixo vivem ENTRE requisições, são invalidados por quem grava, e
 * são lidos no render. Se o memo vence (ou é invalidado) no começo de um render,
 * a 1ª chamada vai ao banco e a deduplicação guarda a resposta; a escrita grava e
 * invalida no meio; a 2ª chamada do MESMO render recebe a resposta de ANTES da
 * escrita — e a guarda de geração (onde existe) a aceita, porque a geração foi
 * capturada depois da invalidação. O memo fica com o valor velho por 30 s, e
 * toda requisição seguinte nega a escrita. O caso da marca, com o histórico do
 * CI, está em `branding-memo-da-instalacao.test.ts`.
 *
 * Diferente daquele arquivo, este NÃO dubla o `createAdminClient`: a leitura
 * passa pelo cliente de verdade (`lib/supabase/admin.ts` → `supabase-js` →
 * `postgrest-js` → `fetchDoServidor`) até o `fetch` global, que é onde o Next
 * deduplica. É o que prova que o `signal` posto na consulta CHEGA ao `fetch` — o
 * dublê de cadeia do outro arquivo não alcança essa pergunta.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { invalidarMarcaDaInstalacao, marcaDaInstalacao } from "@/lib/branding/instalacao";
import {
  cssPersonalizadoDaInstalacao,
  invalidarCssPersonalizadoDaInstalacao,
} from "@/lib/branding/css-personalizado";
import { carregarComportamentoDaInstalacao } from "@/lib/instalacao/comportamento-servidor";
import { esquecerComportamento, invalidarComportamento } from "@/lib/instalacao/comportamento";
import {
  esquecerModoDeCadastro,
  invalidarModoDeCadastro,
  modoDeCadastro,
} from "@/lib/auth/politica-de-cadastro";
import { configuracaoDoGoogle, invalidarCredencialDoGoogle } from "@/lib/agenda/google/config";
import { appDaMeta, invalidarAppDaMeta } from "@/lib/channels/meta/app";

/** O banco: uma linha por tabela (`platform_config` por `chave`). `null` = sem linha. */
let banco: Record<string, Record<string, unknown> | null> = {};
let idasAoBanco = 0;

/**
 * UM render em andamento: a tabela da deduplicação do Next. `null` = fora de
 * render, onde o Next não deduplica (o `React.cache` que a sustenta só tem
 * escopo dentro de um render).
 */
let render: Map<string, Response> | null = null;

function responder(corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function doBanco(url: URL, init: RequestInit | undefined): Promise<Response> {
  idasAoBanco += 1;
  const caminho = url.pathname.replace(/^\/rest\/v1\//, "");
  if (caminho.startsWith("rpc/")) {
    // `fn_decrypt_oauth`: "decifra" devolvendo o próprio texto marcado.
    const { ciphertext } = JSON.parse(String(init?.body ?? "{}")) as { ciphertext: string };
    return responder(`claro:${ciphertext}`);
  }
  const chave = url.searchParams.get("chave")?.replace(/^eq\./, "");
  const linha = banco[chave ? `${caminho}:${chave}` : caminho] ?? null;
  return responder(linha ? [linha] : []);
}

/** O `fetch` global como o Next o deixa num render — só a regra que importa aqui. */
async function fetchComoONext(
  entrada: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(entrada instanceof Request ? entrada.url : String(entrada));
  const metodo = (init?.method ?? "GET").toUpperCase();
  if (!render || init?.signal || metodo !== "GET") return doBanco(url, init);

  const chave = JSON.stringify([url.href, [...new Headers(init?.headers).entries()].sort()]);
  const guardada = render.get(chave);
  if (guardada) return guardada.clone();
  const resposta = await doBanco(url, init);
  render.set(chave, resposta.clone());
  return resposta;
}

const LINHA_DA_MARCA = {
  app_name: "Revenda XPTO",
  logo_url: null,
  logo_path: null,
  accent_hex: null,
  show_powered_by: true,
  // `false` mantém a leitura sem semeadura do `.env` — é o MEMO que se mede.
  seeded_from_env: false,
  fallback_at: null,
  fallback_reason: null,
};

interface Memo {
  nome: string;
  tabela: string;
  antes: Record<string, unknown> | null;
  depois: Record<string, unknown>;
  /** O que a tela lê, reduzido ao campo que a escrita muda. */
  ler: () => Promise<unknown>;
  invalidar: () => void;
  esperado: unknown;
}

const MEMOS: Memo[] = [
  {
    nome: "marca da instalação (lib/branding/instalacao.ts)",
    tabela: "platform_branding",
    antes: LINHA_DA_MARCA,
    depois: { ...LINHA_DA_MARCA, logo_path: "platform/logo-novo.png" },
    ler: async () => (await marcaDaInstalacao())?.logo_path ?? null,
    invalidar: invalidarMarcaDaInstalacao,
    esperado: "platform/logo-novo.png",
  },
  {
    nome: "CSS personalizado (lib/branding/css-personalizado.ts, lido por lib/instalacao/config.ts)",
    tabela: "platform_config:APP_CUSTOM_CSS",
    antes: {
      chave: "APP_CUSTOM_CSS",
      valor: "/* antes */",
      eh_segredo: false,
      semeado_do_env: false,
    },
    depois: {
      chave: "APP_CUSTOM_CSS",
      valor: "/* depois */",
      eh_segredo: false,
      semeado_do_env: false,
    },
    ler: cssPersonalizadoDaInstalacao,
    invalidar: invalidarCssPersonalizadoDaInstalacao,
    esperado: "/* depois */",
  },
  {
    nome: "comportamento da instalação (lib/instalacao/comportamento-servidor.ts)",
    tabela: "platform_settings",
    antes: { promessa_semantica: false },
    depois: { promessa_semantica: true },
    ler: async () => (await carregarComportamentoDaInstalacao()).promessa_semantica,
    invalidar: invalidarComportamento,
    esperado: true,
  },
  {
    nome: "modo de cadastro (lib/auth/politica-de-cadastro.ts)",
    tabela: "platform_settings",
    antes: { signup_mode: "aberto" },
    depois: { signup_mode: "so_convite" },
    ler: modoDeCadastro,
    invalidar: invalidarModoDeCadastro,
    esperado: "so_convite",
  },
  {
    nome: "credencial do Google Agenda (lib/agenda/google/config.ts)",
    tabela: "platform_google_oauth",
    antes: null,
    depois: { client_id: "id-gravado-pela-tela", client_secret_encrypted: "c1" },
    ler: async () => (await configuracaoDoGoogle("https://crm.exemplo.com"))?.clientId ?? null,
    invalidar: invalidarCredencialDoGoogle,
    esperado: "id-gravado-pela-tela",
  },
  {
    nome: "app da Meta (lib/channels/meta/app.ts)",
    tabela: "platform_meta_app",
    antes: null,
    depois: { app_secret_encrypted: "s1", verify_token_encrypted: "t1" },
    ler: async () => (await appDaMeta()).appSecret,
    invalidar: invalidarAppDaMeta,
    esperado: "claro:\\xs1",
  },
];

beforeEach(() => {
  banco = {};
  idasAoBanco = 0;
  render = null;
  vi.stubGlobal("fetch", fetchComoONext);
  for (const memo of MEMOS) memo.invalidar();
  esquecerComportamento();
  esquecerModoDeCadastro();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a deduplicação do fetch dentro de um render não reinstala a leitura de antes da escrita", () => {
  it("CONTROLE: pelo cliente de verdade, um GET sem `signal` no mesmo render recebe a 1ª resposta", async () => {
    // Sem este caso, os de baixo passariam verdes com um dublê que não
    // deduplica, e o conserto pareceria provado sem o defeito reproduzido.
    const ler = async () =>
      (
        await createAdminClient()
          .from("platform_settings")
          .select("signup_mode")
          .eq("id", 1)
          .maybeSingle()
      ).data as { signup_mode: string } | null;
    banco.platform_settings = { signup_mode: "aberto" };
    render = new Map();
    expect((await ler())?.signup_mode).toBe("aberto");
    banco.platform_settings = { signup_mode: "so_convite" };
    expect((await ler())?.signup_mode, "o 2º GET do render foi ao banco").toBe("aberto");
    expect(idasAoBanco).toBe(1);
  });

  it.each(MEMOS)("$nome", async (memo) => {
    banco[memo.tabela] = memo.antes;

    // 1. Um render começa com o memo vazio: a 1ª leitura vai ao banco.
    render = new Map();
    const antes = await memo.ler();
    expect(antes, "controle: o render começou lendo o valor de ANTES").not.toEqual(memo.esperado);

    // 2. No meio desse render, a escrita grava e invalida — a ordem de toda rota
    //    e server action que grava estas configurações.
    banco[memo.tabela] = memo.depois;
    memo.invalidar();

    // 3. O mesmo render lê de novo. O que esta chamada devolve não importa: a
    //    requisição dela começou antes da escrita.
    await memo.ler();
    render = null;

    // 4. Uma requisição NOVA tem de ver a escrita. Sem o `signal`, o passo 3
    //    recebeu da deduplicação a resposta do passo 1 e a memoizou por 30 s.
    expect(await memo.ler(), "uma requisição nova, depois da escrita, ainda a nega").toEqual(
      memo.esperado,
    );
  });
});
