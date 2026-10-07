// @vitest-environment node
/**
 * Os quatro gatilhos de saída da #1528 — ganho, perda, reabertura e troca de
 * responsável — e a propriedade que os torna úteis: O MESMO FATO emite o MESMO
 * evento com o MESMO corpo, não importa o botão que a pessoa apertou.
 *
 * ## Onde o fato nasce (e por que os caminhos convergem)
 *
 * Quem emite `lead.won`/`lead.lost`/`lead.reopened`/`lead.assigned` é UMA fonte
 * só: o trigger `trg_emit_event_on_lead_change` → `fn_emit_event_on_lead_change`
 * → `fn_log_event`, no banco. Arrastar o card, o botão Ganhou/Perdeu
 * (`lib/leads/encerramento.ts`), o mover em lote, o `crm_close_demand` da IA e o
 * `create_or_move_lead` todos terminam no MESMO UPDATE de `crm_leads.status` /
 * `owner_user_id`, então a igualdade de payload entre caminhos é ESTRUTURAL —
 * não há um emissor por caminho para divergir. Este arquivo fixa as duas pontas
 * dessa afirmação:
 *
 *  1. a ponta do BANCO (lida da `baseline.sql`, a fonte que o self-host aplica):
 *     o trigger só emite quando o fato mudou, com um payload que é função pura
 *     da linha — sem mudança, não há linha em `event_log`, logo não há entrega;
 *  2. a ponta do MOTOR: a linha chega com `entity_kind='lead'` (o `fn_log_event`
 *     deriva do `split_part` do event_type) e tem de virar regra rodando, com o
 *     lead hidratado, em vez de cair em `entity_kind_mismatch`.
 *
 * ## O que este arquivo NÃO prova
 *
 * Não sobe Postgres (a suíte de invariants é quem roda o trigger de verdade) e
 * não clica na tela. Aqui o banco é um Supabase em memória e o receptor é um
 * servidor HTTP local de verdade — o mesmo desenho de
 * `tests/unit/webhook-de-saida-mesma-entrega.test.ts`.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  audit: vi.fn(),
  criarClientAdmin: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => deps.criarClientAdmin() }));
// O receptor é 127.0.0.1, que os guardas anti-SSRF recusam — e devem. Aqui
// eles não são o assunto (os testes deles moram em outro arquivo).
vi.mock("@/lib/automation/outbound-url", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertSafeOutboundUrl: () => undefined,
}));
vi.mock("@/lib/automation/outbound-ip", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertDestinoResolvidoSeguro: async () => undefined,
}));

import { runAutomationForEvent, buildContext } from "@/lib/automation/engine";
import { automationRulesHandler } from "@/lib/automation/engine.handler";
import { ENTIDADE_ESPERADA_POR_GATILHO, TRIGGER_EVENTS } from "@/lib/schemas/webhooks";
import { TRIGGER_LABELS } from "@/app/app/webhooks/_components/labels";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { idDaEntrega } from "@/lib/automation/actions/call-webhook";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD_ID = "55555555-5555-4555-8555-555555555555";
const CONTATO_ID = "66666666-6666-4666-8666-666666666666";
const ANA = "99999999-0000-4000-8000-000000000001";
const BETO = "99999999-0000-4000-8000-000000000002";
const REGRA_GANHO = "77777777-7777-4777-8777-777777777701";
const REGRA_ATRIBUICAO = "77777777-7777-4777-8777-777777777702";
const REGRA_ATRIBUICAO_OPTIN = "77777777-7777-4777-8777-777777777703";

/** Os quatro que nascem do trigger do banco (#1528). */
const GATILHOS_NOVOS = ["lead.won", "lead.lost", "lead.reopened", "lead.assigned"] as const;

type Linha = Record<string, unknown>;

/**
 * Supabase em memória no mesmo desenho do vizinho: `from(tabela)` filtra por
 * `.eq`, `insert` grava e devolve a linha, e o construtor é "thenable" como o
 * de verdade. Acrescenta só `auth.admin.getUserById` (resolução de nome do
 * responsável sob opt-in) e `order`.
 */
