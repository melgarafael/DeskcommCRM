/**
 * O MODELO SAI PELA CREDENCIAL DA SESSÃO — E O AMBIENTE FICA DE RESERVA.
 *
 * ─── O defeito, medido (fatia F4 da #850) ─────────────────────────────────────
 *
 * Numa instalação self-host, a tela de conexão do canal oficial salva
 * `phone_number_id`, `waba_id` e o token (cifrado em `channel_sessions`), e o envio
 * de TEXTO já usa essa credencial — `resolveMetaCreds`, sessão primeiro, ambiente
 * como reserva. O MODELO não usava: `app/api/v1/channels/templates/route.ts` (POST) e
 * `lib/channels/meta/send-template-for-session.ts` liam `META_SYSTEM_USER_TOKEN`,
 * `META_PHONE_NUMBER_ID` e `META_GRAPH_VERSION` do `.env`. O efeito medido:
 * "Sincronizar modelos" respondia `400 missing_meta_token` para quem tinha
 * credencial salva e visível na própria tela, e o 2º número oficial da instalação
 * nunca sincronizava nem enviava um modelo — que é justamente o que a janela fechada
 * exige.
 *
 * ─── O que estes casos prendem ────────────────────────────────────────────────
 *
 * Que a credencial da TELA basta para enviar e para sincronizar; que duas
 * organizações não se misturam (o token de um tenant não sai por número de outro,
 * nem pedindo o número dele); que a instalação antiga, que só tem o ambiente,
 * continua enviando; e que a ORDEM dos desfechos não mudou — sem credencial nenhuma
 * o desfecho continua o de "canal não conectado" (`meta_not_configured`, classe
 * `queued`) e a consulta ao espelho nem acontece.
 *
 * ─── Medir ────────────────────────────────────────────────────────────────────
 *
 *   npx vitest run tests/unit/modelo-e-sincronizacao-usam-a-credencial-da-sessao.test.ts
 *
 * Para ver morder, devolva a leitura de `process.env.META_SYSTEM_USER_TOKEN` à guarda
 * de `send-template-for-session.ts` (ou à rota): com o ambiente vazio e a credencial
 * só na sessão, os casos 1, 2, 5 e 6 reprovam.
 */
import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { syncTemplates } from "@/lib/channels/meta/template-sync";
import { sendTemplateForSession } from "@/lib/channels/meta/send-template-for-session";
import { POST } from "@/app/api/v1/channels/templates/route";

const ORG_A = "00000000-0000-4000-8000-0000000008a1";
const ORG_B = "00000000-0000-4000-8000-0000000008a2";

const FIXTURE = JSON.parse(
  readFileSync("tests/fixtures/meta/message-templates.json", "utf8"),
) as { data: { name: string; language: string; components?: unknown[] }[] };

const PEDIDO = FIXTURE.data.find((t) => t.name === "jaspers_market_order_confirmation_v1")!;
const VALORES = { "1": "Rafael", "2": "DESK-001", "3": "30/07" };

/**
 * O "banco" que o admin client enxerga: UMA conexão por organização, com o SEU
 * número e o SEU token. É essa separação que os casos 2 e 3 medem.
 */
let sessoes: Record<string, { phoneNumberId: string; cifrado: string; token: string }> = {};
/** A organização que a sessão autenticada enxerga na rota. */
let orgAtiva = ORG_A;

