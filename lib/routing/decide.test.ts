import { describe, expect, it } from "vitest";

import { decideRouting, resolverRoteamentoPorNumero, selectRoundRobin, type RoutingCandidate } from "./decide";
import { routingConfigSchema } from "@/lib/schemas/routing";

/**
 * Decisão PURA do worker de roteamento (G5-02 — AT-03). Cobre os 5 cenários do
 * acceptance na camada de lógica; a garantia transacional (trigger emite, fn
 * atribui atomicamente + idempotência DB) fica no invariante SQL
 * tests/invariants/gov-4b-routing-worker.test.ts. Clock SEMPRE injetado.
 */

const NOW = new Date("2026-07-13T17:00:00Z");
const config = routingConfigSchema.parse({ mode: "round_robin", max_retries: 5, backoff_seconds: 60 });

const cand = (userId: string, lastAssignedAt: number | null, currentLoad = 0): RoutingCandidate => ({
  userId,
  currentLoad,
  lastAssignedAt,
});

describe("selectRoundRobin (rodízio real)", () => {
  it("nenhum elegível ⇒ null", () => {
    expect(selectRoundRobin([])).toBeNull();
  });

  it("nunca-atribuído (null) tem prioridade sobre quem já recebeu", () => {
    const picked = selectRoundRobin([cand("b", 1000), cand("a", null)]);
    expect(picked).toBe("a");
  });

  it("entre atribuídos, o mais ANTIGO vem primeiro (rodízio)", () => {
    const picked = selectRoundRobin([cand("recent", 5000), cand("old", 1000)]);
    expect(picked).toBe("old");
  });

  it("empate determinístico por userId", () => {
    expect(selectRoundRobin([cand("z", null), cand("a", null)])).toBe("a");
  });
});

describe("decideRouting — os 5 cenários do acceptance", () => {
  it("round_robin com elegível ⇒ assign ao elegível (nunca ao inelegível — já filtrado)", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [cand("agent-eligible", null)],
      config,
      attempts: 0,
      now: NOW,
    });
    expect(action).toEqual({ kind: "assign", userId: "agent-eligible" });
  });

  it("idempotência: conversa que JÁ tem dono ⇒ skip, nunca reatribui (acceptance 3)", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: true,
      eligibles: [cand("someone", null)],
      config,
      attempts: 0,
      now: NOW,
    });
    expect(action).toEqual({ kind: "skip", reason: "already_assigned" });
  });

  it("sem elegível ⇒ requeue com backoff futuro + attempts++ (acceptance 4)", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [],
      config,
      attempts: 2,
      now: NOW,
    });
    expect(action.kind).toBe("requeue");
    if (action.kind === "requeue") {
      expect(action.attempts).toBe(3);
      // backoff_seconds=60 ⇒ next_attempt_at = now + 60s.
      expect(new Date(action.nextAttemptAt).getTime()).toBe(NOW.getTime() + 60_000);
      expect(new Date(action.nextAttemptAt).getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it("sem elegível após max_retries mantém retry lento e contador limitado", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [],
      config, // max_retries=5
      attempts: 5,
      now: NOW,
    });
    expect(action.kind).toBe("requeue");
    if (action.kind === "requeue") {
      expect(action.attempts).toBe(5);
      expect(new Date(action.nextAttemptAt).getTime()).toBe(NOW.getTime() + 900_000);
    }
  });

  it("modo manual ⇒ skip, worker não atribui (acceptance 5)", () => {
    const action = decideRouting({
      mode: "manual",
      alreadyAssigned: false,
      eligibles: [cand("agent", null)],
      config: routingConfigSchema.parse({ mode: "manual" }),
      attempts: 0,
      now: NOW,
    });
    expect(action).toEqual({ kind: "skip", reason: "manual_mode" });
  });

  it("modo desconhecido ⇒ skip defensivo, no-op (nunca roteia o que a tela não oferece)", () => {
    const action = decideRouting({
      mode: "telefone",
      alreadyAssigned: false,
      eligibles: [cand("agent", null)],
      config,
      attempts: 0,
      now: NOW,
    });
    expect(action).toEqual({ kind: "skip", reason: "unsupported_mode:telefone" });
  });
});

