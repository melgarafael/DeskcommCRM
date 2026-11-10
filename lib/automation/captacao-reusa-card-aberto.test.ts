// @vitest-environment node
//
// A CAPTAÇÃO REUSA O CARD ABERTO DO CONTATO EM VEZ DE ABRIR OUTRO (#3101) ────
//
// O defeito medido em v1.86.0: a fonte de webhook criava card NOVO em todo envio
// sem `external_id`, mesmo quando o contato casado (por telefone ou e-mail) já
// tinha negócio ABERTO no MESMO funil. Um contato chegou a TRÊS cards abertos no
// mesmo funil, e quem olha três cards do mesmo cliente não sabe qual dos três a
// equipe está tocando.
//
// A régua que este arquivo fixa é a da ação `create_or_move_lead` (#958): o
// negócio ABERTO do contato NESTE funil é ATUALIZADO com o que o envio trouxe e
// MOVIDO para a etapa da fonte. As duas saídas de sabotagem, uma por controle:
//
//   • tirar o portão da OPÇÃO (controle 1) → a captação volta a reusar card com
//     a opção desligada, e a instalação que nunca ligou muda de comportamento;
//   • tirar o reuso (controle 2) → o contato com card aberto ganha um segundo
//     card, que é o defeito da issue.
//
// Por isso o teste passa pela ROTA de verdade: o `mapInboundPayload` (mapa de
// campos, telefone canônico) e o casamento do contato são os do caminho real —
// o que é de mentira é só o Supabase, o handler de lead e a busca de contato.
//
// Os quatro CONTROLES, e o que cada um prova:
//
//   1. opção DESLIGADA (o padrão da coluna) com contato casado e card aberto:
//      continua criando card novo — o comportamento de hoje, byte a byte;
//   2. opção LIGADA, contato casado e card aberto no funil da fonte: ATUALIZA os
//      campos que mudaram e MOVE o card para a etapa da fonte, que está à frente
//      — não cria. Card que já está ADIANTE da etapa da fonte não volta: a etapa
//      só anda para a frente, como no reenvio do #2316;
//   3. opção LIGADA, mas o contato NÃO tem card aberto no funil: cria — o reuso
//      não pode virar "não entra nada";
//   4. envio COM `external_id`: quem identifica o card continua sendo o id do
//      envio (#2316), e o reuso NÃO é consultado — a régua do `external_id` não
//      foi trocada por uma atualização inesperada.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  registrar: vi.fn(async () => undefined),
  criarLead: vi.fn(async () => ({ id: "lead-novo" })),
  atualizarLead: vi.fn(async (..._args: unknown[]) => ({ id: "lead-aberto" })),
  moverLead: vi.fn(async (..._args: unknown[]) => ({ id: "lead-aberto" })),
  acharContato: vi.fn(async () => ({ id: "contato-1", name: "Joana" })),
  /** Respostas por tabela. Cada LEITURA desloca a primeira; a última repete. */
  leituras: new Map<string, Array<Record<string, unknown>>>(),
}));

/** Cadeia do PostgREST que só resolve na hora do `await`, como na rota real. */
function cadeia(tabela: string): unknown {
  const proxima = (): Record<string, unknown> => {
    const fila = h.leituras.get(tabela) ?? [];
    if (fila.length === 0) return { data: null, error: null };
    if (fila.length > 1) return fila.shift() as Record<string, unknown>;
    return fila[0] as Record<string, unknown>;
  };
  const proxy: unknown = new Proxy(() => undefined, {
    get(_alvo, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown) => ok(proxima());
      return () => proxy;
    },
  });
  return proxy;
}

const ORG = "org-1";
const FUNIL = "pipe-1";
/** A etapa padrão da fonte: é nela que o card novo nasceria. */
const ETAPA_DA_FONTE = "stage-1";
/** Onde o card aberto do contato está — outra etapa, para o MOVE ser visível. */
const ETAPA_DO_CARD = "stage-9";

/** O funil com a etapa da fonte À FRENTE da do card: o MOVE é para a frente. */
const FONTE_A_FRENTE = [
  { id: ETAPA_DO_CARD, name: "Em conversa", position: 1 },
  { id: ETAPA_DA_FONTE, name: "Conta criada", position: 2 },
];

const FONTE = {
  id: "fonte-1",
  name: "Formulário do site",
  organization_id: ORG,
  secret_encrypted: null,
  default_pipeline_id: FUNIL,
  default_stage_id: ETAPA_DA_FONTE,
  field_map: {},
  form_fields: [],
  redirect_to: null,
  is_active: true,
  authorize_ai_on_capture: false,
  // #2316 desligado: quem está sob teste aqui é o reuso do #3101, não o reenvio.
  update_existing_lead_on_capture: false,
  reuse_open_lead_on_capture: true,
};

