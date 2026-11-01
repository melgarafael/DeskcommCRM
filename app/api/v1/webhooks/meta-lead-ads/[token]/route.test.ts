/**
 * A PORTA DO LEAD ADS — os cinco casos que a fatia 1 precisa provar, mais a
 * janela.
 *
 * ## O que este arquivo mede, e por que cada caso existe
 *
 *   1. **payload bom**: entra no funil, na etapa CONFIGURADA na fonte, com o
 *      contato criado e a origem gravada;
 *   2. **assinatura ruim**: recusa em falha fechada — 401 e NENHUMA escrita;
 *   3. **payload sem `field_data`**: não processa nada, e diz por quê;
 *   4. **entrega repetida**: o mesmo `leadgen_id` responde 200 com marcador de
 *      duplicado e não cria segundo contato nem segundo card;
 *   5. **lead de telefone já existente**: o contato é reaproveitado pelo número
 *      normalizado, não duplicado;
 *   6. **fora de tempo**: entrega com `entry[].time` velho não processa nada.
 *
 * ## O dublê
 *
 * `bancoFalso` (o mesmo das rotas vizinhas) grava cada cadeia do PostgREST, e o
 * `responder` aqui FILTRA de verdade sobre um estado em memória (contatos e
 * cards). Filtro de mentira que devolve a linha para qualquer consulta esconde
 * justamente o defeito que o caso 4 mede: a segunda entrega achando o card da
 * primeira. `createLeadHandler` é dublado porque a régua dele já tem as próprias
 * suítes; o que se afirma aqui é O QUE a rota manda para ele.
 */
import { createHmac } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  argumentos,
  bancoFalso,
  operacao,
  valorDoFiltro,
  type BancoFalso,
  type Cadeia,
  type Resposta,
} from "@/tests/helpers/banco-falso-da-cobranca";
import { ESPERADO_DO_EXEMPLO, entregaDoLeadAds } from "@/lib/leads/lead-ads/payload-de-exemplo";

const h = vi.hoisted(() => ({
  criarLead: vi.fn(async (..._args: unknown[]) => ({ id: "lead-mock" })),
  registrar: vi.fn(async (..._args: unknown[]) => undefined),
  decifrar: vi.fn(async (..._args: unknown[]) => "segredo-do-app-da-meta" as string | null),
  banco: undefined as unknown as BancoFalso,
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: h.decifrar }));
vi.mock("@/lib/webhooks/captacao", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  registrarCaptacao: h.registrar,
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: h.criarLead }));

import { POST } from "./route";

const ORG = "org-1";
const TOKEN = "token-da-fonte-da-meta";
const SEGREDO = "segredo-do-app-da-meta";

/** A fonte de captação que o `path_token` resolve — funil e etapa CONFIGURADOS. */
const FONTE = {
  id: "fonte-meta-1",
  name: "Formulário de captação",
  organization_id: ORG,
  secret_encrypted: "\\x00ff00",
  default_pipeline_id: "pipe-1",
  default_stage_id: "stage-configurada",
  is_active: true,
};

interface ContatoGravado {
  id: string;
  name: string | null;
  phone_number: string | null;
  email: string | null;
}
interface CardGravado {
  id: string;
  contact_id: string | null;
  source: string;
  external_id: string;
}

/**
 * O estado que o dublê conhece. `contatos`/`cards` são escritos pelo dublê de
 * `createLeadHandler` e pelo INSERT de contato, e é sobre eles que as leituras
 * filtram — é o que faz o caso 4 medir a segunda entrega de verdade.
 */
const estado = {
  contatos: [] as ContatoGravado[],
  cards: [] as CardGravado[],
  proximoContato: 0,
  falharInsertDeContato: false as false | { code: string; message: string },
};

