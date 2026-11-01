/**
 * A PORTA DO LEAD ADS — issue #3768, fatias 1 e 1-bis.
 *
 * ## O que este arquivo mede, e por quê
 *
 * A rota é o único ponto da captação que é PÚBLICO: qualquer um na internet pode
 * postar nela. Por isso o centro da prova não é "o lead entrou", é **o que acontece
 * quando a entrega não é de quem diz ser** — e o que acontece quando ela é, mas o
 * aviso chegou sem as respostas, ou de uma página que ninguém reivindica.
 *
 * As decisões da fatia 1-bis, com o caso que as prova:
 *
 *   - o `GET` de verificação responde o `hub.challenge` e 403 quando o
 *     `verify_token` não confere → "GET de verificação";
 *   - o segredo da assinatura é o do APP (`appDaMeta()`), não uma cópia por fonte,
 *     e segredo ausente RECUSA → "assinatura";
 *   - o dono do lead é a PÁGINA, e não o token do path → "roteamento por página";
 *   - aviso sem respostas: busca autenticada quando a fonte ligou a opção, e
 *     IGNORADO com motivo nomeado quando não ligou (ou a busca falhou) → "as
 *     respostas que não vieram no aviso";
 *   - entrega velha ENTRA, com a idade no rastro → "entrega atrasada".
 *
 * O banco é o dublê de `tests/helpers/banco-falso-da-cobranca.ts`: ele grava cada
 * cadeia (tabela, método, argumentos), então os casos afirmam O QUE a rota mandou,
 * e não só o status. A Graph API é dublada no módulo (`buscarRespostasDoLead`):
 * aqui não há rede, e a peça que fala com a plataforma tem prova própria em
 * `lib/leads/lead-ads/respostas-na-meta.test.ts`.
 */
import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, operacao, type BancoFalso, type Cadeia } from "@/tests/helpers/banco-falso-da-cobranca";
import {
  ESPERADO_DO_EXEMPLO,
  entregaDoLeadAds,
} from "@/lib/leads/lead-ads/payload-de-exemplo";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_DA_PAGINA = "22222222-2222-4222-8222-222222222222";
const SEGREDO_DO_APP = "segredo-do-app-da-meta-de-teste";
const PATH_TOKEN = "token-do-caminho";

const h = vi.hoisted(() => ({
  criarLead: vi.fn(),
  registrar: vi.fn(),
  decifrar: vi.fn(),
  app: vi.fn(),
  busca: vi.fn(),
  banco: undefined as unknown,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => h.banco,
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: h.decifrar,
  encryptWebhookSecret: vi.fn(),
}));
vi.mock("@/lib/webhooks/captacao", () => ({
  registrarCaptacao: h.registrar,
  registrarCaptacaoRecusada: h.registrar,
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: h.criarLead,
}));
// O App da Meta tem suíte própria; aqui ele é o PISO do segredo, e o que este
// arquivo mede é o que a rota faz com ele (inclusive quando ele não existe).
vi.mock("@/lib/channels/meta/app", () => ({
  appDaMeta: h.app,
}));
vi.mock("@/lib/leads/lead-ads/respostas-na-meta", async (importarOriginal) => {
  const original = (await importarOriginal()) as Record<string, unknown>;
  return { ...original, buscarRespostasDoLead: h.busca };
});

/** A fonte do ENDEREÇO: não reivindica página; a busca nasce desligada. */
const FONTE_DA_URL = {
  id: "fonte-meta-1",
  name: "Formulário de captação",
  organization_id: ORG,
  default_pipeline_id: "pipe-1",
  default_stage_id: "stage-configurada",
  is_active: true,
  meta_page_id: null as string | null,
  meta_lead_retrieval: false,
  meta_page_token_encrypted: null as string | null,
};

/** A fonte que REIVINDICA a página do aviso — de outra organização, de propósito. */
const FONTE_DA_PAGINA = {
  id: "fonte-meta-2",
  name: "Formulário da página B",
  organization_id: ORG_DA_PAGINA,
  default_pipeline_id: "pipe-2",
  default_stage_id: "stage-b",
  is_active: true,
  meta_page_id: ESPERADO_DO_EXEMPLO.pageId as string | null,
  meta_lead_retrieval: true,
  meta_page_token_encrypted: "\\x00ff11" as string | null,
};

