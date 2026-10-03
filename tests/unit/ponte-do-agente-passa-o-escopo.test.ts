/**
 * O escopo de funil chega ao turno REAL do agente — ou as capacidades de CRM
 * são decorativas.
 *
 * `ai_agent_versions.pipeline_ids` responde "em que negócios este agente pode
 * mexer", e a tela do agente ("Em que negócios ele pode mexer") escreve nele.
 * Quem aplica a regra é `podeChamarFerramenta`, através do campo `escopo` de
 * `pickToolsFromMcp` — e ele é OPCIONAL na interface, então esquecer de passá-lo
 * compila, typecheca e passa em todos os testes.
 *
 * Esquecer não é neutro: `escopo ?? []` e vazio significa NENHUM (falha
 * fechada, decisão da migration 0125). Um chamador que omite o campo faz TODA
 * escrita de lead ser recusada — o dono liga a capacidade na tela, o modelo
 * gasta a chamada, e o card nunca se move. É o modo de falha mais caro do
 * produto: o agente conversa bem e nada chega ao funil.
 *
 * O turno de produção (agent-engine) omitia. O dispatcher antigo passava.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { podeOperarNoFunil } from "@/lib/leads/escopo-de-funil";

const RAIZ = resolve(__dirname, "../..");

/** Os arquivos de produção que montam as ferramentas de um turno. */
const CHAMADORES = [
  "lib/agent-engine/edge/crm/mcp-tools.ts",
  "lib/ai/runtime/agent.ts",
];

describe("a consequência de omitir o escopo", () => {
  it("sem escopo, escrever em funil é RECUSADO — não é 'sem restrição'", () => {
    // A leitura errada desta API é achar que ausência = liberado. Se fosse
    // assim, o esquecimento seria invisível em vez de bloqueante.
    expect(podeOperarNoFunil(undefined, "funil-1")).toMatchObject({
      permitido: false,
      motivo: "escopo_vazio",
    });
    expect(podeOperarNoFunil([], "funil-1")).toMatchObject({ motivo: "escopo_vazio" });
  });

  it("com o funil no escopo, é permitido (a recusa acima não é geral demais)", () => {
    expect(podeOperarNoFunil(["funil-1"], "funil-1")).toMatchObject({ permitido: true });
  });
});

describe("todo montador de ferramentas do turno passa o escopo", () => {
  it("os chamadores existem (guarda de vacuidade)", () => {
    // Sem isto, renomear os arquivos deixaria o teste abaixo verde por não ter
    // o que verificar.
    for (const arquivo of CHAMADORES) {
      const fonte = readFileSync(resolve(RAIZ, arquivo), "utf8");
      expect(fonte, `${arquivo} não monta ferramentas`).toMatch(/pickToolsFromMcp\(/);
    }
  });

  it("a ponte provê `resolveLeadDoContato` — senão a agenda recusa tudo", () => {
    // Mesmo modo de falha descrito no cabeçalho deste arquivo, num alvo novo.
    // `funil_vem_do_contato` (crm_book_appointment) falha FECHADA quando o resolvedor
    // não vem: recusa com "resolvedor de contato ausente". Isso é o certo para o gate
    // — dependência que falta não pode virar liberação —, mas significa que esquecer
    // de passá-lo faz TODA marcação de consulta ser recusada, com a capacidade ligada
    // na tela e nenhuma consulta entrando na agenda.
    //
    // A ponte é UMA (`pickToolsFromMcp`), então o guarda é sobre ela, e não sobre os
    // chamadores: eles passam `pipelineIds`; quem monta o resolvedor é ela.
    const fonte = readFileSync(resolve(RAIZ, "lib/ai/runtime/tools.ts"), "utf8");
    expect(fonte, "a ponte não monta o resolvedor de contato").toMatch(/resolveLeadDoContato:/);
    // E ele tem de vir da MESMA regra que roteia atividade — reimplementar "qual
    // negócio da pessoa está em jogo" faria o escopo e a timeline discordarem sobre
    // o mesmo cliente.
    expect(fonte, "o resolvedor não usa `resolveActiveLeadForContact`").toMatch(
      /resolveActiveLeadForContact\(/,
    );
  });

  it("nenhum deles esquece `pipelineIds`", () => {
    const esquecidos = CHAMADORES.filter((arquivo) => {
      const fonte = readFileSync(resolve(RAIZ, arquivo), "utf8");
      return !/pipelineIds:/.test(fonte);
    });
    expect(
      esquecidos,
      "monta as capacidades de CRM sem escopo — toda escrita de lead seria recusada, " +
        "com a capacidade ligada na tela e o card parado",
    ).toEqual([]);
  });
});

describe("o espelho de etapa recebe o escopo do agente publicado", () => {
  it("o turno não omite os funis ao chamar mirrorLeadStageToCrm", () => {
    const fonte = readFileSync(resolve(RAIZ, "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
    const chamada = fonte.match(/const mirror = await mirrorLeadStageToCrm\([\s\S]*?\n\s*\}\);/);
    expect(chamada, "o turno não chama o espelho do CRM").not.toBeNull();
    expect(chamada?.[0], "o espelho ignoraria os funis autorizados na versão publicada").toMatch(
      /pipelineIds: agentConfig\.pipelineIds/,
    );
  });
});
