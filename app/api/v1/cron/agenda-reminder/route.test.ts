/**
 * O lembrete só é útil se acertar a HORA e não vazar entre organizações.
 *
 * As duas regras são testadas de formas diferentes de propósito:
 *
 * - `estaNaHora` e `montarLembrete` são puras, então o teste as exercita de
 *   verdade, inclusive nas bordas (cedo demais, tarde demais, exatamente na
 *   hora) — que é onde um lembrete deixa de ser lembrete.
 *
 * - O isolamento entre organizações é ESTRUTURAL: ele não vive numa função, vive
 *   no encadeamento da consulta. Montar um dublê de Supabase para provar isso
 *   testaria o dublê. O que prende é ler a fonte e cobrar o filtro — o mesmo
 *   estilo de `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`, que varre o
 *   AST das rotas deste diretório.
 *
 * O medo é explícito no código que criou a coluna
 * (`app/api/v1/agenda/agendamentos/_handler.ts`): "no dia em que o worker de
 * lembrete nascer, esta linha vira a organização A mandando WhatsApp para o
 * cliente da B". Este é o dia, e esta é a cerca.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { estaNaHora, montarLembrete } from "./route";

const MIN = 60_000;

describe("estaNaHora", () => {
  const agora = new Date("2026-08-31T12:00:00Z");

  it("não avisa cedo demais", () => {
    // compromisso em 3h, antecedência de 60 min: ainda não.
    const comeca = new Date(agora.getTime() + 180 * MIN);
    expect(estaNaHora(agora, comeca, 60)).toBe(false);
  });

  it("avisa quando a antecedência é alcançada", () => {
    const comeca = new Date(agora.getTime() + 59 * MIN);
    expect(estaNaHora(agora, comeca, 60)).toBe(true);
  });

  it("avisa no instante exato da fronteira", () => {
    const comeca = new Date(agora.getTime() + 60 * MIN);
    expect(estaNaHora(agora, comeca, 60)).toBe(true);
  });

  it("NÃO avisa compromisso que já começou", () => {
    // Lembrar às 15h de uma retirada das 14h não é lembrete, é ruído.
    const comeca = new Date(agora.getTime() - 1 * MIN);
    expect(estaNaHora(agora, comeca, 1440)).toBe(false);
  });

  it("NÃO avisa compromisso que começa exatamente agora", () => {
    expect(estaNaHora(agora, new Date(agora.getTime()), 1440)).toBe(false);
  });

  it("antecedência longa não antecipa o que ainda está longe", () => {
    // 30 dias de antecedência (o teto da coluna) com compromisso em 31 dias.
    const comeca = new Date(agora.getTime() + 31 * 24 * 60 * MIN);
    expect(estaNaHora(agora, comeca, 43_200)).toBe(false);
  });
});

describe("montarLembrete", () => {
  const quando = new Date("2026-08-31T12:45:00Z"); // 09:45 em São Paulo

  it("diz o quê, quando e onde", () => {
    const texto = montarLembrete({
      nomeDoContato: "Rose",
      titulo: "Retirada de manipulado — Poços de Caldas",
      quando,
      timezone: "America/Sao_Paulo",
      local: "R. Ceará, 300 — Centro",
    });

    expect(texto).toContain("Rose");
    expect(texto).toContain("Retirada de manipulado — Poços de Caldas");
    expect(texto).toContain("09:45");
    expect(texto).toContain("R. Ceará, 300 — Centro");
  });

  it("respeita o fuso da organização", () => {
    const emManaus = montarLembrete({
      nomeDoContato: null,
      titulo: "Retirada",
      quando,
      timezone: "America/Manaus", // uma hora atrás de São Paulo
      local: null,
    });
    expect(emManaus).toContain("08:45");
    expect(emManaus).not.toContain("09:45");
  });

  it("sem nome, cumprimenta sem inventar", () => {
    const texto = montarLembrete({
      nomeDoContato: null,
      titulo: "Retirada",
      quando,
      timezone: "America/Sao_Paulo",
      local: null,
    });
    expect(texto.startsWith("Oi!")).toBe(true);
    expect(texto).not.toContain("null");
    expect(texto).not.toContain("undefined");
  });

  it("sem endereço, não promete um", () => {
    const texto = montarLembrete({
      nomeDoContato: "Ana",
      titulo: "Retirada",
      quando,
      timezone: "America/Sao_Paulo",
      local: null,
    });
    expect(texto).not.toContain("Endereço");
  });
});

describe("isolamento entre organizações (estrutural)", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");

  it("resolve o contato DENTRO da organização do compromisso", () => {
    // O trecho tem de conter a busca em `contacts` filtrada por organization_id.
    // Sem isso, um contact_id de outra organização viraria WhatsApp enviado ao
    // cliente dela — o defeito que o handler de agendamentos antecipa.
    const buscaDeContato = fonte.slice(fonte.indexOf('.from("contacts")'));
    expect(fonte).toContain('.from("contacts")');
    expect(buscaDeContato.slice(0, 400)).toContain('.eq("organization_id", org)');
  });

  it("resolve o canal DENTRO da organização do compromisso", () => {
    const buscaDeCanal = fonte.slice(fonte.indexOf('.from("channel_sessions")'));
    expect(fonte).toContain('.from("channel_sessions")');
    expect(buscaDeCanal.slice(0, 400)).toContain('.eq("organization_id", org)');
  });

  it("carimba o compromisso DENTRO da organização dele", () => {
    const carimbo = fonte.slice(fonte.indexOf("reminder_sent_at: new Date()"));
    expect(carimbo.slice(0, 400)).toContain('.eq("organization_id", org)');
  });

  it("a organização vem da linha do compromisso, nunca de parâmetro", () => {
    expect(fonte).toContain("const org = linha.organization_id");
    // controle: se alguém trocar por leitura de query string, isto reprova.
    expect(fonte).not.toContain("searchParams.get(\"organization_id\")");
  });
});