interface Estado {
  /** A fonte resolvida pelo `path_token` do path. */
  fonteDaUrl: typeof FONTE_DA_URL;
  /** As fontes que reivindicam páginas (resultado do filtro `in`). */
  donas: Array<typeof FONTE_DA_URL>;
  /** Cards que já existem no funil, por telefone normalizado. */
  cards: Array<{
    id: string;
    organization_id: string;
    contact_id: string;
    stage_id: string;
    phone_number: string;
    external_id: string;
  }>;
  /** Contatos que já existem, por telefone normalizado. */
  contatos: Array<{ id: string; organization_id: string; phone_number: string }>;
}

function estadoNovo(): Estado {
  return { fonteDaUrl: { ...FONTE_DA_URL }, donas: [], cards: [], contatos: [] };
}

let estado: Estado = estadoNovo();

/**
 * O banco desta rota: `webhook_sources` responde por token do path e por página,
 * e as leituras de card/contato casam pelo telefone normalizado do exemplo.
 */
function responder(cadeia: Cadeia) {
  if (cadeia.tabela === "webhook_sources") {
    if (operacao(cadeia) === "update") return {};
    const paginas = cadeia.passos.find((p) => p.metodo === "in" && p.args[0] === "meta_page_id")?.args[1];
    if (Array.isArray(paginas)) {
      return { data: estado.donas.filter((f) => f.meta_page_id && paginas.includes(f.meta_page_id)) };
    }
    const tokenDoPath = cadeia.passos.find((p) => p.metodo === "eq" && p.args[0] === "path_token")?.args[1];
    if (typeof tokenDoPath === "string") {
      return { data: tokenDoPath === PATH_TOKEN ? estado.fonteDaUrl : null };
    }
    return { data: estado.fonteDaUrl };
  }
  if (cadeia.tabela === "crm_leads") {
    // A idempotência da rota é por `external_id` (o `leadgen_id`), e não por
    // telefone: é o índice único `uniq_crm_leads_org_source_external` que
    // garante, e a leitura tem de casar com ele para o teste medir a mesma coisa.
    const peloLeadgen = cadeia.passos.find((p) => p.args[0] === "external_id")?.args[1];
    if (typeof peloLeadgen === "string") {
      const achado = estado.cards.find((c) => c.external_id === peloLeadgen);
      return { data: achado ?? null };
    }
    const telefone = cadeia.passos.find((p) => p.args[0] === "phone_number")?.args[1];
    const encontrado = estado.cards.find((c) => c.phone_number === telefone);
    return { data: encontrado ?? null };
  }
  if (cadeia.tabela === "contacts") {
    const telefone = cadeia.passos.find((p) => p.args[0] === "phone_number")?.args[1];
    const encontrado = estado.contatos.find((c) => c.phone_number === telefone);
    return { data: encontrado ?? null };
  }
  return {};
}

function banco(): BancoFalso {
  const falso = bancoFalso(responder);
  h.banco = falso.cliente;
  return falso;
}

function corpoAssinado(corpo: string, segredo = SEGREDO_DO_APP): string {
  return `sha256=${createHmac("sha256", segredo).update(corpo, "utf8").digest("hex")}`;
}

function requisicao(corpo: string, opcoes: { assinatura?: string | null; url?: string } = {}) {
  const assinatura = opcoes.assinatura === undefined ? corpoAssinado(corpo) : opcoes.assinatura;
  const headers = new Headers({ "content-type": "application/json" });
  if (assinatura !== null) headers.set("x-hub-signature-256", assinatura);
  return {
    url: opcoes.url ?? `http://localhost:3000/api/v1/webhooks/meta-lead-ads/${PATH_TOKEN}`,
    nextUrl: new URL(opcoes.url ?? `http://localhost:3000/api/v1/webhooks/meta-lead-ads/${PATH_TOKEN}`),
    headers,
    text: async () => corpo,
  };
}

async function carregarRota() {
  return import("./route");
}

async function entregar(
  corpo: string,
  opcoes: { assinatura?: string | null; token?: string } = {},
): Promise<Response> {
  const rota = await carregarRota();
  const req = requisicao(corpo, { assinatura: opcoes.assinatura });
  const resposta = await rota.POST(req as never, { params: Promise.resolve({ token: opcoes.token ?? PATH_TOKEN }) });
  return resposta as unknown as Response;
}