describe("modo load — roteia por menor carga (issue #1539)", () => {
  const configLoad = routingConfigSchema.parse({ mode: "load" });

  const decidir = (eligibles: RoutingCandidate[]) =>
    decideRouting({
      mode: "load",
      alreadyAssigned: false,
      eligibles,
      config: configLoad,
      attempts: 0,
      now: NOW,
    });

  it("o schema ACEITA o modo load (era o 'inalcançável' pós-MVP do G1-06b)", () => {
    expect(configLoad.mode).toBe("load");
  });

  it("cargas 3 e 1 ⇒ a conversa vai para o de carga 1 (critério de aceite)", () => {
    // Ana tem UM e acabou de receber; Bruno tem TRÊS e nunca recebeu. O rodízio
    // puxaria para o Bruno (nunca-atribuído tem prioridade) — o CONTRÁRIO do que
    // o modo load decide, e é por isso que este caso discrimina de verdade:
    // quem rotear isto por rodízio cai aqui vermelho.
    const action = decidir([cand("ana", 9000, 1), cand("bruno", null, 3)]);
    expect(action).toEqual({ kind: "assign", userId: "ana" });
  });

  it("empate de carga ⇒ desempate pelo rodízio (quem há mais tempo sem receber)", () => {
    const action = decidir([cand("recebeu-agora", 5000, 2), cand("sem-receber", 1000, 2)]);
    expect(action).toEqual({ kind: "assign", userId: "sem-receber" });
  });

  it("três cargas distintas => o de MENOR carga ganha, mesmo sendo o último da lista", () => {
    const action = decidir([cand("carga-3", null, 3), cand("folgado", null, 1), cand("carga-2", null, 2)]);
    expect(action).toEqual({ kind: "assign", userId: "folgado" });
  });

  it("sem elegível ⇒ requeue com backoff da config (mesma régua do round_robin)", () => {
    const action = decidir([]);
    expect(action.kind).toBe("requeue");
    if (action.kind === "requeue") {
      expect(action.attempts).toBe(1);
      expect(new Date(action.nextAttemptAt).getTime()).toBe(NOW.getTime() + 60_000);
    }
  });
});

/**
 * Issue #2331 — regras de atendimento POR NÚMERO (canal).
 *
 * O modo de distribuição era UM só para a organização
 * (`organizations.settings.routing.mode`). Aqui ele passa a poder ser do NÚMERO,
 * e o número SEM regra própria continua com o comportamento da organização —
 * nada muda para quem já instalou.
 */