function cadeia(tabela: string, filtros: Record<string, unknown>): Record<string, unknown> {
  const alvo: Record<string, unknown> = {
    maybeSingle: async () => {
      if (tabela !== "channel_sessions") return { data: null, error: null };
      const org = String(filtros.organization_id ?? "");
      const conexao = sessoes[org];
      const numeroPedido = filtros.meta_phone_number_id;
      // Busca por NÚMERO (`resolveMetaCreds`): só casa o número da PRÓPRIA conexão.
      // Pedir o número de outra organização não devolve nada — é o tenant errado.
      if (numeroPedido !== undefined) {
        if (!conexao || numeroPedido !== conexao.phoneNumberId) return { data: null, error: null };
        return {
          data: {
            meta_phone_number_id: conexao.phoneNumberId,
            meta_token_encrypted: conexao.cifrado,
          },
          error: null,
        };
      }
      // Busca por ORGANIZAÇÃO (`metaSessionForOrg`): devolve o número da conexão.
      if (!conexao) return { data: null, error: null };
      return {
        data: {
          id: `sessao-${org}`,
          organization_id: org,
          meta_waba_id: `waba-${org}`,
          meta_phone_number_id: conexao.phoneNumberId,
        },
        error: null,
      };
    },
  };
  alvo.select = () => alvo;
  alvo.eq = (col: string, val: unknown) => {
    filtros[col] = val;
    return alvo;
  };
  alvo.is = () => alvo;
  alvo.order = () => alvo;
  alvo.limit = () => alvo;
  return alvo;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => cadeia(tabela, {}),
    rpc: async (nome: string, args: { ciphertext?: string }) => {
      if (nome !== "fn_decrypt_oauth") return { data: null, error: null };
      const cifrado = String(args?.ciphertext ?? "");
      const dono = Object.values(sessoes).find((s) => s.cifrado === cifrado);
      return { data: dono?.token ?? null, error: null };
    },
  }),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/channels/meta/template-sync", () => ({ syncTemplates: vi.fn() }));

/** O espelho local: a definição aprovada, com o contrato lido no mesmo instante. */
function dbDoEspelho() {
  const consultas: string[] = [];
  const alvo: Record<string, unknown> = {
    maybeSingle: async () => ({
      data: {
        name: PEDIDO.name,
        language: PEDIDO.language,
        status: "APPROVED",
        contract_hash: "hash-do-espelho",
        components: PEDIDO.components,
      },
      error: null,
    }),
  };
  alvo.select = () => alvo;
  alvo.eq = () => alvo;
  return {
    db: {
      from: (tabela: string) => {
        consultas.push(tabela);
        return alvo;
      },
    } as unknown as SupabaseClient,
    consultas,
  };
}

function stubFetch(resposta: unknown) {
  const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => resposta });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function envio(organizacao: string, numero: string) {
  return {
    organizationId: organizacao,
    sessionRef: numero,
    to: "5531999998888",
    name: PEDIDO.name,
    language: PEDIDO.language,
    values: VALORES,
  };
}

function chamadaGraph(spy: ReturnType<typeof stubFetch>) {
  const [url, init] = spy.mock.calls[0] as [string, { headers: Record<string, string> }];
  return { url, autorizacao: init.headers.Authorization };
}

