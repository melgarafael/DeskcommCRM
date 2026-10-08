/**
 * O PDF DE ACESSO ENTREGA O ART. 15.º INTEIRO — e o `data.json` entrega a
 * cópia COMPLETA do n.º 3 (issue #2340, continuação do doc 88 / PR #2339).
 *
 * Este é o gate da pré-condição que trava
 * `tests/unit/so-a-nuvemshop-cria-pedido-de-titular.test.ts`: enquanto o
 * relatório não entregasse as alíneas a), c), d), e), f) e h) do n.º 1 e a
 * cópia do n.º 3, nenhum caminho novo de pedido de titular podia abrir.
 *
 * ─── O que cada caso fecha ──────────────────────────────────────────────────
 *
 * - alíneas preenchidas pelo RESPONSÁVEL (a, c, d) saem de
 *   `organizations.settings.art15`, com "não informado pelo controlador" onde
 *   ele deixou em branco — mentir numa alínea exigida é pior que imprimi-la
 *   vazia;
 * - a alínea f) sai do `autoridadeDeSupervisao` do PERFIL do país (CNPD em
 *   Portugal), e não de texto fixo: país novo troca junto com a lei;
 * - a alínea h) vem dos agentes de IA NO AR (`agenteAtende`: publicado, sem
 *   pausa, não arquivado), NUNCA de `is_active` — a tela cria `mcp_agent` com
 *   `is_active: false` e publicar não religa, então a fixture principal é
 *   exatamente esse caso. O modo decide a frase: `automatic` responde sozinho,
 *   `assisted` sugere e uma pessoa decide;
 * - a cópia do n.º 3 leva `messages_completas` = TODAS as mensagens, contra as
 *   100 de `RECENT_MESSAGES_LIMIT`, e o e-mail do titular leva a ligação do
 *   `data.json` — um relatório que promete uma cópia a que não dá ligação
 *   entrega a promessa e não a cópia. As outras seções têm teto de linhas: o
 *   relatório não diz "completa", e as que bateram no teto vêm em
 *   `secoes_no_limite`;
 * - o Brasil continua SEM a seção do art. 15.º, e desde o doc 110 (2A) recebe
 *   no `data.json` as mesmas `messages_completas` e `secoes_no_limite` — o
 *   resto dele os fixtures de `lgpd-brasil-antes-do-doc88/` cobrem byte a byte.
 */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const banco = vi.hoisted(() => ({
  org: {} as Record<string, unknown>,
  mensagens: [] as Array<Record<string, unknown>>,
  agentes: [] as Array<Record<string, unknown>>,
  conversas: [] as Array<Record<string, unknown>>,
}));

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/email/roteador", () => ({
  sendEmail: vi.fn(async () => ({ ok: true, id: "m1" })),
}));

/**
 * Banco falso com paginação de verdade: `limit` e `range` cortam a lista, e o
 * `head: true` da contagem devolve `count`. Sem isso a cópia das mensagens do n.º 3
 * passaria num mock que devolve tudo para qualquer pergunta — o teste mediria
 * o mock, não o laço de paginação.
 */