describe("regras por número (#2331) — resolverRoteamentoPorNumero", () => {
  // A organização distribui por CARGA. Os números abaixo discordam dela de
  // propósito: é o caso "cada número faz uma coisa".
  const daOrganizacao = routingConfigSchema.parse({ mode: "load" });

  it("canal com regra própria NÃO usa a regra da organização: dois números, modos diferentes, cada um respeitado", () => {
    const numeroOficial = resolverRoteamentoPorNumero(daOrganizacao, {
      distribution_mode: "round_robin",
      default_assignee_user_id: null,
    });
    const numeroDoSetor = resolverRoteamentoPorNumero(daOrganizacao, {
      distribution_mode: "manual",
      default_assignee_user_id: null,
    });

    // Cada número com o SEU modo — e nenhum dos dois é o "load" da organização.
    expect(numeroOficial.mode).toBe("round_robin");
    expect(numeroDoSetor.mode).toBe("manual");
    expect(numeroOficial.mode).not.toBe(daOrganizacao.mode);
    expect(numeroDoSetor.mode).not.toBe(daOrganizacao.mode);

    // E a decisão segue o modo do NÚMERO, não o da organização: a mesma conversa
    // sem dono é distribuída no número oficial e deixada na fila no do setor.
    const noOficial = decideRouting({
      mode: numeroOficial.mode, alreadyAssigned: false, eligibles: [cand("ana", null)],
      config: daOrganizacao, attempts: 0, now: NOW,
    });
    const noSetor = decideRouting({
      mode: numeroDoSetor.mode, alreadyAssigned: false, eligibles: [cand("ana", null)],
      config: daOrganizacao, attempts: 0, now: NOW,
    });
    expect(noOficial).toEqual({ kind: "assign", userId: "ana" });
    expect(noSetor).toEqual({ kind: "skip", reason: "manual_mode" });
  });

  it("canal SEM regra (policy ausente) cai no comportamento da organização", () => {
    const semPolicy = resolverRoteamentoPorNumero(daOrganizacao, null);
    expect(semPolicy).toEqual({ mode: "load", defaultAssigneeUserId: null });

    // O outro estado real de "sem regra": a linha existe (o número tem
    // responsáveis restritos), mas nenhuma das duas colunas foi preenchida.
    const semModoProprio = resolverRoteamentoPorNumero(daOrganizacao, {
      distribution_mode: null,
      default_assignee_user_id: null,
    });
    expect(semModoProprio).toEqual({ mode: "load", defaultAssigneeUserId: null });

    // E a organização MANUAL (o padrão do produto) continua sendo manual no
    // número sem regra: a herança não inventa modo novo.
    const organizacaoManual = routingConfigSchema.parse({ mode: "manual" });
    expect(resolverRoteamentoPorNumero(organizacaoManual, null).mode).toBe("manual");
    expect(resolverRoteamentoPorNumero(organizacaoManual, {
      distribution_mode: null, default_assignee_user_id: null,
    }).mode).toBe("manual");
  });

  it("atendente de destino padrão do número manda mais que o modo (entrega direta)", () => {
    // Caso real da issue: o segundo número conectado por QR Code entrega TUDO a
    // uma pessoa específica, sem passar pela distribuição.
    const doSegundoNumero = resolverRoteamentoPorNumero(daOrganizacao, {
      distribution_mode: "round_robin",
      default_assignee_user_id: "bruno",
    });
    expect(doSegundoNumero.defaultAssigneeUserId).toBe("bruno");

    const action = decideRouting({
      mode: doSegundoNumero.mode,
      alreadyAssigned: false,
      eligibles: [cand("ana", null, 1), cand("bruno", null, 7)],
      config: daOrganizacao,
      defaultAssigneeUserId: doSegundoNumero.defaultAssigneeUserId,
      attempts: 0,
      now: NOW,
    });
    // Nem o rodízio nem o modo carga escolhem por ele: o destino padrão é
    // entrega direta. O rodízio daria "ana" (nunca recebeu, desempate por id);
    // o modo carga também daria "ana" (carga 1 < 7). Só o destino padrão dá
    // "bruno".
    expect(action).toEqual({ kind: "assign", userId: "bruno" });
  });

  it("sem destino padrão o modo decide: nada de entrega direta por acidente", () => {
    const action = decideRouting({
      mode: "round_robin", alreadyAssigned: false, eligibles: [cand("ana", null)],
      config: daOrganizacao, defaultAssigneeUserId: null, attempts: 0, now: NOW,
    });
    expect(action).toEqual({ kind: "assign", userId: "ana" });
  });

  it("idempotência vence o destino padrão: conversa que já tem dono não é reatribuída", () => {
    const action = decideRouting({
      mode: "round_robin", alreadyAssigned: true, eligibles: [],
      config: daOrganizacao, defaultAssigneeUserId: "bruno", attempts: 0, now: NOW,
    });
    expect(action).toEqual({ kind: "skip", reason: "already_assigned" });
  });
});

