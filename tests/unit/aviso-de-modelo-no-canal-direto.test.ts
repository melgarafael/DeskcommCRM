import { createHmac } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AVISO DE STATUS DO MODELO NO CANAL OFICIAL DIRETO (#3635, fatia 3).
 *
 * ─── O buraco medido ──────────────────────────────────────────────────────
 *
 * O webhook `message_template_status_update` já chega e já atualiza
 * `meta_templates`. O que faltava era o EMPURRÃO: quem usa o canal de parceiro
 * recebe aviso na Central quando a Meta aprova, reprova ou pausa um modelo;
 * quem conecta direto pela Cloud API descobria a reprovação no disparo que não
 * saiu — com a campanha montada e o cliente esperando.
 *
 * ─── O que estes testes protegem ──────────────────────────────────────────
 *
 * O aviso não é decoração: é a única superfície onde o operador vê a decisão da
 * Meta sem abrir a tela de modelos. Então o que se prova aqui é o que se erra
 * com facilidade — texto cru da Meta vazando para a tela, aviso duplicado a
 * cada re-entrega, aviso de OUTRA conexão da mesma empresa, e o mais caro de
 * todos: o aviso derrubando o webhook (5xx ⇒ a Meta re-entrega o mesmo evento em
 * backoff por horas ⇒ auto-DDoS).
 */

const ESTADO = vi.hoisted(() => ({ banco: null as unknown }));

const SESSAO = { id: "sess-direto", organizationId: "org-1", wabaId: "WABA" };
const SEGREDO = "segredo_do_app";

vi.mock("@/lib/channels/meta/session", () => ({
  metaSessionByWebhookToken: vi.fn(async () => SESSAO),
}));
vi.mock("@/lib/channels/meta/app", () => ({
  appDaMeta: vi.fn(async () => ({ appSecret: SEGREDO, verifyToken: "v" })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ESTADO.banco,
}));

import { POST } from "@/app/api/v1/webhooks/meta/[token]/route";
import {
  avisarStatusDoModelo,
  avisoDoStatusDoModelo,
  desfechoDoAviso,
  motivoLegivel,
} from "@/lib/channels/meta/aviso-do-modelo";

// ---------------------------------------------------------------------------
// Banco dublado: guarda os avisos como a tabela guardaria — e responde o dedup
// do mesmo jeito que o PostgREST (filtros aplicados, `maybeSingle` com 0 ou 1).
// ---------------------------------------------------------------------------

interface LinhaDeAviso {
  organization_id: string;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  status: string;
}

function bancoFalso(opcoes: { falharInsert?: boolean } = {}) {
  const avisos: LinhaDeAviso[] = [];
  const patches: { patch: Record<string, unknown>; filtros: [string, unknown][] }[] = [];
  let ultimoErroDoInsert: { message: string } | null = null;

  const from = (tabela: string) => {
    const filtros: [string, unknown][] = [];
    let patch: Record<string, unknown> | null = null;
    let inserindo: LinhaDeAviso | null = null;

    const q: Record<string, unknown> = {};
    Object.assign(q, {
      select: () => q,
      update: (p: Record<string, unknown>) => {
        patch = p;
        return q;
      },
      insert: (p: LinhaDeAviso) => {
        inserindo = p;
        return q;
      },
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return q;
      },
      limit: () => q,
      maybeSingle: async () => {
        if (tabela !== "agent_inbox_items") return { data: null, error: null };
        const achado = avisos.find((a) =>
          filtros.every(([coluna, valor]) => (a as unknown as Record<string, unknown>)[coluna] === valor),
        );
        return { data: achado ? { id: "item-1" } : null, error: null };
      },
      then: (ok: (r: unknown) => unknown) => {
        if (tabela === "meta_templates") {
          if (patch) patches.push({ patch, filtros });
          return ok({ data: [{ id: "modelo-1" }], error: null });
        }
        if (inserindo) {
          if (opcoes.falharInsert) {
            ultimoErroDoInsert = { message: "violates check constraint" };
            return ok({ data: null, error: ultimoErroDoInsert });
          }
          avisos.push({ ...inserindo, status: "open" });
          return ok({ data: [{ id: "item-1" }], error: null });
        }
        return ok({ data: [], error: null });
      },
    });
    return q;
  };

  return { admin: { from } as never, avisos, patches };
}

// ---------------------------------------------------------------------------
// Webhook da Meta: envelope real (o parser é o de produção) + assinatura real.
// ---------------------------------------------------------------------------

interface Envelope {
  evento: string;
  nome?: string;
  idioma?: string;
  motivo?: string | null;
  waba?: string;
}

function corpoDoModelo(e: Envelope): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: e.waba ?? SESSAO.wabaId,
        changes: [
          {
            field: "message_template_status_update",
            value: {
              event: e.evento,
              message_template_name: e.nome ?? "boas_vindas",
              message_template_language: e.idioma ?? "pt_BR",
              ...(e.motivo ? { reason: e.motivo } : {}),
            },
          },
        ],
      },
    ],
  });
}

