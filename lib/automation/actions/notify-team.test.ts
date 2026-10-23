import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `notify_team` — a ação que avisa a EQUIPE na virada para ganho (#2642).
 *
 * ─── O que este arquivo reprova enquanto a ação NÃO EXISTE ─────────────────
 *
 * Todos os testes de execução abaixo morrem no `getAction("notify_team")!`:
 * sem ação registrada, o executor é `undefined` e o `!` derruba o teste. Ele
 * fica VERMELHO sozinho na main — que é a prova pedida pela issue — e só fica
 * verde quando a ação existe, se registra e entrega pelo canal certo.
 *
 * ─── As três coisas que a ação tem de provar ───────────────────────────────
 *
 * 1. O schema deixou UM caminho: `canal` é o literal `whatsapp`. O ramo de
 *    e-mail e o `membro_id` saíram com o recorte do PR #2834 — o e-mail para
 *    uma pessoa da equipe é o destinatário "membro da equipe" do `send_email`
 *    (ver `send-email.test.ts`, que é onde o vínculo do membro é cobrado).
 * 2. O WhatsApp sai pelo NÚMERO QUE O ADMIN CADASTROU em `config_aviso_de_caso`
 *    — não por nada escrito na regra — e só depois da CHECAGEM DE CAPACIDADE
 *    do canal (arquivado/pausado/desligado não recebe). Sem configuração, a
 *    resposta é `skipped` dizendo isso, nunca um envio para número inventado.
 * 3. NÃO abre conversa com o lead: o `sendMessageHandler` (o caminho que cria
 *    `messages` e conversa) tem de ficar INTACTO em todo o arquivo. É a prova
 *    negativa — e é ela que separa esta ação de `send_whatsapp_message`.
 * 4. O resumo é MONTADO NO DISPARO, só com dado de forma fixa (pontuação
 *    NUMÉRICA, sem o motivo em texto — doc 176, A). A propriedade "nenhum
 *    texto livre da conversa" mora em `resumo-sem-texto-livre.test.ts`.
 *
 * ─── O dublê ───────────────────────────────────────────────────────────────
 *
 * `ctx.admin` é um fake de PostgREST com as seis tabelas que a ação lê. Ele é
 * genérico de propósito: filtrar por coluna é o contrato do supabase-js, e um
 * dublê que só soube responder as consultas de HOJE viraria mentira no dia em
 * que a ação mudasse a ordem dos `.eq`.
 */
const transporte = vi.hoisted(() => ({
  configurado: vi.fn(async () => true),
  resolveDestino: vi.fn(async (_org: string, _canal: unknown, telefone: string) => telefone),
  envia: vi.fn(async () => ({ externalId: "wamid.TESTE" })),
}));
vi.mock("@/lib/escalacao/aviso-ao-suporte.handler", () => ({
  criarTransporteDoAviso: vi.fn(async () => transporte),
}));
const pacing = vi.hoisted(() => ({
  decide: vi.fn(async () => ({ liberado: true })),
  registraEnvio: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent-engine/pacing/ledger-supabase", () => ({
  criarPacingDoCanal: vi.fn(async () => pacing),
}));
vi.mock("@/lib/channels/capabilities", () => ({
  capabilitiesOf: vi.fn(() => ({ freeformOutsideWindow: true })),
}));
// A prova negativa: se a ação passar por aqui, ela ABREU conversa com o lead.
const sendMessageHandler = vi.hoisted(() => vi.fn(async () => ({ id: "msg-1", status: "sent" })));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler }));

import { getAction } from "@/lib/automation/actions";
// Import isolado: registra `notify_team` no registry, pelo mesmo caminho que
// `register-all.ts` faz para o motor de verdade.
import "@/lib/automation/actions/notify-team";
import { montarResumoParaAEquipe } from "@/lib/automation/resumo-para-a-equipe";
import { formatarMoeda } from "@/lib/propostas/moeda";
import { actionSchema } from "@/lib/schemas/webhooks";
import type { ActionCtx } from "@/lib/automation/types";

