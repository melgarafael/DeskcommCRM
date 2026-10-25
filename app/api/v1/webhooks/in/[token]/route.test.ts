import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  argumentos,
  bancoFalso,
  filtros,
  operacao,
  valorDoFiltro,
  type BancoFalso,
  type Cadeia,
  type Resposta,
} from "@/tests/helpers/banco-falso-da-cobranca";

/**
 * #3357 — O PRIMEIRO ENVIO DE UM `external_id` INÉDITO ADOTA O CARD ABERTO DO
 * CONTATO (e carimba o id nele).
 *
 * ## O defeito medido, na voz de quem o abriu
 *
 * Com a opção "Reaproveitar o card aberto do contato" ligada, o reuso existia só
 * no ramo SEM `external_id` (o portão `if (!externalId)`). O caso de quem
 * integra de verdade — o da #3101, que usa `external_id` para o 2º evento
 * atualizar o 1º (#2316) — ficava de fora:
 *
 *   1. a pessoa chega pelo WhatsApp e a IA abre o card dela no funil "Vendas";
 *   2. ela cria conta no sistema de fora; o webhook manda `external_id = <id da
 *      conta>` e o evento `trial_iniciado`. `findLeadByExternalId` não acha nada
 *      (é o 1º envio desse id) e a captação CRIA um 2º card no mesmo funil,
 *      mesmo com o contato casado e o card da conversa ABERTO;
 *   3. o evento seguinte (`trial_ativado`, mesmo id) atualiza o 2º card — o do
 *      WhatsApp fica parado. Um contato, dois cards abertos.
 *
 * ## O que este arquivo fixa
 *
 * 1. ⭐ com a opção LIGADA, o primeiro envio com id inédito ATUALIZA o card
 *    aberto do contato no funil da fonte e CARIMBA nele o `external_id` e o
 *    `webhook_source_id` — nenhum segundo card é criado;
 * 2. ⭐ o SEGUNDO envio do mesmo id casa por id (o fast-path do #2316), ACHANDO
 *    o card adotado pela leitura do carimbo — o card da conversa é
 *    `source: "whatsapp"` e a leitura de sempre (`source = "webhook"`) erra
 *    ele (#3366). O `stage` reservado é obedecido neste caminho;
 * 3. ⭐ um segundo `external_id` DISTINTO do mesmo contato cria o card do
 *    segundo id: dois ids, dois cards (#2316) — o card de um id não é adotado
 *    pelo outro, nem quando o carimbo veio de OUTRA fonte (#3366, portão 3);
 * 4. as regressões: id JÁ existente continua mandando (nem se procura card
 *    aberto), a opção (ou a coluna) desligada cria o card como hoje, e contato
 *    sem card aberto no funil da fonte cria o card como hoje;
 * 5. o carimbo é um compare-and-set: na corrida de dois primeiros envios
 *    simultâneos, o perdedor não reescreve a identidade do vencedor.
 *
 * O duplê é o `bancoFalso` das rotas vizinhas: ele grava cada cadeia do
 * PostgREST (tabela, método, argumentos), e é o que deixa o teste afirmar O QUE
 * a rota mandou ao banco — o payload do carimbo e os filtros dele —, e não só o
 * status HTTP. Neste arquivo ele filtra de verdade (#3366): um banco de mentira
 * que devolvia o card para qualquer filtro escondeu que o card adotado nunca é
 * achado pela leitura `source = "webhook"`.
 */

const h = vi.hoisted(() => ({
  registrar: vi.fn(async () => undefined),
  criarLead: vi.fn(async (..._args: unknown[]) => ({ id: "lead-novo" })),
  atualizarLead: vi.fn(async (..._args: unknown[]) => ({ id: "lead-whatsapp" })),
  moverLead: vi.fn(async (..._args: unknown[]) => ({ id: "lead-whatsapp" })),
  banco: undefined as unknown as BancoFalso,
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks/captacao", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  registrarCaptacao: h.registrar,
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: h.criarLead,
  updateLeadHandler: h.atualizarLead,
  moveLeadHandler: h.moverLead,
}));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ kickLocalPipeline: async () => undefined }));

