/**
 * AS AUTOMAÇÕES DE DEMONSTRAÇÃO DISPARAM, E O HISTÓRICO DELAS É O QUE O MOTOR GRAVARIA.
 *
 * `scripts/seed-automacoes-e-followups.ts` grava regras em `automation_rules`
 * (`conditions` e `actions` são `jsonb`) e execuções em `automation_rule_runs`.
 * O banco aceita qualquer coisa nas duas, e a primeira versão do seed provou o
 * custo: a regra "Quem manda mensagem cai com o gerente" tinha
 * `field: "direction"`, que o motor nunca casa — medido,
 * `evaluateConditions([{field:"direction",…}], {event:{direction:"inbound"}})`
 * devolve `false` —, e o histórico mostrava `assign_owner` numa regra cuja única
 * ação era `add_tag`.
 *
 * Tudo aqui passa pelas peças REAIS: o schema da API, o `buildContext` do motor
 * sobre a linha de `event_log` que o gatilho emite, o `evaluateConditions`, e o
 * executor de `assign_owner`. Só o banco é dublê.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/add-tag";
import "@/lib/automation/actions/assign-owner";
import { evaluateConditions } from "@/lib/automation/conditions";
import { buildContext } from "@/lib/automation/engine";
import type { ActionCtx } from "@/lib/automation/types";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { createAutomationRuleSchema, ENTIDADE_ESPERADA_POR_GATILHO } from "@/lib/schemas/webhooks";

import {
  historicoDeDemonstracao,
  REGRA_ORCAMENTO,
  type MundoDaExecucao,
  REGRA_VIP,
  regrasDeDemonstracao,
  type RegraDeDemonstracao,
} from "../../scripts/lib/automacoes-de-demonstracao";

const ORG = "87500000-0000-4000-8000-000000000001";
const GERENTE = "87500000-0000-4000-8000-000000000002";
const CONTATO = "87500000-0000-4000-8000-000000000003";
const LEAD = "87500000-0000-4000-8000-000000000004";
const PIPELINE = "87500000-0000-4000-8000-000000000005";
const ETAPA = "87500000-0000-4000-8000-000000000006";

const COM_FUNIL = regrasDeDemonstracao({ pipelineId: PIPELINE, stageId: ETAPA, managerId: GERENTE });

function regra(nome: string): RegraDeDemonstracao {
  const r = COM_FUNIL.find((x) => x.name === nome);
  if (!r) throw new Error(`regra "${nome}" sumiu das regras de demonstração`);
  return r;
}

/**
 * Dublê do admin client: `maybeSingle` responde pela tabela; `update … eq` é
 * aguardável e não erra. Tabela não listada devolve `null`, então uma leitura em
 * lugar inesperado aparece como contexto vazio em vez de passar despercebida.
 */
function banco(linhas: Record<string, Record<string, unknown> | null>): SupabaseClient {
  const tabela = (nome: string) => {
    const cadeia: Record<string, unknown> = {};
    for (const m of ["select", "update", "eq", "neq", "in", "is", "order", "limit"]) cadeia[m] = () => cadeia;
    cadeia.maybeSingle = async () => ({ data: linhas[nome] ?? null, error: null });
    cadeia.then = (resolve: (v: { error: null }) => unknown) => resolve({ error: null });
    return cadeia;
  };
  return { from: tabela } as unknown as SupabaseClient;
}