function bancoFalso(tabelas: Record<string, Linha[]>): SupabaseClient {
  const cliente = {
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      let inserida: Linha | null = null;
      const linhas = (): Linha[] =>
        inserida
          ? [inserida]
          : (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v));
      const consulta = {
        select: () => consulta,
        order: () => consulta,
        update: () => consulta,
        eq: (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          return consulta;
        },
        insert: (payload: Linha) => {
          inserida = { id: randomUUID(), ...payload };
          (tabelas[tabela] ??= []).push(inserida);
          return consulta;
        },
        maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
        single: async () => ({ data: linhas()[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
          Promise.resolve({ data: linhas(), error: null }).then(ok, erro),
      };
      return consulta;
    },
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: {
            user: {
              id,
              email: `${id.slice(0, 4)}@estudio.test`,
              user_metadata: { full_name: id === ANA ? "Ana Souza" : "Beto Lima" },
            },
          },
          error: null,
        }),
      },
    },
  };
  return cliente as unknown as SupabaseClient;
}

/** A linha do negócio, como ela está quando o fato acontece. */
function leadRow(extra: Linha = {}): Linha {
  return {
    id: LEAD_ID,
    organization_id: ORG,
    contact_id: CONTATO_ID,
    title: "Pedido #42",
    status: "won",
    pipeline_id: "pipe-1",
    stage_id: "stage-won",
    value_cents: 50_000,
    currency: "BRL",
    tags: ["vip"],
    custom_fields: {},
    won_reason: null,
    lost_reason: null,
    closed_at: "2026-10-03T12:00:00.000Z",
    source: "whatsapp",
    created_at: "2026-10-01T09:00:00.000Z",
    owner_user_id: ANA,
    owner_agent_id: null,
    owner_kind: "user",
    organization_secret: "nao-pode-sair",
    ...extra,
  };
}

function evento(eventType: string, payload: Linha, id: string, kind = "lead"): EventRow {
  return {
    id,
    organization_id: ORG,
    event_type: eventType,
    entity_kind: kind,
    entity_id: LEAD_ID,
    payload,
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: "2026-10-03T12:00:00.000Z",
  };
}

type Corpo = {
  event: string;
  delivery_id: string;
  happened_at: string;
  data: Record<string, unknown>;
};

