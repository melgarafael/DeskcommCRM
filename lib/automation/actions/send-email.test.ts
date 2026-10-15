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

function ctx(
  override: Record<string, unknown> = {},
  vinculos: Vinculo[] = EQUIPE_ATIVA,
  falhaDaConsulta: { message: string } | null = null,
): ActionCtx {
  return {
    admin: {
      auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: { email: "dono@estudio.com" } } })) } },
      from: (tabela: string) => {
        if (tabela !== "user_organizations") throw new Error(`tabela inesperada: ${tabela}`);
        return tabelaDeVinculos(vinculos, falhaDaConsulta);
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

beforeEach(() => enviar.mockReset());

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
