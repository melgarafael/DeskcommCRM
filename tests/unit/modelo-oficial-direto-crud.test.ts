import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Sessao from "@/lib/channels/meta/session";

/**
 * MODELO DE MENSAGEM: CRIAR, EDITAR E APAGAR PELO CRM TAMBÉM NO CANAL OFICIAL
 * DIRETO (#3635, fatia 1).
 *
 * ─── O que estava quebrado ───────────────────────────────────────────────────
 *
 * Quem usa o canal oficial DIRETO saía do CRM, criava o modelo no Gerenciador do
 * WhatsApp, esperava a aprovação e voltava para "Sincronizar". Quem usa o canal
 * de PARCEIRO já criava, editava e apagava pela tela. O modelo pertence à CONTA
 * (WABA), não ao tipo de conexão.
 *
 * ─── O que este arquivo prova, caso a caso ───────────────────────────────────
 *
 * 1. criar sai para `/{waba_da_sessao}/message_templates` com o token DA SESSÃO
 *    (duble de `fetch`: a URL e o header são asseridos, não o "chamou a
 *    plataforma");
 * 2. editar resolve o id da VARIANTE (nome + idioma) e faz `POST /{id}`;
 * 3. apagar manda o `hsm_id` (uma variante, não todas) e tira do espelho;
 * 4. apagar modelo EM USO pede confirmação (409) e não toca a plataforma;
 * 5. conexão sem `whatsapp_business_management` devolve 403 com o nome do
 *    escopo, em vez de 500/502 "não deu";
 * 6. conexão sem WABA para o número NÃO chama a plataforma — o isolamento entre
 *    contas é isso, e o erro é claro (409);
 * 7. CONTROLE CRÍTICO: o canal de PARCEIRO continua usando o host e o token
 *    dele, com o mesmo cliente (`lib/channels/templates-graph.ts`), sem herdar
 *    nada desta fatia.
 *
 * Medir: `pnpm exec vitest run tests/unit/modelo-oficial-direto-crud.test.ts`
 */
const h = vi.hoisted(() => ({
  role: vi.fn(),
  audit: vi.fn(),
  sync: vi.fn(),
  sessao: vi.fn(),
  wabaDoNumero: vi.fn(),
  creds: vi.fn(),
  credsParceiro: vi.fn(),
  consultas: [] as string[],
  apagados: [] as string[],
  linhasApagadas: [] as string[],
  espelho: [] as Record<string, unknown>[],
  tabelas: {} as Record<string, unknown[]>,
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/channels/meta/template-sync", () => ({ syncTemplates: h.sync }));
vi.mock("@/lib/channels/meta/session", async (original) => ({
  ...(await original<typeof Sessao>()),
  metaSessionForOrg: h.sessao,
  metaWabaDoNumero: h.wabaDoNumero,
}));
vi.mock("@/lib/channels/meta/credentials", () => ({ resolveMetaCreds: h.creds }));
vi.mock("@/lib/channels/graph-parceiro/credentials", () => ({
  resolveGraphPartnerCreds: h.credsParceiro,
  graphPartnerGraphBase: () => "https://cloud.do-parceiro.test/v1",
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      h.consultas.push(tabela);
      // O espelho OBEDECE aos filtros: um duble que devolve toda linha a qualquer
      // `eq` deixava passar o apagar que filtrava pela coluna errada (as linhas do
      // canal oficial têm `channel_session_id` nulo) e o modelo de OUTRA conexão.
      const filtros: ((r: Record<string, unknown>) => boolean)[] = [];
      let apagando = false;
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push((r) => r[c] === v), q),
        is: (c: string, v: unknown) => (filtros.push((r) => (r[c] ?? null) === v), q),
        in: (c: string, vs: unknown[]) => (filtros.push((r) => vs.includes(r[c])), q),
        not: () => q,
        order: () => q,
        limit: () => q,
        delete: () => {
          h.apagados.push(tabela);
          apagando = true;
          return q;
        },
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: async () => ({ error: null }),
        then: (ok: (r: unknown) => unknown) => {
          if (tabela !== "meta_templates") return ok({ data: h.tabelas[tabela] ?? [], error: null });
          const linhas = h.espelho.filter((r) => filtros.every((f) => f(r)));
          if (apagando) h.linhasApagadas.push(...linhas.map((r) => String(r.id)));
          return ok({ data: linhas, error: null });
        },
      };
      return q;
    },
  }),
}));

