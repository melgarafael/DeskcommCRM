import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { criarEfeitoDasEscrituras } from "@/lib/ai/runtime/efeito-das-escritas";

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
    expect(fonte).toMatch(/preview \? \{ readOnly: true, efeitos: efeitosDoTurno \} : \{ readOnly: false, efeitos: efeitosDoTurno \}/);
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
