import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { criarEfeitoDasEscrituras } from "@/lib/ai/runtime/efeito-das-escritas";
import { MAXIMO_DE_RESERVAS_NA_REVISAO } from "@/lib/ai/runtime/recibos-de-agendamento";

/**
 * O PREDICADO ÚNICO do efeito (issue #3333) — a pergunta "esta ação já produziu efeito?"
 *
 * Duas metades nesta suíte:
 *
 *  1. o COMPORTAMENTO do coletor (as três respostas e a monotonicidade do efeito);
 *  2. a FIAÇÃO — que a ponte das tools é quem RESPONDE (uma linha por saída, o mesmo desfecho
 *     do `api_audit_log`) e que o turno entrega o MESMO coletor ao gate que produz a fala.
 *
 * A fiação é lida do FONTE, como `cerca-prometer-de-ponta-a-ponta.test.ts` faz: um
 * `toHaveBeenCalled` não alcança `wrapMcpTool` sem montar Supabase, escopo, fila e catálogo
 * inteiros, e o que precisa ficar travado não é um mock — é que não exista uma SEGUNDA opinião
 * sobre "deu certo?" em lugar nenhum do caminho.
 */
describe("o coletor do efeito", () => {
  it("começa em `nao_tentada` e só `produziu_efeito` responde `true`", () => {
    const efeitos = criarEfeitoDasEscrituras();
    expect(efeitos.desfechoDe("crm_create_lead")).toBe("nao_tentada");
    expect(efeitos.produziuEfeito("crm_create_lead")).toBe(false);

    efeitos.registrar("crm_create_lead", "falhou");
    expect(efeitos.produziuEfeito("crm_create_lead")).toBe(false);

    efeitos.registrar("crm_create_lead", "incerto");
    expect(efeitos.produziuEfeito("crm_create_lead")).toBe(false);

    efeitos.registrar("crm_create_lead", "produziu_efeito");
    expect(efeitos.produziuEfeito("crm_create_lead")).toBe(true);
  });

  it("é MONOTÔNICO: uma falha depois do efeito não apaga o registro que existe", () => {
    const efeitos = criarEfeitoDasEscrituras();
    efeitos.registrar("crm_create_lead", "produziu_efeito");
    efeitos.registrar("crm_create_lead", "falhou");
    efeitos.registrar("crm_create_lead", "incerto");
    expect(efeitos.produziuEfeito("crm_create_lead")).toBe(true);
    expect(efeitos.desfechoDe("crm_create_lead")).toBe("produziu_efeito");
  });

  it("é por FERRAMENTA: o efeito de uma não responde pela outra", () => {
    const efeitos = criarEfeitoDasEscrituras();
    efeitos.registrar("crm_create_lead", "produziu_efeito");
    expect(efeitos.produziuEfeito("crm_update_lead")).toBe(false);
    expect(efeitos.desfechoDe("crm_update_lead")).toBe("nao_tentada");
  });

  it("instâncias são independentes — um turno nunca lê o efeito de outro", () => {
    const a = criarEfeitoDasEscrituras();
    const b = criarEfeitoDasEscrituras();
    a.registrar("crm_create_lead", "produziu_efeito");
    expect(b.produziuEfeito("crm_create_lead")).toBe(false);
  });
});

