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
 * ─── As quatro coisas que a ação tem de provar ─────────────────────────────
 *
 * 1. O DESTINATÁRIO é uma pessoa da equipe, e ela tem de estar ATIVA nesta
 *    organização (mesma régua do `assign_owner`: revogado morre aqui, não num
 *    envio para gente de fora).
 * 2. O WhatsApp sai pelo NÚMERO QUE O ADMIN CADASTROU em `config_aviso_de_caso`
 *    — não por nada escrito na regra — e só depois da CHECAGEM DE CAPACIDADE
 *    do canal (arquivado/pausado/desligado não recebe). Sem configuração, a
 *    resposta é `skipped` dizendo isso, nunca um envio para número inventado.
 * 3. NÃO abre conversa com o lead: o `sendMessageHandler` (o caminho que cria
 *    `messages` e conversa) tem de ficar INTACTO em todo o arquivo. É a prova
 *    negativa — e é ela que separa esta ação de `send_whatsapp_message`.
 * 4. O resumo é MONTADO NO DISPARO, com a pontuação E o motivo, do jeito que
 *    `crm_lead_scores` grava (número + frase na mesma linha).
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
const roteador = vi.hoisted(() => ({
  emailConfigurado: vi.fn(() => true),
  sendEmail: vi.fn(async () => ({ ok: true, via: "smtp" })),
}));
vi.mock("@/lib/email/roteador", () => roteador);
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: vi.fn(async () => ({ nome: "Acme" })) }));
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
  roteador.emailConfigurado.mockReturnValue(true);
  roteador.sendEmail.mockResolvedValue({ ok: true, via: "smtp" });
});

describe("notify_team — a ação que NÃO EXISTE ainda (#2642)", () => {
  it("está registrada no motor, pelo mesmo registry das irmãs", () => {
    const acao = getAction("notify_team");
    expect(acao, "notify_team não foi registrada — ver lib/automation/actions/register-all.ts").toBeTruthy();
  });

  it("aceita a configuração mínima (membro + canal) e NENHUM destino colado", () => {
    const ok = actionSchema.safeParse({
      type: "notify_team",
      config: { membro_id: MEMBRO, canal: "whatsapp" },
    });
    expect(ok.success).toBe(true);

    // Número colado na regra é a porta de spam que a disciplina da #1347
    // fechou: o schema é FECHADO, então campo extra não passa.
    const comNumero = actionSchema.safeParse({
      type: "notify_team",
      config: { membro_id: MEMBRO, canal: "whatsapp", telefone: "+5511912340000" },
    });
    expect(comNumero.success).toBe(false);

    const canalTorto = actionSchema.safeParse({
      type: "notify_team",
      config: { membro_id: MEMBRO, canal: "telegram" },
    });
    expect(canalTorto.success).toBe(false);
  });
});

