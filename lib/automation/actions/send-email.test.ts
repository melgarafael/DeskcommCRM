/**
 * A ação `send_email` (#2726) — o e-mail como SAÍDA das regras.
 *
 * O que este arquivo prova:
 *
 *   1. o schema aceita a regra com a ação (e recusa configuração torta);
 *   2. **o caso pedido**: a automação dispara e o DESTINATÁRIO e as VARIÁVEIS
 *      já chegam resolvidos no `sendEmail` — endereço, assunto e corpo sem
 *      nenhuma marcação `{{...}}` sobrando;
 *   3. a falha do transporte vira `failed` com motivo de gente (código no
 *      `error`, mensagem crua do provedor no `detail.error`) — igual ao que
 *      `send-whatsapp.ts` faz, nunca sucesso por omissão;
 *   4. as recusas que NÃO são tentativa (sem e-mail, opt-out, configuração
 *      incompleta) saem como `skipped`/`failed` com o motivo, e o transporte
 *      nem é chamado.
 *
 * O transporte é MOCKADO de propósito: este teste mede a ação, não a Resend
 * nem o SMTP — quem escolhe o caminho é `lib/email/roteador.ts`, e já tem os
 * testes dele (`tests/unit/roteador-de-email-nao-afirma-resend-sem-resend`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/roteador", () => ({ sendEmail: vi.fn() }));

import { sendEmail } from "@/lib/email/roteador";
import { getAction } from "@/lib/automation/actions";
import type { ActionCtx } from "@/lib/automation/types";
import { actionSchema } from "@/lib/schemas/webhooks";

import {
  JANELA_DO_LIMITE_SEG,
  LIMITE_DE_EMAILS_POR_JANELA,
} from "@/lib/automation/actions/send-email";

const enviar = vi.mocked(sendEmail);

const CONFIG = {
  destinatario: "contato",
  assunto: "Sua viagem para {{destino}}",
  corpo: "Oi {{primeiro_nome}}, estamos com tudo certo para {{destino}}. Titular: {{nome}}.",
  formato: "texto",
};

/** O contexto que o motor entrega: lead com campos personalizados + contato. */
function contexto(): Record<string, unknown> {
  return {
    lead: {
      id: "lead-1",
      owner_user_id: "dono-1",
      title: "Lua de mel",
      custom_fields: { destino: "Gramado" },
    },
    contact: {
      id: "contato-1",
      name: "Ana Souza",
      email: "ana@exemplo.com",
      is_blocked: false,
      consent: { marketing: { declined_at: null } },
    },
  };
}

/** Linha de `user_organizations` como o banco a guarda. */
interface Vinculo {
  user_id: string;
  organization_id: string;
  revoked_at: string | null;
}

const EQUIPE_ATIVA: Vinculo[] = [{ user_id: "dono-1", organization_id: "org-1", revoked_at: null }];

/**
 * Dublê de `user_organizations` que APLICA os filtros pedidos sobre as linhas:
 * tirar o `.is("revoked_at", null)` da ação devolve o ex-membro, e o teste vê.
 */
function tabelaDeVinculos(linhas: Vinculo[], falha: { message: string } | null) {
  let restantes = [...linhas];
  const consulta = {
    select: () => consulta,
    eq: (coluna: keyof Vinculo, valor: string) => {
      restantes = restantes.filter((l) => l[coluna] === valor);
      return consulta;
    },
    is: (coluna: keyof Vinculo, valor: null) => {
      restantes = restantes.filter((l) => l[coluna] === valor);
      return consulta;
    },
    maybeSingle: async () =>
      falha ? { data: null, error: falha } : { data: restantes[0] ?? null, error: null },
  };
  return consulta;
}

/** Uma linha de qualquer tabela do resumo, como o PostgREST a devolve. */
type Linha = Record<string, unknown>;

/**
 * As tabelas que o RESUMO lê (#2642), com o cenário de um negócio ganho: a
 * pontuação com o motivo e o checkpoint com o que a conversa combinou.
 */
