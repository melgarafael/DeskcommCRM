/**
 * O TEXTO do aviso de agendamento e do resumo das 7h — o que chega ao celular
 * do dono. Cada caso mede uma linha do pedido: primeiro nome só, serviço, dia e
 * hora NO FUSO DA EMPRESA, profissional, origem, resumo em ordem com total, e
 * nenhuma marca fixa.
 */
import { describe, expect, it } from "vitest";

import {
  diaEHora,
  montarAvisoDeAgendamento,
  montarResumoDoDia,
  montarTesteDoAvisoDeAgendamento,
  origemDoAutor,
} from "./texto-do-aviso-de-agendamento";

const BASE = {
  marca: "Clínica Sol",
  idioma: "pt-BR" as const,
  cliente: "Maria Souza Pereira",
  servico: "Limpeza de pele",
  // 13:30 UTC — 10:30 em São Paulo, 09:30 em Manaus.
  inicio: new Date("2026-10-23T13:30:00.000Z"),
  fuso: "America/Sao_Paulo",
  profissional: "Ana Lima",
};

describe("montarAvisoDeAgendamento", () => {
  it("traz primeiro nome, serviço, dia e hora local, profissional e origem", () => {
    const texto = montarAvisoDeAgendamento({ ...BASE, evento: "appointment.created", origem: "ai" });
    expect(texto.split("\n")[0]).toBe("📅 Clínica Sol: novo agendamento");
    expect(texto).toContain("Cliente: Maria");
    expect(texto).not.toMatch(/Souza|Pereira/);
    expect(texto).toContain("Serviço: Limpeza de pele");
    expect(texto).toMatch(/Quando: .*23\/10.*10:30/);
    expect(texto).toContain("Profissional: Ana");
    expect(texto).not.toContain("Lima");
    expect(texto).toContain("Origem: IA");
  });

  it("a hora é a do fuso da EMPRESA, não a do servidor", () => {
    const texto = montarAvisoDeAgendamento({
      ...BASE,
      fuso: "America/Manaus",
      evento: "appointment.created",
      origem: "user",
    });
    expect(texto).toContain("09:30");
    expect(texto).toContain("Origem: Equipe");
  });

  it("remarcado e cancelado têm título e ícone próprios", () => {
    expect(montarAvisoDeAgendamento({ ...BASE, evento: "appointment.rescheduled", origem: "google" })).toMatch(
      /^🔁 Clínica Sol: agendamento remarcado[\s\S]*Origem: Google Agenda/,
    );
    expect(montarAvisoDeAgendamento({ ...BASE, evento: "appointment.cancelled", origem: "user" })).toMatch(
      /^❌ Clínica Sol: agendamento cancelado/,
    );
  });

  it("sem cliente, serviço ou profissional, as linhas somem — a hora e a origem ficam", () => {
    const texto = montarAvisoDeAgendamento({
      ...BASE,
      cliente: null,
      servico: "   ",
      profissional: null,
      evento: "appointment.created",
      origem: "system",
    });
    expect(texto).not.toContain("Cliente:");
    expect(texto).not.toContain("Serviço:");
    expect(texto).not.toContain("Profissional:");
    expect(texto).toContain("Quando:");
    expect(texto).toContain("Origem: Sistema");
  });

  it("a marca é a que veio do chamador — nenhuma fixa", () => {
    const texto = montarAvisoDeAgendamento({ ...BASE, marca: "Studio X", evento: "appointment.created", origem: "ai" });
    expect(texto.startsWith("📅 Studio X:")).toBe(true);
  });

  it("em espanhol, os rótulos são traduzidos", () => {
    const texto = montarAvisoDeAgendamento({ ...BASE, idioma: "es", evento: "appointment.created", origem: "ai" });
    expect(texto).toContain("nueva cita");
    expect(texto).toContain("Profesional: Ana");
  });

  it("fuso inválido não derruba o aviso: cai para UTC", () => {
    expect(diaEHora(BASE.inicio, "Fuso/Inexistente", "pt-BR")).toContain("13:30");
  });
});

describe("origemDoAutor", () => {
  it("reconhece as cinco origens e trata o resto como sistema", () => {
    expect(origemDoAutor("ai")).toBe("ai");
    expect(origemDoAutor("user")).toBe("user");
    expect(origemDoAutor("google")).toBe("google");
    expect(origemDoAutor("contact")).toBe("contact");
    expect(origemDoAutor("sync")).toBe("system");
    expect(origemDoAutor(undefined)).toBe("system");
  });
});

describe("montarResumoDoDia", () => {
  it("lista em ordem de horário, com o total, e as mudanças da noite", () => {
    const texto = montarResumoDoDia({
      marca: "Clínica Sol",
      idioma: "pt-BR",
      fuso: "America/Sao_Paulo",
      dia: new Date("2026-10-23T10:10:00.000Z"),
      agenda: [
        { inicio: new Date("2026-10-23T17:00:00.000Z"), cliente: "João Silva", servico: "Retorno", profissional: null },
        { inicio: new Date("2026-10-23T12:00:00.000Z"), cliente: "Maria Souza", servico: "Limpeza", profissional: "Ana Lima" },
      ],
      daNoite: [{ evento: "appointment.created", inicio: new Date("2026-10-24T12:00:00.000Z"), cliente: "Pedro Alves" }],
    });
    const linhas = texto.split("\n");
    expect(linhas[0]).toMatch(/^☀️ Clínica Sol: agenda de hoje \(.*23\/10\)$/);
    const nove = linhas.findIndex((l) => l.startsWith("09:00"));
    const quatorze = linhas.findIndex((l) => l.startsWith("14:00"));
    expect(nove).toBeGreaterThan(0);
    expect(quatorze).toBeGreaterThan(nove);
    expect(linhas[nove]).toBe("09:00 · Maria · Limpeza · com Ana");
    expect(linhas[quatorze]).toBe("14:00 · João · Retorno");
    expect(texto).toContain("Total: 2");
    expect(texto).toContain("Durante a noite (22h às 7h):");
    expect(texto).toMatch(/• novo agendamento · .* · Pedro/);
  });

  it("dia vazio diz que não há agendamento, com total zero", () => {
    const texto = montarResumoDoDia({
      marca: "Clínica Sol",
      idioma: "pt-BR",
      fuso: "America/Sao_Paulo",
      dia: new Date("2026-10-23T10:10:00.000Z"),
      agenda: [],
      daNoite: [],
    });
    expect(texto).toContain("Nenhum agendamento para hoje.");
    expect(texto).toContain("Total: 0");
    expect(texto).not.toContain("Durante a noite");
  });
});

describe("montarTesteDoAvisoDeAgendamento", () => {
  it("diz que é um teste e o que vai chegar", () => {
    const texto = montarTesteDoAvisoDeAgendamento({ marca: "Clínica Sol", idioma: "pt-BR" });
    expect(texto).toContain("Clínica Sol: teste do aviso de agendamento");
    expect(texto).toContain("Às 7h chega o resumo do dia.");
  });
});