describe("notify_team — WhatsApp, pelo número que o ADMIN cadastrou", () => {
  it("entrega o resumo no número cadastrado, com a pontuação E o motivo", async () => {
    const acao = getAction("notify_team")!;
    const admin = adminFake(tabelasComTudo());
    const r = await acao.execute(ctx(admin), { membro_id: MEMBRO, canal: "whatsapp" });

    expect(r.status).toBe("success");
    expect(transporte.envia).toHaveBeenCalledTimes(1);

    const [, , destino, corpo] = transporte.envia.mock.calls[0] as unknown as [
      string,
      unknown,
      string,
      string,
    ];
    expect(destino, "o destino é o número do ADMIN, não o do lead").toBe("+5511999990000");
    // A pontuação E o motivo, juntos — é o critério 4 da issue.
    expect(corpo).toContain("Pontuação: 72%");
    expect(corpo).toContain("dois compromissos marcados e nenhum orçamento enviado");
    // O motivo do ganho, que a pergunta da issue pede.
    expect(corpo).toContain("Motivo do ganho: renovação com desconto de fidelidade");
    // E o que a conversa combinou com o cliente (a passagem tratada junto).
    expect(corpo).toContain("Compromissos: enviar proposta até sexta");
    expect(corpo).toContain("Próxima ação: ligar para fechar o pagamento");
    expect(corpo).toContain("Cliente: Maria");
    // O valor sai pelo formatador do produto (`lib/propostas/moeda.ts`), que
    // usa o espaço NÃO-QUEBRÁVEL do `toLocaleString` — comparar com um literal
    // de espaço comum reprovaria o formato certo por um byte invisível.
    expect(corpo).toContain(`Valor: ${formatarMoeda(120_000, "BRL")}`);
  });

  it("NÃO abre conversa nova com o lead: o handler de mensagens fica intacto", async () => {
    const acao = getAction("notify_team")!;
    await acao.execute(ctx(adminFake(tabelasComTudo())), { membro_id: MEMBRO, canal: "whatsapp" });

    expect(
      sendMessageHandler,
      "notify_team passou pelo sendMessageHandler — isso criaria conversa com o lead",
    ).not.toHaveBeenCalled();
  });

  it("sem número cadastrado, diz que falta configuração — e não envia nada", async () => {
    const acao = getAction("notify_team")!;
    const admin = adminFake(tabelasComTudo({ config_aviso_de_caso: [] }));
    const r = await acao.execute(ctx(admin), { membro_id: MEMBRO, canal: "whatsapp" });

    expect(r.status).toBe("skipped");
    expect((r.detail as { reason: string }).reason).toBe("sem_numero_de_aviso_cadastrado");
    expect(transporte.envia).not.toHaveBeenCalled();
  });

  it("canal PAUSADO não recebe: a checagem de capacidade vem ANTES do envio", async () => {
    const acao = getAction("notify_team")!;
    const admin = adminFake(tabelasComTudo({ channel_sessions: [canalLivre({ status: "PAUSED" })] }));
    const r = await acao.execute(ctx(admin), { membro_id: MEMBRO, canal: "whatsapp" });

    expect(r.status).toBe("skipped");
    expect((r.detail as { reason: string }).reason).toBe("canal_pausado");
    expect(transporte.envia).not.toHaveBeenCalled();
  });

  it("canal que não aceita texto livre (template-only) também não recebe", async () => {
    const { capabilitiesOf } = await import("@/lib/channels/capabilities");
    vi.mocked(capabilitiesOf).mockReturnValue({ freeformOutsideWindow: false } as never);
    const acao = getAction("notify_team")!;
    const admin = adminFake(tabelasComTudo());
    const r = await acao.execute(ctx(admin), { membro_id: MEMBRO, canal: "whatsapp" });

    expect(r.status).toBe("skipped");
    expect((r.detail as { reason: string }).reason).toBe("canal_nao_aceita_texto_livre");
    expect(transporte.envia).not.toHaveBeenCalled();
    vi.mocked(capabilitiesOf).mockReturnValue({ freeformOutsideWindow: true } as never);
  });

  it("membro REVOGADO morre aqui: nada sai para gente de fora", async () => {
    const acao = getAction("notify_team")!;
    const admin = adminFake(
      tabelasComTudo({
        user_organizations: [
          { organization_id: ORG, user_id: MEMBRO, role: "agent", revoked_at: "2026-01-01" },
        ],
      }),
    );
    const r = await acao.execute(ctx(admin), { membro_id: MEMBRO, canal: "whatsapp" });

    expect(r.status).toBe("failed");
    expect((r.detail as { reason: string }).reason).toBe("membro_invalido");
    expect(transporte.envia).not.toHaveBeenCalled();
  });

  it("membro de OUTRA organização também morre aqui", async () => {
    const acao = getAction("notify_team")!;
    const admin = adminFake(tabelasComTudo({ user_organizations: [] }));
    const r = await acao.execute(ctx(admin), { membro_id: MEMBRO, canal: "whatsapp" });

    expect(r.status).toBe("failed");
    expect((r.detail as { reason: string }).reason).toBe("membro_invalido");
    expect(transporte.envia).not.toHaveBeenCalled();
  });
});