describe("a distribuição ESPERA a IA qualificar (#3966)", () => {
  const esperando = { motivo: "ia_qualificando", limiteEm: "2026-11-06T11:59:00.000Z" };

  it("com a espera de pé, o worker NÃO atribui: devolve `wait` com o próximo olhar", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [cand("ana", null)],
      config,
      attempts: 0,
      now: NOW,
      esperaPelaQualificacao: esperando,
    });
    expect(action.kind).toBe("wait");
    if (action.kind === "wait") {
      expect(action.reason).toBe("ia_qualificando");
      // backoff de 60s: o próximo olhar é daqui a um minuto, não no limite.
      expect(action.nextAttemptAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    }
  });

  it("nenhum elegível na espera NÃO vira `requeue` (não gasta tentativa do backoff)", () => {
    const action = decideRouting({
      mode: "load",
      alreadyAssigned: false,
      eligibles: [],
      config,
      attempts: 5, // no teto: `requeue` cairia nos 15 min
      now: NOW,
      esperaPelaQualificacao: esperando,
    });
    expect(action.kind).toBe("wait");
  });

  it("a última espera é agendada PARA o limite, nunca depois dele", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [cand("ana", null)],
      config: routingConfigSchema.parse({ mode: "round_robin", backoff_seconds: 3600 }),
      attempts: 0,
      now: NOW,
      esperaPelaQualificacao: { motivo: "ia_qualificando", limiteEm: "2026-07-13T17:05:00.000Z" },
    });
    expect(action.kind).toBe("wait");
    if (action.kind === "wait") {
      expect(action.nextAttemptAt).toBe("2026-07-13T17:05:00.000Z");
    }
  });

  it("a espera vence o destino padrão do número (é onde calar a IA dói mais)", () => {
    const action = decideRouting({
      mode: "manual",
      alreadyAssigned: false,
      eligibles: [],
      config: routingConfigSchema.parse({ mode: "manual" }),
      defaultAssigneeUserId: "bruno",
      attempts: 0,
      now: NOW,
      esperaPelaQualificacao: esperando,
    });
    expect(action.kind).toBe("wait");
  });

  it("modo manual SEM destino padrão não espera: esse canal nunca distribui", () => {
    const action = decideRouting({
      mode: "manual",
      alreadyAssigned: false,
      eligibles: [],
      config: routingConfigSchema.parse({ mode: "manual" }),
      attempts: 0,
      now: NOW,
      esperaPelaQualificacao: esperando,
    });
    expect(action).toEqual({ kind: "skip", reason: "manual_mode" });
  });

  it("idempotência e caso vencem a espera (nada de evento girando por conversa já resolvida)", () => {
    expect(
      decideRouting({
        mode: "round_robin", alreadyAssigned: true, eligibles: [], config,
        attempts: 0, now: NOW, esperaPelaQualificacao: esperando,
      }),
    ).toEqual({ kind: "skip", reason: "already_assigned" });

    expect(
      decideRouting({
        mode: "round_robin", alreadyAssigned: false, eligibles: [cand("ana", null)], config,
        attempts: 0, now: NOW, esperaPelaQualificacao: esperando,
        motivoDoCaso: "caso_encerrado",
      }),
    ).toEqual({ kind: "skip", reason: "caso_encerrado" });
  });

  it("sem espera (null/ausente) a decisão é a de HOJE, byte a byte", () => {
    const base = {
      mode: "round_robin" as const, alreadyAssigned: false,
      eligibles: [cand("ana", null)], config, attempts: 0, now: NOW,
    };
    const semCampo = decideRouting(base);
    const comNull = decideRouting({ ...base, esperaPelaQualificacao: null });
    expect(comNull).toEqual(semCampo);
    expect(semCampo).toEqual({ kind: "assign", userId: "ana" });
  });
});