import { GET, POST } from "@/app/api/v1/channels/templates/route";
import { graphPartnerTemplateOps } from "@/lib/channels/graph-parceiro/templates";

const URL_ROTA = "https://crm.test/api/v1/channels/templates";
const post = (body: unknown) => {
  // A rota sempre recebeu corpo (o "Sincronizar" manda `{}`).
  const texto = body === undefined ? undefined : JSON.stringify(body);
  return POST(new NextRequest(URL_ROTA, { method: "POST", body: texto }));
};

const CORPO = [{ type: "BODY", text: "Olá {{1}}", example: { body_text: [["Ana"]] } }];
const ALVO = { name: "boas_vindas", language: "pt_BR" };

const AUTORIZADO = {
  ok: true,
  org: { orgId: "org-da-sessao" },
  user: { id: "u-1", idioma: "pt-BR" },
};

/** A sessão oficial desta organização: número e conta amarrados na MESMA linha. */
const SESSAO = {
  id: "sess-oficial-1",
  organizationId: "org-da-sessao",
  wabaId: "WABA-DA-SESSAO",
  phoneNumberId: "PN-DA-SESSAO",
};

/**
 * As duas linhas do espelho com o MESMO nome e idioma, como o banco as grava: a
 * do canal oficial chaveia pela WABA e deixa a conexão nula
 * (`lib/channels/meta/template-sync.ts`); a do parceiro grava a conexão dele e a
 * conta do provedor no lugar da WABA (`partner/templates`).
 */
const LINHA_OFICIAL = {
  id: "tpl-oficial",
  organization_id: "org-da-sessao",
  channel_session_id: null,
  waba_id: "WABA-DA-SESSAO",
  ...ALVO,
};
const LINHA_DO_PARCEIRO = {
  id: "tpl-parceiro",
  organization_id: "org-da-sessao",
  channel_session_id: "sess-parceiro",
  waba_id: "WABA-DO-PARCEIRO",
  ...ALVO,
};