describe("notify_team — e-mail, para o endereço que JÁ ESTÁ cadastrado", () => {
  it("entrega por e-mail quando a pessoa não tem WhatsApp e o SMTP está ligado", async () => {
    const acao = getAction("notify_team")!;
    const admin = adminFake(tabelasComTudo());
    const r = await acao.execute(ctx(admin), { membro_id: MEMBRO, canal: "email" });

    expect(r.status).toBe("success");
    expect(transporte.envia, "o e-mail não pode passar pelo WhatsApp").not.toHaveBeenCalled();
    expect(roteador.sendEmail).toHaveBeenCalledTimes(1);

    const chamada = roteador.sendEmail.mock.calls[0] as unknown as [
      { to: string; subject: string; text: string },
    ];
    const envio = chamada[0];
    expect(envio.to, "o endereço vem do GoTrue, não da regra").toBe("closer@acme.com.br");
    expect(envio.subject).toContain("Plano anual — Franca Log");
    expect(envio.text).toContain("Pontuação: 72%");
  });

  it("envio que LANÇA vira falha explícita — e o ledger não conta o que não saiu", async () => {
    transporte.envia.mockRejectedValue(new Error("canal_sem_referencia_de_transporte"));
    const acao = getAction("notify_team")!;
    const admin = adminFake(tabelasComTudo());
    const r = await acao.execute(ctx(admin), { membro_id: MEMBRO, canal: "whatsapp" });

    expect(r.status, "exceção do transporte NÃO pode virar 'enviado'").toBe("failed");
    expect((r.detail as { reason: string }).reason).toBe("whatsapp_falhou");
    expect((r.detail as { error?: string }).error).toContain("canal_sem_referencia_de_transporte");
    expect(pacing.registraEnvio, "sem envio não há pacing a cobrar").not.toHaveBeenCalled();
  });

  it("sem SMTP configurado, o aviso não sai e o motivo fica explícito", async () => {
    roteador.emailConfigurado.mockReturnValue(false);
    const acao = getAction("notify_team")!;
    const admin = adminFake(tabelasComTudo());
    const r = await acao.execute(ctx(admin), { membro_id: MEMBRO, canal: "email" });

    expect(r.status).toBe("skipped");
    expect((r.detail as { reason: string }).reason).toBe("smtp_nao_configurado");
    expect(roteador.sendEmail).not.toHaveBeenCalled();
  });
});

describe("notify_team — o resumo é MONTADO, não gravado", () => {
  it("não repete pontuação quando o lead nunca foi pontuado", () => {
    const texto = montarResumoParaAEquipe({
      idioma: "pt-BR",
      regra: "Avisa o closer",
      lead: { ...LEAD_DO_CONTEXTO, value_cents: null, won_reason: null },
      contato: CONTATO_DO_CONTEXTO,
      pontuacao: null,
      passagem: null,
    });
    expect(texto).not.toContain("Pontuação");
    expect(texto).not.toContain("Motivo do ganho");
  });

  it("0% é afirmação, não ausência: o piso legítimo continua saindo", () => {
    const texto = montarResumoParaAEquipe({
      idioma: "pt-BR",
      regra: "Avisa o closer",
      lead: LEAD_DO_CONTEXTO,
      pontuacao: { probabilidade: 0, motivo: "sem interação desde a primeira mensagem" },
    });
    expect(texto).toContain("Pontuação: 0% — sem interação desde a primeira mensagem");
  });

  it("número fora da faixa é cortado nos 0–100 do banco", () => {
    const texto = montarResumoParaAEquipe({
      idioma: "pt-BR",
      regra: "Avisa o closer",
      lead: LEAD_DO_CONTEXTO,
      pontuacao: { probabilidade: 137, motivo: "cálculo torto" },
    });
    expect(texto).toContain("Pontuação: 100%");
  });

  it("a fala do MODELO passa pela limpeza antes de virar mensagem", () => {
    const texto = montarResumoParaAEquipe({
      idioma: "pt-BR",
      regra: "Avisa o closer",
      lead: { ...LEAD_DO_CONTEXTO, title: "meu site é http://phish.example.com/paga e meu CPF é 529.982.247-25" },
      pontuacao: { probabilidade: 80, motivo: "veja https://oferta.example.com/boleto agora" },
    });
    expect(texto, "um link de phishing não pode sair na mensagem da equipe").not.toContain("http");
    expect(texto, "telefone com 8+ dígitos é removido da fala do modelo").not.toContain("529.982.247-25");
  });

  it("falas vazias não viram linha: `Pontuação: ` vazio afirmaria pontuação nenhuma", () => {
    const texto = montarResumoParaAEquipe({
      idioma: "pt-BR",
      regra: "",
      lead: LEAD_DO_CONTEXTO,
      pontuacao: { probabilidade: null, motivo: "   " },
      passagem: { compromissos: [], objecoes: [], proximaAcao: null },
    });
    expect(texto).not.toContain("Pontuação:");
    expect(texto).not.toContain("Compromissos:");
    expect(texto).not.toContain("Regra:");
  });
});