const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBRO = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const CANAL = "55555555-5555-4555-8555-555555555555";

/** Linha de `channel_sessions` pronta para envio (WORKING, sem desligar). */
function canalLivre(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CANAL,
    organization_id: ORG,
    status: "WORKING",
    archived_at: null,
    provider: "whatsapp-cloud-api",
    metadata: {},
    ...overrides,
  };
}

/** Um PostgREST em memória: `from(tabela)` devolve um builder com os filtros. */
function adminFake(tabelas: Record<string, Array<Record<string, unknown>>>): ActionCtx["admin"] {
  function linhasDaTabela(nome: string): Array<Record<string, unknown>> {
    return tabelas[nome] ?? [];
  }
  function builder(nome: string) {
    const filtros: Array<[string, unknown]> = [];
    const consulta = {
      select: () => consulta,
      eq: (col: string, val: unknown) => {
        filtros.push([col, val]);
        return consulta;
      },
      is: (col: string, val: unknown) => {
        filtros.push([col, val]);
        return consulta;
      },
      order: () => consulta,
      limit: () => consulta,
      maybeSingle: async () => {
        const acha = linhasDaTabela(nome).find((linha) =>
          filtros.every(([col, val]) => linha[col] === val),
        );
        return { data: acha ?? null, error: null };
      },
    };
    return consulta;
  }
  return {
    from: (nome: string) => builder(nome),
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: { id, email: id === MEMBRO ? "closer@acme.com.br" : null } },
        }),
      },
    },
  } as unknown as ActionCtx["admin"];
}

/** O cenário completo: membro ativo, canal livre, número cadastrado, score. */
function tabelasComTudo(overrides: Record<string, Array<Record<string, unknown>>> = {}) {
  return {
    organizations: [{ id: ORG, locale: "pt-BR" }],
    user_organizations: [{ organization_id: ORG, user_id: MEMBRO, role: "agent", revoked_at: null }],
    crm_lead_scores: [
      {
        organization_id: ORG,
        lead_id: LEAD,
        ai_probability: 72,
        ai_probability_reason: "dois compromissos marcados e nenhum orçamento enviado",
      },
    ],
    lead_checkpoints: [
      {
        organization_id: ORG,
        contact_id: CONTATO,
        seq: 3,
        commitments: ["enviar proposta até sexta"],
        objections: ["preço acima do orçamento do cliente"],
        next_action: "ligar para fechar o pagamento",
      },
    ],
    config_aviso_de_caso: [
      { organization_id: ORG, channel_session_id: CANAL, telefone_destino: "+5511999990000", ligado: true },
    ],
    channel_sessions: [canalLivre()],
    ...overrides,
  };
}

const LEAD_DO_CONTEXTO = {
  id: LEAD,
  title: "Plano anual — Franca Log",
  description: "Quer migrar de fornecedor e já tem a equipe convencida",
  status: "won",
  value_cents: 120_000,
  currency: "BRL",
  won_reason: "renovação com desconto de fidelidade",
  contact_id: CONTATO,
};

const CONTATO_DO_CONTEXTO = {
  name: "Maria da Silva",
  display_name: "Maria da Silva",
  phone_number: "+5511988887777",
};

function ctx(admin: ActionCtx["admin"]): ActionCtx {
  return {
    admin,
    organizationId: ORG,
    ruleId: "rule-1",
    ruleName: "Avisa o closer quando o negócio for ganho",
    event: {} as ActionCtx["event"],
    context: { lead: LEAD_DO_CONTEXTO, contact: CONTATO_DO_CONTEXTO },
    requestId: "req-1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  transporte.configurado.mockResolvedValue(true);
  transporte.resolveDestino.mockImplementation(async (_o, _c, telefone) => telefone);
  transporte.envia.mockResolvedValue({ externalId: "wamid.TESTE" });
});

