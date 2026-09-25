/**
 * TODO CONTROLE QUE A TELA GRAVA TEM DE SER APLICADO PELO MOTOR.
 *
 * ─── O defeito que este arquivo existe para impedir ─────────────────────────
 *
 * A tela do agente oferece "Tamanho máximo desse histórico" e grava
 * `ai_agent_versions.history_token_window` (default 8.000). O turno carregava a
 * coluna, montava `historyTokenWindow` na config… e passava ao contexto o valor
 * de `LEAD_CONTEXT_MAX_TOKENS` — uma env com default 1.000 que sequer aparece no
 * `.env.example`. Quem configurava 8.000 recebia 1.000, e nada dizia isso.
 *
 * O campo ficou assim desde o commit que trouxe a leitura da versão publicada:
 * metade dela era lida, metade não. Ninguém percebeu porque a coluna ESTAVA no
 * SELECT — e "está no SELECT" é o proxy errado. É por isso que a régua aqui é
 * outra: cada campo carregado precisa ter ao menos um CONSUMIDOR fora do próprio
 * mapeamento.
 *
 * ─── Por que estático, e qual a fraqueza ────────────────────────────────────
 *
 * A propriedade é enumerável a partir do repositório, e o comportamento só
 * apareceria num turno real com modelo e fila — a mesma régua de
 * `camada-lida-no-motor.test.ts` e `navegacao-completude.test.ts`.
 *
 * A fraqueza, declarada: isto mede TEXTO. Um consumidor que leia o campo por um
 * caminho que o padrão abaixo não conhece passaria batido. Por isso existe o
 * controle positivo — instrumento que não acha nada devolve verde igual a
 * instrumento que não achou problema.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const CONFIG = path.join("lib", "agent-engine", "agent", "agent-config.ts");

/**
 * Campos carregados de propósito SEM consumidor de comportamento. Cada entrada
 * é uma dívida declarada — e a lista só encolhe.
 */
const SEM_CONSUMIDOR_ACEITO: Readonly<Record<string, string>> = {
  // Nome só para o log do turno: não muda o que o agente faz nem o que o
  // cliente recebe. Sai daqui no dia em que virar comportamento.
  agentName: "usado apenas no log do run, nunca em decisão",
  // Liga/desliga pelo celular (C-076/C-077). O motor NÃO lê estes campos
  // carregados: quem decide é `configDeComandosDoAgente`
  // (`lib/escalacao/comando-de-canal.ts`), consultado pelo ingest do canal
  // (que não carrega o `agentConfig`). Os campos aqui espelham a config para
  // leitura/tela — o consumo de comportamento vive na outra consulta. Some da
  // lista no dia em que o ingest passar a usar o config já carregado.
  aceitaComandosCelular: "consumido via configDeComandosDoAgente (ingest), não pelo agentConfig",
  comandoLigar: "consumido via configDeComandosDoAgente (ingest), não pelo agentConfig",
  comandoDesligar: "consumido via configDeComandosDoAgente (ingest), não pelo agentConfig",
};

function camposDaConfig(): string[] {
  const src = readFileSync(path.join(RAIZ, CONFIG), "utf8");
  const ini = src.indexOf("export interface PublishedAgentConfig");
  const fim = src.indexOf("interface Row", ini);
  expect(ini, "não achei a interface da config publicada").toBeGreaterThan(-1);
  expect(fim, "não achei o fim da interface da config publicada").toBeGreaterThan(ini);
  return [...src.slice(ini, fim).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
}

/** Arquivos que leem o campo, fora do próprio módulo que o carrega. */
function consumidoresDe(campo: string): string[] {
  try {
    const saida = execFileSync(
      "git",
      ["grep", "-l", "-e", `agentConfig.${campo}`, "-e", `agentConfig?.${campo}`, "--", "lib", "workers", "app"],
      { cwd: RAIZ, encoding: "utf8" },
    );
    return saida.split("\n").filter((f) => f !== "" && !f.includes("agent-config"));
  } catch {
    // `git grep` sai com 1 quando não encontra nada — ausência, não falha.
    return [];
  }
}

describe("knobs da versão publicada", () => {
  it("o instrumento enxerga (controle positivo)", () => {
    const campos = camposDaConfig();
    expect(campos.length, "a interface da config veio vazia — o parser quebrou").toBeGreaterThan(15);
    expect(campos).toContain("systemPrompt");
    expect(
      consumidoresDe("systemPrompt").length,
      "nem o system_prompt foi encontrado: o grep não está enxergando o repo",
    ).toBeGreaterThan(0);
  });

  it("todo campo carregado tem quem o aplique", () => {
    const orfaos = camposDaConfig().filter(
      (c) => !(c in SEM_CONSUMIDOR_ACEITO) && consumidoresDe(c).length === 0,
    );
    expect(
      orfaos,
      `campo carregado da versão publicada e nunca aplicado: ${orfaos.join(", ")}. ` +
        "A tela grava, o dono acredita que vale, e o motor ignora. Ligue o campo, " +
        "tire-o da tela, ou declare a dívida em SEM_CONSUMIDOR_ACEITO com o porquê.",
    ).toEqual([]);
  });

  it("a janela de tokens do histórico vem da versão, não da instalação", () => {
    // O caso concreto que originou o arquivo. Explícito porque o teste genérico
    // acima ficaria verde com um uso qualquer do campo em outro lugar — e o que
    // importa é este ponto, o que monta o contexto do turno.
    const turno = readFileSync(
      path.join(RAIZ, "lib", "agent-engine", "agent", "inbound-turn.ts"),
      "utf8",
    );
    const ramo = /const turnContextKnobs =[\s\S]{0,300}?: contextKnobs;/.exec(turno)?.[0] ?? "";
    expect(ramo, "não achei a montagem dos knobs do turno").not.toBe("");
    expect(ramo).toContain("agentConfig.historyTokenWindow");
    expect(
      ramo,
      "o turno voltou a preferir a env ao valor que a tela grava por agente",
    ).not.toContain("deps.knobs.maxContextTokens");
  });
});