function responder(cadeia: Cadeia): Resposta {
  if (cadeia.tabela === "webhook_sources") {
    if (operacao(cadeia) === "update") return {};
    return { data: FONTE };
  }

  if (cadeia.tabela === "crm_leads") {
    const externalId = valorDoFiltro(cadeia, "eq", "external_id");
    const source = valorDoFiltro(cadeia, "eq", "source");
    const org = valorDoFiltro(cadeia, "eq", "organization_id");
    const achado =
      estado.cards.find(
        (c) => c.external_id === externalId && c.source === source && org === ORG,
      ) ?? null;
    return { data: achado };
  }

  if (cadeia.tabela === "contacts") {
    if (operacao(cadeia) === "insert") {
      if (estado.falharInsertDeContato) {
        return { data: null, error: estado.falharInsertDeContato };
      }
      const payload = argumentos(cadeia, "insert")?.[0] as Record<string, unknown>;
      const id = `contato-${estado.proximoContato++}`;
      estado.contatos.push({
        id,
        name: (payload.name as string | null) ?? null,
        phone_number: (payload.phone_number as string | null) ?? null,
        email: (payload.email as string | null) ?? null,
      });
      return { data: { id } };
    }
    const variantes = argumentos(cadeia, "in")?.[1] as string[] | undefined;
    if (variantes) {
      return {
        data: estado.contatos.filter(
          (c) => c.phone_number !== null && variantes.includes(c.phone_number),
        ),
      };
    }
    const email = valorDoFiltro(cadeia, "eq", "email_normalized");
    if (typeof email === "string") {
      return {
        data: estado.contatos.find((c) => (c.email ?? "").toLowerCase() === email) ?? null,
      };
    }
    const id = valorDoFiltro(cadeia, "eq", "id");
    return { data: id ? (estado.contatos.find((c) => c.id === id) ?? null) : null };
  }

  // `contact_phones`: nenhum número extra nesta organização.
  if (cadeia.tabela === "contact_phones") return { data: null };
  return {};
}

/** `sha256=<hex>` do corpo cru — exatamente o que a Meta manda. */
function assinar(corpo: string, segredo: string = SEGREDO): string {
  return `sha256=${createHmac("sha256", segredo).update(corpo, "utf8").digest("hex")}`;
}