function pedido(corpo: string): NextRequest {
  const assinatura = createHmac("sha256", SEGREDO).update(corpo, "utf8").digest("hex");
  return new NextRequest("http://localhost/api/v1/webhooks/meta/token-do-teste", {
    method: "POST",
    body: corpo,
    headers: { "x-hub-signature-256": `sha256=${assinatura}` },
  });
}

const contexto = { params: Promise.resolve({ token: "token-do-teste" }) };

async function entregar(corpo: string) {
  const r = await POST(pedido(corpo), contexto as never);
  return { status: r.status, body: (await r.json()) as { received: number; outcomes: string[] } };
}

beforeEach(() => {
  ESTADO.banco = bancoFalso();
});

// ---------------------------------------------------------------------------

describe("o texto do aviso", () => {
  it("aprovado é INFO e diz o modelo e o idioma — a Central não fala em código da Meta", () => {
    const a = avisoDoStatusDoModelo({
      templateName: "boas_vindas",
      templateLanguage: "pt_BR",
      event: "APPROVED",
      reason: null,
    });
    expect(a).toMatchObject({ kind: "channel_template_review_direct", severity: "info" });
    expect(a?.title).toContain("boas_vindas");
    expect(a?.title).toContain("pt_BR");
    expect(a?.title).toContain("aprovado");
    expect(a?.body).toContain("Conexões › Modelos");
  });

  it("reprovado é CRÍTICO — a campanha que dependia dele não sai", () => {
    const a = avisoDoStatusDoModelo({
      templateName: "promo",
      templateLanguage: "pt_BR",
      event: "REJECTED",
      reason: "PROMOTIONAL",
    });
    expect(a?.severity).toBe("critical");
    expect(a?.title).toContain("rejeitado");
  });

  it("o motivo chega em português e NUNCA o texto cru da Meta", () => {
    // `PROMOTIONAL` na tela não ensina ninguém a corrigir o texto; a frase em
    // português sim. O código cru fica no espelho (`rejected_reason`), para quem
    // depurar — não na Central, que é lida por quem opera.
    const a = avisoDoStatusDoModelo({
      templateName: "promo",
      templateLanguage: "pt_BR",
      event: "REJECTED",
      reason: "PROMOTIONAL",
    });
    expect(a?.body).toContain("promoção");
    expect(a?.body).not.toContain("PROMOTIONAL");
    expect(a?.body).not.toMatch(/promotional/i);
  });

  it("motivo desconhecido (ou frase em inglês) vira 'não detalhou' — nunca vaza", () => {
    for (const reason of ["Content violated our policy", "ALGO_QUE_A_META_INVENTOU"]) {
      const a = avisoDoStatusDoModelo({
        templateName: "promo",
        templateLanguage: "pt_BR",
        event: "REJECTED",
        reason,
      });
      expect(a?.body).toContain("não detalhou o motivo");
      expect(a?.body).not.toContain(reason);
    }
    expect(motivoLegivel("NONE")).toBeNull();
  });

  it("pausado pede atenção (warn) e desativado é crítico", () => {
    const pausado = avisoDoStatusDoModelo({
      templateName: "x",
      templateLanguage: "pt_BR",
      event: "PAUSED",
      reason: null,
    });
    const desativado = avisoDoStatusDoModelo({
      templateName: "x",
      templateLanguage: "pt_BR",
      event: "DISABLED",
      reason: null,
    });
    expect(pausado?.severity).toBe("warn");
    expect(desativado?.severity).toBe("critical");
  });

  it("evento que a Meta inventar depois NÃO vira aviso — e não explode", () => {
    // O vocabulário dela é aberto. Erro aqui viraria re-entrega em loop.
    expect(
      avisoDoStatusDoModelo({
        templateName: "x",
        templateLanguage: "pt_BR",
        event: "ARCHIVED_BY_SOMETHING_NEW",
        reason: null,
      }),
    ).toBeNull();
  });

  it("os desfechos distinguem 'espelho ok, aviso não' de 'espelho não atualizado'", () => {
    expect(desfechoDoAviso("aviso")).toBe("modelo:aviso");
    expect(desfechoDoAviso("aviso_repetido")).toBe("modelo:aviso_repetido");
    expect(desfechoDoAviso("aviso_falhou")).toBe("modelo:aviso_falhou");
    expect(desfechoDoAviso("sem_aviso")).toBe("modelo");
  });
});

