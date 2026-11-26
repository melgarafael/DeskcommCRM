import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  TETO_DE_LEMBRETES_EXTRAS,
  deMinutos,
  desempacotarLembretes,
  empacotarLembretes,
  lerDegrausSemLink,
  lerPassosDoFormulario,
  levaOLinkNoLembrete,
  minutosLivres,
  moldeDoDegrau,
  paraMinutos,
} from "./lembretes";

describe("empacotarLembretes", () => {
  it("o mais antecipado vira principal; o resto, extra com texto próprio", () => {
    const r = empacotarLembretes([
      { minutes: 180, body: "Falta pouco", comLink: true },
      { minutes: 1440, body: "Amanhã tem", comLink: true },
    ]);
    expect(r.principal).toBe(1440);
    expect(r.corpoPrincipal).toBe("Amanhã tem");
    expect(r.extras).toEqual([180]);
    expect(r.corposExtras).toEqual({ "180": "Falta pouco" });
    expect(r.degrausSemLink).toEqual([]);
  });

  it("extra sem texto não entra no mapa — cai na frase de fábrica, não na do principal", () => {
    const r = empacotarLembretes([
      { minutes: 1440, body: "Amanhã tem", comLink: true },
      { minutes: 180, body: "   ", comLink: true },
    ]);
    expect(r.corposExtras).toEqual({});
    expect(r.degrausSemLink).toEqual([]);
  });

  it("duplicata no mesmo minuto não vira aviso em dobro", () => {
    const r = empacotarLembretes([
      { minutes: 180, body: "a", comLink: true },
      { minutes: 180, body: "b", comLink: true },
    ]);
    expect(r.principal).toBe(180);
    expect(r.extras).toEqual([]);
    expect(r.corpoPrincipal).toBe("a");
  });

  it("fora da faixa some, e lista vazia cai no default do banco", () => {
    const r = empacotarLembretes([
      { minutes: 5, body: "cedo demais", comLink: true },
      { minutes: 20_000, body: "convite", comLink: true },
    ]);
    expect(r.principal).toBe(1440);
    expect(r.extras).toEqual([]);
    expect(r.corpoPrincipal).toBe("");
  });

  it("o degrau com o link desligado entra na lista de degraus sem link", () => {
    const r = empacotarLembretes([
      { minutes: 1440, body: "Amanhã tem", comLink: true },
      { minutes: 180, body: "Falta pouco", comLink: false },
      { minutes: 60, body: "Tô chegando", comLink: true },
    ]);
    expect(r.degrausSemLink).toEqual([180]);
    expect(r.corposExtras).toEqual({ "180": "Falta pouco", "60": "Tô chegando" });
  });
});

describe("desempacotarLembretes", () => {
  it("monta a lista que a tela edita, principal + extras com texto próprio", () => {
    expect(
      desempacotarLembretes({
        reminder_minutes_before: 1440,
        reminder_extra_offsets_minutes: [180, 60],
        reminder_body: "Amanhã",
        reminder_bodies: { "180": "Falta pouco" },
      }),
    ).toEqual([
      { minutes: 1440, body: "Amanhã", comLink: true },
      { minutes: 180, body: "Falta pouco", comLink: true },
      { minutes: 60, body: "", comLink: true },
    ]);
  });

  it("o degrau marcado sem link volta desmarcado; os outros voltam ligados", () => {
    expect(
      desempacotarLembretes({
        reminder_minutes_before: 1440,
        reminder_extra_offsets_minutes: [180, 60],
        reminder_body: "Amanhã",
        reminder_bodies: { "180": "Falta pouco" },
        reminder_sem_link_offsets_minutes: [180],
      }).map((p) => p.comLink),
    ).toEqual([true, false, true]);
  });

  it("coluna ausente ou vazia = todas as faixas levam o link", () => {
    const semAColuna = desempacotarLembretes({
      reminder_minutes_before: 60,
      reminder_extra_offsets_minutes: [15],
      reminder_body: null,
      reminder_bodies: null,
    });
    expect(semAColuna.map((p) => p.comLink)).toEqual([true, true]);
  });
});