import { POST } from "./route";

const ORG = "org-1";
const TOKEN = "token-da-fonte-0001";
const CARD_DA_CONVERSA = "lead-whatsapp";

/** A fonte com o reuso LIGADO — o estado de quem abre a issue. */
const FONTE = {
  id: "fonte-1",
  name: "Integração do produto",
  organization_id: ORG,
  // Sem segredo: a fonte entra pela rota pública (a assinatura é exigida no
  // PATCH da fonte, não na captação).
  secret_encrypted: null,
  default_pipeline_id: "pipe-1",
  default_stage_id: "stage-1",
  field_map: {},
  form_fields: [],
  redirect_to: null,
  is_active: true,
  authorize_ai_on_capture: false,
  /**
   * A opção IRMÃ (#2316) fica desligada na maioria dos casos de propósito: o
   * reenvio não pode ser confundido com a adoção que este arquivo mede.
   */
  update_existing_lead_on_capture: false,
  reuse_open_lead_on_capture: true,
};

const ETAPAS = [
  { id: "stage-1", name: "Em conversa", position: 1 },
  { id: "stage-2", name: "Teste iniciado", position: 2 },
];

/** O card que a CONVERSA abriu, na etapa de entrada do funil da fonte. */
const CARD_ABERTO = {
  id: CARD_DA_CONVERSA,
  contact_id: "contato-1",
  title: "Joana",
  custom_fields: { evento: "conversa_iniciada" },
  pipeline_id: "pipe-1",
  stage_id: "stage-1",
  /**
   * É como o card da conversa NASCE de verdade (`ORIGEM_DO_WHATSAPP`, em
   * `lib/channels/origem-do-negocio.ts`), e é isto que o review do #3366
   * cobrou medir: um card `source: "whatsapp"` não é achado pela leitura
   * `source = "webhook"` do `findLeadByExternalId` — só pelo carimbo.
   */
  source: "whatsapp",
  /** Card sem identidade de integração: é ele o adotável (#3366, portão 3). */
  external_id: null as string | null,
};

const CONTATO = { id: "contato-1", phone_number: "+5532984793302", name: "Joana" };

interface Mundo {
  fonte: Record<string, unknown>;
  /** O que `findLeadByExternalId` acha: `null` = o id é inédito. */
  porExternalId: Record<string, unknown> | null;
  /** O card aberto do contato no funil da fonte. */
  cardAberto: Record<string, unknown> | null;
  contato: Record<string, unknown> | null;
}

let m: Mundo;

/**
 * As colunas que o banco de mentira SABE comparar nas buscas de card por id.
 *
 * #3366: o banco de mentira anterior devolvia o card para QUALQUER filtro de
 * `external_id` e ignorava os outros — foi isso que escondeu que o card da
 * conversa (`source: "whatsapp"`) nunca é achado pela leitura
 * `source = "webhook"`. Ele agora filtra como o PostgREST filtra.
 */
const COLUNAS_FALSAS = new Set(["source", "webhook_source_id", "external_id"]);

/** A linha fake passa quando TODOS os filtros da cadeia batem. */
function casaNosFiltros(c: Cadeia, linha: Record<string, unknown> | null): boolean {
  if (!linha) return false;
  return filtros(c).every(([metodo, coluna, valor]) => {
    if (!COLUNAS_FALSAS.has(String(coluna))) return true;
    if (metodo === "eq") return linha[String(coluna)] === valor;
    if (metodo === "is") return (linha[String(coluna)] ?? null) === valor;
    return true;
  });
}