/** A linha que `fn_emit_message_event` grava para mensagem de entrada. */
function eventoDeMensagem(corpo: string): EventRow {
  return {
    id: "87500000-1111-4000-8000-000000000001",
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: ENTIDADE_ESPERADA_POR_GATILHO["message.received"],
    entity_id: "87500000-1111-4000-8000-000000000002",
    payload: { contact_id: CONTATO, direction: "inbound", type: "text", body_preview: corpo },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

function eventoDeLeadCriado(): EventRow {
  return {
    id: "87500000-1111-4000-8000-000000000003",
    organization_id: ORG,
    event_type: "lead.created",
    entity_kind: ENTIDADE_ESPERADA_POR_GATILHO["lead.created"],
    entity_id: LEAD,
    payload: { lead_id: LEAD },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

const CONTATO_LINHA = { id: CONTATO, organization_id: ORG, name: "Contato", tags: [] };

/**
 * O banco no MUNDO de uma execução do histórico: o lead com as etiquetas de
 * então, o gerente dentro ou fora da organização, e a escrita aceita ou não.
 * É o que deixa o teste rodar o motor de verdade sobre a história de cada linha,
 * em vez de só conferir a forma dela.
 */
function mundoNoBanco(mundo: MundoDaExecucao): SupabaseClient {
  const linhas: Record<string, Record<string, unknown> | null> = {
    crm_leads: mundo.lead ? { id: LEAD, organization_id: ORG, contact_id: null, tags: mundo.lead.tags } : null,
    contacts: CONTATO_LINHA,
    user_organizations: mundo.gerenteNaOrganizacao ? { user_id: GERENTE, role: "manager" } : null,
  };
  const escrita = { error: mundo.escritaFalhou ? { message: mundo.escritaFalhou } : null };
  const tabela = (nome: string) => {
    let escrevendo = false;
    const cadeia: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "is", "order", "limit"]) cadeia[m] = () => cadeia;
    cadeia.update = () => {
      escrevendo = true;
      return cadeia;
    };
    cadeia.maybeSingle = async () => ({ data: linhas[nome] ?? null, error: null });
    cadeia.then = (resolve: (v: unknown) => unknown) => resolve(escrevendo ? escrita : { error: null });
    return cadeia;
  };
  return { from: tabela, rpc: async () => ({ error: null }) } as unknown as SupabaseClient;
}

describe("regras de demonstração", () => {
  it("todas passam pelo createAutomationRuleSchema da API — com e sem o funil do CRM Vivo", () => {
    const semFunil = regrasDeDemonstracao({ pipelineId: null, stageId: null, managerId: GERENTE });
    expect(semFunil.length, "sem funil a regra de aniversário sai").toBe(COM_FUNIL.length - 1);
    for (const r of COM_FUNIL) {
      const v = createAutomationRuleSchema.safeParse(r);
      expect(v.success ? null : JSON.stringify(v.error.issues), `"${r.name}"`).toBeNull();
    }
  });

  it("o campo da regra de orçamento é uma chave que o gatilho de mensagem EMITE", () => {
    // O dublê do evento acima é escrito à mão; isto amarra a chave ao emissor
    // real, o trigger SQL que o self-host aplica.
    const baseline = readFileSync(path.join(process.cwd(), "supabase/baseline.sql"), "utf8");
    const emissor = /FUNCTION "public"\."fn_emit_message_event"\(\)[\s\S]*?\$\$;/.exec(baseline)?.[0] ?? "";
    expect(emissor, "fn_emit_message_event não encontrada no baseline").toContain("'message.received'");
    const campo = regra(REGRA_ORCAMENTO).conditions[0]!.field;
    expect(campo.startsWith("event."), "condição de mensagem lê o payload, que mora em `event`").toBe(true);
    expect(emissor).toContain(`'${campo.slice("event.".length)}'`);
  });

  it("a regra de orçamento CASA com a mensagem que pede orçamento, e só com ela", async () => {
    const admin = banco({ contacts: CONTATO_LINHA });
    const pede = await buildContext(admin, eventoDeMensagem("Oi! Queria um orçamento do pacote completo"));
    const naoPede = await buildContext(admin, eventoDeMensagem("Bom dia, tudo bem?"));

    expect(evaluateConditions(regra(REGRA_ORCAMENTO).conditions, pede)).toBe(true);
    expect(evaluateConditions(regra(REGRA_ORCAMENTO).conditions, naoPede)).toBe(false);

    // Controle do instrumento: a condição da primeira versão, no MESMO contexto,
    // não casa. Sem isto, um avaliador que devolvesse `true` sempre deixaria o
    // primeiro caso verde.
    expect(evaluateConditions([{ field: "direction", op: "eq" as const, value: "inbound" }], pede)).toBe(false);
  });

  it("a regra VIP casa com o lead que nasce com a etiqueta, e não com os outros", async () => {
    const vip = await buildContext(
      banco({ crm_leads: { id: LEAD, organization_id: ORG, contact_id: null, tags: ["vip"] } }),
      eventoDeLeadCriado(),
    );
    const comum = await buildContext(
      banco({ crm_leads: { id: LEAD, organization_id: ORG, contact_id: null, tags: ["novo"] } }),
      eventoDeLeadCriado(),
    );
    expect(evaluateConditions(regra(REGRA_VIP).conditions, vip)).toBe(true);
    expect(evaluateConditions(regra(REGRA_VIP).conditions, comum)).toBe(false);
  });

  it("assign_owner funciona no gatilho da regra VIP — e não funcionaria no de mensagem", async () => {
    const executor = getAction("assign_owner");
    expect(executor, "assign_owner não registrado").toBeDefined();
    const config = regra(REGRA_VIP).actions.find((a) => a.type === "assign_owner")!.config;
    const admin = banco({
      crm_leads: { id: LEAD, organization_id: ORG, contact_id: null, tags: ["vip"] },
      contacts: CONTATO_LINHA,
      user_organizations: { user_id: GERENTE, role: "manager" },
    });

    const ctx = async (evento: EventRow): Promise<ActionCtx> => ({
      admin,
      serviceBoundaries: new Map(),
      organizationId: ORG,
      ruleId: "regra",
      ruleName: REGRA_VIP,
      event: evento,
      context: await buildContext(admin, evento),
      requestId: evento.id,
    });

    expect((await executor!.execute(await ctx(eventoDeLeadCriado()), config)).status).toBe("success");
    // O que a primeira versão pedia: `assign_owner` num evento de mensagem, cujo
    // contexto tem contato e nunca lead.
    expect(
      await executor!.execute(await ctx(eventoDeMensagem("orçamento")), config),
    ).toMatchObject({ status: "skipped", detail: { reason: "missing_input" } });
  });
});

describe("histórico de demonstração", () => {
  const historico = historicoDeDemonstracao(GERENTE);

  it("traz os três desfechos da aba Atividade", () => {
    expect(new Set(historico.map((h) => h.status))).toEqual(new Set(["success", "partial", "failed"]));
  });

  it("cada execução descreve AS AÇÕES DA SUA regra: uma por ação, na ordem, e só da regra que existe sempre", () => {
    const semFunil = regrasDeDemonstracao({ pipelineId: null, stageId: null, managerId: GERENTE });
    for (const h of historico) {
      const dona = semFunil.find((r) => r.name === h.regra);
      expect(dona, `a execução aponta para "${h.regra}", que não existe sem o funil`).toBeDefined();
      expect(h.actions_result.map((a) => a.type), `"${h.regra}" (${h.status})`).toEqual(
        dona!.actions.map((a) => a.type),
      );
    }
  });

  it("o status da execução é o que o motor agregaria dos resultados das ações", () => {
    // Mesma régua de `runAutomationForEvent` (lib/automation/engine.ts, bloco "O
    // AGREGADOR TAMBÉM PRECISA DIZER A VERDADE"): failed e skipped contam como
    // não feito; todos não feitos = failed; alguns = partial.
    for (const h of historico) {
      const naoFeitas = h.actions_result.filter((a) => a.status === "failed" || a.status === "skipped").length;
      const esperado = naoFeitas === 0 ? "success" : naoFeitas === h.actions_result.length ? "failed" : "partial";
      expect(h.status, `execução de "${h.regra}"`).toBe(esperado);
    }
  });

  it("cada execução é POSSÍVEL: a regra casa com o mundo dela, e as ações de verdade devolvem o que ela grava", async () => {
    // A forma sozinha aceitava uma linha que o motor nunca escreveria: `failed`
    // da regra VIP com as duas ações puladas por falta de lead — e sem lead a
    // condição `lead.tags contém vip` é falsa, então o motor nem executa a regra.
    for (const h of historico) {
      const dona = regra(h.regra);
      const evento =
        dona.trigger_event === "lead.created"
          ? eventoDeLeadCriado()
          : dona.trigger_event === "message.received"
            ? eventoDeMensagem(h.mundo.mensagem ?? "")
            : null;
      if (!evento) throw new Error(`gatilho "${dona.trigger_event}" sem evento de teste`);

      const admin = mundoNoBanco(h.mundo);
      const context = await buildContext(admin, evento);
      expect(
        evaluateConditions(dona.conditions, context),
        `"${h.regra}" (${h.status}): a condição não casa no mundo desta execução — o motor nem a executaria`,
      ).toBe(true);

      const resultados = [];
      for (const acao of dona.actions) {
        const executor = getAction(acao.type);
        expect(executor, `${acao.type} não registrado`).toBeDefined();
        resultados.push(
          await executor!.execute(
            {
              admin,
              serviceBoundaries: new Map(),
              organizationId: ORG,
              ruleId: "regra",
              ruleName: dona.name,
              event: evento,
              context,
              requestId: evento.id,
            },
            acao.config,
          ),
        );
      }
      expect(resultados, `"${h.regra}" (${h.status}): o motor gravaria outra coisa neste mundo`).toEqual(
        h.actions_result,
      );
    }
  });

  it("todo código de erro ou motivo é um que a ação de verdade devolve", () => {
    for (const h of historico) {
      for (const a of h.actions_result) {
        const codigo = a.error ?? (a.detail?.reason as string | undefined);
        if (codigo === undefined) continue;
        // A mensagem que o BANCO devolveu não é código da ação: ela a repassa
        // (`error: error.message`). Quem prova que ela chega assim é o caso acima.
        if (codigo === h.mundo.escritaFalhou) continue;
        const fonte = readFileSync(
          path.join(process.cwd(), "lib/automation/actions", `${a.type.replaceAll("_", "-")}.ts`),
          "utf8",
        );
        expect(fonte, `${a.type} nunca devolve "${codigo}"`).toContain(`"${codigo}"`);
      }
    }
  });
});