describe("notify_team — a ação que NÃO EXISTE ainda (#2642)", () => {
  it("está registrada no motor, pelo mesmo registry das irmãs", () => {
    const acao = getAction("notify_team");
    expect(acao, "notify_team não foi registrada — ver lib/automation/actions/register-all.ts").toBeTruthy();
  });

  it("aceita a configuração mínima (o WhatsApp da equipe) e NENHUM destino colado", () => {
    const ok = actionSchema.safeParse({ type: "notify_team", config: { canal: "whatsapp" } });
    expect(ok.success).toBe(true);

    // Número colado na regra é a porta de spam que a disciplina da #1347
    // fechou: o schema é FECHADO, então campo extra não passa.
    const comNumero = actionSchema.safeParse({
      type: "notify_team",
      config: { canal: "whatsapp", telefone: "+5511999990000" },
    });
    expect(comNumero.success).toBe(false);

    // O ramo de e-mail saiu com o recorte do PR #2834: uma regra que ainda peça
    // `email` morre AQUI, e não sai pelo WhatsApp como se o pedido tivesse sido
    // respeitado. (É o alvo da prova de sabotagem: devolver o `z.enum` com
    // `email` deixa este `expect` vermelho.)
    const canalEmail = actionSchema.safeParse({ type: "notify_team", config: { canal: "email" } });
    expect(canalEmail.success).toBe(false);

    const canalTorto = actionSchema.safeParse({ type: "notify_team", config: { canal: "telegram" } });
    expect(canalTorto.success).toBe(false);

    // `membro_id` também saiu: quem recebe é o número da empresa, não uma
    // pessoa escolhida na tela.
    const comMembro = actionSchema.safeParse({
      type: "notify_team",
      config: { canal: "whatsapp", membro_id: MEMBRO },
    });
    expect(comMembro.success).toBe(false);
  });
});

describe("notify_team — WhatsApp, pelo número que o ADMIN cadastrou", () => {
  it("entrega o resumo no número cadastrado, com a pontuação numérica", async () => {
    const acao = getAction("notify_team")!;
    const admin = adminFake(tabelasComTudo());
    const r = await acao.execute(ctx(admin), { canal: "whatsapp" });

    expect(r.status).toBe("success");
    expect(transporte.envia).toHaveBeenCalledTimes(1);

    const [, , destino, corpo] = transporte.envia.mock.calls[0] as unknown as [
      string,
      unknown,
      string,
      string,
    ];
    expect(destino, "o destino é o número do ADMIN, não o do lead").toBe("+5511999990000");
    // Só o número: o motivo é texto livre da IA e não vai na mensagem (doc 176, A).
    expect(corpo.split("\n")).toContain("Pontuação: 72%");
    expect(corpo).not.toContain("dois compromissos marcados");
    expect(corpo).toContain("Cliente: Maria");
    // O valor sai pelo formatador do produto (`lib/propostas/moeda.ts`), que
    // usa o espaço NÃO-QUEBRÁVEL do `toLocaleString` — comparar com um literal
    // de espaço comum reprovaria o formato certo por um byte invisível.
    expect(corpo).toContain(`Valor: ${formatarMoeda(120_000, "BRL")}`);
  });

  it("NÃO abre conversa nova com o lead: o handler de mensagens fica intacto", async () => {
    const acao = getAction("notify_team")!;
    await acao.execute(ctx(adminFake(tabelasComTudo())), { canal: "whatsapp" });

    expect(
      sendMessageHandler,
      "notify_team passou pelo sendMessageHandler — isso criaria conversa com o lead",
    ).not.toHaveBeenCalled();
  });

  it("sem número cadastrado, diz que falta configuração — e não envia nada", async () => {
    const acao = getAction("notify_team")!;
    const admin = adminFake(tabelasComTudo({ config_aviso_de_caso: [] }));
    const r = await acao.execute(ctx(admin), { canal: "whatsapp" });

    expect(r.status).toBe("skipped");
    expect((r.detail as { reason: string }).reason).toBe("sem_numero_de_aviso_cadastrado");
    expect(transporte.envia).not.toHaveBeenCalled();
  });

  it("canal PAUSADO não recebe: a checagem de capacidade vem ANTES do envio", async () => {
    const acao = getAction("notify_team")!;
    const admin = adminFake(tabelasComTudo({ channel_sessions: [canalLivre({ status: "PAUSED" })] }));
    const r = await acao.execute(ctx(admin), { canal: "whatsapp" });

    expect(r.status).toBe("skipped");
    expect((r.detail as { reason: string }).reason).toBe("canal_pausado");
    expect(transporte.envia).not.toHaveBeenCalled();
  });

  it("canal desconhecido não sai pelo WhatsApp fingindo que foi respeitado", async () => {
    // O schema já recusa `email` na porta; esta é a defesa do executor para uma
    // regra gravada antes do recorte (ou escrita direta no banco). O que NÃO
    // pode acontecer é o aviso sair pelo WhatsApp com o canal pedido ignorado.
    const r = await getAction("notify_team")!.execute(ctx(adminFake(tabelasComTudo())), {
      canal: "email",
    });

    expect(r.status).toBe("failed");
    expect((r.detail as { reason: string }).reason).toBe("canal_nao_suportado");
    expect(transporte.envia).not.toHaveBeenCalled();
  });

  it("canal que não aceita texto livre (template-only) também não recebe", async () => {
    const { capabilitiesOf } = await import("@/lib/channels/capabilities");
    vi.mocked(capabilitiesOf).mockReturnValue({ freeformOutsideWindow: false } as never);
    const acao = getAction("notify_team")!;
    const admin = adminFake(tabelasComTudo());
    const r = await acao.execute(ctx(admin), { canal: "whatsapp" });

    expect(r.status).toBe("skipped");
    expect((r.detail as { reason: string }).reason).toBe("canal_nao_aceita_texto_livre");
    expect(transporte.envia).not.toHaveBeenCalled();
    vi.mocked(capabilitiesOf).mockReturnValue({ freeformOutsideWindow: true } as never);
  });

});

