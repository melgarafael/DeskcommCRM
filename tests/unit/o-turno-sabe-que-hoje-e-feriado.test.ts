import { describe, expect, it } from "vitest";

import {
  blocoDoFeriado,
  feriadoNacionalNoTurno,
  lerFeriadoDoTurno,
} from "@/lib/agent-engine/agent/feriado-nacional";

/**
 * O TURNO PRECISA SABER QUE O DIA É FERIADO NACIONAL (#3877).
 *
 * ─── O defeito, com caso real ───────────────────────────────────────────────
 *
 * Em 02/11/2026 — Finados, feriado nacional — dois agentes desta instalação
 * disseram a clientes "atendemos hoje até as 18h", e um deles convidou a pessoa
 * a ir até a loja. A empresa estava fechada. O prompt informa o horário
 * semanal (seg–sex, 8h–18h) e o bloco `## Agora` diz o dia da semana — o
 * agente sabia que era segunda-feira e aplicou o expediente de segunda. O que
 * ele não tinha, em lugar nenhum do contexto, era o fato de que aquele dia é
 * feriado nacional. O CRM já calcula esse calendário (`isHolidayBR`, usado pelo
 * prazo da LGPD); a informação simplesmente não chegava ao turno.
 *
 * ─── Por que o fuso vem ANTES da data ──────────────────────────────────────
 *
 * `isHolidayBR` lê a data de calendário em `America/Sao_Paulo`. A pergunta do
 * turno é outra: "que dia é hoje NA ORGANIZAÇÃO". Às 21h30 de 02/11 em São
 * Paulo já é 03/11 em UTC, e um turno que formatasse a data em UTC diria
 * "amanhã não é feriado, hoje é" — o inverso do que a pessoa do outro lado vê.
 * Feriado marcado no dia errado é pior que nenhum, então a data local vem de
 * `dataIsoNoFuso`/`somarDiasNoFuso` (a régua de data civil do repo) e o fuso
 * entra antes de qualquer conta.
 *
 * As datas abaixo são FIXAS e passadas como parâmetro — nunca `new Date()`:
 * um teste de calendário que depende do relógio do runner mede o dia em que
 * rodou, não a regra.
 */

/** Finados de 2026. */
const FINADOS = "2026-11-02";

/** 11h em São Paulo no próprio Finados. */
const NO_FERIADO = new Date("2026-11-02T14:00:00Z");
/** 11h em São Paulo na véspera (domingo, 01/11). */
const NA_VESPERA = new Date("2026-11-01T14:00:00Z");
/** Quarta-feira comum, 04/11 — e o dia seguinte também. */
const DIA_COMUM = new Date("2026-11-04T14:00:00Z");

describe("feriadoNacionalNoTurno — hoje e amanhã, no fuso da organização", () => {
  it("feriado nacional HOJE é dito ao turno", () => {
    const f = feriadoNacionalNoTurno(NO_FERIADO, "America/Sao_Paulo", null);

    expect(f?.hojeEm).toBe(FINADOS);
    expect(f?.hoje).toBe(true);
    // Amanhã (03/11) é dia útil — o par existe para o turno poder distinguir.
    expect(f?.amanha).toBe(false);
  });

  it("véspera de feriado: o turno fica sabendo que AMANHÃ é feriado", () => {
    // Sem este caso, uma implementação que só olhasse "hoje" passaria no
    // anterior e o agente continuaria marcando consulta para o Finados.
    const f = feriadoNacionalNoTurno(NA_VESPERA, "America/Sao_Paulo", null);

    expect(f?.hoje).toBe(false);
    expect(f?.amanha).toBe(true);
    expect(f?.amanhaEm).toBe(FINADOS);
  });

  it("dia comum: o turno RECEBE a negativa explícita, não o silêncio", () => {
    // Requisito do defeito: omitir o bloco faria o agente inventar. O fato
    // negativo tem de estar escrito, e é o texto dele que este caso trava.
    const f = feriadoNacionalNoTurno(DIA_COMUM, "America/Sao_Paulo", null);

    expect(f).not.toBeNull();
    expect(f?.hoje).toBe(false);
    expect(f?.amanha).toBe(false);
    expect(blocoDoFeriado(f)).toContain("NÃO são feriados nacionais");
  });

  it("O FUSO MANDA NA DATA: 21h30 de 02/11 em São Paulo já é 03/11 em UTC", () => {
    // O caso de controle do arquivo. Com a data formatada em UTC (o erro que
    // `new Date().toISOString()` comete), `hoje` seria 03/11 — a véspera — e o
    // agente diria "hoje é feriado" no dia seguinte ao feriado.
    const instante = new Date("2026-11-03T00:30:00Z");
    expect(instante.toISOString().slice(0, 10)).toBe("2026-11-03");

    const f = feriadoNacionalNoTurno(instante, "America/Sao_Paulo", null);

    expect(f?.hojeEm).toBe(FINADOS);
    expect(f?.hoje).toBe(true);
  });

  it("o fuso da ORGANIZAÇÃO e não o de São Paulo: em Fernando de Noronha já é 03/11", () => {
    // 23h30 em São Paulo do dia 02/11 = 00h30 de 03/11 em Noronha (UTC−2). A
    // mesma instante, dois fusos do mesmo país, dois dias de calendário — quem
    // fixar `America/Sao_Paulo` dentro da função reprova aqui.
    const instante = new Date("2026-11-03T02:30:00Z");

    const sp = feriadoNacionalNoTurno(instante, "America/Sao_Paulo", null);
    const noronha = feriadoNacionalNoTurno(instante, "America/Noronha", null);

    expect(sp?.hoje).toBe(true);
    expect(noronha?.hojeEm).toBe("2026-11-03");
    expect(noronha?.hoje).toBe(false);
    expect(noronha?.amanha).toBe(false);
  });

  it("fuso inválido NÃO derruba o turno — degrada para o padrão do produto", () => {
    // `organizations.timezone` não tem CHECK e o `Intl` lança em fuso torto.
    // Este bloco é montado antes da chamada de modelo: um throw aqui é agente
    // mudo, sem erro para investigar.
    expect(() => feriadoNacionalNoTurno(NO_FERIADO, "America/Asunción", null)).not.toThrow();
    expect(feriadoNacionalNoTurno(NO_FERIADO, "America/Asunción", null)).toEqual(
      feriadoNacionalNoTurno(NO_FERIADO, "America/Sao_Paulo", null),
    );
  });

  it("organização FORA do Brasil não recebe feriado brasileiro", () => {
    // O calendário é por ORGANIZAÇÃO (`organizations.country`, nulo = Brasil).
    // Uma clínica em Lisboa com feriado brasileiro no prompt prometeria
    // fechamento num dia em que abre — o mesmo defeito, ao contrário.
    expect(feriadoNacionalNoTurno(NO_FERIADO, "Europe/Lisbon", "PT")).toBeNull();
    expect(feriadoNacionalNoTurno(NO_FERIADO, "Europe/Lisbon", "pt")).toBeNull();
    // País vazio ou nulo é Brasil, a régua de `perfil-do-pais` para a coluna.
    expect(feriadoNacionalNoTurno(NO_FERIADO, "America/Sao_Paulo", null)?.hoje).toBe(true);
    expect(feriadoNacionalNoTurno(NO_FERIADO, "America/Sao_Paulo", "")?.hoje).toBe(true);
    expect(feriadoNacionalNoTurno(NO_FERIADO, "America/Sao_Paulo", "BR")?.hoje).toBe(true);
  });
});