function responder(c: Cadeia): Resposta {
  if (c.tabela === "webhook_sources") return { data: m.fonte };
  if (c.tabela === "contacts") {
    // Duas leituras de `contacts` no caminho: a busca por grafias do telefone
    // (uma LISTA, que `escolherContatoCanonico` desempata) e o portão de titular
    // anonimizado do reenvio (uma linha).
    const colunas = String(argumentos(c, "select")?.[0] ?? "");
    if (colunas.includes("is_anonymized")) return { data: { is_anonymized: false } };
    return { data: m.contato ? [m.contato] : [] };
  }
  if (c.tabela === "crm_stages") return { data: ETAPAS };
  if (c.tabela === "crm_leads") {
    if (operacao(c) === "update") return { data: null };
    if (operacao(c) === "insert") return { data: { id: "lead-novo" } };
    // As buscas por id (o fast-path do #2316 e a leitura 2 do carimbo) filtram
    // `external_id` — e agora também respeitam o que veio junto.
    if (valorDoFiltro(c, "eq", "external_id") !== undefined)
      return { data: casaNosFiltros(c, m.porExternalId) ? m.porExternalId : null };
    return { data: m.cardAberto };
  }
  return { data: null };
}

async function enviar(corpo: Record<string, unknown>): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN}`, {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
  return (await POST(req, { params: Promise.resolve({ token: TOKEN }) })) as Response;
}

/** As leituras do card aberto do contato — a pergunta do #3101. */
const leiturasDoCardAberto = () =>
  h.banco.cadeias.filter(
    (c) =>
      c.tabela === "crm_leads" &&
      operacao(c) === "select" &&
      valorDoFiltro(c, "eq", "status") === "open",
  );

/** Os UPDATE que carimbam o id do envio no card (a coluna só existe neles). */
const carimbos = () =>
  h.banco.cadeias.filter((c) => {
    if (c.tabela !== "crm_leads" || operacao(c) !== "update") return false;
    const payload = argumentos(c, "update")?.[0] as Record<string, unknown> | undefined;
    return !!payload && "external_id" in payload;
  });

function desfecho(): string | undefined {
  const chamadas = h.registrar.mock.calls as unknown as Array<[unknown, { outcome?: string }]>;
  return chamadas.at(-1)?.[1]?.outcome;
}

/** O envio de quem cria conta no sistema de fora: id inédito e evento novo. */
const ENVIO_DO_TRIAL = {
  external_id: "conta-3357",
  nome: "Joana",
  telefone: "+5532984793302",
  evento: "trial_iniciado",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.criarLead.mockResolvedValue({ id: "lead-novo" });
  h.atualizarLead.mockResolvedValue({ id: CARD_DA_CONVERSA });
  h.moverLead.mockResolvedValue({ id: CARD_DA_CONVERSA });
  m = {
    fonte: { ...FONTE },
    porExternalId: null,
    cardAberto: { ...CARD_ABERTO },
    contato: { ...CONTATO },
  };
  h.banco = bancoFalso(responder, () => ({}));
});

describe("primeiro envio com external_id inédito adota o card aberto (#3357)", () => {
  it("⭐ adota o card da conversa e carimba nele o external_id e a fonte — nenhum segundo card", async () => {
    const res = await enviar(ENVIO_DO_TRIAL);

    expect(
      h.criarLead,
      "com a opção ligada o contato ficou com DOIS cards abertos no mesmo funil — o defeito da issue",
    ).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { lead_id: CARD_DA_CONVERSA } });

    // O id do envio passa a apontar para o card que a equipe já está tocando.
    const feitos = carimbos();
    expect(feitos).toHaveLength(1);
    expect(argumentos(feitos[0]!, "update")?.[0]).toEqual({
      external_id: "conta-3357",
      webhook_source_id: "fonte-1",
    });
    expect(filtros(feitos[0]!)).toEqual([
      ["eq", "organization_id", ORG],
      ["eq", "id", CARD_DA_CONVERSA],
      ["is", "external_id", null],
    ]);

    // O evento novo entra NELE — não num card novo.
    expect(h.atualizarLead.mock.calls[0]?.[2]).toBe(CARD_DA_CONVERSA);
    expect(h.atualizarLead.mock.calls[0]?.[3]).toEqual({
      custom_fields: { evento: "trial_iniciado" },
    });
    expect(desfecho()).toBe("atualizado");
  });

  it("⭐ o SEGUNDO envio do mesmo id acha o card ADOPTADO pelo carimbo e casa por id (#3366)", async () => {
    // O card que o primeiro envio adotou É o da conversa: `source: "whatsapp"`
    // (como ele nasce) com o id e a fonte gravados pelo carimbo. A leitura de
    // sempre (`source = "webhook"`) erra este card — é o achado do review.
    m.porExternalId = {
      ...CARD_ABERTO,
      external_id: "conta-3357",
      webhook_source_id: "fonte-1",
    };
    m.fonte = { ...FONTE, update_existing_lead_on_capture: true };

    const res = await enviar({ ...ENVIO_DO_TRIAL, evento: "trial_ativado", stage: "Teste iniciado" });

    expect(h.criarLead).not.toHaveBeenCalled();
    expect(carimbos()).toHaveLength(0);
    expect(
      leiturasDoCardAberto(),
      "o envio de um id já existente foi procurar card aberto: o id é quem manda",
    ).toHaveLength(0);

    // Duas leituras por id, nesta ordem: a de sempre (`source = "webhook"`,
    // que ERRA este card) e a do carimbo (`webhook_source_id` desta fonte,
    // que ACHA). Sem a segunda, o envio voltava para a procura de card aberto.
    const buscas = h.banco.cadeias.filter(
      (c) =>
        c.tabela === "crm_leads" &&
        operacao(c) === "select" &&
        valorDoFiltro(c, "eq", "external_id") !== undefined,
    );
    expect(buscas).toHaveLength(2);
    expect(valorDoFiltro(buscas[0]!, "eq", "source")).toBe("webhook");
    expect(valorDoFiltro(buscas[1]!, "eq", "webhook_source_id")).toBe("fonte-1");

    expect(h.atualizarLead.mock.calls[0]?.[2]).toBe(CARD_DA_CONVERSA);
    expect(h.atualizarLead.mock.calls[0]?.[3]).toEqual({
      custom_fields: { evento: "trial_ativado" },
    });
    // O `stage` reservado (#2316) é obedecido neste caminho — o segundo caso
    // vermelho do review, que morria ignorado quando o card não era achado.
    expect(h.moverLead.mock.calls[0]?.[3]).toEqual({ to_stage_id: "stage-2" });
    expect(desfecho()).toBe("atualizado");
    expect(res.status).toBe(200);
  });
});

describe("regressões do caminho com external_id (#3357)", () => {
  it("⭐ id JÁ existente continua mandando: atualiza o card DO ID, e o card aberto do contato não é tocado", async () => {
    m.fonte = { ...FONTE, update_existing_lead_on_capture: true };
    // O card que ESTA rota criou: `source: "webhook"` com o id do envio — a
    // leitura de sempre acha ele na primeira tentativa (#3366).
    m.porExternalId = {
      ...CARD_ABERTO,
      id: "lead-do-id",
      source: "webhook",
      external_id: "conta-3357",
      webhook_source_id: "fonte-1",
    };
    // O contato TEM outro card aberto no funil — e ele não pode virar o alvo.
    m.cardAberto = { ...CARD_ABERTO, id: "lead-outro-card" };

    const res = await enviar(ENVIO_DO_TRIAL);

    expect(h.criarLead).not.toHaveBeenCalled();
    expect(leiturasDoCardAberto()).toHaveLength(0);
    expect(carimbos()).toHaveLength(0);
    expect(
      h.banco.cadeias.filter(
        (c) =>
          c.tabela === "crm_leads" &&
          operacao(c) === "select" &&
          valorDoFiltro(c, "eq", "external_id") !== undefined,
      ),
      "o card `source: \"webhook\"` foi achado na leitura de sempre: a do carimbo não roda",
    ).toHaveLength(1);
    expect(h.atualizarLead.mock.calls[0]?.[2]).toBe("lead-do-id");
    expect(desfecho()).toBe("atualizado");
    expect(res.status).toBe(200);
  });

  it("⭐ opção DESLIGADA: o primeiro envio com id inédito cria o card como hoje", async () => {
    m.fonte = { ...FONTE, reuse_open_lead_on_capture: false };

    const res = await enviar(ENVIO_DO_TRIAL);

    expect(leiturasDoCardAberto()).toHaveLength(0);
    expect(carimbos()).toHaveLength(0);
    expect(h.criarLead).toHaveBeenCalledTimes(1);
    const leadInput = h.criarLead.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(leadInput.external_id).toBe("conta-3357");
    expect(leadInput.contact_id).toBe("contato-1");
    expect(leadInput.pipeline_id).toBe("pipe-1");
    expect(leadInput.stage_id).toBe("stage-1");
    expect(desfecho()).toBe("criado");
    expect(await res.json()).toEqual({ data: { lead_id: "lead-novo" } });
  });

  it("⭐ segundo id DISTINTO do mesmo contato cria o card do segundo id — dois ids, dois cards (#3366)", async () => {
    // O estado que o primeiro envio deixou: o card do contato está ABERTO e já
    // responde pelo id A. O envio do id B chega em seguida.
    m.cardAberto = {
      ...CARD_ABERTO,
      external_id: "conta-3357",
      webhook_source_id: "fonte-1",
    };

    const res = await enviar({ ...ENVIO_DO_TRIAL, external_id: "conta-9999" });

    // O card do id A não é adotado pelo id B: cada id tem o seu card e a sua
    // idempotência (#2316). Sem este portão o envio de B atualizava o card de A
    // sem ser gravado nele, e o evento seguinte do id B ia atrás do card
    // aberto mais novo do contato.
    expect(h.criarLead).toHaveBeenCalledTimes(1);
    expect((h.criarLead.mock.calls[0]?.[2] as Record<string, unknown>).external_id).toBe("conta-9999");
    expect(
      carimbos(),
      "o carimbo tentou trocar a identidade do card que já respondia por outro id",
    ).toHaveLength(0);
    expect(desfecho()).toBe("criado");
    expect(res.status).toBe(200);
  });

  it("card aberto carimbado por OUTRA fonte também não é adotado (#3366)", async () => {
    m.cardAberto = {
      ...CARD_ABERTO,
      external_id: "conta-de-outra-fonte",
      webhook_source_id: "fonte-outra",
    };

    await enviar(ENVIO_DO_TRIAL);

    // Escrever por cima do card de outra fonte seria a fonte A reescrever o
    // card que a B identifica — a mesma pergunta do portão 2 do reenvio.
    expect(h.criarLead).toHaveBeenCalledTimes(1);
    expect(carimbos()).toHaveLength(0);
    expect(desfecho()).toBe("criado");
  });

  it("⭐ coluna AUSENTE (instalação sem a migration): também cria o card como hoje", async () => {
    const semColuna = { ...FONTE } as Record<string, unknown>;
    delete semColuna.reuse_open_lead_on_capture;
    m.fonte = semColuna;

    await enviar(ENVIO_DO_TRIAL);

    expect(leiturasDoCardAberto()).toHaveLength(0);
    expect(carimbos()).toHaveLength(0);
    expect(h.criarLead).toHaveBeenCalledTimes(1);
    expect(desfecho()).toBe("criado");
  });

  it("⭐ contato sem card aberto no funil da fonte: cria o card como hoje", async () => {
    m.cardAberto = null;

    const res = await enviar(ENVIO_DO_TRIAL);

    expect(leiturasDoCardAberto()).toHaveLength(1);
    expect(carimbos()).toHaveLength(0);
    expect(h.criarLead).toHaveBeenCalledTimes(1);
    expect(desfecho()).toBe("criado");
    expect(res.status).toBe(200);
  });

  it("o carimbo é compare-and-set: dois primeiros envios simultâneos não reescrevem o id do vencedor", async () => {
    await enviar(ENVIO_DO_TRIAL);

    const feitos = carimbos();
    expect(feitos).toHaveLength(1);
    expect(
      filtros(feitos[0]!),
      "sem o compare-and-set o segundo envio simultâneo sobrescreveria o id do vencedor — o retry do outro abriria um terceiro card",
    ).toContainEqual(["is", "external_id", null]);
  });
});