/** Quem NUNCA ligou a opção — o padrão da coluna (migration 0722). */
const FONTE_DESLIGADA = { ...FONTE, reuse_open_lead_on_capture: false };

/**
 * O card ABERTO do mesmo contato no MESMO funil — o do follow-up em andamento,
 * com valor já corrigido à mão, que não pode ser sobrescrito por reenvio.
 */
const CARD_ABERTO = {
  id: "lead-aberto",
  contact_id: "contato-1",
  title: "Joana",
  custom_fields: { valor_pago: "100" },
  pipeline_id: FUNIL,
  stage_id: ETAPA_DO_CARD,
};

/** O mesmo envio, com nome e telefone que casam o contato já cadastrado. */
const ENVIO_SEM_EXTERNAL_ID = {
  nome: "Joana",
  telefone: "+5532999990000",
  valor_pago: "250",
};

function desfecho(): string | undefined {
  const chamadas = h.registrar.mock.calls as unknown as Array<[unknown, { outcome?: string }]>;
  return chamadas.at(-1)?.[1]?.outcome;
}

/** O que a linha de captação levou, para o vínculo não se perder. */
function linhaDaCaptacao(): { leadId?: string; contactId?: string } | undefined {
  const chamadas = h.registrar.mock.calls as unknown as Array<
    [unknown, { leadId?: string; contactId?: string }]
  >;
  return chamadas.at(-1)?.[1];
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: cadeia, rpc: async () => ({ data: {}, error: null }) }),
}));
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
// O casamento do contato é o do caminho real; o que se fixa aqui é o que a
// captação faz DEPOIS de casar — por isso ele é o único ponto de mentira.
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefoneComNome: h.acharContato,
}));

import { POST } from "@/app/api/v1/webhooks/in/[token]/route";

const TOKEN = "token-da-fonte-0001";