const fetchOk = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** A chamada que saiu de verdade, como URL + headers + corpo. */
function chamada(n: number) {
  const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[n]!;
  return { url: String(url), init, headers: (init?.headers ?? {}) as Record<string, string> };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.consultas = [];
  h.apagados = [];
  h.linhasApagadas = [];
  h.espelho = [];
  h.tabelas = {};
  h.role.mockResolvedValue(AUTORIZADO);
  h.sessao.mockResolvedValue(SESSAO);
  h.wabaDoNumero.mockResolvedValue("WABA-DA-SESSAO");
  // O duble responde pelo NÚMERO PEDIDO — e é isso que impede o teste de passar
  // por acidente: a rota resolve a credencial uma vez para o sync e o binding
  // resolve DE NOVO para a chamada de gestão. Se a segunda resolução pedir o
  // número do ambiente (o comportamento de antes da fatia), ela recebe o token de
  // OUTRA conta, e a asserção do header pega.
  h.creds.mockImplementation(
    async (_db: unknown, q: { phoneNumberId?: string }) =>
      q?.phoneNumberId === "PN-DA-SESSAO"
        ? {
            phoneNumberId: "PN-DA-SESSAO",
            token: "token-da-sessao",
            graphVersion: "v22.0",
            source: "session",
          }
        : {
            phoneNumberId: q?.phoneNumberId ?? "",
            token: "token-do-ambiente",
            graphVersion: "v22.0",
            source: "env",
          },
  );
  h.sync.mockResolvedValue({ inserted: 0, updated: 0, unchanged: 0, disabled: 0 });
  h.credsParceiro.mockResolvedValue({
    channelSessionId: "sess-parceiro",
    phoneNumberId: "PN-PARCEIRO",
    wabaId: "WABA-DO-PARCEIRO",
    token: "sk_live_do_parceiro",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("canal oficial direto — criar", () => {
  it("⭐ cria na WABA da SESSÃO, com o token da sessão (não o do ambiente)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(fetchOk({ id: "tpl-novo", name: "boas_vindas", status: "PENDING" }));

    const res = await post({ acao: "criar", ...ALVO, category: "UTILITY", components: CORPO });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const { url, init, headers } = chamada(0);
    // A CONTA sai da sessão oficial, e o caminho é o da coleção de modelos dela.
    expect(url).toContain("graph.facebook.com");
    expect(url).toContain("/WABA-DA-SESSAO/message_templates");
    expect(headers.Authorization).toBe("Bearer token-da-sessao");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: "boas_vindas",
      language: "pt_BR",
      category: "UTILITY",
      components: CORPO,
    });
    // A credencial foi pedida com o NÚMERO da sessão (não com id de conta), e a
    // ÚLTIMA resolução é a que assina a chamada — a rota resolve antes para o
    // sync, e é a segunda que importa aqui.
    expect(h.creds).toHaveBeenLastCalledWith(expect.anything(), {
      organizationId: "org-da-sessao",
      phoneNumberId: "PN-DA-SESSAO",
    });
    expect(h.wabaDoNumero).toHaveBeenCalledWith("org-da-sessao", "PN-DA-SESSAO");
    // A organização vem da SESSÃO: um corpo mandando outra não muda o dono.
    expect(h.creds.mock.calls.at(-1)![1]).toMatchObject({ organizationId: "org-da-sessao" });
    // E o espelho é atualizado depois da resposta da plataforma.
    expect(h.sync).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-da-sessao", wabaId: "WABA-DA-SESSAO" }),
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template.created", actorUserId: "u-1" }),
    );
  });

  it("corpo inválido é 422 e não toca a plataforma nem a conta", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const corpo of [
      { acao: "criar", name: "x", language: "pt_BR" },
      { acao: "criar", ...ALVO, category: "OUTRA", components: CORPO },
      { acao: "inventada", ...ALVO },
    ]) {
      expect((await post(corpo)).status, JSON.stringify(corpo)).toBe(422);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("sem `acao` continua sendo SINCROZINAR — o botão antigo não muda", async () => {
    await post({});
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("canal oficial direto — editar", () => {
  it("⭐ edita a VARIANTE: resolve o id por nome+idioma e faz POST no nó dela", async () => {
    h.espelho = [LINHA_OFICIAL];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        fetchOk({
          data: [
            { id: "777", name: "boas_vindas", language: "pt_BR" },
            { id: "888", name: "boas_vindas", language: "en_US" },
          ],
        }),
      )
      .mockResolvedValueOnce(fetchOk({ success: true, id: "777", name: "boas_vindas" }));

    // O corpo tem variável, então leva a amostra: sem ela a régua da #3635
    // recusa o payload antes de chegar aqui — e o que este caso mede é o
    // caminho de EDIÇÃO (id da variante + POST no nó), não a validação.
    const NOVOS = [{ type: "BODY", text: "Oi {{1}}", example: { body_text: [["Ana"]] } }];
    const res = await post({ acao: "editar", ...ALVO, components: NOVOS });

    expect(res.status).toBe(200);
    expect(h.creds).toHaveBeenLastCalledWith(expect.anything(), {
      organizationId: "org-da-sessao",
      phoneNumberId: "PN-DA-SESSAO",
    });
    const consulta = chamada(0);
    // A busca da variante é escopada pela WABA da sessão e pelo nome.
    expect(consulta.url).toContain("/WABA-DA-SESSAO/message_templates");
    expect(consulta.url).toContain("&name=boas_vindas");
    const edicao = chamada(1);
    // O caminho da edição é SÓ o id (OpenAPI `editar-template`).
    expect(edicao.url).toMatch(/\/777$/);
    expect(edicao.init.method).toBe("POST");
    expect(JSON.parse(String(edicao.init.body))).toEqual({ components: NOVOS });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template.updated", actorUserId: "u-1" }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("canal oficial direto — apagar", () => {
  it("⭐ apaga UMA variante (hsm_id) e tira a linha do espelho", async () => {
    h.espelho = [LINHA_OFICIAL, LINHA_DO_PARCEIRO];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(fetchOk({ data: [{ id: "5400801403478858", name: "boas_vindas", language: "pt_BR" }] }))
      .mockResolvedValueOnce(fetchOk({ success: true }));

    const res = await post({ acao: "apagar", ...ALVO, confirmado: true });

    expect(res.status).toBe(200);
    expect(h.creds).toHaveBeenLastCalledWith(expect.anything(), {
      organizationId: "org-da-sessao",
      phoneNumberId: "PN-DA-SESSAO",
    });
    const remocao = chamada(1);
    // Sem `hsm_id` o DELETE levaria TODOS os idiomas daquele nome (#1734).
    expect(remocao.url).toContain("/WABA-DA-SESSAO/message_templates?name=boas_vindas&hsm_id=5400801403478858");
    expect(remocao.init.method).toBe("DELETE");
    expect(h.apagados).toContain("meta_templates");
    // Sai do espelho a linha DA CONTA OFICIAL — e só ela: a do parceiro, com o
    // mesmo nome, é de outra conta e continua existindo lá.
    expect(h.linhasApagadas).toEqual(["tpl-oficial"]);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template.deleted", actorUserId: "u-1" }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("apagar modelo EM USO responde 409 com onde ele está, e não apaga", async () => {
    h.espelho = [LINHA_OFICIAL];
    h.tabelas.followup_flow_pointers = [
      { name: "Remarketing", active_version_id: null, draft_graph: { t: "tpl-oficial" } },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await post({ acao: "apagar", ...ALVO });

    expect(res.status).toBe(409);
    const j = (await res.json()) as { error: { code: string; details: { usos: string[] } } };
    expect(j.error.code).toBe("template_in_use");
    expect(j.error.details.usos).toEqual(["Follow-up «Remarketing»"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.apagados).not.toContain("meta_templates");
  });
});

describe("canal oficial direto — só o modelo DESTA conexão", () => {
  // O espelho é da organização inteira, e a aba oficial o lista assim. Um modelo
  // da conexão do PARCEIRO aparece ali — e editar/apagar pela rota oficial mira
  // a WABA oficial pelo NOME: apagar é irreversível na plataforma.
  it("⭐ editar modelo de OUTRA conexão é recusado e não toca a plataforma", async () => {
    h.espelho = [LINHA_DO_PARCEIRO];
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await post({ acao: "editar", ...ALVO, components: CORPO });

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("⭐ apagar modelo de OUTRA conexão é recusado, mesmo confirmado", async () => {
    h.espelho = [LINHA_DO_PARCEIRO];
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await post({ acao: "apagar", ...ALVO, confirmado: true });

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.apagados).not.toContain("meta_templates");
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("a lista marca quais modelos são DESTA conexão (os únicos com Editar/Apagar)", async () => {
    h.espelho = [
      { ...LINHA_OFICIAL, status: "APPROVED", components: [], parameter_format: "POSITIONAL" },
      { ...LINHA_DO_PARCEIRO, status: "APPROVED", components: [], parameter_format: "POSITIONAL" },
    ];

    const res = await GET();

    expect(res.status).toBe(200);
    const j = (await res.json()) as { data: { templates: { daConexao: boolean }[] } };
    expect(j.data.templates.map((t) => t.daConexao)).toEqual([true, false]);
  });
});

describe("canal oficial direto — recusas que precisam ser claras", () => {
  it("⭐ sem whatsapp_business_management devolve 403 com o escopo, não 502", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: "(#200) The client does not have whatsapp_business_management permission",
            code: 200,
            type: "OAuthException",
          },
        }),
        { status: 403 },
      ),
    );

    const res = await post({ acao: "criar", ...ALVO, components: CORPO });

    expect(res.status).toBe(403);
    const j = (await res.json()) as { error: { code: string; message: string } };
    expect(j.error.message).toContain("whatsapp_business_management");
  });

  it("⭐ conexão sem WABA para este número não chama a plataforma (isolamento)", async () => {
    // O número não é desta organização, ou a linha é anterior à 0144: sem conta,
    // não existe coleção de modelos a alcançar — e o erro diz QUAL é o problema.
    h.wabaDoNumero.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await post({ acao: "criar", ...ALVO, components: CORPO });

    expect(res.status).toBe(409);
    const j = (await res.json()) as { error: { message: string } };
    expect(j.error.message).toMatch(/WABA|conta/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("conexão oficial sem número gravado é 409 e não toca a plataforma", async () => {
    h.sessao.mockResolvedValue({ ...SESSAO, phoneNumberId: null });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const r = await post({ acao: "criar", ...ALVO, components: CORPO });

    expect(r.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sem canal oficial continua 400 `no_meta_channel` (desfecho de antes)", async () => {
    h.sessao.mockResolvedValue(null);
    const res = await post({ acao: "criar", ...ALVO, components: CORPO });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { message: "no_meta_channel" } });
  });
});

describe("CONTROLE CRÍTICO — o canal de PARCEIRO não mudou", () => {
  it("⭐ o parceiro continua listando no host DELE, com o token DELE", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fetchOk({ data: [{ name: "pedido_confirmado", language: "pt_BR", status: "APPROVED", components: [] }] }),
    );

    const lista = await graphPartnerTemplateOps.list({
      organizationId: "org-da-sessao",
      sessionRef: "PN-PARCEIRO",
    });

    expect(lista.map((t) => t.name)).toEqual(["pedido_confirmado"]);
    const { url, headers } = chamada(0);
    expect(url).toContain("cloud.do-parceiro.test");
    expect(url).toContain("/WABA-DO-PARCEIRO/message_templates");
    expect(headers.Authorization).toBe("Bearer sk_live_do_parceiro");
    // A credencial do parceiro é resolvida pela sessão DELE, não pela oficial.
    expect(h.credsParceiro).toHaveBeenCalledWith(expect.anything(), {
      organizationId: "org-da-sessao",
      phoneNumberId: "PN-PARCEIRO",
    });
    expect(h.creds).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * OS LIMITES E OS EXEMPLOS, CONFERIDOS ANTES DE FALAR COM A PLATAFORMA (#3635, 2).
 *
 * ─── O que estava errado ─────────────────────────────────────────────────────
 *
 * `components` viajava cru até a Meta. Um corpo de 1500 caracteres e uma
 * variável `{{n}}` sem amostra saíam daqui como se estivessem bons, e a recusa
 * voltava horas depois com um erro genérico — sem dizer qual campo estourou nem
 * qual variável ficou sem exemplo. O operador corrigia por tentativa.
 *
 * ─── O que estes casos prendem ───────────────────────────────────────────────
 *
 * 1. reprovado é 422 NOMEANDO o campo (`error.details`), não 502 "não deu";
 * 2. a fronteira é inclusiva: 1024 passa e chega na plataforma, 1025 não;
 * 3. o dublê de `fetch` NÃO é chamado nas recusas — sem chamada nova à Meta;
 * 4. editar é barrado pelo mesmo caminho que criar.
 */
describe("canal oficial direto — limites e exemplos ANTES da plataforma", () => {
  const corpoDe = (n: number, exemplo?: string[][]) => [
    { type: "BODY", text: "a".repeat(n), ...(exemplo ? { example: { body_text: exemplo } } : {}) },
  ];

  it("⭐ corpo de 1500 caracteres é 422 nomeando `corpo`, e a Meta NÃO é chamada", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await post({ acao: "criar", ...ALVO, category: "UTILITY", components: corpoDe(1500) });

    expect(res.status).toBe(422);
    const j = (await res.json()) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(j.error.details).toMatchObject({ campo: "corpo", atual: 1500, limite: 1024 });
    // A mensagem nomeia o campo, em vez de "erro ao criar modelo".
    expect(j.error.message).toContain("corpo");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("⭐ variável sem exemplo é 422 apontando o NÚMERO da variável", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await post({
      acao: "criar",
      ...ALVO,
      components: [
        { type: "BODY", text: "Olá {{1}}, seu pedido {{2}} saiu", example: { body_text: [["Ana"]] } },
      ],
    });

    expect(res.status).toBe(422);
    const j = (await res.json()) as {
      error: { message: string; details: Record<string, unknown> };
    };
    expect(j.error.details).toMatchObject({ campo: "exemploDaVariavel", variavel: 2 });
    // O número tem de estar na mensagem: "variável sem exemplo" não diz qual.
    expect(j.error.message).toContain("2");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fronteira: 1024 passa e chega na Meta; 1025 não sai daqui", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(fetchOk({ id: "tpl-novo", name: "boas_vindas", status: "PENDING" }));

    const ok1024 = await post({ acao: "criar", ...ALVO, components: corpoDe(1024) });
    expect(ok1024.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const nao1025 = await post({ acao: "criar", ...ALVO, components: corpoDe(1025) });
    expect(nao1025.status).toBe(422);
    // A chamada do caso de 1024 continua sendo a ÚNICA: a de 1025 não saiu.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("editar é barrado pelo MESMO caminho — e antes de resolver o id na Meta", async () => {
    h.espelho = [LINHA_OFICIAL];
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await post({
      acao: "editar",
      ...ALVO,
      components: [{ type: "FOOTER", text: "b".repeat(61) }],
    });

    expect(res.status).toBe(422);
    const j = (await res.json()) as { error: { details: Record<string, unknown> } };
    expect(j.error.details).toMatchObject({ campo: "rodape", atual: 61, limite: 60 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("botão com texto acima de 25 é 422 com o índice do botão", async () => {
    const res = await post({
      acao: "criar",
      ...ALVO,
      components: [
        { type: "BODY", text: "Olá" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Ok" },
            { type: "QUICK_REPLY", text: "c".repeat(26) },
          ],
        },
      ],
    });

    expect(res.status).toBe(422);
    const j = (await res.json()) as { error: { details: Record<string, unknown> } };
    expect(j.error.details).toMatchObject({ campo: "textoDoBotao", botao: 2, limite: 25 });
  });

  it("o caminho feliz continua 200 — corpo com variável E exemplo passa", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(fetchOk({ id: "tpl-novo", status: "PENDING" }));

    const res = await post({ acao: "criar", ...ALVO, components: CORPO });

    expect(res.status).toBe(200);
    expect(h.sync).toHaveBeenCalledTimes(1);
  });
});

/**
 * QUEM NÃO É `admin` E A RECUSA DO CONTEÚDO (#3635, fatia 1) — os dois desfechos
 * que faltavam prender.
 *
 * ─── Por que estes dois ──────────────────────────────────────────────────────
 *
 * 1. `admin` é a única porta da ESCRITA. Ele já era exigido, mas nenhum caso
 *    provava que a recusa acontece ANTES da plataforma: um `requireRole`
 *    movido para depois do `fetch` (ou um ramo novo que o ignore) continuaria
 *    "verde" na asserção de status, enquanto um `agent` conseguiria criar
 *    modelo na conta da empresa. Aqui a prova é a chamada NÃO existir.
 *
 * 2. A recusa do CONTEÚDO pela plataforma chegava como `502` com o texto cru:
 *    "erro do servidor" para um nome repetido ou um componente fora do formato.
 *    O caso prende o desfecho que o operador lê (422, na língua dele) e o motivo
 *    da plataforma em `details` — e, no mesmo caso, que o canal de PARCEIRO não
 *    herdou nada disto: ele segue com a mensagem crua, que é o contrato dele.
 */
describe("canal oficial direto — admin obrigatório e recusa legível da plataforma", () => {
  it("⭐ sem `admin` a escrita é recusada ANTES da plataforma (nenhuma chamada)", async () => {
    h.role.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: { code: "forbidden_role", message: "forbidden_role" } },
        { status: 403, headers: { "x-request-id": "req-recusa" } },
      ),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await post({ acao: "criar", ...ALVO, category: "UTILITY", components: CORPO });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "forbidden_role" } });
    // E o papel exigido é `admin`, não "algum papel": um `orgOrFail` trocado por
    // `agent` deixaria um convidado criar modelo na conta da empresa, e o 403
    // acima continuaria verde porque o dublê nega qualquer papel.
    expect(h.role).toHaveBeenCalledWith(
      "admin",
      expect.objectContaining({ resource: "channels_templates" }),
    );
    // A prova que importa: o corpo era VÁLIDO e mesmo assim nada saiu daqui.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    // E a credencial nem foi resolvida: a recusa é antes de qualquer I/O de conta.
    expect(h.creds).not.toHaveBeenCalled();
    expect(h.sessao).not.toHaveBeenCalled();
  });

  it("⭐ recusa do CONTEÚDO vira 422 legível com o motivo — e o parceiro não muda", async () => {
    h.espelho = [LINHA_OFICIAL];
    const MOTIVO = "Invalid parameter: name is already in use";
    // A plataforma recusa o payload: 4xx com código e motivo no corpo.
    // `mockImplementation` e não `mockResolvedValue`: o corpo de uma `Response` só
    // pode ser lido UMA vez, e o mesmo objeto servido às duas chamadas (oficial e
    // parceiro) chegaria vazio na segunda.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ error: { message: MOTIVO, code: 100, type: "OAuthException" } }),
        { status: 400 },
      ),
    );

    const res = await post({ acao: "criar", ...ALVO, category: "UTILITY", components: CORPO });

    // 422, não 502: o defeito é do MODELO, não do servidor.
    expect(res.status).toBe(422);
    const j = (await res.json()) as {
      error: { code: string; message: string; details: { codigo: string; motivo: string } };
    };
    expect(j.error.code).toBe("validation_failed");
    // Mensagem na língua da tela, dizendo O QUE conferir — e nada de "erro do servidor".
    expect(j.error.message).toContain("recusou o modelo");
    expect(j.error.message).not.toMatch(/internal_error|502/);
    // O motivo da plataforma chega preservado, em `details` (diagnóstico, não interface).
    expect(j.error.details).toMatchObject({ codigo: "100", motivo: MOTIVO });
    // Recusa não sincroniza nem audita: nada foi gravado.
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // ─── CONTROLE: o canal de PARCEIRO segue com o contrato DELE ───────────────
    // O mesmo 400, pelo binding do parceiro: a mensagem crua continua saindo
    // (é o que a rota dele já devolvia), sem a tradução desta fatia.
    await expect(
      graphPartnerTemplateOps.create({
        organizationId: "org-da-sessao",
        sessionRef: "PN-PARCEIRO",
        draft: { name: "boas_vindas", language: "pt_BR", category: "UTILITY", components: CORPO },
      }),
    ).rejects.toThrow(MOTIVO);
  });
});