vi.mock("@/lib/supabase/admin", () => {
  const linhas = (tabela: string): Array<Record<string, unknown>> =>
    tabela === "organizations"
      ? [banco.org]
      : tabela === "messages"
        ? banco.mensagens
        : tabela === "ai_agents"
          ? banco.agentes
          : tabela === "conversations"
            ? banco.conversas
            : [];
  const de = (tabela: string) => {
    const rows = linhas(tabela);
    const estado = { offset: 0, size: undefined as number | undefined, head: false };
    const q: Record<string, unknown> = {
      select: (_cols: string, opts?: { head?: boolean }) => {
        estado.head = Boolean(opts?.head);
        return q;
      },
      eq: () => q,
      in: () => q,
      or: () => q,
      order: () => q,
      limit: (n: number) => {
        estado.size = n;
        return q;
      },
      range: (a: number, b: number) => {
        estado.offset = a;
        estado.size = b - a + 1;
        return q;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => {
        const fatia =
          estado.size === undefined ? rows : rows.slice(estado.offset, estado.offset + estado.size);
        return Promise.resolve({
          data: estado.head ? [] : fatia,
          error: null,
          count: rows.length,
        }).then(ok, ko);
      },
    };
    return q;
  };
  return {
    createAdminClient: () => ({ from: de, rpc: async () => ({ data: null, error: null }) }),
  };
});

import { PERFIS_DO_PAIS, perfilDoPais, type PerfilDoPais } from "@/lib/legal/perfil-do-pais";
import { sendEmail } from "@/lib/email/roteador";
import { sendExportEmail } from "@/lib/lgpd/email-delivery";
import { collectExportData, type ExportPayload } from "@/lib/lgpd/export-collector";
import { LgpdExportPdf } from "@/lib/lgpd/pdf-renderer";

/** 120 mensagens: passa de `RECENT_MESSAGES_LIMIT` (100) e é menos que a página. */
const TOTAL_MENSAGENS = 120;

const SETTINGS_PREENCHIDO = {
  art15: {
    finalidades: "Atendimento ao cliente, gestão de pedidos e faturação.",
    destinatarios: "Prestadores de serviços de alojamento e de envio de e-mail, dentro da UE.",
    prazo_conservacao: "5 anos depois do último contacto.",
  },
};

function org(country: string | null, settings?: unknown) {
  banco.org = {
    legal_name: "Clínica Bem Viver, Lda.",
    display_name: "Bem Viver",
    dpo_email: "dpo@bv.test",
    country,
    timezone: country === "PT" ? "Europe/Lisbon" : "America/Sao_Paulo",
    ...(settings === undefined ? {} : { settings }),
  };
}

beforeEach(() => {
  banco.mensagens = Array.from({ length: TOTAL_MENSAGENS }, (_, i) => ({
    id: `m${i}`,
    conversation_id: "cv1",
    direction: i % 2 === 0 ? "inbound" : "outbound",
    type: "text",
    status: "delivered",
    body: `mensagem ${i}`,
    media_url: null,
    media_derived_text: null,
    sent_at: null,
    created_at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
  }));
  banco.conversas = [];
  banco.agentes = [
    // O caso COMUM: criado pela tela (`is_active: false`) e publicado.
    agente({ id: "a1", name: "Agente de Atendimento", operation_mode: "automatic" }),
    agente({ id: "a2", name: "Agente Assistente", operation_mode: "assisted" }),
    agente({ id: "a3", name: "Agente Arquivado", archived_at: "2026-02-01T00:00:00.000Z" }),
    agente({ id: "a4", name: "Agente Pausado", paused_at: "2026-02-01T00:00:00.000Z" }),
    // `is_active: true` sem versão publicada: não está no ar, não responde.
    agente({ id: "a5", name: "Agente Rascunho", is_active: true, published_version_id: null }),
  ];
});

afterEach(() => {
  delete PERFIS_DO_PAIS.XI;
});

function agente(campos: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "mcp_agent",
    is_active: false,
    operation_mode: "automatic",
    paused_at: null,
    published_version_id: "v1",
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...campos,
  };
}

/** O texto da alínea h) no PDF, sem o resto do documento. */
function alineaH(payload: ExportPayload): string {
  expect(payload.art15, "o bloco do art. 15.º sumiu do data.json").toBeDefined();
  return payload.art15!.decisoes_automatizadas;
}

async function coleta(country: string | null, settings?: unknown): Promise<ExportPayload> {
  org(country, settings);
  return collectExportData({
    organizationId: "org-1",
    requestId: "r1",
    contactId: "c1",
    externalCustomerId: null,
  });
}

function textos(no: ReactNode): string[] {
  if (no === null || no === undefined || typeof no === "boolean") return [];
  if (typeof no === "string") return [no];
  if (typeof no === "number") return [String(no)];
  if (Array.isArray(no)) return no.flatMap(textos);
  const el = no as ReactElement<{ children?: ReactNode }>;
  if (el.props && "children" in el.props) return textos(el.props.children);
  return [];
}

/** O PDF achado, com espaços colapsados — a mesma técnica de `lgpd-pdf-controlador`. */
function pdf(payload: ExportPayload): string {
  return textos(LgpdExportPdf({ data: payload })).join(" ").replace(/\s+/g, " ");
}