describe("notify_team — o resumo é MONTADO, não gravado", () => {
  it("não repete pontuação quando o lead nunca foi pontuado", () => {
    const texto = montarResumoParaAEquipe({
      idioma: "pt-BR",
      regra: "Avisa o closer",
      lead: { ...LEAD_DO_CONTEXTO, value_cents: null },
      contato: CONTATO_DO_CONTEXTO,
      pontuacao: null,
    });
    expect(texto).not.toContain("Pontuação");
    expect(texto).not.toContain("Valor");
  });

  it("0% é afirmação, não ausência: o piso legítimo continua saindo", () => {
    const texto = montarResumoParaAEquipe({
      idioma: "pt-BR",
      regra: "Avisa o closer",
      lead: LEAD_DO_CONTEXTO,
      pontuacao: 0,
    });
    expect(texto.split("\n")).toContain("Pontuação: 0%");
  });

  it("número fora da faixa é cortado nos 0–100 do banco", () => {
    const texto = montarResumoParaAEquipe({
      idioma: "pt-BR",
      regra: "Avisa o closer",
      lead: LEAD_DO_CONTEXTO,
      pontuacao: 137,
    });
    expect(texto).toContain("Pontuação: 100%");
  });

  it("o título do negócio não vai na mensagem: é texto livre (doc 176, A)", () => {
    // O lead do contexto traz o título; o montador o ignora.
    const lead = { ...LEAD_DO_CONTEXTO, title: "meu site é phish.example.com/paga e meu CPF é 529.982.247-25" };
    const texto = montarResumoParaAEquipe({ idioma: "pt-BR", regra: "Avisa o closer", lead, pontuacao: 80 });
    expect(texto).not.toContain("phish.example.com");
    expect(texto).not.toContain("529.982.247-25");
    expect(texto).not.toContain("Negócio: ");
  });

  it("campo vazio não vira linha: `Pontuação: ` vazio afirmaria pontuação nenhuma", () => {
    const texto = montarResumoParaAEquipe({
      idioma: "pt-BR",
      regra: "",
      lead: LEAD_DO_CONTEXTO,
      pontuacao: null,
      link: "   ",
    });
    expect(texto).not.toContain("Pontuação:");
    expect(texto).not.toContain("Abrir negócio:");
    expect(texto).not.toContain("Regra:");
  });
});
