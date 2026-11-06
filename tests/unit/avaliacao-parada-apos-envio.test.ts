import { describe, expect, it } from "vitest";

import {
  agrupar,
  CENARIOS,
  classificarTurno,
  conferirTeto,
  execucaoDoTelefone,
  limiteSuperiorSemEventos,
  modeloDoLote,
  padraoDoLote,
  telefoneDaExecucao,
  vereditoDoModelo,
  type TurnoMedido,
} from "@/scripts/lib/avaliacao-parada-apos-envio";

/**
 * O roteiro da avaliação local da parada do laço (docs/runbooks/parada-apos-envio.md)
 * provado SEM rede e sem banco: a identidade de cada execução, a classificação de
 * cada turno contra a trava de produção e o veredito por modelo. A avaliação paga
 * só confia neste relatório porque ele erra para o lado conservador — os casos
 * "perda" e "revisar" abaixo são essa garantia.
 */

const cenario = (id: string) => {
  const c = CENARIOS.find((x) => x.id === id);
  if (c === undefined) throw new Error(id);
  return c;
};

const envio = (encerra_turno?: boolean) => ({
  nome: "send_message",
  estado: "ok",
  ...(encerra_turno === true ? { encerra_turno: true } : {}),
});
const feito = (nome: string) => ({ nome, estado: "ok" });

function turno(over: Partial<TurnoMedido> & Pick<TurnoMedido, "ferramentas">): TurnoMedido {
  return {
    jobId: "job",
    telefone: telefoneDaExecucao(1, cenario("S1-casos-off"), "observe", 1),
    modelo: "m",
    mensagensEnviadas: 1,
    corpos: ["Tudo certo por aqui."],
    casoAutomatico: false,
    handoffKeywords: [],
    ...over,
  };
}

describe("telefone da execução — um contato novo por execução, e ele diz quem é", () => {
  it("ida e volta para todo cenário e braço", () => {
    for (const c of CENARIOS) {
      for (const braco of ["off", "observe"] as const) {
        const tel = telefoneDaExecucao(7, c, braco, 20);
        expect(tel).toMatch(/^\d{13}$/);
        expect(execucaoDoTelefone(`+${tel}`)).toEqual({ lote: 7, cenario: c, braco, k: 20 });
      }
    }
  });

  it("telefone de fora da avaliação não é atribuído a cenário nenhum", () => {
    expect(execucaoDoTelefone("+5531988887777")).toBeNull();
    expect(execucaoDoTelefone("5520901990001")).toBeNull(); // cenário 9 não existe
  });

  it("nenhum telefone da avaliação disca: o DDD 20 não existe no Brasil", () => {
    // A avaliação desliga a proteção anti-banimento do canal. Com o WAHA pareado a um
    // número de verdade por engano, um DDD que existe mandaria a resposta a um desconhecido.
    const DDDS_EM_USO = new Set([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38,
      41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69,
      71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
    ]);
    for (const c of CENARIOS) {
      const tel = telefoneDaExecucao(1, c, "observe", 1);
      expect(tel.slice(0, 2), tel).toBe("55");
      expect(DDDS_EM_USO.has(Number(tel.slice(2, 4))), tel).toBe(false);
    }
  });

  it("execuções distintas nunca dividem contato", () => {
    const todos = CENARIOS.flatMap((c) =>
      (["off", "observe"] as const).flatMap((b) => [1, 2].map((k) => telefoneDaExecucao(1, c, b, k))),
    );
    expect(new Set(todos).size).toBe(todos.length);
  });
});