describe("as bordas do portão 3 (#3366)", () => {
  it("⭐ envio SEM external_id continua reusando o card aberto que já tem id — o portão é só do envio COM id (#3101)", async () => {
    // O card do contato nasceu de uma integração (tem id), e um formulário sem
    // id chega pela fonte com o reuso ligado. Antes do #3366 ele era reusado;
    // o portão de "um id não adota o card de outro" não tem id a comparar aqui.
    m.cardAberto = { ...CARD_ABERTO, external_id: "conta-3357", webhook_source_id: "fonte-1" };
    const { external_id: _semId, ...semId } = ENVIO_DO_TRIAL;

    const res = await enviar(semId);

    expect(h.criarLead, "o envio sem id abriu um segundo card ao lado do card com id").not.toHaveBeenCalled();
    expect(carimbos()).toHaveLength(0);
    expect(h.atualizarLead.mock.calls[0]?.[2]).toBe(CARD_DA_CONVERSA);
    expect(desfecho()).toBe("atualizado");
    expect(res.status).toBe(200);
  });

  it("envio SEM external_id não reusa o card de OUTRA fonte de webhook", async () => {
    m.cardAberto = { ...CARD_ABERTO, webhook_source_id: "fonte-outra" };
    const { external_id: _semId, ...semId } = ENVIO_DO_TRIAL;

    await enviar(semId);

    expect(h.criarLead).toHaveBeenCalledTimes(1);
    expect(h.atualizarLead).not.toHaveBeenCalled();
    expect(desfecho()).toBe("criado");
  });

  it("envio COM id não adota card de OUTRA fonte nem quando o card ainda não tem id", async () => {
    m.cardAberto = { ...CARD_ABERTO, webhook_source_id: "fonte-outra" };

    await enviar(ENVIO_DO_TRIAL);

    expect(h.criarLead).toHaveBeenCalledTimes(1);
    expect(carimbos()).toHaveLength(0);
    expect(desfecho()).toBe("criado");
  });

  it("⭐ card aberto que já tem ESTE id (o vencedor da corrida carimbou entre as duas leituras) é adotado, não duplicado", async () => {
    // Dois primeiros envios simultâneos do mesmo id: o perdedor leu o id como
    // inédito, e quando foi ler o card aberto o vencedor já o tinha carimbado.
    m.cardAberto = { ...CARD_ABERTO, external_id: "conta-3357", webhook_source_id: "fonte-1" };

    const res = await enviar(ENVIO_DO_TRIAL);

    expect(h.criarLead, "a corrida de dois primeiros envios abriu um segundo card").not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ data: { lead_id: CARD_DA_CONVERSA } });
  });

  it("⭐ segundo envio do mesmo id com \"Atualizar o card existente\" DESLIGADA: sucesso e card intocado (o que o fragmento afirma)", async () => {
    m.porExternalId = { ...CARD_ABERTO, external_id: "conta-3357", webhook_source_id: "fonte-1" };
    // Só "Reaproveitar" ligada — `update_existing_lead_on_capture: false` é o default da FONTE.

    const res = await enviar({ ...ENVIO_DO_TRIAL, evento: "trial_ativado" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { lead_id: CARD_DA_CONVERSA } });
    expect(h.criarLead).not.toHaveBeenCalled();
    expect(h.atualizarLead).not.toHaveBeenCalled();
    expect(h.moverLead).not.toHaveBeenCalled();
    expect(carimbos()).toHaveLength(0);
    expect(leiturasDoCardAberto()).toHaveLength(0);
    expect(desfecho()).toBe("duplicado");
  });
});