describe("art. 15.º, n.º 1 — alínea a alínea no PDF", () => {
  it("Portugal: entrega a), c), d), e), f) e h) com a autoridade do perfil", async () => {
    const payload = await coleta("PT", SETTINGS_PREENCHIDO);
    expect(payload.art15, "o bloco do art. 15.º sumiu do data.json").toBeDefined();
    const tudo = pdf(payload);

    // a), c), d) — preenchidas pelo responsável, vindo de settings.art15.
    expect(tudo).toContain("a) Finalidades:");
    expect(tudo).toContain("Atendimento ao cliente, gestão de pedidos e faturação.");
    expect(tudo).toContain("c) Destinatários:");
    expect(tudo).toContain("Prestadores de serviços de alojamento e de envio de e-mail, dentro da UE.");
    expect(tudo).toContain("d) Conservação:");
    expect(tudo).toContain("5 anos depois do último contacto.");

    // e) — o texto fixo da lei (retificação, apagamento, oposição).
    expect(tudo).toContain("e) Direitos");
    expect(tudo).toContain("retificação ou o apagamento");
    expect(tudo).toContain("artigos 16.º, 17.º, 18.º e 21.º do RGPD");

    // f) — do `autoridadeDeSupervisao` do PERFIL do país.
    expect(tudo).toContain("f) Reclamação a uma autoridade de controlo");
    expect(tudo).toContain("Comissão Nacional de Proteção de Dados (CNPD)");
    expect(tudo).toContain("https://www.cnpd.pt");

    // h) — dos agentes de IA NO AR; arquivado, pausado e rascunho ficam fora.
    expect(tudo).toContain("h) Decisões automatizadas");
    expect(tudo).toContain("Agente de Atendimento");
    expect(tudo).not.toContain("Agente Arquivado");
    expect(tudo).not.toContain("Agente Pausado");
    expect(tudo).not.toContain("Agente Rascunho");

    // n.º 3 — as palavras do n.º 3 (não as do art. 20.º), sem "completa".
    expect(tudo).toContain("data.json");
    expect(tudo).toContain("n.º 3");
    expect(tudo).toContain("em fase de tratamento, em formato eletrónico de uso corrente");
    expect(tudo).toContain("secoes_no_limite");
    expect(tudo).not.toMatch(/c[óo]pia completa/i);
    expect(tudo).not.toContain("formato estruturado");
  });

  it("Portugal: sem o responsável preencher, cada alínea diz que não foi informada", async () => {
    const payload = await coleta("PT");
    const tudo = pdf(payload);
    expect(tudo.match(/não informado pelo controlador/g), "as 3 alíneas vazias").toHaveLength(3);
    // O vazio não pode virar mentira: nenhuma finalidade inventada.
    expect(tudo).not.toContain("Atendimento ao cliente");
  });

  it("Brasil: sem a seção do art. 15.º no PDF; o data.json leva todas as mensagens (doc 110, 2A)", async () => {
    const payload = await coleta(null, SETTINGS_PREENCHIDO);
    expect(payload.art15).toBeUndefined();
    const tudo = pdf(payload);
    expect(tudo).not.toContain("art. 15.º, n.º 1");
    expect(tudo).not.toContain("CNPD");
    expect(tudo, "o PDF brasileiro não cita a ressalva").not.toContain("secoes_no_limite");
    expect(Object.keys(payload)).not.toContain("art15");
    expect(payload.messages_recent).toHaveLength(100);
    expect(payload.messages_completas, "o Brasil ficou no recorte de 100").toHaveLength(TOTAL_MENSAGENS);
  });

  it("país sem citação revisada não herda a lista do RGPD nem a CNPD de Portugal", async () => {
    PERFIS_DO_PAIS.XI = {
      ...perfilDoPais("PT"),
      codigo: "XI",
      nome: "Xistão",
      lei: null,
    } as PerfilDoPais;
    org("XI", SETTINGS_PREENCHIDO);
    const payload = await collectExportData({
      organizationId: "org-1",
      requestId: "r1",
      contactId: "c1",
      externalCustomerId: null,
    });
    expect(payload.art15).toBeUndefined();
    expect(pdf(payload)).not.toContain("CNPD");
  });
});