beforeEach(() => {
  estado = estadoNovo();
  h.criarLead.mockReset();
  h.registrar.mockReset();
  h.decifrar.mockReset();
  h.app.mockReset();
  h.busca.mockReset();

  h.app.mockResolvedValue({ appSecret: SEGREDO_DO_APP, verifyToken: "verify-token-do-app" });
  h.decifrar.mockResolvedValue("token-de-pagina-em-claro");
  h.busca.mockResolvedValue({
    ok: true,
    respostas: [
      { campo: "full_name", valor: "Maria Aparecida Souza" },
      { campo: "phone_number", valor: "+55 11 98888-7777" },
      { campo: "email", valor: "maria@exemplo.com.br" },
      { campo: "qual_o_seu_objetivo", valor: "Comprar nos próximos 30 dias" },
    ],
  });
  h.registrar.mockResolvedValue(undefined);
  // O escritor canônico devolve a LINHA do card (`{ id, …campos }`), e não um
  // envelope: é o contrato de `createLeadHandler(admin, { org, actor }, campos)`.
  h.criarLead.mockImplementation(async (_admin: unknown, _ctx: unknown, campos: Record<string, unknown>) => ({
    id: "card-novo",
    ...campos,
  }));
});

describe("GET — verificação da URL", () => {
  it("devolve o desafio em TEXTO PURO quando o verify_token confere", async () => {
    banco();
    const rota = await carregarRota();
    const req = requisicao("", {
      url:
        "http://localhost:3000/api/v1/webhooks/meta-lead-ads/qualquer-token" +
        "?hub.mode=subscribe&hub.verify_token=verify-token-do-app&hub.challenge=desafio-123",
    });

    const resposta = (await rota.GET(req as never, { params: Promise.resolve({ token: "qualquer-token" }) })) as Response;

    expect(resposta.status).toBe(200);
    // Texto puro, sem envelope `{data:…}`: a plataforma compara o corpo com o
    // desafio que mandou, e um JSON reprovaria a URL nova no cadastro.
    expect(resposta.headers.get("content-type")).toContain("text/plain");
    expect(await resposta.text()).toBe("desafio-123");
  });

  it("403 quando o verify_token NÃO confere — e não devolve o desafio", async () => {
    banco();
    const rota = await carregarRota();
    const req = requisicao("", {
      url:
        "http://localhost:3000/api/v1/webhooks/meta-lead-ads/qualquer-token" +
        "?hub.mode=subscribe&hub.verify_token=outro&hub.challenge=desafio-123",
    });

    const resposta = (await rota.GET(req as never, { params: Promise.resolve({ token: "qualquer-token" }) })) as Response;

    expect(resposta.status).toBe(403);
  });

  it("403 sem o desafio — e sem verify token configurado na instalação", async () => {
    banco();
    h.app.mockResolvedValue({ appSecret: null, verifyToken: null });
    const rota = await carregarRota();
    const req = requisicao("", {
      url: "http://localhost:3000/api/v1/webhooks/meta-lead-ads/x?hub.mode=subscribe&hub.verify_token=&hub.challenge=desafio",
    });
    const resposta = (await rota.GET(req as never, { params: Promise.resolve({ token: "x" }) })) as Response;
    expect(resposta.status).toBe(403);
  });
});