describe("classificarTurno — a trava de produção aplicada ao corpo enviado", () => {
  it("envio marcado como ÚLTIMA ferramenta: sem risco (a parada não perde nada)", () => {
    const t = classificarTurno(turno({ ferramentas: [feito("search_knowledge"), envio(true)] }), cenario("S0"));
    expect(t).toMatchObject({ adotou: true, marcouEAgiu: false, desfecho: "sem_risco", emRisco: false });
  });

  it("marcou e depois passou para a equipe, com corpo que ANUNCIA: a trava teria segurado", () => {
    const t = classificarTurno(
      turno({
        ferramentas: [envio(true), feito("request_human_handoff")],
        corpos: ["Vou chamar alguém da equipe para te atender."],
      }),
      cenario("S1-casos-off"),
    );
    expect(t).toMatchObject({ emRisco: true, marcouEAgiu: true, desfecho: "segurado", acaoEsperadaCumprida: true });
    expect(t.acoesAposFinal).toEqual(["request_human_handoff"]);
  });

  it("marcou e depois registrou nota, com corpo que NÃO anuncia: perda efetiva", () => {
    const t = classificarTurno(
      turno({ ferramentas: [envio(true), feito("save_lead_note")], corpos: ["Anotado, obrigado!"] }),
      cenario("S4"),
    );
    expect(t.desfecho).toBe("perda");
  });

  it("vários envios no turno: o corpo do marcado não é identificável — revisar", () => {
    const t = classificarTurno(
      turno({ ferramentas: [envio(true), envio(), feito("update_lead_state")], mensagensEnviadas: 2 }),
      cenario("S4"),
    );
    expect(t.desfecho).toBe("revisar");
  });

  it("promessa de retorno com follow-up ANTES do envio marcado: a trava libera, então é perda", () => {
    const t = classificarTurno(
      turno({
        ferramentas: [feito("schedule_followup"), envio(true), feito("save_lead_note")],
        corpos: ["Combinado, te chamo amanhã às 10h."],
      }),
      cenario("S2-casos-off"),
    );
    expect(t.desfecho).toBe("perda");
  });

  it("caso aberto pelo fail-safe libera a promessa como em produção: o turno é PERDA, não 'segurado'", () => {
    // S1-casos-on: o próprio send_message com a promessa abre o caso
    // (guardrail_autofallback), que liga `openedCaseThisTurn` — a trava solta e o
    // laço para; a nota que viria depois se perde. O caso não aparece no traço.
    const t = classificarTurno(
      turno({
        ferramentas: [envio(true), feito("save_lead_note")],
        corpos: ["Vou chamar alguém da equipe para te atender."],
        casoAutomatico: true,
      }),
      cenario("S1-casos-on"),
    );
    expect(t.desfecho).toBe("perda");
  });

  it("ledger com mensagem que o único envio do traço não explica: revisar, nunca 'segurado'", () => {
    // A promessa só aparece na 2ª linha do ledger (outra mensagem do job): em
    // produção a trava lê só o corpo do send_message e NÃO seguraria.
    const t = classificarTurno(
      turno({
        ferramentas: [envio(true), feito("save_lead_note")],
        corpos: ["Anotado, obrigado!", "Vou chamar alguém da equipe para te atender."],
      }),
      cenario("S4"),
    );
    expect(t.desfecho).toBe("revisar");
  });

  it("ferramenta que falhou não conta como ação esperada", () => {
    const t = classificarTurno(
      turno({ ferramentas: [envio(), { nome: "request_human_handoff", estado: "falhou" }] }),
      cenario("S1-casos-off"),
    );
    expect(t.acaoEsperadaCumprida).toBe(false);
    expect(t.adotou).toBe(false);
  });
});