function tabelasDoResumo(): Record<string, Linha[]> {
  return {
    organizations: [{ id: "org-1", locale: "pt-BR" }],
    crm_lead_scores: [
      {
        organization_id: "org-1",
        lead_id: "lead-1",
        ai_probability: 72,
        ai_probability_reason: "dois compromissos marcados e nenhum orçamento enviado",
      },
    ],
    lead_checkpoints: [
      {
        organization_id: "org-1",
        contact_id: "contato-1",
        seq: 3,
        commitments: ["enviar proposta até sexta"],
        objections: ["preço acima do orçamento do cliente"],
        next_action: "ligar para fechar o pagamento",
      },
    ],
  };
}

/** O mesmo dublê, para as tabelas do resumo: aplica os filtros e devolve a primeira linha. */
function tabelaGenerica(linhas: Linha[]) {
  let restantes = [...linhas];
  const consulta = {
    select: () => consulta,
    eq: (coluna: string, valor: unknown) => {
      restantes = restantes.filter((l) => l[coluna] === valor);
      return consulta;
    },
    is: () => consulta,
    order: () => consulta,
    limit: () => consulta,
    maybeSingle: async () => ({ data: restantes[0] ?? null, error: null }),
  };
  return consulta;
}

/** Quais tabelas a ação LEU — é assim que o teste prova que o resumo é sob demanda. */
interface Leitura {
  tabelas: Record<string, Linha[]>;
  lidas: string[];
}

/**
 * `organizations` tem DUAS leituras nesta ação, e o dublê as separa pela FORMA
 * da consulta — não por um flag:
 *
 *   - `select("settings")` → o remetente da organização desta fatia (#3287);
 *   - `select("locale")`   → o idioma do resumo da equipe (`{{resumo}}`), que só
 *                            roda quando o modelo usa a variável. É ESTA que
 *                            entra em `lidas`; a de `settings` não, porque não é
 *                            resumo — e é isso que mantém honesta a asserção de
 *                            que o modelo sem `{{resumo}}` não lê tabela de
 *                            resumo nenhuma.
 */
function tabelaDaOrganizacao(marca: Record<string, unknown> | null, leitura: Leitura | null) {
  const linha: Linha = {
    id: "org-1",
    locale: "pt-BR",
    settings: marca === null ? null : { branding: marca },
  };
  let restantes: Linha[] = [linha];
  let colunas = "";
  const consulta = {
    select: (c: string) => {
      colunas = c;
      return consulta;
    },
    eq: (coluna: string, valor: unknown) => {
      restantes = restantes.filter((l) => l[coluna] === valor);
      return consulta;
    },
    is: () => consulta,
    maybeSingle: async () => {
      if (colunas.includes("locale")) {
        // A leitura do idioma só existe junto com o resumo: se ela acontecer sem
        // `{{resumo}}` no modelo, o dublê diz isso em vez de devolver um valor.
        if (leitura === null) throw new Error("leitura do resumo sem {{resumo}} no modelo");
        leitura.lidas.push("organizations");
      }
      return { data: restantes[0] ?? null, error: null };
    },
  };
  return consulta;
}

function ctx(
  override: Record<string, unknown> = {},
  vinculos: Vinculo[] = EQUIPE_ATIVA,
  falhaDaConsulta: { message: string } | null = null,
  resumo: Leitura | null = null,
  emailDoAcesso: (id: string) => string | null = () => "dono@estudio.com",
  /** O `settings.branding` da organização — o remetente da automação (#3287). */
  marcaDaOrganizacao: Record<string, unknown> | null = null,
): ActionCtx {
  return {
    admin: {
      auth: {
        admin: {
          getUserById: vi.fn(async (id: string) => ({ data: { user: { email: emailDoAcesso(id) } } })),
        },
      },
      from: (tabela: string) => {
        if (tabela === "user_organizations") return tabelaDeVinculos(vinculos, falhaDaConsulta);
        // `organizations` é lida pela AÇÃO (o remetente da automação, #3287) e —
        // só com `{{resumo}}` — pelo carregador do resumo. O dublê separa as
        // duas pela forma da consulta; ver `tabelaDaOrganizacao`.
        if (tabela === "organizations") return tabelaDaOrganizacao(marcaDaOrganizacao, resumo);
        // Sem `resumo`, ler qualquer outra tabela é defeito: o dublê estoura e
        // o teste de `{{resumo}}` que não é usado vira vermelho se a ação
        // passar a carregar o resumo sempre.
        if (resumo === null) throw new Error(`tabela inesperada: ${tabela}`);
        resumo.lidas.push(tabela);
        return tabelaGenerica(resumo.tabelas[tabela] ?? []);
      },
    } as unknown as ActionCtx["admin"],
    organizationId: "org-1",
    ruleId: "rule-1",
    ruleName: "Aviso de viagem",
    requestId: "evt-1",
    event: {
      id: "evt-1",
      organization_id: "org-1",
      event_type: "lead.stage_changed",
      entity_kind: "crm_lead",
      entity_id: "lead-1",
      payload: {},
      metadata: {},
      consumed_by: [],
      attempts: 0,
    },
    context: { ...contexto(), ...override },
  } as ActionCtx;
}