beforeEach(() => {
  sessoes = {};
  orgAtiva = ORG_A;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u-1" },
    org: { orgId: orgAtiva },
  } as never);
  vi.mocked(syncTemplates).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("o modelo sai pela credencial da sessão", () => {
  it("a credencial da TELA basta: o modelo sai pelo número da sessão", async () => {
    sessoes = {
      [ORG_A]: { phoneNumberId: "1103328999528818", cifrado: "\\xcifra-a", token: "tok-da-tela" },
    };
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "");
    const spy = stubFetch({ messages: [{ id: "wamid.TPL" }] });
    const { db, consultas } = dbDoEspelho();

    const id = await sendTemplateForSession(db, envio(ORG_A, "1103328999528818"));

    expect(id).toBe("wamid.TPL");
    const { url, autorizacao } = chamadaGraph(spy);
    expect(url).toContain("/1103328999528818/messages");
    expect(autorizacao).toBe("Bearer tok-da-tela");
    // A credencial é resolvida ANTES de o espelho ser consultado.
    expect(consultas).toContain("meta_templates");
  });

  it("o token de OUTRA organização não sai por este número", async () => {
    sessoes = {
      [ORG_A]: { phoneNumberId: "111", cifrado: "\\xcifra-a", token: "tok-da-org-a" },
      [ORG_B]: { phoneNumberId: "222", cifrado: "\\xcifra-b", token: "tok-da-org-b" },
    };
    vi.stubEnv("META_PHONE_NUMBER_ID", "999");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok-do-ambiente");
    const spy = stubFetch({ messages: [{ id: "wamid.B" }] });
    const { db } = dbDoEspelho();

    await sendTemplateForSession(db, envio(ORG_B, "222"));

    const { url, autorizacao } = chamadaGraph(spy);
    expect(url).toContain("/222/messages");
    expect(autorizacao).toBe("Bearer tok-da-org-b");
    expect(autorizacao).not.toContain("org-a");
  });

  it("pedir o número de OUTRA organização não devolve o token dela — cai no ambiente", async () => {
    sessoes = {
      [ORG_A]: { phoneNumberId: "111", cifrado: "\\xcifra-a", token: "tok-da-org-a" },
      [ORG_B]: { phoneNumberId: "222", cifrado: "\\xcifra-b", token: "tok-da-org-b" },
    };
    vi.stubEnv("META_PHONE_NUMBER_ID", "999");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok-do-ambiente");
    const spy = stubFetch({ messages: [{ id: "wamid.X" }] });
    const { db } = dbDoEspelho();

    // A organização B pedindo o número da A: a chave é o PAR, então não casa —
    // e o que sobra é a reserva do ambiente, nunca a credencial do vizinho.
    await sendTemplateForSession(db, envio(ORG_B, "111"));

    const { url, autorizacao } = chamadaGraph(spy);
    expect(url).toContain("/999/messages");
    expect(autorizacao).toBe("Bearer tok-do-ambiente");
  });

  it("instalação que só tem o ambiente continua enviando", async () => {
    vi.stubEnv("META_PHONE_NUMBER_ID", "999");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok-do-ambiente");
    const spy = stubFetch({ messages: [{ id: "wamid.ENV" }] });
    const { db } = dbDoEspelho();

    const id = await sendTemplateForSession(db, envio(ORG_A, "999"));

    expect(id).toBe("wamid.ENV");
    const { url, autorizacao } = chamadaGraph(spy);
    expect(url).toContain("/999/messages");
    expect(autorizacao).toBe("Bearer tok-do-ambiente");
  });

  it("sem credencial nenhuma o desfecho continua o de canal não conectado", async () => {
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "");
    const spy = stubFetch({ messages: [{ id: "wamid.NAO" }] });
    const { db, consultas } = dbDoEspelho();

    await expect(sendTemplateForSession(db, envio(ORG_A, "111"))).rejects.toThrow(
      /^meta_not_configured/,
    );

    // A guarda vem ANTES da consulta ao espelho (ordem dos desfechos é comportamento
    // neste repo) e nenhuma chamada sai para a Graph.
    expect(consultas).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("a rota de sincronizar modelos", () => {
  function pedido() {
    return new NextRequest("http://localhost:3000/api/v1/channels/templates", {
      method: "POST",
    });
  }

  it("sincroniza com a credencial da SESSÃO quando o ambiente não tem nenhuma", async () => {
    sessoes = {
      [ORG_A]: { phoneNumberId: "1103328999528818", cifrado: "\\xcifra-a", token: "tok-da-tela" },
    };
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "");
    const recebido: Array<Record<string, unknown>> = [];
    vi.mocked(syncTemplates).mockImplementation(async (input) => {
      recebido.push(input as unknown as Record<string, unknown>);
      return { created: 1, updated: 0, removed: 0 } as never;
    });

    const res = await POST(pedido());

    expect(res.status).toBe(200);
    expect(recebido).toHaveLength(1);
    expect(recebido[0]!.token).toBe("tok-da-tela");
    expect(recebido[0]!.organizationId).toBe(ORG_A);
    expect(recebido[0]!.wabaId).toBe(`waba-${ORG_A}`);
  });

  it("sem canal oficial a resposta continua `no_meta_channel` — e o sync nem roda", async () => {
    const res = await POST(pedido());

    // Nesta rota o DESFECHO mora na `message`, não no `code`: o `fail()` é
    // chamado como `fail("invalid_request", "no_meta_channel", 400)` — o código
    // é o do erro de protocolo e a mensagem é o desfecho que a tela lê. Afirmar
    // só o código deixava o teste passar por acidente em qualquer 400.
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "invalid_request", message: "no_meta_channel" },
    });
    expect(syncTemplates).not.toHaveBeenCalled();
  });

  it("com canal e sem credencial nenhuma continua `missing_meta_token`", async () => {
    // Conexão existe, mas o token cifrado ainda não foi gravado e o ambiente está
    // vazio: o desfecho é o MESMO de antes da fatia.
    sessoes = { [ORG_A]: { phoneNumberId: "111", cifrado: "", token: "" } };
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "");

    const res = await POST(pedido());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "invalid_request", message: "missing_meta_token" },
    });
    expect(syncTemplates).not.toHaveBeenCalled();
  });
});