const corpos: Corpo[] = [];
const cabecalhos: Array<Record<string, string | string[] | undefined>> = [];
let url = "";
let fecharReceptor: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const server = createServer((req, res) => {
    const pedacos: Buffer[] = [];
    req.on("data", (c: Buffer) => pedacos.push(c));
    req.on("end", () => {
      cabecalhos.push(req.headers);
      corpos.push(JSON.parse(Buffer.concat(pedacos).toString("utf8")) as Corpo);
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  url = `http://127.0.0.1:${port}/hook`;
  fecharReceptor = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await fecharReceptor();
});

beforeEach(() => {
  corpos.length = 0;
  cabecalhos.length = 0;
});

/** Monta o cenário inteiro e devolve o banco + as tabelas para inspeção. */
function cenario(regraExtra: Linha[] = []): { banco: SupabaseClient; tabelas: Record<string, Linha[]> } {
  const acoesGanho = [{ type: "call_webhook", config: { url } }];
  const tabelas: Record<string, Linha[]> = {
    automation_rules: [
      {
        id: REGRA_GANHO,
        organization_id: ORG,
        trigger_event: "lead.won",
        is_active: true,
        name: "Avisa o faturamento quando ganhar",
        conditions: [],
        actions: acoesGanho,
      },
      {
        id: REGRA_ATRIBUICAO,
        organization_id: ORG,
        trigger_event: "lead.assigned",
        is_active: true,
        name: "Avisa a troca de responsável",
        conditions: [],
        actions: [{ type: "call_webhook", config: { url } }],
      },
      {
        id: REGRA_ATRIBUICAO_OPTIN,
        organization_id: ORG,
        trigger_event: "lead.assigned",
        is_active: true,
        name: "Avisa a troca com o responsável identificado",
        conditions: [],
        actions: [{ type: "call_webhook", config: { url, include_owner: true } }],
      },
      ...regraExtra,
    ],
    crm_leads: [leadRow()],
    contacts: [
      {
        id: CONTATO_ID,
        organization_id: ORG,
        name: "Fulano da Silva",
        display_name: "Fulano",
        email: "fulano@example.com",
        phone_number: "+5511999990000",
        tags: ["lead"],
        created_at: "2026-10-01T09:00:00.000Z",
      },
    ],
    automation_rule_runs: [],
  };
  const banco = bancoFalso(tabelas);
  deps.criarClientAdmin.mockReturnValue(banco);
  return { banco, tabelas };
}

describe("gatilhos de encerramento, reabertura e troca de responsável (#1528)", () => {
  it("a fonte única declara os quatro, o handler assina, o rótulo existe e tem espanhol", () => {
    for (const gatilho of GATILHOS_NOVOS) {
      expect(TRIGGER_EVENTS as readonly string[], gatilho).toContain(gatilho);
      expect(ENTIDADE_ESPERADA_POR_GATILHO[gatilho as keyof typeof ENTIDADE_ESPERADA_POR_GATILHO]).toBe(
        "crm_lead",
      );
      expect([...automationRulesHandler.events], gatilho).toContain(gatilho);
      const rotulo = TRIGGER_LABELS[gatilho as keyof typeof TRIGGER_LABELS];
      expect(rotulo, gatilho).toBeTruthy();
      expect(DICIONARIO[rotulo]?.es, `${gatilho} → ${rotulo}`).toBeTruthy();
    }
  });

  it("arrasto e botão: o MESMO evento, o MESMO corpo de ponta a ponta", async () => {
    const { banco, tabelas } = cenario();
    const acoes = tabelas.automation_rules![0]!.actions as Array<{ type: string; config: Linha }>;

    // Dois caminhos, duas linhas de event_log — o payload é o do trigger.
    await runAutomationForEvent(banco, evento("lead.won", { lead_id: LEAD_ID, value_cents: 50_000 }, "evt-arrasto"));
    await runAutomationForEvent(banco, evento("lead.won", { lead_id: LEAD_ID, value_cents: 50_000 }, "evt-botao"));

    expect(corpos, "a regra lead.won não rodou nos dois caminhos").toHaveLength(2);
    expect(corpos[0]!.event).toBe("lead.won");
    expect(corpos[1]!.event).toBe("lead.won");
    expect(corpos[0]!.data).toEqual(corpos[1]!.data);

    // O envelope de ganho tem o que a integração precisa (#1528 §critérios).
    const lead = corpos[0]!.data.lead as Linha;
    expect(lead.value_cents).toBe(50_000);
    expect(lead.currency).toBe("BRL");
    expect(lead.closed_at).toBe("2026-10-03T12:00:00.000Z");
    expect(corpos[0]!.data.lead_id).toBe(LEAD_ID);
    // Dado interno nunca sai.
    expect(JSON.stringify(corpos[0]!.data)).not.toContain("nao-pode-sair");

    // O id da entrega é determinístico por evento (deduplicação do receptor).
    expect(corpos[0]!.delivery_id).toBe(idDaEntrega("evt-arrasto", REGRA_GANHO, 0, acoes));
    expect(corpos[1]!.delivery_id).toBe(idDaEntrega("evt-botao", REGRA_GANHO, 0, acoes));
    expect(corpos[0]!.delivery_id).not.toBe(corpos[1]!.delivery_id);

    const runs = tabelas.automation_rule_runs!;
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "success")).toBe(true);
  });

  it("perda: o mesmo corpo nos dois caminhos, com lost_reason no lead", async () => {
    const { banco, tabelas } = cenario([
      {
        id: "77777777-7777-4777-8777-777777777704",
        organization_id: ORG,
        trigger_event: "lead.lost",
        is_active: true,
        name: "Avisa a perda",
        conditions: [],
        actions: [{ type: "call_webhook", config: { url } }],
      },
    ]);
    // O lead recém-perdido: a CHECK do banco exige `lost_reason` junto com
    // `status='lost'`, então quando o trigger emite a linha JÁ traz o motivo —
    // é por isso que `data.lead.lost_reason` pode vir da projeção.
    const perda = { lead_id: LEAD_ID, lost_reason: "Preço" };
    tabelas.crm_leads![0] = leadRow({ status: "lost", lost_reason: "Preço" });
    await runAutomationForEvent(banco, evento("lead.lost", perda, "evt-perda-arrasto"));
    await runAutomationForEvent(banco, evento("lead.lost", perda, "evt-perda-botao"));

    expect(corpos).toHaveLength(2);
    expect(corpos[0]!.data).toEqual(corpos[1]!.data);
    expect(corpos[0]!.data.lost_reason).toBe("Preço");
    expect((corpos[0]!.data.lead as Linha).lost_reason).toBe("Preço");
    expect((corpos[0]!.data.lead as Linha).closed_at).toBe("2026-10-03T12:00:00.000Z");
  });

  it("reabertura: um lead encerrado que volta para etapa aberta dispara", async () => {
    const { banco, tabelas } = cenario([
      {
        id: "77777777-7777-4777-8777-777777777705",
        organization_id: ORG,
        trigger_event: "lead.reopened",
        is_active: true,
        name: "Avisa a reabertura",
        conditions: [],
        actions: [{ type: "call_webhook", config: { url } }],
      },
    ]);
    // Reaberto: a linha do lead já está open, com closed_at null (CHECK do banco).
    tabelas.crm_leads![0] = leadRow({ status: "open", closed_at: null });

    await runAutomationForEvent(banco, evento("lead.reopened", { lead_id: LEAD_ID }, "evt-reabertura"));

    expect(corpos).toHaveLength(1);
    expect(corpos[0]!.event).toBe("lead.reopened");
    expect((corpos[0]!.data.lead as Linha).status).toBe("open");
  });

  it("troca de responsável: dispara SEM UUID interno no corpo cru", async () => {
    const { banco, tabelas } = cenario();
    const atribuicao = {
      lead_id: LEAD_ID,
      from_user_id: ANA,
      to_user_id: BETO,
      from_agent_id: null,
      to_agent_id: null,
      owner_kind: "user",
    };

    // O trigger do banco emite `lead.assigned` DEPOIS do UPDATE (`AFTER UPDATE`
    // em `crm_leads`), então quando o drain lê a linha ela já carrega o novo
    // dono — o `owner` do corpo vem da linha ATUAL, mesma doutrina do
    // compromisso (#1612), não do payload.
    tabelas.crm_leads![0] = leadRow({ owner_user_id: BETO });

    await runAutomationForEvent(banco, evento("lead.assigned", atribuicao, "evt-atribuicao"));

    // Duas regras em `lead.assigned`: uma sem opt-in, outra com.
    expect(corpos).toHaveLength(2);
    const semOptIn = corpos.find((c) => c.delivery_id === idDaEntrega("evt-atribuicao", REGRA_ATRIBUICAO, 0, [{ type: "call_webhook", config: { url } }]));
    const comOptIn = corpos.find(
      (c) =>
        c.delivery_id ===
        idDaEntrega("evt-atribuicao", REGRA_ATRIBUICAO_OPTIN, 0, [
          { type: "call_webhook", config: { url, include_owner: true } },
        ]),
    );
    expect(semOptIn, "a regra sem opt-in não entregou").toBeDefined();
    expect(comOptIn, "a regra com opt-in não entregou").toBeDefined();

    const cru = JSON.stringify(semOptIn!.data);
    expect(cru).not.toContain(ANA);
    expect(cru).not.toContain(BETO);
    expect(cru).not.toContain("from_user_id");
    expect(cru).not.toContain("to_user_id");
    expect(semOptIn!.data).not.toHaveProperty("owner");
    // O fato em si continua legível: mudou, e de quem era para quem é.
    expect(semOptIn!.data.lead_id).toBe(LEAD_ID);
    expect(semOptIn!.data.owner_kind).toBe("user");

    // Sob opt-in, o responsável identificado sai — e a identificação é do
    // PRÓPRIO opt-in, nunca acidental.
    expect(comOptIn!.data.owner).toEqual({ kind: "user", id: BETO, name: "Beto Lima" });
  });

  it("o mesmo evento reprocessado entrega o MESMO id (o receptor deduplica)", async () => {
    const { banco } = cenario();
    const linha = evento("lead.won", { lead_id: LEAD_ID, value_cents: 50_000 }, "evt-reprocessado");

    await runAutomationForEvent(banco, linha);
    await runAutomationForEvent(banco, linha);

    expect(corpos).toHaveLength(2);
    expect(corpos[0]!.delivery_id).toBe(corpos[1]!.delivery_id);
    // `happened_at` é a hora do FATO e também não anda.
    expect(corpos[0]!.happened_at).toBe(corpos[1]!.happened_at);
  });

  it("buildContext hidrata o lead e o contato a partir da linha do trigger do banco", async () => {
    const { banco } = cenario();
    const contexto = await buildContext(banco, evento("lead.won", { lead_id: LEAD_ID }, "evt-contexto"));

    expect((contexto.lead as Linha).id).toBe(LEAD_ID);
    expect((contexto.contact as Linha).id).toBe(CONTATO_ID);
    expect(contexto.event).toEqual({ lead_id: LEAD_ID });
  });

  it("o guard continua recusando o lead.stage_changed legado com entity_kind='lead'", async () => {
    // A anti-duplicação de sempre: o moveLeadHandler já emite esse evento com
    // `entity_kind='crm_lead'`; a linha legada do trigger NÃO pode rodar a
    // mesma regra uma segunda vez.
    const { banco, tabelas } = cenario([
      {
        id: "77777777-7777-4777-8777-777777777706",
        organization_id: ORG,
        trigger_event: "lead.stage_changed",
        is_active: true,
        name: "Avisa mudança de etapa",
        conditions: [],
        actions: [{ type: "call_webhook", config: { url } }],
      },
    ]);

    const resultado = await runAutomationForEvent(
      banco,
      evento("lead.stage_changed", { lead_id: LEAD_ID, status: "won" }, "evt-legado", "lead"),
    );

    expect(resultado.status).toBe("skipped");
    expect(resultado.detail).toBe("entity_kind_mismatch");
    expect(corpos).toHaveLength(0);
    expect(tabelas.automation_rule_runs).toHaveLength(0);
  });
});