const acao = () => getAction("send_email");

beforeEach(() => {
  enviar.mockReset();
  // Sucesso por PADRÃO no dublê: um teste de recusa não pode passar só porque o
  // transporte estourou com `undefined` — se a ação chamar o envio quando não
  // devia, a asserção de `skipped` é quem fica vermelha, não um TypeError.
  enviar.mockResolvedValue({ ok: true, id: "e-mail-padrao", via: "smtp" });
});

describe("send_email no schema", () => {
  it("a regra com a ação é aceita, com destinatário, assunto e corpo", () => {
    const parsed = actionSchema.parse({ type: "send_email", config: CONFIG });
    expect(parsed).toEqual({ type: "send_email", config: CONFIG });
  });

  it("destinatário fora do conjunto é recusado na porta", () => {
    expect(() =>
      actionSchema.parse({ type: "send_email", config: { ...CONFIG, destinatario: "fax" } }),
    ).toThrow();
  });
});

describe("a automação dispara send_email", () => {
  it("destinatário e variáveis já resolvidos no envio", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail-1", via: "resend" });

    const r = await acao()!.execute(ctx(), CONFIG);

    expect(enviar).toHaveBeenCalledTimes(1);
    const pedido = enviar.mock.calls[0]![0];
    // O destinatário vem do CONTATO, resolvido pela ação — a tela não manda
    // endereço cru para o motor.
    expect(pedido.to).toBe("ana@exemplo.com");
    // Assunto e corpo já sem nenhuma marcação: `{{destino}}` é campo
    // personalizado do lead, `{{primeiro_nome}}`/`{{nome}}` são do contato.
    expect(pedido.subject).toBe("Sua viagem para Gramado");
    expect(pedido.text).toContain("Oi Ana,");
    expect(pedido.text).toContain("Gramado");
    expect(pedido.text).toContain("Ana Souza");
    expect(JSON.stringify(pedido)).not.toContain("{{");

    expect(r).toEqual({
      type: "send_email",
      status: "success",
      detail: { destinatario: "contato", via: "resend", email_id: "e-mail-1" },
    });
  });

  it("corpo em HTML simples sai como está, e o texto sem as tags", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail-2", via: "smtp" });

    await acao()!.execute(
      ctx(),
      {
        destinatario: "fixo",
        email_fixo: "equipe@estudio.com",
        assunto: "Voucher",
        corpo: "<p>Oi <strong>{{nome}}</strong></p>",
        formato: "html",
      },
    );

    const pedido = enviar.mock.calls[0]![0];
    expect(pedido.to).toBe("equipe@estudio.com");
    expect(pedido.html).toBe("<p>Oi <strong>Ana Souza</strong></p>");
    expect(pedido.text).toBe("Oi Ana Souza");
  });

  it("no HTML, o valor vindo do contato entra como texto, e a marcação do operador fica", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail-4", via: "smtp" });
    const contato = contexto().contact as Record<string, unknown>;
    contato.name = '<a href="https://exemplo.invalid">Ana</a> & "Bia"';

    await acao()!.execute(ctx({ contact: contato }), {
      destinatario: "fixo",
      email_fixo: "equipe@estudio.com",
      assunto: "Voucher",
      corpo: "<p>Oi <strong>{{nome}}</strong></p>",
      formato: "html",
    });

    const pedido = enviar.mock.calls[0]![0];
    expect(pedido.html).toBe(
      "<p>Oi <strong>&lt;a href=&quot;https://exemplo.invalid&quot;&gt;Ana&lt;/a&gt; &amp; &quot;Bia&quot;</strong></p>",
    );
    // A versão em texto leva o valor como a pessoa o escreveu, sem entidades.
    expect(pedido.text).toContain('& "Bia"');
  });

  it("destinatário dono_do_lead resolve o e-mail do responsável", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail-3", via: "resend" });

    const r = await acao()!.execute(ctx(), { ...CONFIG, destinatario: "dono_do_lead" });

    expect(enviar.mock.calls[0]![0].to).toBe("dono@estudio.com");
    expect(r.status).toBe("success");
  });
});

