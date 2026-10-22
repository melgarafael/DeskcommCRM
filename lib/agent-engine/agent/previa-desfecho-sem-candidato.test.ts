import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  desfechoSemCandidato,
  previaPedeCorrecaoDoTurnoMudo,
  tetoDePassosAtingido,
} from "./desfecho-da-previa";
import { motivoDoVeto, temOfertaAoAtendente } from "./sugestao-de-resposta";

/**
 * O DESFECHO DA PRÉVIA — um caso por causa (issue #3093).
 *
 * O defeito medido pelo autor da issue: `avisarSemCandidato` gravava o MESMO
 * `no_candidate` para causas que não têm nada em comum, e o painel não podia
 * dizer ao atendente se o agente decidiu não responder ou se a geração parou no
 * meio. Aqui cada causa cobra o SEU código — e o controle cobra que a prévia que
 * responde continue concluída, sem impedimento e sem rascunho `failed`.
 *
 * A sabotagem prevista: devolver `no_candidate` para todas as causas deixa
 * VERMELHOS os casos de truncamento e de teto de passos (os dois desfechos que
 * deixaram de existir), que é exatamente o defeito que a issue descreve.
 */

const semCandidato = (over: Partial<Parameters<typeof desfechoSemCandidato>[0]> = {}) =>
  desfechoSemCandidato({
    candidatos: 0,
    impedimentos: 0,
    saidaTruncada: false,
    tetoDePassosAtingido: false,
    ...over,
  });

describe("cada causa da parada tem código próprio (#3093)", () => {
  it("⛔ TRUNCAMENTO (finish_reason = length) vira `output_truncated`, não `no_candidate`", () => {
    const d = semCandidato({ saidaTruncada: true });
    expect(d?.code).toBe("output_truncated");
    // A mesma frase que o painel mostra — e ela NÃO pode dizer que o agente
    // decidiu: a geração foi cortada no teto de tokens de saída.
    expect(motivoDoVeto(d!.code)!.texto).toMatch(/cortada/i);
  });

  it("⛔ TETO DE PASSOS vira `max_steps_exhausted`, não `no_candidate`", () => {
    const d = semCandidato({
      // O sinal real do turno: o laço parou no teto de `max_steps`, no meio de um
      // passo de ferramenta — o modelo consultou até o orçamento acabar.
      tetoDePassosAtingido: tetoDePassosAtingido({
        passosUsados: 10,
        maxSteps: 10,
        finishReason: "tool-calls",
      }),
    });
    expect(d?.code).toBe("max_steps_exhausted");
    expect(motivoDoVeto(d!.code)!.texto).toMatch(/teto de passos/i);
  });

  it("⛔ as duas paradas NÃO caem no `no_candidate` — é o defeito da issue", () => {
    // Este caso existe para que uma implementação que "separa as causas" só no
    // comentário não passe: as duas têm de sair do código genérico.
    expect(semCandidato({ saidaTruncada: true })?.code).not.toBe("no_candidate");
    expect(semCandidato({ tetoDePassosAtingido: true })?.code).not.toBe("no_candidate");
  });

  it("a DECISÃO de não responder é o que sobra, e é `no_candidate`", () => {
    // Nada de parada nenhuma: o agente encerrou sem escrever e sem impedimento —
    // a saudação automática do WhatsApp Business de quem foi abordado (#3092).
    expect(semCandidato()?.code).toBe("no_candidate");
    expect(motivoDoVeto("no_candidate")!.texto).toMatch(/decidiu não responder/);
  });

  it("o truncamento tem precedência sobre o teto de passos", () => {
    // Os dois podem estar verdadeiros (o último passo estourou o teto de tokens);
    // a falha mais específica é a que nomeia o desfecho.
    expect(semCandidato({ saidaTruncada: true, tetoDePassosAtingido: true })?.code).toBe(
      "output_truncated",
    );
  });

  it("`tetoDePassosAtingido` só acusa quando o laço PAROU no teto", () => {
    // Usar todos os passos e terminar em texto é decisão (`stop`), não teto.
    expect(
      tetoDePassosAtingido({ passosUsados: 10, maxSteps: 10, finishReason: "stop" }),
    ).toBe(false);
    expect(
      tetoDePassosAtingido({ passosUsados: 3, maxSteps: 10, finishReason: "tool-calls" }),
    ).toBe(false);
    expect(tetoDePassosAtingido({ passosUsados: 0, maxSteps: 0, finishReason: "tool-calls" })).toBe(
      false,
    );
  });
});

describe("TEXTO SOLTO passa pela correção do turno mudo também na prévia (#3093)", () => {
  it("⛔ o modelo escreveu fora do send_message: a prévia pede a MESMA correção", () => {
    expect(
      previaPedeCorrecaoDoTurnoMudo({
        textoEscrito: "Perfeito, qual o endereço de entrega?",
        candidatos: 0,
        tentativasDeEnvio: 0,
      }),
    ).toBe(true);
  });

  it("silêncio SEM texto é decisão já tomada — não gasta uma chamada de modelo", () => {
    // O `CORRECAO_DO_TURNO_MUDO` autoriza o modelo a encerrar sem chamar nada
    // (#2938): pedir de novo sem texto solto pagaria para ouvir a mesma coisa.
    for (const vazio of ["", "   \n  "])
      expect(
        previaPedeCorrecaoDoTurnoMudo({
          textoEscrito: vazio,
          candidatos: 0,
          tentativasDeEnvio: 0,
        }),
        JSON.stringify(vazio),
      ).toBe(false);
  });

  it("com candidato já aceito a correção não é pedida — a resposta já está pronta", () => {
    expect(
      previaPedeCorrecaoDoTurnoMudo({
        textoEscrito: "texto solto",
        candidatos: 1,
        tentativasDeEnvio: 1,
      }),
    ).toBe(false);
  });
});