describe("POST — assinatura", () => {
  it("payload bom: assinatura do APP confere, o lead entra e responde `recebido`", async () => {
    const falso = banco();
    const corpo = entregaDoLeadAds();

    const resposta = await entregar(corpo);
    expect(resposta.ok).toBe(true);
    const json = (await resposta.json()) as { data: { recebido: boolean; leads: Array<{ desfecho: string; lead_id: string }>; ignorados: unknown[] } };
    expect(json.data.recebido).toBe(true);
    expect(json.data.leads).toHaveLength(1);
    expect(json.data.leads[0]!.desfecho).toBe("criado");
    expect(json.data.leads[0]!.lead_id).toBe("card-novo");
    // A entrega boa não tem nada a ignorar — a lista vazia é o "nada a esconder".
    expect(json.data.ignorados).toEqual([]);

    expect(h.criarLead).toHaveBeenCalledTimes(1);
    const [, ctx, campos] = h.criarLead.mock.calls[0]! as [
      unknown,
      { organization_id: string },
      Record<string, unknown>,
    ];
    expect(ctx.organization_id).toBe(ORG);
    expect(campos).toMatchObject({
      stage_id: "stage-configurada",
      external_id: ESPERADO_DO_EXEMPLO.leadgenId,
      source: "meta_ads",
    });

    // A IDENTIDADE mora na ficha (`contacts`), e não no card: é o INSERT do
    // contato que carrega nome, telefone e e-mail.
    const insertDoContato = falso.cadeias.find((c) => c.tabela === "contacts" && operacao(c) === "insert");
    expect(insertDoContato).toBeDefined();
    const linhaDoContato = insertDoContato!.passos.find((p) => p.metodo === "insert")!.args[0] as Record<string, unknown>;
    expect(linhaDoContato).toMatchObject({
      organization_id: ORG,
      name: ESPERADO_DO_EXEMPLO.nome,
      email: ESPERADO_DO_EXEMPLO.email,
      source: "meta_ads",
    });
    expect(String(linhaDoContato.phone_number)).toMatch(/^\+55/);
    // A leitura da fonte foi UMA, pelo token do path.
    const leituras = falso.cadeias.filter((c) => c.tabela === "webhook_sources" && operacao(c) === "select");
    expect(leituras.length).toBe(2); // a do path + a das páginas do aviso
  });

  it("assinatura ausente → 401 e NADA é lido do banco depois do corpo", async () => {
    const falso = banco();
    const resposta = await entregar(entregaDoLeadAds(), { assinatura: null });

    expect(resposta.status).toBe(401);
    const envelope = (await resposta.json()) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("unauthorized");
    expect(envelope.error.message).toBe("assinatura_ausente");
    expect(h.criarLead).not.toHaveBeenCalled();
    // A fonte do path é lida antes (é o 404); nenhuma escrita acontece.
    expect(falso.cadeias.filter((c) => operacao(c) !== "select")).toEqual([]);
  });

  it("assinatura com OUTRO segredo → 401 assinatura_invalida", async () => {
    banco();
    const corpo = entregaDoLeadAds();
    const resposta = await entregar(corpo, { assinatura: corpoAssinado(corpo, "segredo-do-atacante") });

    expect(resposta.status).toBe(401);
    const envelope = (await resposta.json()) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("unauthorized");
    expect(envelope.error.message).toBe("assinatura_invalida");
    expect(h.criarLead).not.toHaveBeenCalled();
  });

  it("corpo alterado depois da assinatura → 401 (a HMAC cobre o corpo CRU)", async () => {
    banco();
    const corpo = entregaDoLeadAds();
    const resposta = await entregar(corpo.replace(ESPERADO_DO_EXEMPLO.nome, "Outra Pessoa"), {
      assinatura: corpoAssinado(corpo),
    });
    expect(resposta.status).toBe(401);
    expect(h.criarLead).not.toHaveBeenCalled();
  });

  it("instalação SEM segredo do App → 401 fechado, e não 200 generoso", async () => {
    banco();
    h.app.mockResolvedValue({ appSecret: null, verifyToken: null });
    const corpo = entregaDoLeadAds();
    // A assinatura é feita com o segredo que a instalação NÃO tem: nenhuma serve.
    const resposta = await entregar(corpo, { assinatura: corpoAssinado(corpo, "qualquer") });

    expect(resposta.status).toBe(401);
    const envelope = (await resposta.json()) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("unauthorized");
    // Distinto de `assinatura_ausente`: aqui não há segredo para conferir, e é a
    // instalação que está sem configuração — o motivo diz qual dos dois é.
    expect(envelope.error.message).toBe("segredo_ausente");
    expect(h.criarLead).not.toHaveBeenCalled();
  });

  it("token do path desconhecido → 404, e nada mais é lido", async () => {
    const falso = banco();
    const resposta = await entregar(entregaDoLeadAds(), { token: "nao-existe" });

    expect(resposta.status).toBe(404);
    expect(h.criarLead).not.toHaveBeenCalled();
    expect(falso.cadeias.filter((c) => operacao(c) !== "select")).toEqual([]);
  });
});