describe("o responsável do negócio só recebe se ainda for da equipe", () => {
  it("ex-membro (vínculo revogado): skipped com dono_fora_da_equipe, sem tentar enviar", async () => {
    const r = await acao()!.execute(
      ctx({}, [{ user_id: "dono-1", organization_id: "org-1", revoked_at: "2026-09-01T00:00:00Z" }]),
      { ...CONFIG, destinatario: "dono_do_lead" },
    );

    expect(r).toEqual({ type: "send_email", status: "skipped", detail: { reason: "dono_fora_da_equipe" } });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("membro ativo de OUTRA empresa não conta como da equipe", async () => {
    const r = await acao()!.execute(
      ctx({}, [{ user_id: "dono-1", organization_id: "org-2", revoked_at: null }]),
      { ...CONFIG, destinatario: "dono_do_lead" },
    );

    expect(r.detail).toEqual({ reason: "dono_fora_da_equipe" });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("consulta de equipe que não volta: não envia, e diz que foi a consulta", async () => {
    const r = await acao()!.execute(ctx({}, EQUIPE_ATIVA, { message: "fetch failed" }), {
      ...CONFIG,
      destinatario: "dono_do_lead",
    });

    expect(r.detail).toEqual({ reason: "membro_indeterminado" });
    expect(enviar).not.toHaveBeenCalled();
  });
});

describe("a falha do transporte não vira sucesso", () => {
  it("recusa do provedor vira failed com motivo e o detalhe cru", async () => {
    enviar.mockResolvedValue({
      ok: false,
      error: "dominio_nao_verificado",
      details: "Domain not verified",
      via: "resend",
    });

    const r = await acao()!.execute(ctx(), CONFIG);

    expect(r.status).toBe("failed");
    // O código é o que a aba Atividade traduz (MOTIVO_DA_PARADA); a mensagem
    // crua do provedor fica no `detail.error` como detalhe técnico.
    expect(r.error).toBe("dominio_nao_verificado");
    expect(r.detail).toMatchObject({ destinatario: "contato", error: "Domain not verified" });
  });

  it("instalação sem e-mail configurado vira failed, nunca sucesso", async () => {
    enviar.mockResolvedValue({ ok: false, error: "not_configured" });

    const r = await acao()!.execute(ctx(), CONFIG);

    expect(r.status).toBe("failed");
    expect(r.error).toBe("email_nao_configurado");
  });
});

describe("as recusas que nem tentam", () => {
  it("contato sem e-mail: skipped com o motivo, e o transporte não é chamado", async () => {
    const semEmail = contexto();
    delete (semEmail.contact as Record<string, unknown>).email;

    const r = await acao()!.execute(ctx({ contact: semEmail.contact }), CONFIG);

    expect(r).toEqual({ type: "send_email", status: "skipped", detail: { reason: "no_email" } });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("contato bloqueado: skipped com contact_blocked, sem tentar enviar", async () => {
    // As irmãs têm este caso na guarda compartilhada (guarda-do-contato.test.ts);
    // esta ação tem guarda própria, então o caso mora aqui.
    const bloqueado = contexto();
    (bloqueado.contact as { is_blocked: boolean }).is_blocked = true;

    const r = await acao()!.execute(ctx({ contact: bloqueado.contact }), CONFIG);

    expect(r).toEqual({ type: "send_email", status: "skipped", detail: { reason: "contact_blocked" } });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("opt-out registrado: skipped com consent_declined, sem tentar enviar", async () => {
    const recusado = contexto();
    (recusado.contact as { consent: { marketing: { declined_at: string } } }).consent.marketing.declined_at =
      "2026-01-01T00:00:00Z";

    const r = await acao()!.execute(ctx({ contact: recusado.contact }), CONFIG);

    expect(r).toEqual({
      type: "send_email",
      status: "skipped",
      detail: { reason: "consent_declined" },
    });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("endereço fixo sem valor: failed com missing_config, sem tentar enviar", async () => {
    const r = await acao()!.execute(
      ctx(),
      { destinatario: "fixo", email_fixo: "", assunto: "Oi", corpo: "Texto" },
    );

    expect(r.status).toBe("failed");
    expect(r.error).toBe("missing_config");
    expect(enviar).not.toHaveBeenCalled();
  });
});

describe("limite de envio por organização", () => {
  const FIXO = { destinatario: "fixo", email_fixo: "equipe@estudio.com", assunto: "Oi", corpo: "Texto" };
  // Relógio parado no meio de uma janela: o laço não pode atravessar a virada.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T10:30:00Z"));
  });
  afterAll(() => vi.useRealTimers());

  /** Cada caso numa organização própria: o contador vive na memória do processo. */
  const daOrg = (org: string, override: Record<string, unknown> = {}): ActionCtx => ({
    ...ctx(override),
    organizationId: org,
  });

  it("os envios de verdade enchem a janela, e aí o evento é adiado até a virada", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail", via: "smtp" });
    const c = daOrg("org-limite-cheio");

    for (let i = 0; i < LIMITE_DE_EMAILS_POR_JANELA; i++) {
      expect(await acao()!.postponeUntil!(c, FIXO)).toBeNull();
      await acao()!.execute(c, FIXO);
    }

    const ate = await acao()!.postponeUntil!(c, FIXO);
    expect(ate).not.toBeNull();
    const ms = Date.parse(ate!);
    expect(ms).toBeGreaterThan(Date.now());
    expect(ms).toBeLessThanOrEqual(Date.now() + JANELA_DO_LIMITE_SEG * 1000);
    // Outra empresa não herda o teto desta.
    expect(await acao()!.postponeUntil!(daOrg("org-limite-vizinha"), FIXO)).toBeNull();
  });

  it("sem a pré-checagem (eventos em paralelo), o envio mesmo segura o teto", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail", via: "smtp" });
    const c = daOrg("org-limite-paralelo");

    const resultados = [];
    for (let i = 0; i <= LIMITE_DE_EMAILS_POR_JANELA; i++) resultados.push(await acao()!.execute(c, FIXO));

    expect(enviar).toHaveBeenCalledTimes(LIMITE_DE_EMAILS_POR_JANELA);
    expect(resultados.at(-1)).toMatchObject({ status: "skipped", detail: { reason: "email_limite_atingido" } });
    expect(resultados.filter((r) => r.status === "success")).toHaveLength(LIMITE_DE_EMAILS_POR_JANELA);
  });

  it("recusa que nem tenta (contato bloqueado) não consome o orçamento", async () => {
    const bloqueado = contexto();
    (bloqueado.contact as { is_blocked: boolean }).is_blocked = true;
    const c = daOrg("org-limite-recusas", { contact: bloqueado.contact });

    for (let i = 0; i <= LIMITE_DE_EMAILS_POR_JANELA; i++) await acao()!.execute(c, CONFIG);

    expect(enviar).not.toHaveBeenCalled();
    expect(await acao()!.postponeUntil!(c, CONFIG)).toBeNull();
  });

  it("a pré-checagem repetida (evento adiado por outra ação) não consome o orçamento", async () => {
    const c = daOrg("org-limite-precheca");

    for (let i = 0; i <= LIMITE_DE_EMAILS_POR_JANELA; i++) {
      expect(await acao()!.postponeUntil!(c, FIXO)).toBeNull();
    }
  });
});

/**
 * #2642 — o destinatário "membro da equipe" e a variável `{{resumo}}`.
 *
 * É o e-mail que antes morava no `notify_team`, com o recorte do PR #2834. O
 * que este bloco cobra:
 *
 *   1. o endereço vem do ACESSO da pessoa, nunca de um campo da regra;
 *   2. o vínculo é conferido NO ENVIO — membro removido da organização não
 *      recebe (o defeito do #2794). É o teste que fica vermelho se alguém
 *      voltar a resolver o destinatário sem olhar `user_organizations`;
 *   3. `{{resumo}}` resolve com a pontuação, o motivo e o que a passagem
 *      combinou, montado no disparo;
 *   4. sem `{{resumo}}` no modelo, a ação NÃO lê as tabelas do resumo (o dublê
 *      estoura em qualquer tabela que não seja `user_organizations`).
 */
const MEMBRO_ID = "66666666-6666-4666-8666-666666666666";
const EQUIPE_COM_MEMBRO: Vinculo[] = [
  { user_id: MEMBRO_ID, organization_id: "org-1", revoked_at: null },
];
const ACESSO_DO_MEMBRO = (id: string) => (id === MEMBRO_ID ? "pessoa@estudio.com" : null);

/** O modelo sem `{{resumo}}`: é o que a maioria das regras de e-mail tem. */
const CONFIG_MEMBRO = {
  destinatario: "membro_da_equipe",
  membro_id: MEMBRO_ID,
  assunto: "Negócio ganho: {{lead.title}}",
  corpo: "Oi! O negócio {{lead.title}} foi ganho.",
  formato: "texto",
};

/** O mesmo destinatário, com o resumo automático no corpo. */
const CONFIG_COM_RESUMO = { ...CONFIG_MEMBRO, corpo: "Oi!\n\n{{resumo}}" };

/** O lead do contexto, com o `contact_id` que liga o negócio ao checkpoint. */
function contextoDoResumo(): Record<string, unknown> {
  return { lead: { ...(contexto().lead as Record<string, unknown>), contact_id: "contato-1" } };
}

describe("send_email — o destinatário \"membro da equipe\" (#2642)", () => {
  it("no schema: aceita com a pessoa escolhida, e recusa sem ela", () => {
    expect(
      actionSchema.safeParse({ type: "send_email", config: CONFIG_MEMBRO }).success,
    ).toBe(true);

    // Sem `membro_id` a regra salvaria e só falharia no disparo — a mesma
    // recusa que o endereço fixo sem endereço já tem.
    expect(
      actionSchema.safeParse({
        type: "send_email",
        config: { ...CONFIG_MEMBRO, membro_id: "" },
      }).success,
    ).toBe(false);
  });

  it("entrega no e-mail do ACESSO da pessoa, não num endereço da regra", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail-membro", via: "smtp" });

    const r = await acao()!.execute(
      ctx({}, EQUIPE_COM_MEMBRO, null, null, ACESSO_DO_MEMBRO),
      CONFIG_MEMBRO,
    );

    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0]![0].to).toBe("pessoa@estudio.com");
    expect(r).toEqual({
      type: "send_email",
      status: "success",
      detail: { destinatario: "membro_da_equipe", via: "smtp", email_id: "e-mail-membro" },
    });
  });

  it("MEMBRO REMOVIDO da organização não recebe: o vínculo é conferido no envio", async () => {
    // O vínculo continua gravado, mas revogado — exatamente o caso do #2794:
    // revogar não reescreve a regra, então quem barra é a checagem do disparo.
    const vinculos: Vinculo[] = [
      { user_id: MEMBRO_ID, organization_id: "org-1", revoked_at: "2026-01-01T00:00:00Z" },
    ];
    const r = await acao()!.execute(
      ctx({}, vinculos, null, null, ACESSO_DO_MEMBRO),
      CONFIG_MEMBRO,
    );

    expect(r.status).toBe("skipped");
    expect((r.detail as { reason: string }).reason).toBe("membro_fora_da_equipe");
    expect(enviar, "e-mail saiu para quem já não é da equipe").not.toHaveBeenCalled();
  });

  it("membro de OUTRA organização também não recebe", async () => {
    const vinculos: Vinculo[] = [
      { user_id: MEMBRO_ID, organization_id: "org-2", revoked_at: null },
    ];
    const r = await acao()!.execute(
      ctx({}, vinculos, null, null, ACESSO_DO_MEMBRO),
      CONFIG_MEMBRO,
    );

    expect(r.status).toBe("skipped");
    expect((r.detail as { reason: string }).reason).toBe("membro_fora_da_equipe");
    expect(enviar).not.toHaveBeenCalled();
  });

  it("consulta do vínculo que não volta não envia, e diz que foi a consulta", async () => {
    const r = await acao()!.execute(
      ctx({}, EQUIPE_COM_MEMBRO, { message: "timeout" }, null, ACESSO_DO_MEMBRO),
      CONFIG_MEMBRO,
    );

    expect(r.status).toBe("skipped");
    expect((r.detail as { reason: string }).reason).toBe("membro_indeterminado");
    expect(enviar).not.toHaveBeenCalled();
  });

  it("pessoa sem e-mail no acesso: skipped com o motivo, sem tentar enviar", async () => {
    const r = await acao()!.execute(
      ctx({}, EQUIPE_COM_MEMBRO, null, null, () => null),
      CONFIG_MEMBRO,
    );

    expect(r.status).toBe("skipped");
    expect((r.detail as { reason: string }).reason).toBe("membro_sem_email");
    expect(enviar).not.toHaveBeenCalled();
  });

  it("sem a pessoa escolhida na execução, a regra não roda (missing_config)", async () => {
    const r = await acao()!.execute(
      ctx({}, EQUIPE_COM_MEMBRO, null, null, ACESSO_DO_MEMBRO),
      { ...CONFIG_MEMBRO, membro_id: "" },
    );

    expect(r).toEqual({ type: "send_email", status: "failed", error: "missing_config" });
    expect(enviar).not.toHaveBeenCalled();
  });
});

describe("send_email — a variável {{resumo}} (#2642)", () => {
  it("resolve só com dado de forma fixa: a pontuação sai sem o motivo, e a passagem não sai", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail-resumo", via: "smtp" });
    const leitura: Leitura = { tabelas: tabelasDoResumo(), lidas: [] };

    await acao()!.execute(
      ctx(contextoDoResumo(), EQUIPE_COM_MEMBRO, null, leitura, ACESSO_DO_MEMBRO),
      CONFIG_COM_RESUMO,
    );

    const pedido = enviar.mock.calls[0]![0];
    expect(pedido.to).toBe("pessoa@estudio.com");
    // O resumo vem do MESMO montador do WhatsApp da equipe: só o número da
    // pontuação; o texto livre da conversa não vai na mensagem (doc 176, A).
    expect((pedido.text ?? "").split("\n")).toContain("Pontuação: 72%");
    expect(pedido.text).not.toContain("dois compromissos marcados");
    expect(pedido.text).not.toContain("enviar proposta até sexta");
    expect(pedido.subject).toBe("Negócio ganho: Lua de mel");
    // Nada de marcação sobrando no que sai.
    expect(JSON.stringify(pedido)).not.toContain("{{");
    // As duas leituras do resumo aconteceram, e só elas: o checkpoint nem é lido.
    expect([...new Set(leitura.lidas)].sort()).toEqual(["crm_lead_scores", "organizations"]);
  });

  it("modelo SEM {{resumo}} não lê as tabelas do resumo", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail-simples", via: "smtp" });
    const leitura: Leitura = { tabelas: tabelasDoResumo(), lidas: [] };

    // Montar o resumo custa duas consultas: quem não usa a variável não paga
    // por elas. (Nos outros testes do bloco o `resumo` é `null`, e o dublê
    // ESTOURA em qualquer tabela que não seja `user_organizations` — é a mesma
    // prova, pelo lado de quem carrega demais.)
    const r = await acao()!.execute(
      ctx(contextoDoResumo(), EQUIPE_COM_MEMBRO, null, leitura, ACESSO_DO_MEMBRO),
      CONFIG_MEMBRO,
    );

    expect(r.status).toBe("success");
    expect(leitura.lidas).toEqual([]);
  });

  it("no HTML, o resumo entra escapado — a fala do modelo não vira marcação", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail-html", via: "smtp" });
    const leitura: Leitura = { tabelas: tabelasDoResumo(), lidas: [] };

    await acao()!.execute(
      ctx(contextoDoResumo(), EQUIPE_COM_MEMBRO, null, leitura, ACESSO_DO_MEMBRO),
      { ...CONFIG_COM_RESUMO, corpo: "<p>{{resumo}}</p>", formato: "html" },
    );

    const pedido = enviar.mock.calls[0]![0];
    expect(pedido.html).toContain("Pontuação: 72%");
    expect(pedido.html).toContain("<p>");
  });
});