async function entregar(
  corpo: string,
  opcoes: { assinatura?: string | null; token?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const assinatura = opcoes.assinatura === undefined ? assinar(corpo) : opcoes.assinatura;
  if (assinatura !== null) headers["x-hub-signature-256"] = assinatura;
  const req = new NextRequest(
    `http://localhost/api/v1/webhooks/meta-lead-ads/${opcoes.token ?? TOKEN}`,
    { method: "POST", body: corpo, headers },
  );
  return (await POST(req, {
    params: Promise.resolve({ token: opcoes.token ?? TOKEN }),
  })) as Response;
}

/** O corpo de sucesso, já desembrulhado do `{ data }` canônico. */
async function corpo(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const insertsDeContato = () =>
  h.banco.cadeias.filter((c) => c.tabela === "contacts" && operacao(c) === "insert");

const escritasEmCrmLeads = () =>
  h.banco.cadeias.filter(
    (c) => c.tabela === "crm_leads" && (operacao(c) === "insert" || operacao(c) === "upsert"),
  );

beforeEach(() => {
  estado.contatos = [];
  estado.cards = [];
  estado.proximoContato = 0;
  estado.falharInsertDeContato = false;
  h.registrar.mockClear();
  h.decifrar.mockClear();
  h.decifrar.mockImplementation(async () => SEGREDO);
  h.criarLead.mockReset();
  // O dublê do escritor canônico GRAVA o card no estado: sem isso a segunda
  // entrega não teria o que achar, e o caso 4 mediria um banco vazio.
  h.criarLead.mockImplementation(async (...args: unknown[]) => {
    const entrada = args[2] as Record<string, unknown>;
    const card: CardGravado = {
      id: `lead-${estado.cards.length + 1}`,
      contact_id: (entrada.contact_id as string | undefined) ?? null,
      source: entrada.source as string,
      external_id: entrada.external_id as string,
    };
    estado.cards.push(card);
    return { id: card.id };
  });
  h.banco = bancoFalso(responder);
});

describe("POST /api/v1/webhooks/meta-lead-ads/[token]", () => {
  it("payload bom: contato novo + card no funil e etapa CONFIGURADOS, com a origem gravada", async () => {
    const corpoDoEnvio = entregaDoLeadAds({ entradaEm: Math.floor(Date.now() / 1000) });
    const res = await entregar(corpoDoEnvio);
    expect(res.status).toBe(200);

    const dados = (await corpo(res)).data as {
      recebido: boolean;
      leads: Array<{ leadgen_id: string; desfecho: string; lead_id: string; contato_id: string }>;
      ignorados: unknown[];
    };
    expect(dados.recebido).toBe(true);
    expect(dados.ignorados).toEqual([]);
    expect(dados.leads).toHaveLength(1);
    expect(dados.leads[0]?.leadgen_id).toBe(ESPERADO_DO_EXEMPLO.leadgenId);
    expect(dados.leads[0]?.desfecho).toBe("criado");

    // O contato nasceu com o TELEFONE NORMALIZADO (E.164 canônico) e a origem
    // que a ficha lê.
    expect(insertsDeContato()).toHaveLength(1);
    const contato = argumentos(insertsDeContato()[0]!, "insert")?.[0] as Record<string, unknown>;
    expect(contato.organization_id).toBe(ORG);
    expect(contato.phone_number).toBe(ESPERADO_DO_EXEMPLO.telefone);
    expect(contato.name).toBe(ESPERADO_DO_EXEMPLO.nome);
    expect(contato.source).toBe("meta_ads");
    expect(contato.source_metadata).toMatchObject({
      ad_platform: "meta_ads",
      meta_lead_ads: {
        form_id: ESPERADO_DO_EXEMPLO.formId,
        leadgen_id: ESPERADO_DO_EXEMPLO.leadgenId,
      },
    });

    // O card: funil e etapa da FONTE, origem no mesmo vocabulário do Kanban e as
    // respostas do formulário como campos do negócio.
    expect(h.criarLead).toHaveBeenCalledTimes(1);
    const [, ctx, entrada] = h.criarLead.mock.calls[0]! as [
      unknown,
      { organization_id: string; actor: { type: string; id: string } },
      Record<string, unknown>,
    ];
    expect(ctx.organization_id).toBe(ORG);
    expect(ctx.actor).toEqual({ type: "webhook_source", id: FONTE.id });
    expect(entrada.pipeline_id).toBe("pipe-1");
    expect(entrada.stage_id).toBe("stage-configurada");
    expect(entrada.source).toBe("meta_ads");
    expect(entrada.tags).toEqual(["Meta_ads"]);
    expect(entrada.external_id).toBe(ESPERADO_DO_EXEMPLO.leadgenId);
    expect(entrada.webhook_source_id).toBe(FONTE.id);
    expect(entrada.contact_id).toBe(dados.leads[0]?.contato_id);
    expect(entrada.custom_fields).toMatchObject({
      qual_o_seu_objetivo: "Comprar nos próximos 30 dias",
      cidade: "São Paulo",
    });

    // O rastro durável da captação.
    expect(h.registrar).toHaveBeenCalledTimes(1);
    expect(h.registrar.mock.calls[0]?.[1]).toMatchObject({
      organizationId: ORG,
      outcome: "criado",
      capturedPhone: ESPERADO_DO_EXEMPLO.telefone,
    });
  });

  it("assinatura ruim é recusada em falha fechada — 401 e NENHUMA escrita", async () => {
    const corpoDoEnvio = entregaDoLeadAds({ entradaEm: Math.floor(Date.now() / 1000) });

    // (a) assinatura de outro segredo; (b) sem assinatura; (c) formato que não é
    // o da Meta. Os três têm de morrer na porta.
    const invalida = await entregar(corpoDoEnvio, { assinatura: assinar(corpoDoEnvio, "outro") });
    const ausente = await entregar(corpoDoEnvio, { assinatura: null });
    const formatoErrado = await entregar(corpoDoEnvio, { assinatura: "deadbeef" });

    for (const [res, motivo] of [
      [invalida, "assinatura_invalida"],
      [ausente, "assinatura_ausente"],
      [formatoErrado, "assinatura_invalida"],
    ] as const) {
      expect(res.status).toBe(401);
      const erro = (await corpo(res)).error as { code: string; message: string };
      expect(erro.code).toBe("unauthorized");
      expect(erro.message).toBe(motivo);
    }

    // Nada atravessou a porta: nem contato, nem card, nem captação.
    expect(insertsDeContato()).toHaveLength(0);
    expect(escritasEmCrmLeads()).toHaveLength(0);
    expect(h.criarLead).not.toHaveBeenCalled();
    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("segredo que não pôde ser lido recusa — 'não dá para conferir' é 'não confere'", async () => {
    // `decryptWebhookSecret` devolve `null` quando a GUC de cifra está ausente ou
    // o bytea está corrompido. A tentação é tratar isso como "fonte sem segredo,
    // então aceita" — e é ela que transforma a porta pública em entrada livre.
    h.decifrar.mockImplementation(async () => null);
    const res = await entregar(entregaDoLeadAds({ entradaEm: Math.floor(Date.now() / 1000) }));

    expect(res.status).toBe(401);
    expect((await corpo(res)).error).toMatchObject({
      code: "unauthorized",
      message: "segredo_ausente",
    });
    expect(insertsDeContato()).toHaveLength(0);
    expect(h.criarLead).not.toHaveBeenCalled();
  });

  it("payload sem field_data não processa nada e diz por quê", async () => {
    const semRespostas = entregaDoLeadAds({
      entradaEm: Math.floor(Date.now() / 1000),
      comRespostas: false,
    });
    const res = await entregar(semRespostas);
    expect(res.status).toBe(200);

    const dados = (await corpo(res)).data as {
      recebido: boolean;
      leads: unknown[];
      ignorados: Array<{ leadgen_id: string; motivo: string }>;
    };
    expect(dados.recebido).toBe(true);
    expect(dados.leads).toEqual([]);
    expect(dados.ignorados).toEqual([
      { leadgen_id: ESPERADO_DO_EXEMPLO.leadgenId, motivo: "sem_field_data" },
    ]);

    expect(insertsDeContato()).toHaveLength(0);
    expect(h.criarLead).not.toHaveBeenCalled();
    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("entrega repetida do MESMO lead: 200 com marcador de duplicado, sem segundo contato nem segundo card", async () => {
    const corpoDoEnvio = entregaDoLeadAds({ entradaEm: Math.floor(Date.now() / 1000) });

    const primeira = await entregar(corpoDoEnvio);
    expect(primeira.status).toBe(200);
    expect(
      ((await corpo(primeira)).data as { leads: Array<{ desfecho: string }> }).leads[0]?.desfecho,
    ).toBe("criado");

    // A Meta reentrega o mesmo corpo (retry por timeout): o `leadgen_id` é a
    // mesma pessoa, e o desfecho tem de ser 200 — senão ela reentrega para sempre.
    const segunda = await entregar(corpoDoEnvio);
    expect(segunda.status).toBe(200);
    const dados = (await corpo(segunda)).data as {
      leads: Array<{ leadgen_id: string; desfecho: string; lead_id: string }>;
    };
    expect(dados.leads[0]?.desfecho).toBe("duplicado");
    expect(dados.leads[0]?.leadgen_id).toBe(ESPERADO_DO_EXEMPLO.leadgenId);
    // O MESMO card da primeira entrega.
    expect(dados.leads[0]?.lead_id).toBe("lead-1");

    expect(insertsDeContato()).toHaveLength(1);
    expect(h.criarLead).toHaveBeenCalledTimes(1);
    expect(estado.cards).toHaveLength(1);
    // A segunda passagem registra o desfecho como duplicado, para a tela
    // "Leads recebidos" mostrar o retry em vez de escondê-lo.
    expect(h.registrar).toHaveBeenCalledTimes(2);
    expect(h.registrar.mock.calls[1]?.[1]).toMatchObject({ outcome: "duplicado" });
  });

  it("lead de telefone já existente reaproveita o contato em vez de criar outro", async () => {
    estado.contatos.push({
      id: "contato-existente",
      name: "Maria",
      phone_number: ESPERADO_DO_EXEMPLO.telefone,
      email: null,
    });

    const corpoDoEnvio = entregaDoLeadAds({
      entradaEm: Math.floor(Date.now() / 1000),
      // A MESMA pessoa, com o número escrito de outro jeito — é o caso real de
      // quem já é contato por WhatsApp e preenche o formulário.
      telefone: "+55 11 98888-7777",
      leadgenId: "1122334455667788",
    });
    const res = await entregar(corpoDoEnvio);
    expect(res.status).toBe(200);

    const dados = (await corpo(res)).data as {
      leads: Array<{ desfecho: string; contato_id: string }>;
    };
    expect(dados.leads[0]?.desfecho).toBe("criado");
    expect(dados.leads[0]?.contato_id).toBe("contato-existente");

    // Nenhum contato novo: o card aponta para a ficha que já existia.
    expect(insertsDeContato()).toHaveLength(0);
    expect(h.criarLead).toHaveBeenCalledTimes(1);
    const entrada = h.criarLead.mock.calls[0]?.[2] as { contact_id: string };
    expect(entrada.contact_id).toBe("contato-existente");
  });

  it("fora de tempo não processa nada — mesmo com a assinatura certa", async () => {
    // Duas horas atrás: o corpo é legítimo (assinado com o segredo), mas é uma
    // entrega velha — replay, ou fila parada além do aceitável.
    const velho = entregaDoLeadAds({ entradaEm: Math.floor(Date.now() / 1000) - 7200 });
    const res = await entregar(velho);
    expect(res.status).toBe(401);
    const erro = (await corpo(res)).error as { code: string; message: string };
    expect(erro.code).toBe("unauthorized");
    expect(erro.message).toBe("fora_de_tempo");

    expect(insertsDeContato()).toHaveLength(0);
    expect(h.criarLead).not.toHaveBeenCalled();
    expect(h.registrar).not.toHaveBeenCalled();
  });
});