describe("o trigger do banco: a fonte única dos quatro gatilhos", () => {
  const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

  /** O último corpo de `fn_emit_event_on_lead_change` — o que o self-host aplica. */
  function corpoDoTrigger(): string {
    const definicoes = [
      ...BASELINE.matchAll(
        /create or replace function public\.fn_emit_event_on_lead_change\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$/g,
      ),
    ];
    const ultima = definicoes.at(-1)?.[1];
    if (!ultima) throw new Error("não encontrei fn_emit_event_on_lead_change na baseline.sql");
    return ultima;
  }

  it("só emite quando o fato MUDOU — sem mudança, não há evento e não há entrega", () => {
    const corpo = corpoDoTrigger();
    // INSERT não emite: quem cria o lead é o handler, com entity_kind próprio.
    expect(corpo).toContain("if tg_op = 'INSERT' then");
    // Os dois guards de mudança, um por fato.
    expect(corpo).toContain("if new.status is distinct from old.status then");
    expect(corpo).toContain("if new.owner_user_id is distinct from old.owner_user_id");
    // Todo emisso vem DEPOIS do primeiro guard: não existe caminho que emita
    // sem que a coluna tenha mudado.
    expect(corpo.indexOf("fn_log_event")).toBeGreaterThan(corpo.indexOf("is distinct from"));
  });

  it("emite os quatro, com payload que é função pura da linha (idempotente)", () => {
    const corpo = corpoDoTrigger();
    expect(corpo.match(/fn_log_event/g)).toHaveLength(4);
    expect(corpo).toContain("'lead.won'");
    expect(corpo).toContain("'lead.lost'");
    expect(corpo).toContain("'lead.reopened'");
    expect(corpo).toContain("'lead.assigned'");
    // Payload congelado por gatilho — é o contrato que a igualdade entre
    // caminhos pressupõe (nada de hora, ator ou id de entrega no payload).
    expect(corpo).toContain("'lead_id', new.id, 'value_cents', new.value_cents");
    expect(corpo).toContain("'lead_id', new.id, 'lost_reason', new.lost_reason");
    expect(corpo).toContain("'owner_kind', new.owner_kind");
  });
});