describe("veredito por modelo", () => {
  const medir = (cen: string, braco: "off" | "observe", k: number, t: Omit<TurnoMedido, "telefone" | "jobId">) => ({
    ...t,
    jobId: `${cen}-${braco}-${k}`,
    telefone: telefoneDaExecucao(1, cenario(cen), braco, k),
  });
  const emRiscoSegurado = {
    modelo: "luna",
    mensagensEnviadas: 1,
    ferramentas: [envio(true), feito("request_human_handoff")],
    corpos: ["Vou chamar alguém da equipe para te atender."],
    casoAutomatico: false,
    handoffKeywords: [],
  };

  it("limite superior exato com 0 eventos: 80 execuções dão ≤ 3,7%", () => {
    expect(limiteSuperiorSemEventos(80)).toBeCloseTo(0.0368, 3);
    expect(limiteSuperiorSemEventos(0)).toBeNull();
  });

  it("80 em risco, 0 perdas e ação esperada igual nos dois braços: APROVA", () => {
    const turnos = [
      ...Array.from({ length: 80 }, (_, i) => medir("S1-casos-off", "observe", i + 1, emRiscoSegurado)),
      ...Array.from({ length: 80 }, (_, i) => medir("S1-casos-off", "off", i + 1, { ...emRiscoSegurado, ferramentas: [envio(), feito("request_human_handoff")] })),
    ];
    const v = vereditoDoModelo("luna", agrupar(turnos));
    expect(v).toMatchObject({ resultado: "aprova", emRisco: 80, perdas: 0 });
  });

  it("amostra em risco abaixo do mínimo: INCONCLUSIVO, nunca aprova", () => {
    const turnos = Array.from({ length: 10 }, (_, i) => medir("S1-casos-off", "observe", i + 1, emRiscoSegurado));
    expect(vereditoDoModelo("luna", agrupar(turnos)).resultado).toBe("inconclusivo");
  });

  it("uma perda reprova, qualquer que seja a amostra", () => {
    const turnos = [
      ...Array.from({ length: 80 }, (_, i) => medir("S1-casos-off", "observe", i + 1, emRiscoSegurado)),
      medir("S4", "observe", 1, { ...emRiscoSegurado, ferramentas: [envio(true), feito("save_lead_note")], corpos: ["Anotado!"] }),
    ];
    expect(vereditoDoModelo("luna", agrupar(turnos)).resultado).toBe("reprova");
  });

  it("a ação esperada cai além da tolerância no observe: REPROVA (o parâmetro influenciou o modelo)", () => {
    const off = Array.from({ length: 20 }, (_, i) =>
      medir("S2-casos-off", "off", i + 1, { ...emRiscoSegurado, ferramentas: [envio(), feito("schedule_followup")] }),
    );
    const observe = Array.from({ length: 20 }, (_, i) =>
      medir("S2-casos-off", "observe", i + 1, { ...emRiscoSegurado, ferramentas: i < 15 ? [envio(), feito("schedule_followup")] : [envio(true)] }),
    );
    const v = vereditoDoModelo("luna", agrupar([...off, ...observe]), { minimoEmRisco: 1, tolerancia: 0.1 });
    expect(v.resultado).toBe("reprova");
    expect(v.motivos.join(" ")).toMatch(/S2-casos-off/);
  });

  it("lote fora do filtro fica de fora do relatório", () => {
    const t = medir("S0", "observe", 1, emRiscoSegurado);
    expect(agrupar([t], new Set([2]))).toEqual([]);
  });
});

describe("modelo do lote — provedor direto ou OpenRouter", () => {
  it("provedor:modelo publica no provedor direto", () => {
    expect(modeloDoLote("openai:gpt-5.6-luna")).toEqual({ provedor: "openai", modelo: "gpt-5.6-luna" });
    expect(modeloDoLote("anthropic:claude-sonnet-4-6")).toEqual({ provedor: "anthropic", modelo: "claude-sonnet-4-6" });
  });

  it("sem ':' é o id da OpenRouter, como antes", () => {
    expect(modeloDoLote("openai/gpt-5.6-luna")).toEqual({ provedor: "openrouter", modelo: "openai/gpt-5.6-luna" });
  });

  it("provedor ou modelo vazio é recusado", () => {
    expect(() => modeloDoLote(":gpt-5.6-luna")).toThrow();
    expect(() => modeloDoLote("openai:")).toThrow();
  });
});

describe("teto do executar — lido de llm_calls, falha fechado quando cego", () => {
  it("o padrão do lote casa as execuções dele e de nenhum outro", () => {
    const re = new RegExp(padraoDoLote(92));
    for (const c of CENARIOS) expect(re.test(telefoneDaExecucao(92, c, "observe", 20))).toBe(true);
    expect(re.test(telefoneDaExecucao(9, CENARIOS[0]!, "off", 1))).toBe(false);
    expect(re.test(telefoneDaExecucao(93, CENARIOS[0]!, "off", 1))).toBe(false);
    expect(re.test("5531988887777")).toBe(false);
  });

  it("abaixo do teto segue; no teto ou acima para", () => {
    expect(conferirTeto({ centavos: 4.9, chamadasCegas: 0 }, 0.05)).toBe("segue");
    expect(conferirTeto({ centavos: 5, chamadasCegas: 0 }, 0.05)).toBe("teto");
    expect(conferirTeto({ centavos: 12, chamadasCegas: 0 }, 0.05)).toBe("teto");
  });

  it("chamada com tokens e sem custo lança, mesmo com a soma em zero", () => {
    expect(() => conferirTeto({ centavos: 0, chamadasCegas: 1 }, 1)).toThrow(/cego/);
    expect(() => conferirTeto({ centavos: 3, chamadasCegas: 2 }, 1)).toThrow(/cego/);
  });
});