describe("art. 15.º, n.º 1, al. h) — só o que o sistema sabe", () => {
  it("agente publicado com is_active:false em modo automático: diz que responde sozinho", async () => {
    banco.agentes = [agente({ id: "a1", name: "Agente de Atendimento" })];
    const h = alineaH(await coleta("PT"));
    expect(h).toContain("Responde(m) automaticamente às suas mensagens 1 assistente(s) de IA: Agente de Atendimento.");
    expect(h).not.toContain("Sugere(m)");
    // A frase que o automático desmente, e a afirmação que o sistema não sabe.
    expect(h).not.toContain("não decide por si só");
    expect(h).not.toMatch(/^Sim\./);
    expect(h).toContain("quem o informa é o controlador");
  });

  it("só modo assistido: a IA sugere e uma pessoa decide", async () => {
    banco.agentes = [agente({ id: "a2", name: "Agente Assistente", operation_mode: "assisted" })];
    const h = alineaH(await coleta("PT"));
    expect(h).toContain("Sugere(m) respostas que uma pessoa revê e decide enviar 1 assistente(s) de IA: Agente Assistente.");
    expect(h).not.toContain("automaticamente");
  });

  it("os dois modos ao mesmo tempo: cada agente na frase do seu modo", async () => {
    const h = alineaH(await coleta("PT"));
    expect(h).toContain("automaticamente às suas mensagens 1 assistente(s) de IA: Agente de Atendimento.");
    expect(h).toContain("decide enviar 1 assistente(s) de IA: Agente Assistente.");
  });

  it("nenhum agente no ar (pausado, arquivado, rascunho com is_active:true): não há assistente a responder", async () => {
    banco.agentes = banco.agentes.filter((a) => ["a3", "a4", "a5"].includes(a.id as string));
    const h = alineaH(await coleta("PT"));
    expect(h).toBe("Não há assistente de IA a responder às suas mensagens nesta organização.");
    // Nada de afirmar ausência de definição de perfis ou de decisão: o sistema não sabe.
    expect(h).not.toMatch(/perfil|decisão/i);
  });
});

describe("art. 15.º, n.º 3 — a cópia", () => {
  it("o data.json declara as seções que bateram no teto de linhas", async () => {
    banco.conversas = Array.from({ length: 500 }, (_, i) => ({ id: `cv${i}`, is_group: false }));
    const cheio = await coleta("PT");
    expect(cheio.secoes_no_limite).toEqual(["conversations"]);

    banco.conversas = [{ id: "cv1", is_group: false }];
    const folgado = await coleta("PT");
    expect(folgado.secoes_no_limite, "nenhuma seção no teto é lista vazia, não ausência").toEqual([]);

    // Brasil: o mesmo aviso desde o doc 110 (2A).
    banco.conversas = Array.from({ length: 500 }, (_, i) => ({ id: `cv${i}`, is_group: false }));
    expect((await coleta(null)).secoes_no_limite).toEqual(["conversations"]);
  });

  it("o data.json leva TODAS as mensagens, contra as 100 do recorte do PDF", async () => {
    const payload = await coleta("PT");
    expect(payload.messages_recent).toHaveLength(100);
    expect(payload.messages_completas, "a cópia completa ficou no recorte").toHaveLength(
      TOTAL_MENSAGENS,
    );
    expect(payload.messages_count_total).toBe(TOTAL_MENSAGENS);
    expect(payload.messages_completas!.map((m) => m.id)).toContain("m119");
  });

  it("o e-mail ao titular entrega a ligação do data.json (fora do Brasil)", async () => {
    await sendExportEmail({
      to: "titular@x.test",
      requestId: "3f2a9c10-0000-4000-8000-000000000001",
      signedUrl: "https://storage.test/report.pdf?token=abc",
      signedUrlDados: "https://storage.test/data.json?token=abc",
      expiresAt: new Date("2026-10-08T12:00:00.000Z"),
      marca: { nome: "Bem Viver", logoUrl: null, accent: "#2f6f4e", accentFg: "#fff", origens: { nome: "banco", cor: "banco" } },
      perfil: perfilDoPais("PT"),
      fuso: "Europe/Lisbon",
    });
    const enviado = (sendEmail as unknown as Mock).mock.calls[0]![0] as {
      text: string;
      html: string;
    };
    for (const corpo of [enviado.text, enviado.html]) {
      expect(corpo).toContain("data.json");
      expect(corpo).toContain("https://storage.test/data.json?token=abc");
    }
    expect(enviado.text).toContain("A cópia dos seus dados pessoais (data.json) está em:");
    for (const corpo of [enviado.text, enviado.html]) {
      expect(corpo).not.toMatch(/c[óo]pia completa/i);
      expect(corpo).not.toContain("formato estruturado");
    }
  });
});