/**
 * #3287 (fatia 1) — o REMETENTE DA ORGANIZAÇÃO no e-mail da automação.
 *
 * O que este bloco prende, e é o critério de aceite da issue:
 *
 *   1. com nome de exibição e "responder para" GRAVADOS na organização, os dois
 *      chegam ao `sendEmail` — o dublê do cliente de e-mail registra `fromName`
 *      e `replyTo`, e é por eles que o teste mede;
 *   2. SEM configuração, o envio sai como sempre saiu: as duas chaves ficam
 *      AUSENTES do pedido, não `null` nem `undefined`. A diferença importa: o
 *      caminho SMTP da plataforma usa o `fromName` DELE quando ninguém passa um,
 *      e um `undefined` explícito não é a mesma coisa que a chave ausente;
 *   3. o ENDEREÇO do `From` não vem daqui — quem decide o transporte e o
 *      endereço é `lib/email/roteador.ts`, e esta ação não passa `from`. O SMTP
 *      próprio da organização é a FATIA 2 e não entra nesta fatia.
 */
describe("send_email — o remetente da organização (#3287, fatia 1)", () => {
  /** A configuração da organização como a tela de marca a grava em `settings.branding`. */
  const COM_REMETENTE = { email_from_name: "Loja da Ana", email_reply_to: "contato@lojadaana.com" };

  it("com nome e responder-para configurados, os dois chegam ao envio", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail-org", via: "resend" });

    const r = await acao()!.execute(
      ctx({}, EQUIPE_ATIVA, null, null, undefined, COM_REMETENTE),
      CONFIG,
    );

    expect(enviar).toHaveBeenCalledTimes(1);
    const pedido = enviar.mock.calls[0]![0];
    expect(pedido.fromName).toBe("Loja da Ana");
    expect(pedido.replyTo).toBe("contato@lojadaana.com");
    // O endereço do `From` continua sendo decidido pelo roteador: a ação NÃO
    // manda `from`, então o domínio da plataforma segue no cabeçalho.
    expect("from" in pedido).toBe(false);
    expect(r.status).toBe("success");
  });

  it("sem configuração da organização, o envio sai como hoje: sem fromName e sem replyTo", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail-hoje", via: "smtp" });

    await acao()!.execute(ctx(), CONFIG);

    const pedido = enviar.mock.calls[0]![0];
    // AUSENTES, não `null`: o SMTP da plataforma usa o `fromName` dele quando a
    // chave não vem, e é esse o comportamento de hoje.
    expect("fromName" in pedido).toBe(false);
    expect("replyTo" in pedido).toBe(false);
    expect(pedido).toEqual({
      to: "ana@exemplo.com",
      subject: "Sua viagem para Gramado",
      html: expect.stringContaining("Ana Souza"),
      text: expect.stringContaining("Ana Souza"),
      tags: [{ name: "origem", value: "automacao" }],
    });
  });

  it("organização com marca mas SEM o remetente: nada muda no envio", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail-marca", via: "smtp" });

    await acao()!.execute(
      ctx({}, EQUIPE_ATIVA, null, null, undefined, { app_name: "Loja da Ana", accent_hex: "#b3261e" }),
      CONFIG,
    );

    const pedido = enviar.mock.calls[0]![0];
    expect("fromName" in pedido).toBe(false);
    expect("replyTo" in pedido).toBe(false);
  });

  it("responder-para torto não vira cabeçalho: só o nome vai", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail-torto", via: "smtp" });

    await acao()!.execute(
      ctx({}, EQUIPE_ATIVA, null, null, undefined, {
        email_from_name: "Loja da Ana",
        email_reply_to: "não é endereço",
      }),
      CONFIG,
    );

    const pedido = enviar.mock.calls[0]![0];
    expect(pedido.fromName).toBe("Loja da Ana");
    expect("replyTo" in pedido).toBe(false);
  });

  it("leitura da organização que não volta degrada para o de hoje, e o e-mail sai", async () => {
    enviar.mockResolvedValue({ ok: true, id: "e-mail-degradado", via: "smtp" });

    // Sem `organizations` no dublê (marca `null`) a leitura responde linha nula —
    // o mesmo desfecho de "a organização não configurou nada". O caminho do erro
    // de banco é o irmão deste caso em `lib/email/remetente-da-organizacao.ts`.
    const r = await acao()!.execute(ctx(), CONFIG);

    expect(r.status).toBe("success");
    expect("fromName" in enviar.mock.calls[0]![0]).toBe(false);
  });
});