describe("o aviso na Central, pelo webhook do canal oficial direto", () => {
  it("APPROVED atualiza o espelho E abre UM aviso com o nome do modelo e a conexão certa", async () => {
    const banco = bancoFalso();
    ESTADO.banco = banco.admin;

    const r = await entregar(corpoDoModelo({ evento: "APPROVED" }));

    expect(r.status).toBe(200);
    expect(r.body.outcomes).toEqual(["modelo:aviso"]);
    // O espelho primeiro: o aviso manda abrir a tela, e a tela lê daqui.
    expect(banco.patches[0]?.patch).toMatchObject({ status: "APPROVED" });
    expect(banco.patches[0]?.filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", "org-1"],
        ["waba_id", "WABA"],
        ["name", "boas_vindas"],
        ["language", "pt_BR"],
      ]),
    );

    expect(banco.avisos).toHaveLength(1);
    expect(banco.avisos[0]).toMatchObject({
      organization_id: "org-1",
      kind: "channel_template_review_direct",
      severity: "info",
      // O escopo é a CONEXÃO: duas conexões da mesma empresa podem ter modelos
      // homônimos, e o aviso de uma não pode aparecer como se fosse da outra.
      ref_kind: "channel_session",
      ref_id: "sess-direto",
    });
    expect(banco.avisos[0]?.title).toContain("boas_vindas");
  });

  it("REJECTED leva o motivo legível ao corpo e guarda o cru só no espelho", async () => {
    const banco = bancoFalso();
    ESTADO.banco = banco.admin;

    await entregar(corpoDoModelo({ evento: "REJECTED", motivo: "INCORRECT_CATEGORY" }));

    expect(banco.patches[0]?.patch).toMatchObject({
      status: "REJECTED",
      rejected_reason: "INCORRECT_CATEGORY",
    });
    const corpo = banco.avisos[0]?.body ?? "";
    expect(corpo).toContain("categoria");
    expect(corpo).not.toContain("INCORRECT_CATEGORY");
    expect(banco.avisos[0]?.severity).toBe("critical");
  });

  it("duas entregas do MESMO evento ⇒ UM aviso (a Meta re-entrega)", async () => {
    const banco = bancoFalso();
    ESTADO.banco = banco.admin;
    const corpo = corpoDoModelo({ evento: "PAUSED" });

    const primeira = await entregar(corpo);
    const segunda = await entregar(corpo);

    expect(primeira.body.outcomes).toEqual(["modelo:aviso"]);
    expect(segunda.body.outcomes).toEqual(["modelo:aviso_repetido"]);
    expect(banco.avisos).toHaveLength(1);
  });

  it("evento de OUTRA conexão da mesma organização não abre aviso nenhum", async () => {
    const banco = bancoFalso();
    ESTADO.banco = banco.admin;

    // A sessão do token é `WABA`; o corpo diz outra conta. A rota ignora antes
    // de qualquer escrita — é o que impede o aviso de vazar entre conexões.
    const r = await entregar(corpoDoModelo({ evento: "REJECTED", waba: "OUTRA_WABA" }));

    expect(r.status).toBe(200);
    expect(r.body.outcomes).toEqual([]);
    expect(banco.avisos).toHaveLength(0);
    expect(banco.patches).toHaveLength(0);
  });

  it("evento desconhecido: 2xx, SEM aviso, desfecho do parser preservado", async () => {
    const banco = bancoFalso();
    ESTADO.banco = banco.admin;

    const r = await entregar(corpoDoModelo({ evento: "QUALQUER_COISA_NOVA" }));

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ received: 1, outcomes: ["modelo"] });
    expect(banco.avisos).toHaveLength(0);
  });

  it("falha ao gravar o aviso NÃO derruba o espelho nem devolve 5xx — re-entrega em loop é auto-DDoS", async () => {
    const banco = bancoFalso({ falharInsert: true });
    ESTADO.banco = banco.admin;

    const r = await entregar(corpoDoModelo({ evento: "APPROVED" }));

    expect(r.status).toBe(200);
    expect(r.body.outcomes).toEqual(["modelo:aviso_falhou"]);
    // O espelho continua atualizado: perder o empurrão é ruim, perder a
    // informação que a tela mostra é pior.
    expect(banco.patches[0]?.patch).toMatchObject({ status: "APPROVED" });
    expect(banco.avisos).toHaveLength(0);
  });

  it("o aviso só abre DEPOIS do espelho — espelho que falha não manda abrir tela vazia", async () => {
    // Administrador cujo `meta_templates` recusa o update: o evento é de um
    // modelo que este CRM não espelha, e o aviso apontaria para uma lista onde
    // ele não aparece.
    const recusa = {
      from: (tabela: string) => {
        const q: Record<string, unknown> = {};
        Object.assign(q, {
          update: () => q,
          select: () => q,
          insert: () => q,
          eq: () => q,
          limit: () => q,
          maybeSingle: async () => ({ data: null, error: null }),
          then: (ok: (r: unknown) => unknown) =>
            ok(tabela === "meta_templates" ? { data: null, error: { message: "sem linha" } } : { data: [], error: null }),
        });
        return q;
      },
    };
    ESTADO.banco = recusa;

    const r = await entregar(corpoDoModelo({ evento: "APPROVED" }));

    expect(r.status).toBe(200);
    expect(r.body.outcomes).toEqual(["modelo_nao_atualizado"]);
  });

  it("update que não casa linha NENHUMA volta sem erro — e também não abre aviso", async () => {
    // É o que o banco devolve de verdade para um modelo que este CRM não
    // espelha: `{ data: [], error: null }`. Olhar só o `error` abria o aviso
    // de um modelo que a tela de Modelos não lista.
    const avisos: unknown[] = [];
    const semLinha = {
      from: (tabela: string) => {
        const q: Record<string, unknown> = {};
        Object.assign(q, {
          update: () => q,
          select: () => q,
          insert: (p: unknown) => {
            if (tabela === "agent_inbox_items") avisos.push(p);
            return q;
          },
          eq: () => q,
          limit: () => q,
          maybeSingle: async () => ({ data: null, error: null }),
          then: (ok: (r: unknown) => unknown) => ok({ data: [], error: null }),
        });
        return q;
      },
    };
    ESTADO.banco = semLinha;

    const r = await entregar(corpoDoModelo({ evento: "REJECTED", motivo: "INCORRECT_CATEGORY" }));

    expect(r.status).toBe(200);
    expect(r.body.outcomes).toEqual(["modelo_nao_atualizado"]);
    expect(avisos).toHaveLength(0);
  });
});

describe("a gravação direta do aviso", () => {
  it("nunca lança — quem chama é webhook, e exceção aqui viraria 5xx", async () => {
    const explode = {
      from: () => {
        throw new Error("banco fora do ar");
      },
    } as never;

    await expect(
      avisarStatusDoModelo(explode, { organizationId: "org-1", channelSessionId: "sess-direto" }, {
        templateName: "boas_vindas",
        templateLanguage: "pt_BR",
        event: "APPROVED",
        reason: null,
      }),
    ).resolves.toBe("aviso_falhou");
  });

  it("evento sem desfecho conhecido não toca o banco", async () => {
    const banco = bancoFalso();
    await expect(
      avisarStatusDoModelo(banco.admin, { organizationId: "org-1", channelSessionId: "sess-direto" }, {
        templateName: "x",
        templateLanguage: "pt_BR",
        event: "DESCONHECIDO",
        reason: null,
      }),
    ).resolves.toBe("sem_aviso");
    expect(banco.avisos).toHaveLength(0);
  });
});