describe("levaOLinkNoLembrete", () => {
  it("mensagem que cobre dois degraus leva o link se ALGUM deles levar", () => {
    // Marcação em cima da hora: principal e extra vencem juntos e viram UMA
    // mensagem. O degrau desligado não pode tirar o link do degrau ligado.
    expect(levaOLinkNoLembrete({ reminder_sem_link_offsets_minutes: [1440] }, [1440, 180])).toBe(true);
    expect(levaOLinkNoLembrete({ reminder_sem_link_offsets_minutes: [180] }, [1440, 180])).toBe(true);
    expect(levaOLinkNoLembrete({ reminder_sem_link_offsets_minutes: [1440, 180] }, [1440, 180])).toBe(false);
  });

  it("sem a coluna (ou vazia) todos levam — é o comportamento de sempre", () => {
    expect(levaOLinkNoLembrete({}, [1440])).toBe(true);
    expect(levaOLinkNoLembrete({ reminder_sem_link_offsets_minutes: [] }, [60])).toBe(true);
  });
});

describe("lerDegrausSemLink", () => {
  it("descarta lixo em vez de calar o envio: o modo de falha é mandar o link a mais", () => {
    expect(lerDegrausSemLink(["60", null, 5, 20_000, 60.5, 60, 60])).toEqual([60]);
    expect(lerDegrausSemLink(null)).toEqual([]);
    expect(lerDegrausSemLink({ "60": true })).toEqual([]);
  });
});

describe("moldeDoDegrau", () => {
  const tipo = {
    reminder_minutes_before: 1440,
    reminder_body: "Amanhã tem",
    reminder_bodies: { "180": "Falta pouco, {{nome}}" },
  };

  it("extra usa o próprio texto", () => {
    expect(moldeDoDegrau(tipo, 180)).toBe("Falta pouco, {{nome}}");
  });

  it("principal usa reminder_body", () => {
    expect(moldeDoDegrau(tipo, 1440)).toBe("Amanhã tem");
  });

  it("extra sem texto NÃO herda o do principal", () => {
    expect(moldeDoDegrau(tipo, 60)).toBeNull();
  });
});

describe("unidade de antecedência", () => {
  it("1440 min é 1 dia; 180 min é 3 horas", () => {
    expect(deMinutos(1440)).toEqual({ quantidade: 1, unidade: "dias" });
    expect(deMinutos(180)).toEqual({ quantidade: 3, unidade: "horas" });
    expect(deMinutos(45)).toEqual({ quantidade: 45, unidade: "minutos" });
    expect(paraMinutos(1, "dias")).toBe(1440);
    expect(paraMinutos(3, "horas")).toBe(180);
  });
});

describe("minutosLivres", () => {
  it("não sugere um horário que já está na lista", () => {
    expect(minutosLivres([1440, 180])).toBe(60);
  });
});

describe("lerPassosDoFormulario", () => {
  it("JSON da tela vira passos; lixo vira vazio", () => {
    expect(lerPassosDoFormulario('[{"minutes":60,"body":"oi"}]')).toEqual([
      { minutes: 60, body: "oi", comLink: true },
    ]);
    expect(
      lerPassosDoFormulario('[{"minutes":60,"body":"oi","comLink":false}]'),
    ).toEqual([{ minutes: 60, body: "oi", comLink: false }]);
    expect(lerPassosDoFormulario("não é json")).toEqual([]);
    expect(lerPassosDoFormulario(null)).toEqual([]);
  });
});

describe("o teto do TypeScript é o teto do CHECK", () => {
  it("a constante e a função do banco dizem o mesmo número", () => {
    // Se alguém subir o teto num lado só, o PATCH aceita o que o CHECK recusa
    // (500) ou o CHECK aceita o que a rota recusa — as duas mentiras.
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/20260919151100_0329_mensagem_por_lembrete.sql"),
      "utf8",
    );
    expect(sql).toContain(`<= ${TETO_DE_LEMBRETES_EXTRAS}`);
    expect(TETO_DE_LEMBRETES_EXTRAS).toBe(20);
  });
});