describe("POST — as respostas que não vieram no aviso", () => {
  it("busca DESLIGADA (o default): aviso sem respostas é IGNORADO com motivo nomeado", async () => {
    const falso = banco();
    const corpo = entregaDoLeadAds({ comRespostas: false });

    const resposta = await entregar(corpo);
    expect(resposta.ok).toBe(true);
    const json = (await resposta.json()) as { data: { leads: unknown[]; ignorados: Array<{ leadgen_id: string; motivo: string }> } };
    expect(json.data.leads).toEqual([]);
    // `sem_field_data` e não `sem_respostas_na_meta`: a busca nem foi tentada,
    // e a diferença é o que diz a quem opera "ligue a opção" em vez de "a
    // plataforma não respondeu".
    expect(json.data.ignorados).toEqual([
      { leadgen_id: ESPERADO_DO_EXEMPLO.leadgenId, motivo: "sem_field_data" },
    ]);
    expect(h.busca).not.toHaveBeenCalled();
    expect(h.criarLead).not.toHaveBeenCalled();
    expect(falso.cadeias.filter((c) => operacao(c) !== "select")).toEqual([]);
  });

  it("busca LIGADA e a plataforma responde: o lead entra com as respostas da busca", async () => {
    const falso = banco();
    estado.fonteDaUrl.meta_lead_retrieval = true;
    estado.fonteDaUrl.meta_page_token_encrypted = "\\x00ff22";

    const resposta = await entregar(entregaDoLeadAds({ comRespostas: false }));
    expect(resposta.ok).toBe(true);

    // A busca foi UMA, pelo id do lead, com o token DECIFRADO — nunca o cifrado.
    expect(h.busca).toHaveBeenCalledTimes(1);
    expect(h.busca.mock.calls[0]![0]).toEqual({
      leadgenId: ESPERADO_DO_EXEMPLO.leadgenId,
      token: "token-de-pagina-em-claro",
    });
    expect(h.decifrar).toHaveBeenCalledWith(expect.anything(), "\\x00ff22");

    expect(h.criarLead).toHaveBeenCalledTimes(1);
    const [, , campos] = h.criarLead.mock.calls[0]! as [unknown, unknown, Record<string, unknown>];
    expect(campos).toMatchObject({ external_id: ESPERADO_DO_EXEMPLO.leadgenId });

    // O que a busca devolveu é o que a ficha recebe: sem isso, o lead entraria em
    // branco, que é o defeito que a fatia 1-bis veio consertar.
    const insertDoContato = falso.cadeias.find((c) => c.tabela === "contacts" && operacao(c) === "insert");
    const linhaDoContato = insertDoContato!.passos.find((p) => p.metodo === "insert")!.args[0] as Record<string, unknown>;
    expect(linhaDoContato).toMatchObject({
      organization_id: ORG,
      name: "Maria Aparecida Souza",
      email: "maria@exemplo.com.br",
    });
    expect(String(linhaDoContato.phone_number)).toBe("+5511988887777");
  });

  it("busca LIGADA e a plataforma NÃO responde: ignorado `sem_respostas_na_meta`, sem dado inventado", async () => {
    const falso = banco();
    estado.fonteDaUrl.meta_lead_retrieval = true;
    estado.fonteDaUrl.meta_page_token_encrypted = "\\x00ff22";
    h.busca.mockResolvedValue({ ok: false, motivo: "recusada_pela_meta", detalhe: "http_401" });

    const resposta = await entregar(entregaDoLeadAds({ comRespostas: false }));
    expect(resposta.ok).toBe(true);
    const json = (await resposta.json()) as { data: { leads: unknown[]; ignorados: Array<{ motivo: string; detalhe?: string }> } };
    expect(json.data.leads).toEqual([]);
    expect(json.data.ignorados).toEqual([
      {
        leadgen_id: ESPERADO_DO_EXEMPLO.leadgenId,
        motivo: "sem_respostas_na_meta",
        detalhe: "recusada_pela_meta:http_401",
      },
    ]);
    // O ponto do desenho: NENHUM card em branco. Um lead sem nome não entra.
    expect(h.criarLead).not.toHaveBeenCalled();
    expect(falso.cadeias.filter((c) => operacao(c) !== "select")).toEqual([]);
  });

  it("busca LIGADA sem token de página colado: ignorado, e a plataforma não é chamada", async () => {
    banco();
    estado.fonteDaUrl.meta_lead_retrieval = true;
    estado.fonteDaUrl.meta_page_token_encrypted = null;

    const resposta = await entregar(entregaDoLeadAds({ comRespostas: false }));
    const json = (await resposta.json()) as { data: { ignorados: Array<{ motivo: string; detalhe?: string }> } };
    expect(json.data.ignorados[0]!.motivo).toBe("sem_respostas_na_meta");
    expect(json.data.ignorados[0]!.detalhe).toBe("sem_token_da_pagina");
    expect(h.busca).not.toHaveBeenCalled();
    expect(h.criarLead).not.toHaveBeenCalled();
  });

  it("token gravado que NÃO decifra: recusa nomeada, sem chamar a plataforma", async () => {
    banco();
    estado.fonteDaUrl.meta_lead_retrieval = true;
    estado.fonteDaUrl.meta_page_token_encrypted = "\\xdead";
    h.decifrar.mockResolvedValue(null);

    const resposta = await entregar(entregaDoLeadAds({ comRespostas: false }));
    const json = (await resposta.json()) as { data: { ignorados: Array<{ detalhe?: string }> } };
    expect(json.data.ignorados[0]!.detalhe).toBe("token_indecifravel");
    expect(h.busca).not.toHaveBeenCalled();
    expect(h.criarLead).not.toHaveBeenCalled();
  });
});