describe("lerFeriadoDoTurno — o país vem do banco, e a leitura falha ABERTA", () => {
  /** Dublê de `Queryable`: só a linha de `organizations` interessa aqui. */
  const bancoCom = (pais: string | null) => ({
    query: async () => ({ rows: [{ country: pais }] }),
  });

  it("organização brasileira (coluna nula) recebe o fato", async () => {
    const f = await lerFeriadoDoTurno(
      bancoCom(null) as never,
      "org-1",
      NO_FERIADO,
      "America/Sao_Paulo",
    );

    expect(f?.hoje).toBe(true);
    expect(f?.hojeEm).toBe(FINADOS);
  });

  it("organização de Portugal não recebe feriado brasileiro", async () => {
    const f = await lerFeriadoDoTurno(
      bancoCom("PT") as never,
      "org-2",
      NO_FERIADO,
      "Europe/Lisbon",
    );

    expect(f).toBeNull();
  });

  it("banco indisponível NÃO derruba o turno — o bloco apenas não entra", async () => {
    // O turno não pode virar agente mudo porque uma leitura de configuração
    // falhou; e o `null` é "não sei o país", não "não é feriado".
    const quebrado = {
      query: async () => {
        throw new Error("relation organizations does not exist");
      },
    };
    const avisos: unknown[] = [];
    const log = { warn: (_m: string, campos?: unknown) => avisos.push(campos) };

    await expect(
      lerFeriadoDoTurno(quebrado as never, "org-3", NO_FERIADO, "America/Sao_Paulo", log as never),
    ).resolves.toBeNull();
    // O rastro existe: sem ele, a organização de outro país nunca saberia por
    // que o bloco sumiu.
    expect(avisos).toHaveLength(1);
  });
});

describe("blocoDoFeriado — o texto que entra no prompt", () => {
  it("hoje é feriado: diz o fato, com a data, e manda não prometer o expediente normal", () => {
    const bloco = blocoDoFeriado(feriadoNacionalNoTurno(NO_FERIADO, "America/Sao_Paulo", null));

    expect(bloco).toContain("## Feriado nacional");
    expect(bloco).toContain("Hoje (02/11/2026) é feriado nacional no Brasil");
    expect(bloco).toContain("expediente normal");
  });

  it("amanhã é feriado: o aviso é sobre o dia SEGUINTE, não sobre hoje", () => {
    const bloco = blocoDoFeriado(feriadoNacionalNoTurno(NA_VESPERA, "America/Sao_Paulo", null));

    expect(bloco).toContain("Amanhã (02/11/2026) é feriado nacional no Brasil");
    expect(bloco).not.toContain("Hoje (01/11/2026) é feriado");
  });

  it("hoje e amanhã feriados: um bloco só, e os dois dias nomeados", () => {
    const bloco = blocoDoFeriado({
      hojeEm: FINADOS,
      amanhaEm: "2026-11-03",
      hoje: true,
      amanha: true,
    });

    expect(bloco).toContain("Hoje (02/11/2026) e amanhã (03/11/2026) são feriados nacionais");
  });

  it("país sem feriado brasileiro não rende bloco nenhum", () => {
    expect(blocoDoFeriado(feriadoNacionalNoTurno(NO_FERIADO, "Europe/Lisbon", "PT"))).toBe("");
  });

  it("não cita ferramenta interna — o bloco entra no prompt de todo turno", () => {
    const bloco = blocoDoFeriado(feriadoNacionalNoTurno(NA_VESPERA, "America/Sao_Paulo", null));

    for (const nome of ["update_lead_state", "send_message", "crm_", "business_hours"]) {
      expect(bloco).not.toContain(nome);
    }
  });
});