describe("recibos de cancelamento acumulam no turno", () => {
  const confirmado = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "confirmed",
    starts_at: "2026-12-10T13:00:00Z",
    ends_at: "2026-12-10T13:30:00Z",
    revision: 1,
  };
  const cancelado = (id: string, revision = 2) => ({
    id,
    status: "cancelled",
    starts_at: "2026-12-10T13:00:00Z",
    ends_at: "2026-12-10T13:30:00Z",
    revision,
  });
  const idA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const idB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("a troca inteira (cancelar → marcar → os dois recibos na lista)", () => {
    const efeitos = criarEfeitoDasEscrituras();
    const g1 = efeitos.iniciarAgendamento();
    efeitos.registrarRecibosDeAgendamento(g1, { cancelado: true, compromisso: cancelado(idA) });
    const g2 = efeitos.iniciarAgendamento();
    efeitos.registrarRecibosDeAgendamento(g2, { marcado: true, compromisso: confirmado });
    const lista = efeitos.recibosDeAgendamento();
    expect(lista).toHaveLength(2);
    expect(lista.some((r) => r.status === "cancelled" && r.id === idA)).toBe(true);
    expect(lista.some((r) => r.status === "confirmed" && r.id === confirmado.id)).toBe(true);
  });

  it("marcação que falha depois do cancelamento mantém o cancelado", () => {
    const efeitos = criarEfeitoDasEscrituras();
    const g1 = efeitos.iniciarAgendamento();
    efeitos.registrarRecibosDeAgendamento(g1, { cancelado: true, compromisso: cancelado(idA) });
    const g2 = efeitos.iniciarAgendamento();
    efeitos.registrarRecibosDeAgendamento(g2, { marcado: true, compromisso: { ...confirmado, revision: undefined } });
    const lista = efeitos.recibosDeAgendamento();
    expect(lista).toEqual([cancelado(idA)]);
  });

  it("dois cancelamentos acumulam", () => {
    const efeitos = criarEfeitoDasEscrituras();
    const g1 = efeitos.iniciarAgendamento();
    efeitos.registrarRecibosDeAgendamento(g1, { cancelado: true, compromisso: cancelado(idA) });
    const g2 = efeitos.iniciarAgendamento();
    efeitos.registrarRecibosDeAgendamento(g2, { cancelado: true, compromisso: cancelado(idB) });
    expect(efeitos.recibosDeAgendamento().filter((r) => r.status === "cancelled")).toHaveLength(2);
  });

  it("cancelamento registrado com geração antiga é guardado e confirmado com geração antiga não", () => {
    const efeitos = criarEfeitoDasEscrituras();
    const antiga = efeitos.iniciarAgendamento();
    efeitos.iniciarAgendamento(); // geração já avançou
    efeitos.registrarRecibosDeAgendamento(antiga, { cancelado: true, compromisso: cancelado(idA) });
    efeitos.registrarRecibosDeAgendamento(antiga, { marcado: true, compromisso: confirmado });
    const lista = efeitos.recibosDeAgendamento();
    expect(lista.some((r) => r.status === "cancelled" && r.id === idA)).toBe(true);
    expect(lista.some((r) => r.status === "confirmed")).toBe(false);
  });

  it("mesmo id não duplica; para um mesmo id vence o de maior revision", () => {
    const efeitos = criarEfeitoDasEscrituras();
    const g1 = efeitos.iniciarAgendamento();
    efeitos.registrarRecibosDeAgendamento(g1, { cancelado: true, compromisso: cancelado(idA, 2) });
    const g2 = efeitos.iniciarAgendamento();
    efeitos.registrarRecibosDeAgendamento(g2, { cancelado: true, compromisso: cancelado(idA, 3) });
    const lista = efeitos.recibosDeAgendamento().filter((r) => r.id === idA);
    expect(lista).toHaveLength(1);
    expect(lista[0]!.revision).toBe(3);
  });

  it("confirmado anterior continua sendo invalidado por nova mutação", () => {
    const efeitos = criarEfeitoDasEscrituras();
    const g1 = efeitos.iniciarAgendamento();
    efeitos.registrarRecibosDeAgendamento(g1, { marcado: true, compromisso: confirmado });
    expect(efeitos.recibosDeAgendamento().some((r) => r.status === "confirmed")).toBe(true);
    efeitos.iniciarAgendamento();
    expect(efeitos.recibosDeAgendamento().some((r) => r.status === "confirmed")).toBe(false);
  });

  it("o teto de 20 nunca corta o confirmado: 20 cancelamentos + 1 marcação → a marcação está na lista, e o cancelamento mais antigo sai", () => {
    const efeitos = criarEfeitoDasEscrituras();
    const idCancel = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    for (let i = 0; i < MAXIMO_DE_RESERVAS_NA_REVISAO; i++) {
      const g = efeitos.iniciarAgendamento();
      efeitos.registrarRecibosDeAgendamento(g, { cancelado: true, compromisso: cancelado(idCancel(i), i + 1) });
    }
    const gMark = efeitos.iniciarAgendamento();
    efeitos.registrarRecibosDeAgendamento(gMark, { marcado: true, compromisso: confirmado });
    const lista = efeitos.recibosDeAgendamento();
    expect(lista).toHaveLength(MAXIMO_DE_RESERVAS_NA_REVISAO);
    // confirmed primeiro
    expect(lista[0]!.status).toBe("confirmed");
    expect(lista[0]!.id).toBe(confirmado.id);
    // cancelados do mais recente para o mais antigo
    const cancelados = lista.filter((r) => r.status === "cancelled");
    expect(cancelados[0]!.id).toBe(idCancel(MAXIMO_DE_RESERVAS_NA_REVISAO - 1));
    // o cancelamento mais antigo é o que sai
    expect(lista.some((r) => r.id === idCancel(0))).toBe(false);
    expect(cancelados.some((r) => r.id === idCancel(1))).toBe(true);
  });

  it("no máximo MAXIMO_DE_RESERVAS_NA_REVISAO, devolvendo cópias", () => {
    const efeitos = criarEfeitoDasEscrituras();
    for (let i = 0; i < MAXIMO_DE_RESERVAS_NA_REVISAO + 5; i++) {
      const g = efeitos.iniciarAgendamento();
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      efeitos.registrarRecibosDeAgendamento(g, { cancelado: true, compromisso: cancelado(id, i + 1) });
    }
    const lista = efeitos.recibosDeAgendamento();
    expect(lista.length).toBeLessThanOrEqual(MAXIMO_DE_RESERVAS_NA_REVISAO);
    lista[0]!.revision = 9999;
    expect(efeitos.recibosDeAgendamento()[0]!.revision).not.toBe(9999);
  });
});