describe("POST — de quem é o lead: a PÁGINA, e não o token do path", () => {
  it("a fonte que reivindica a página é a dona, mesmo sendo de OUTRA organização", async () => {
    banco();
    estado.donas = [{ ...FONTE_DA_PAGINA, meta_page_id: ESPERADO_DO_EXEMPLO.pageId }];

    const resposta = await entregar(entregaDoLeadAds());
    expect(resposta.ok).toBe(true);

    // A URL é da fonte da org A; o lead é da página da org B. Sem o roteamento
    // por página, este card cairia no funil da org A.
    expect(h.criarLead).toHaveBeenCalledTimes(1);
    const [, ctx, campos] = h.criarLead.mock.calls[0]! as [
      unknown,
      { organization_id: string; actor: { type: string; id: string } },
      Record<string, unknown>,
    ];
    expect(ctx.organization_id).toBe(ORG_DA_PAGINA);
    expect(campos.stage_id).toBe("stage-b");
    expect(campos.pipeline_id).toBe("pipe-2");
    // O ator é a FONTE dona da página, e não a do endereço: é ela que a auditoria
    // e a timeline do card mostram.
    expect(ctx.actor).toEqual({ type: "webhook_source", id: "fonte-meta-2" });
  });

  it("página sem dona NÃO herda a fonte da URL quando ela reivindica outra página", async () => {
    banco();
    estado.fonteDaUrl.meta_page_id = "999888777";

    const resposta = await entregar(entregaDoLeadAds());
    expect(resposta.ok).toBe(true);
    const json = (await resposta.json()) as { data: { leads: unknown[]; ignorados: Array<{ motivo: string }> } };
    expect(json.data.leads).toEqual([]);
    expect(json.data.ignorados).toEqual([
      { leadgen_id: ESPERADO_DO_EXEMPLO.leadgenId, motivo: "pagina_sem_dono" },
    ]);
    expect(h.criarLead).not.toHaveBeenCalled();
  });

  it("página com dona DESLIGADA: ignorado `pagina_desligada`, nada é escrito", async () => {
    banco();
    estado.donas = [{ ...FONTE_DA_PAGINA, is_active: false }];

    const resposta = await entregar(entregaDoLeadAds());
    const json = (await resposta.json()) as { data: { ignorados: Array<{ motivo: string }> } };
    expect(json.data.ignorados).toEqual([
      { leadgen_id: ESPERADO_DO_EXEMPLO.leadgenId, motivo: "pagina_desligada" },
    ]);
    expect(h.criarLead).not.toHaveBeenCalled();
  });

  it("a busca usa o token DA PÁGINA dona, e o decifra UMA vez por entrega", async () => {
    banco();
    estado.donas = [{ ...FONTE_DA_PAGINA }];
    estado.fonteDaUrl.meta_lead_retrieval = true;
    // A fonte da URL tem token próprio; o lead é da página, então o token que vale
    // é o dela — usar o da URL seria buscar na página errada.
    estado.fonteDaUrl.meta_page_token_encrypted = "\\xcafe";

    // Duas entradas da MESMA página na mesma entrega: a decifra é uma RPC, e não
    // deve ser paga duas vezes.
    const corpo = JSON.stringify({
      object: "page",
      entry: [
        {
          id: ESPERADO_DO_EXEMPLO.pageId,
          time: Math.floor(Date.now() / 1000),
          changes: [
            { field: "leadgen", value: { leadgen_id: "111", page_id: ESPERADO_DO_EXEMPLO.pageId, form_id: "1" } },
            { field: "leadgen", value: { leadgen_id: "222", page_id: ESPERADO_DO_EXEMPLO.pageId, form_id: "1" } },
          ],
        },
      ],
    });

    const resposta = await entregar(corpo);
    expect(resposta.ok).toBe(true);
    expect(h.busca).toHaveBeenCalledTimes(2);
    expect(h.decifrar).toHaveBeenCalledTimes(1);
    expect(h.decifrar).toHaveBeenCalledWith(expect.anything(), "\\x00ff11");
  });
});