async function enviar(corpo: Record<string, unknown>): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN}`, {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
  return (await POST(req, { params: Promise.resolve({ token: TOKEN }) })) as Response;
}

beforeEach(() => {
  h.registrar.mockClear();
  h.criarLead.mockClear();
  h.atualizarLead.mockClear();
  h.moverLead.mockClear();
  h.acharContato.mockClear();
  h.acharContato.mockResolvedValue({ id: "contato-1", name: "Joana" });
  h.leituras.clear();
});

describe("a captação por webhook reusa o card aberto do contato (#3101)", () => {
  it("⭐ CONTROLE 1 — opção DESLIGADA: contato casado com card aberto continua ganhando card NOVO", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE_DESLIGADA, error: null }]);
    h.leituras.set("crm_leads", [{ data: CARD_ABERTO, error: null }]);

    const res = await enviar(ENVIO_SEM_EXTERNAL_ID);

    expect(
      h.atualizarLead,
      "com a opção desligada a captação reescreveu o card aberto do contato — quem nunca ligou a opção mudou de comportamento",
    ).not.toHaveBeenCalled();
    expect(h.moverLead).not.toHaveBeenCalled();
    expect(h.criarLead, "a captação deixou de criar o card que sempre criou").toHaveBeenCalledTimes(1);
    expect(desfecho()).toBe("criado");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { lead_id: "lead-novo" } });
  });

  it("⭐ CONTROLE 2 — opção LIGADA: ATUALIZA o card aberto (só o que mudou) e MOVE, em vez de criar", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE, error: null }]);
    h.leituras.set("crm_leads", [{ data: CARD_ABERTO, error: null }]);
    h.leituras.set("crm_stages", [{ data: FONTE_A_FRENTE, error: null }]);

    const res = await enviar(ENVIO_SEM_EXTERNAL_ID);

    expect(
      h.criarLead,
      "o contato já tinha card aberto no mesmo funil e a captação abriu o SEGUNDO — é o defeito da issue",
    ).not.toHaveBeenCalled();
    expect(h.atualizarLead).toHaveBeenCalledTimes(1);
    // ⚠️ Só `valor_pago` mudou: `area_ha` que o card tem e o envio não trouxe fica
    // onde está, como no reenvio do #2316.
    expect(h.atualizarLead.mock.calls[0]?.[2]).toBe("lead-aberto");
    expect(h.atualizarLead.mock.calls[0]?.[3]).toEqual({ custom_fields: { valor_pago: "250" } });
    expect(h.moverLead, "o card aberto não andou para a etapa da fonte").toHaveBeenCalledTimes(1);
    expect(h.moverLead.mock.calls[0]?.[2]).toBe("lead-aberto");
    expect(h.moverLead.mock.calls[0]?.[3]).toEqual({ to_stage_id: ETAPA_DA_FONTE });
    expect(desfecho()).toBe("atualizado");
    expect(linhaDaCaptacao()?.leadId).toBe("lead-aberto");
    expect(linhaDaCaptacao()?.contactId).toBe("contato-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { lead_id: "lead-aberto" } });
  });

  it("card aberto JÁ na etapa da fonte: atualiza sem mover (o MOVE é só quando a etapa muda)", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE, error: null }]);
    h.leituras.set("crm_leads", [{ data: { ...CARD_ABERTO, stage_id: ETAPA_DA_FONTE }, error: null }]);

    await enviar(ENVIO_SEM_EXTERNAL_ID);

    expect(h.atualizarLead).toHaveBeenCalledTimes(1);
    expect(h.moverLead).not.toHaveBeenCalled();
    expect(desfecho()).toBe("atualizado");
  });

  it("⭐ card aberto numa etapa MAIS À FRENTE não é puxado de volta para a etapa da fonte", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE, error: null }]);
    h.leituras.set("crm_leads", [{ data: CARD_ABERTO, error: null }]);
    h.leituras.set("crm_stages", [{ data: [
      { id: ETAPA_DA_FONTE, name: "Novo", position: 1 },
      { id: ETAPA_DO_CARD, name: "Proposta", position: 9 },
    ], error: null }]);

    await enviar(ENVIO_SEM_EXTERNAL_ID);

    expect(h.moverLead, "o card voltou de 'Proposta' para 'Novo'").not.toHaveBeenCalled();
    expect(h.atualizarLead, "os campos novos deixaram de chegar ao card").toHaveBeenCalledTimes(1);
    expect(desfecho()).toBe("atualizado");
  });

  it("⭐ Respondi: o título do card (\"Empresa — Nome\") não é reescrito para só o nome", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE, error: null }]);
    h.leituras.set("crm_leads", [
      { data: { ...CARD_ABERTO, title: "Fazenda Boa Vista — Joana", stage_id: ETAPA_DA_FONTE }, error: null },
    ]);

    await enviar({
      form: { form_name: "Diagnóstico" },
      respondent: {
        answers: {
          "Qual é o seu nome?": "Joana",
          "Qual é o melhor WhatsApp para falarmos sobre essa análise?": "+5532999990000",
          "Qual é o nome da sua empresa?": "Fazenda Boa Vista",
        },
      },
    });

    expect(h.criarLead).not.toHaveBeenCalled();
    const escritas = h.atualizarLead.mock.calls.map((c) => c[3] as Record<string, unknown>);
    expect(
      escritas.some((e) => "title" in e),
      "o envio do Respondi reescreveu o título do card para só o nome",
    ).toBe(false);
    expect(desfecho()).toBe("atualizado");
  });

  it("⭐ CONTROLE 3 — opção LIGADA, mas o contato NÃO tem card aberto no funil: cria", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE, error: null }]);
    h.leituras.set("crm_leads", [{ data: null, error: null }]);

    const res = await enviar(ENVIO_SEM_EXTERNAL_ID);

    expect(
      h.criarLead,
      "o reuso virou 'não entra nada': o envio de um contato sem card aberto perdeu o lead",
    ).toHaveBeenCalledTimes(1);
    expect(h.atualizarLead).not.toHaveBeenCalled();
    expect(h.moverLead).not.toHaveBeenCalled();
    expect(desfecho()).toBe("criado");
    expect(res.status).toBe(200);
  });

  it("a opção só age no caminho SEM external_id: o card aberto nem é procurado", async () => {
    // Se o reuso fosse consultado neste caminho, a SEGUNDA leitura de `crm_leads`
    // devolveria o card aberto e o envio acabaria no lead errado.
    h.leituras.set("webhook_sources", [{ data: { ...FONTE, update_existing_lead_on_capture: true }, error: null }]);
    h.leituras.set("crm_leads", [
      { data: { ...CARD_ABERTO, id: "lead-do-external-id", webhook_source_id: "fonte-1" }, error: null },
      { data: CARD_ABERTO, error: null },
    ]);

    const res = await enviar({ ...ENVIO_SEM_EXTERNAL_ID, external_id: "ext-1" });

    expect(h.criarLead).not.toHaveBeenCalled();
    expect(h.moverLead, "o reuso mexeu na etapa de um envio que traz external_id").not.toHaveBeenCalled();
    expect(desfecho()).toBe("atualizado");
    expect(linhaDaCaptacao()?.leadId).toBe("lead-do-external-id");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { lead_id: "lead-do-external-id" } });
  });

  it("envio SEM telefone e SEM e-mail: nada a reusar, o card novo continua nascendo", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE, error: null }]);
    h.leituras.set("crm_leads", [{ data: CARD_ABERTO, error: null }]);

    await enviar({ nome: "Joana", valor_pago: "250" });

    expect(h.acharContato).not.toHaveBeenCalled();
    expect(h.atualizarLead).not.toHaveBeenCalled();
    expect(h.criarLead).toHaveBeenCalledTimes(1);
  });
});
