/**
 * TURNO MUDO — quando o silêncio do turno é decisão e quando é defeito.
 *
 * A regra é de `lib/agent-engine/agent/turno-mudo.ts`; o caminho inteiro (o
 * handler de `inbound_turn` pedindo a correção ao modelo) está em
 * `tests/invariants/turno-mudo-pede-uma-correcao.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { CORRECAO_DO_TURNO_MUDO, turnoMudoPedeCorrecao } from "@/lib/agent-engine/agent/turno-mudo";

const MUDO = {
  tentativasDeEnvio: 0,
  vetoIrrevogavel: false,
  enviadas: 0,
  turnoDescartado: false,
  passouParaAEquipe: false,
  capDeEnvio: false,
};

describe("o turno mudo pede correção só quando nada explica o silêncio", () => {
  it("⭐ nenhum envio, nenhuma tentativa, nenhuma razão: pede correção", () => {
    expect(turnoMudoPedeCorrecao(MUDO)).toBe(true);
  });

  it.each([
    ["algo saiu", { enviadas: 1 }],
    ["o turno foi descartado como obsoleto", { turnoDescartado: true }],
    ["a conversa foi passada à equipe", { passouParaAEquipe: true }],
    ["o cap de envio do número barrou", { capDeEnvio: true }],
    // opt-out / contato interno / equipe / LGPD: o veto diz "encerre sem tentar de
    // novo" — a correção mandaria o modelo tentar de novo, contra o veto.
    ["a cadeia vetou com um código que manda parar", { tentativasDeEnvio: 1, vetoIrrevogavel: true }],
  ])("silêncio com razão — %s: não pede", (_razao, mudanca) => {
    expect(turnoMudoPedeCorrecao({ ...MUDO, ...mudanca })).toBe(false);
  });

  it("⭐ teste 10 do aceite: tentativas vetadas e NADA entregue — pede correção", () => {
    // O caso medido (2026-10-25, job 217c6925): o modelo chamou send_message 2×,
    // o agenda_stall vetou as duas (erros de ensino voltaram DENTRO do loop) e ele
    // encerrou o turno com texto solto. Nada chegou ao cliente e a agenda não
    // mudou. "O veto já ensinou" é uma suposição que este turno refuta: a lição
    // ficou no loop e o cliente ficou sem resposta — a correção é o único caminho
    // de recuperação que o motor já tem.
    expect(
      turnoMudoPedeCorrecao({ ...MUDO, tentativasDeEnvio: 2 }),
      "tentativa vetada não entregou nada — o silêncio é defeito, não decisão",
    ).toBe(true);
  });

  it("a correção diz o que aconteceu, manda usar send_message e deixa o silêncio deliberado possível", () => {
    expect(CORRECAO_DO_TURNO_MUDO).toContain("send_message");
    expect(CORRECAO_DO_TURNO_MUDO).toContain("não chega");
    expect(CORRECAO_DO_TURNO_MUDO).toMatch(/idioma da conversa/);
    expect(CORRECAO_DO_TURNO_MUDO).toMatch(/não responder, encerre/);
  });

  it("⭐ quando o veto é de AGENDA, a correção ensina a MOVER o compromisso — nunca criar outro", () => {
    // Medido no teste 10 do aceite (2026-10-26, job 5ca40cb3): o diálogo trazia o
    // veto `agenda_stall` e a correção resolveu o "falta mexer na agenda" como
    // NOVO agendamento — chamou crm_find_and_book_appointment e criou uma SEGUNDA
    // consulta (30/10 09:00) enquanto a original (29/10) ficou intacta. O texto da
    // correção precisa nomear o caminho certo: localizar SEM `dia` (o dia chutado
    // devolve lista vazia — foi o que aconteceu nos turnos 1 e 2) e MOVER com
    // crm_reschedule_appointment.
    expect(CORRECAO_DO_TURNO_MUDO).toContain("crm_list_appointments");
    expect(CORRECAO_DO_TURNO_MUDO).toContain("crm_reschedule_appointment");
    expect(CORRECAO_DO_TURNO_MUDO).toMatch(/sem `dia`/);
    expect(CORRECAO_DO_TURNO_MUDO).toMatch(/crm_find_and_book_appointment/);
    expect(CORRECAO_DO_TURNO_MUDO).toMatch(/SEGUNDO compromisso/);
    // …e a ordem continua sendo: mudar a agenda PRIMEIRO, responder DEPOIS.
    expect(CORRECAO_DO_TURNO_MUDO).toMatch(/S[oó] depois de a agenda ter mudado/);
  });
});