describe("a fiação do predicado (quem responde × quem pergunta)", () => {
  const ler = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  it("a PONTE anota o desfecho na única função que já decide o `success` do audit", () => {
    const fonte = ler("lib/ai/runtime/tools.ts");
    // O ponto de anotação é dentro do wrapper que executa a tool.
    expect(fonte).toContain("const anotarEfeito = (desfecho: DesfechoDaEscrita): void =>");
    expect(fonte).toContain("input.efeitos?.registrar(def.name, desfecho)");
    // As três respostas saem daqui — não há um quarto caminho inventado no call site.
    expect(fonte).toContain('anotarEfeito("falhou")');
    // Escrita sem desfecho NÃO é falha (`incerto`), e é o predicado que guarda a diferença.
    expect(fonte).toMatch(
      /anotarEfeito\(\s*err instanceof EscritaDoNegocioSemDesfechoError \? "incerto" : "falhou"\)/,
    );
    expect(fonte).toContain('anotarEfeito(motivoDoVazio === null ? "produziu_efeito" : "falhou")');
    // Leitura não é efeito.
    expect(fonte).toMatch(/if \(def\.category === "read"\) return;\s*\n\s*input\.efeitos/);
  });

  it("a ponte do engine REPASSA o coletor ao runtime nativo", () => {
    const fonte = ler("lib/agent-engine/edge/crm/mcp-tools.ts");
    expect(fonte).toMatch(/efeitos\?: EfeitoDasEscrituras/);
    expect(fonte).toMatch(/\.\.\.\(options\?\.efeitos \? \{ efeitos: options\.efeitos \} : \{\}\)/);
  });

  it("o turno cria UMA instância, entrega à ponte e a MESMA ao gate", () => {
    const fonte = ler("lib/agent-engine/agent/inbound-turn.ts");
    expect(fonte).toMatch(/const efeitosDoTurno = criarEfeitoDasEscrituras\(\)/);
    // uma instância por turno, não duas
    expect(fonte.match(/criarEfeitoDasEscrituras\(\)/g) ?? []).toHaveLength(1);
    // a ponte recebe o coletor nos DOIS modos (prévia e produção)
    // (a ponte também recebe as nativas do turno — `duplicata-nativa-some-do-turno-mcp.test.ts`)
    expect(fonte).toMatch(
      /preview\s*\?\s*\{ readOnly: true, efeitos: efeitosDoTurno, nativasDoTurno \}\s*:\s*\{ readOnly: false, efeitos: efeitosDoTurno, nativasDoTurno \}/,
    );
    // o before-send recebe a leitura do MESMO coletor
    expect(fonte).toMatch(/registro: registroDoTurno\(\),/);
    // a prévia arma igual ao turno real (o motivo escrito em `preview.ts` para a agenda)
    expect(fonte).toMatch(/registro: registroDoTurno\(\),\s*\n\s*\}\s*\n\s*: null;/);
    // ...e o turno NÃO decide sucesso por conta própria: quem responde é a ponte.
    expect(fonte).not.toContain("efeitosDoTurno.registrar");
  });

  it("o gate lê o predicado, não 'a ferramenta foi chamada'", () => {
    const fonte = ler("lib/agent-engine/guardrails/before-send.ts");
    expect(fonte).toMatch(/registro\.ferramentas\.some\(\(f\) => registro\.efeitos\.produziuEfeito\(f\)\)/);
    // O gate NÃO consulta a lista de chamadas do turno (o sinal do `agendaStallGate`): uma
    // chamada recusada pelo escopo deixa o registro sem existir, e é esse turno que precisa
    // mudar a fala.
    const gate = fonte.slice(fonte.indexOf("export const registroSemEfeitoGate"));
    const corpo = gate.slice(0, gate.indexOf("export const disclosureGate"));
    expect(corpo).not.toContain("toolCalledThisTurn");
  });

  it("a família de escritas de registro é UMA lista, exportada", () => {
    const fonte = ler("lib/agent-engine/guardrails/registro-sem-efeito.ts");
    expect(fonte).toMatch(/export const ESCRITAS_QUE_REGISTRAM_O_INTERESSE: readonly string\[\] = \["crm_create_lead"\]/);
  });
});