describe("PROPOSTA sem resposta não lê como `failed` (#3093, caso 2)", () => {
  it("⛔ só propostas, sem resposta: o rascunho tem o que oferecer", () => {
    // Antes: corpo vazio → `failed`, e o painel dizia "Não foi possível concluir
    // a sugestão" para um desfecho que deu certo (a proposta está registrada).
    expect(
      temOfertaAoAtendente("", [{ tool: "request_human_handoff", arguments: {} }], "no_candidate"),
    ).toBe(true);
    expect(temOfertaAoAtendente("", [{ tool: "save_lead_note", arguments: {} }], null)).toBe(true);
  });

  it("⛔ veto + proposta continua `failed` (o motivo do veto aparece)", () => {
    // O `send_message` foi vetado e o modelo propôs uma ação em seguida. Em
    // `pending` o painel mostraria só a proposta, sem dizer que o contato pediu
    // para não receber mensagens — o motivo só é exibido em `failed` (#2975).
    const proposta = [{ tool: "save_lead_note", arguments: {} }];
    expect(temOfertaAoAtendente("", proposta, "contato_bloqueado")).toBe(false);
    expect(temOfertaAoAtendente("", proposta, "lgpd_anonymized")).toBe(false);
    expect(temOfertaAoAtendente("", proposta, "messaging_window_closed")).toBe(false);
  });

  it("⛔ output_truncated / max_steps_exhausted + proposta continuam `failed`", () => {
    const proposta = [{ tool: "update_lead_state", arguments: {} }];
    expect(temOfertaAoAtendente("", proposta, "output_truncated")).toBe(false);
    expect(temOfertaAoAtendente("", proposta, "max_steps_exhausted")).toBe(false);
  });

  it("CONTROLE: sem resposta E sem proposta continua `failed` — ali não há nada", () => {
    expect(temOfertaAoAtendente("", [], "no_candidate")).toBe(false);
    expect(temOfertaAoAtendente("   ", [], null)).toBe(false);
    expect(temOfertaAoAtendente("", null, "no_candidate")).toBe(false);
    expect(temOfertaAoAtendente("", undefined, undefined)).toBe(false);
  });
});

describe("CONTROLE: a prévia que responde continua concluída", () => {
  it("com candidato aceito, nenhum desfecho é acrescentado", () => {
    // O caminho feliz não pode ganhar impedimento nenhum — senão a separação das
    // causas teria estragado justamente o caso que funciona.
    expect(semCandidato({ candidatos: 1 }) ).toBeNull();
  });

  it("com impedimento já registrado, nada é acrescentado por cima", () => {
    // O veto (ou a mídia que não preparou) JÁ é a causa; um segundo código
    // apagaria o primeiro, que é o único que o rascunho guarda.
    expect(semCandidato({ impedimentos: 1 })).toBeNull();
    expect(semCandidato({ impedimentos: 1, saidaTruncada: true })).toBeNull();
  });

  it("a prévia que responde mantém o rascunho fora de `failed`", () => {
    expect(temOfertaAoAtendente("Olá, posso ajudar?", [], null)).toBe(true);
  });
});

describe("o motor e a tela usam ESTAS decisões", () => {
  const ler = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

  it("a prévia do rascunho está ligada na correção do turno mudo", () => {
    const motor = ler("lib/agent-engine/agent/inbound-turn.ts");
    // O `!preview` que excluía a prévia foi trocado por um ramo próprio: sem
    // isto o texto solto voltaria a morrer no `no_candidate`.
    expect(motor).toMatch(/preview\?\.kind === 'assisted'/);
    expect(motor).toMatch(/previaPedeCorrecaoDoTurnoMudo\(\{/);
    expect(motor).toMatch(/CORRECAO_DO_TURNO_MUDO/);
  });

  it("o desfecho da prévia é decidido pelo módulo, não por um `if` solto no turno", () => {
    const motor = ler("lib/agent-engine/agent/inbound-turn.ts");
    expect(motor).toMatch(/desfechoSemCandidato\(\{/);
    expect(motor).toMatch(/tetoDePassosAtingido\(\{/);
  });

  it("a correção truncada ou no teto dela é falha, não decisão", () => {
    // Presença de texto, não comportamento: o closure do turno não roda sozinho.
    const motor = ler("lib/agent-engine/agent/inbound-turn.ts");
    expect(motor).toMatch(/saidaTruncada: saidaTruncada \|\| correcaoTruncou/);
    expect(motor).toMatch(/tetoNaCorrecao = tetoDePassosAtingido\(\{/);
    expect(motor).toMatch(/\}\) \|\| tetoNaCorrecao/);
  });

  it("a oferta decide o status do rascunho NO SQL (uma régua só)", () => {
    const drafts = ler("lib/agent-engine/agent/reply-drafts.ts");
    expect(drafts).toMatch(
      /temOfertaAoAtendente\(body, result\.proposals, result\.impediments\[0\]\?\.code\)/,
    );
    expect(drafts).toMatch(/when \$4::boolean then 'pending' else 'failed'/);
  });
});