describe("POST — entrega atrasada", () => {
  it("aviso de duas horas atrás ENTRA, com a idade marcada no rastro da captação", async () => {
    banco();
    const agora = Math.floor(Date.now() / 1000);
    const corpo = entregaDoLeadAds({ entradaEm: agora - 7_200, comRespostas: false });
    estado.fonteDaUrl.meta_lead_retrieval = true;
    estado.fonteDaUrl.meta_page_token_encrypted = "\\x00ff22";

    const resposta = await entregar(corpo);
    expect(resposta.ok).toBe(true);
    const json = (await resposta.json()) as { data: { leads: Array<{ desfecho: string }> } };
    // O ponto: NÃO é 401. A plataforma reentrega por horas, e recusar aqui
    // perdia o lead de vez.
    expect(json.data.leads).toHaveLength(1);
    expect(json.data.leads[0]!.desfecho).toBe("criado");

    // A idade vai no `utm` da linha de captação: fica gravada, sem coluna nova.
    const [, captacao] = h.registrar.mock.calls[0]! as [unknown, { utm?: Record<string, string> }];
    const idade = Number(captacao.utm?.recebido_com_atraso_segundos);
    expect(Number.isFinite(idade)).toBe(true);
    expect(idade).toBeGreaterThanOrEqual(7_000);
  });

  it("entrega no prazo não carrega o carimbo de atraso", async () => {
    banco();
    const corpo = entregaDoLeadAds({ entradaEm: Math.floor(Date.now() / 1000) });
    await entregar(corpo);
    const [, captacao] = h.registrar.mock.calls[0]! as [unknown, { utm?: Record<string, string> }];
    // `undefined` e não `0`: "não sei a idade" é diferente de "chegou na hora".
    expect(captacao.utm).toBeUndefined();
  });
});

describe("POST — o mesmo aviso duas vezes", () => {
  it("reentrega do mesmo leadgen_id responde `duplicado`, sem segundo card nem segundo contato", async () => {
    const falso = banco();
    // O card já existe: o índice único e a busca por `external_id` devolvem o mesmo.
    estado.cards = [
      {
        id: "card-existente",
        organization_id: ORG,
        contact_id: "contato-existente",
        stage_id: "stage-configurada",
        phone_number: ESPERADO_DO_EXEMPLO.telefone,
        external_id: ESPERADO_DO_EXEMPLO.leadgenId,
      },
    ];
    estado.contatos = [
      { id: "contato-existente", organization_id: ORG, phone_number: ESPERADO_DO_EXEMPLO.telefone },
    ];

    const corpo = entregaDoLeadAds();
    const primeira = await entregar(corpo);
    const segunda = await entregar(corpo);

    expect(primeira.ok).toBe(true);
    expect(segunda.ok).toBe(true);
    const json = (await segunda.json()) as { data: { leads: Array<{ desfecho: string; lead_id: string }> } };
    // A segunda entrega NÃO é erro para a plataforma (200) e diz o que houve.
    expect(json.data.leads[0]!.desfecho).toBe("duplicado");
    expect(json.data.leads[0]!.lead_id).toBe("card-existente");
    expect(falso.cadeias.filter((c) => c.tabela === "crm_leads" && operacao(c) === "insert")).toEqual([]);
  });
});
