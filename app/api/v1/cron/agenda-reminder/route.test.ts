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

import { degrausPendentes, estaNaHora, montarLembrete } from "./route";

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

  it("molde próprio interpola nome, dia e hora, e deixa chave desconhecida no texto", () => {
    const texto = montarLembrete({
      nomeDoContato: "Ian Couto",
      titulo: "Atendimento",
      quando,
      timezone: "America/Sao_Paulo",
      local: "Sala 2",
      molde: "Oi {{primeiro_nome}}! {{titulo}} {{dia}} às {{hora}} em {{endereco}}. {{foo}}",
      tipoNome: "Consulta",
    });
    expect(texto).toBe("Oi Ian! Atendimento segunda-feira, 31/08 às 09:45 em Sala 2. {{foo}}");
  });

  it("molde em branco cai na frase padrão", () => {
    const comMolde = montarLembrete({
      nomeDoContato: "Ana",
      titulo: "Retirada",
      quando,
      timezone: "America/Sao_Paulo",
      local: null,
      molde: "   ",
    });
    const semMolde = montarLembrete({
      nomeDoContato: "Ana",
      titulo: "Retirada",
      quando,
      timezone: "America/Sao_Paulo",
      local: null,
    });
    expect(comMolde).toBe(semMolde);
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

describe("degrausPendentes — o lembrete que tem mais de um degrau", () => {
  const comeca = new Date("2026-09-20T14:00:00.000Z");
  const base = { comeca, principal: 1440, extras: [180], jaEnviados: null as number[] | null };

  it("dois dias antes não deve nada — nem o degrau mais antecipado venceu", () => {
    expect(degrausPendentes({ ...base, agora: new Date("2026-09-18T14:00:00.000Z") })).toEqual([]);
  });

  it("um dia antes deve só o degrau de um dia", () => {
    expect(degrausPendentes({ ...base, agora: new Date("2026-09-19T15:00:00.000Z") })).toEqual([1440]);
  });

  it("três horas antes, com o de um dia já enviado, deve o de três horas", () => {
    expect(
      degrausPendentes({ ...base, agora: new Date("2026-09-20T11:30:00.000Z"), jaEnviados: [1440] }),
    ).toEqual([180]);
  });

  it("com os dois já enviados não deve nada — é o que impede a mensagem repetida", () => {
    expect(
      degrausPendentes({ ...base, agora: new Date("2026-09-20T13:00:00.000Z"), jaEnviados: [1440, 180] }),
    ).toEqual([]);
  });

  it("cron parado: dois degraus vencidos saem JUNTOS, para virarem uma mensagem só", () => {
    // Quem chama manda um texto e carimba os dois. Se esta função devolvesse um
    // por rodada, a pessoa receberia o mesmo aviso duas vezes seguidas.
    expect(degrausPendentes({ ...base, agora: new Date("2026-09-20T13:00:00.000Z") })).toEqual([1440, 180]);
  });

  it("depois de começar não deve nada — lembrete atrasado não é lembrete", () => {
    expect(degrausPendentes({ ...base, agora: new Date("2026-09-20T14:00:00.000Z") })).toEqual([]);
  });

  it("sem extras se comporta exatamente como antes", () => {
    const so = { ...base, extras: null };
    expect(degrausPendentes({ ...so, agora: new Date("2026-09-19T15:00:00.000Z") })).toEqual([1440]);
    expect(degrausPendentes({ ...so, agora: new Date("2026-09-19T15:00:00.000Z"), jaEnviados: [1440] })).toEqual([]);
  });

  it("extra igual ao principal não duplica o aviso", () => {
    expect(
      degrausPendentes({ ...base, extras: [1440], agora: new Date("2026-09-19T15:00:00.000Z") }),
    ).toEqual([1440]);
  });
});

describe("o cron NÃO pode filtrar por reminder_sent_at", () => {
  it("o filtro antigo não voltou — com ele o segundo degrau nunca sairia", () => {
    // Guarda estrutural: este filtro passou a ser errado quando o lembrete ganhou
    // degraus, e o erro não daria sinal nenhum — o compromisso simplesmente não
    // receberia o segundo aviso, em silêncio.
    //
    // Os comentários saem antes: o texto que EXPLICA o filtro é o mais parecido
    // com o filtro, e é ele que faria a asserção passar com o código removido.
    const fonte = readFileSync(join(__dirname, "route.ts"), "utf8").replace(/--[^\n]*|\/\/[^\n]*/g, "");
    expect(fonte).not.toMatch(/\.is\(\s*["']reminder_sent_at["']/);
    expect(fonte).toMatch(/reminder_sent_offsets_minutes/);
  });

  it("lê o texto POR degrau — senão extra sai com a frase do principal", () => {
    const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(fonte).toMatch(/reminder_bodies/);
    expect(fonte).toMatch(/moldeDoDegrau/);
  });
});

describe("a rota lê a régua da remarcação (#2230)", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");

  it("seleciona starts_at_marked_at — sem a coluna na consulta não há por onde saber que a data mudou", () => {
    // Estrutural, como as de cima: o que a rota PEDE ao banco é propriedade do
    // texto, e um dublê de Supabase provaria o dublê. Sem a coluna no SELECT,
    // `linha.starts_at_marked_at` seria `undefined` e a régua voltaria a ser
    // `created_at` sem erro nenhum — o defeito nasceria calado.
    const consulta = fonte.slice(fonte.indexOf(".select("), fonte.indexOf('.eq("status"'));
    expect(consulta).toContain("starts_at_marked_at");
  });

  it("repassa os dois instantes para degrausPendentes e deixa a função decidir", () => {
    expect(fonte).toContain("remarcadoEm: linha.starts_at_marked_at");
    expect(fonte).toContain("criadoEm: linha.created_at");
    // A precedência mora na função, não na rota: `remarcadoEm` sabe do
    // movimento e `criadoEm` é o fallback da linha nunca remarcada.
    expect(fonte).toContain("input.remarcadoEm ?? input.criadoEm");
  });
});

describe("a rota repassa o instante do último carimbo (#2243)", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");

  it("seleciona reminder_sent_at — a lista diz QUAIS degraus saíram, mas não QUANDO", () => {
    // Estrutural, como as acima: sem a coluna na consulta `linha.reminder_sent_at`
    // seria `undefined`, a limpeza ficaria fora do caminho em toda instalação e
    // o rearma nasceria calado — o defeito da #2243 voltaria sem erro nenhum.
    const consulta = fonte.slice(fonte.indexOf(".select("), fonte.indexOf('.eq("status"'));
    expect(consulta).toContain("reminder_sent_at");
  });

  it("repassa enviadoEm e deixa a limpeza morar na regra, não na rota", () => {
    expect(fonte).toContain("enviadoEm: linha.reminder_sent_at");
    expect(fonte).toContain("input.enviadoEm");
    // E o filtro de recebimento continua sendo a LISTA — `reminder_sent_at`
    // não volta a ser critério de quem recebe (a 0254 proíbe, prende o teste
    // "o cron NÃO pode filtrar por reminder_sent_at").
    expect(fonte).not.toMatch(/\.is\(\s*["']reminder_sent_at["']/);
  });
});

describe("degrausPendentes — a véspera não sai no dia em que a reunião foi marcada", () => {
  // Amanhã 14h em São Paulo (17h UTC); avisos de 1 dia e de 1 hora.
  const comeca = new Date("2026-10-06T17:00:00.000Z");
  const base = { comeca, principal: 1440, extras: [60], jaEnviados: null as number[] | null, timezone: "America/Sao_Paulo" };

  it("marcou hoje às 9h para amanhã às 14h: a véspera de hoje às 14h não sai", () => {
    const criadoEm = new Date("2026-10-05T12:00:00.000Z");
    expect(degrausPendentes({ ...base, criadoEm, agora: new Date("2026-10-05T17:00:00.000Z") })).toEqual([]);
  });

  it("o aviso de 1 hora continua saindo amanhã", () => {
    const criadoEm = new Date("2026-10-05T12:00:00.000Z");
    expect(degrausPendentes({ ...base, criadoEm, agora: new Date("2026-10-06T16:00:00.000Z") })).toEqual([60]);
  });

  it("marcou ontem para amanhã: a véspera sai normalmente hoje", () => {
    const criadoEm = new Date("2026-10-04T12:00:00.000Z");
    expect(degrausPendentes({ ...base, criadoEm, agora: new Date("2026-10-05T17:00:00.000Z") })).toEqual([1440]);
  });

  it("o dia é o do fuso da organização, não o UTC", () => {
    // 22h de SP já é o dia seguinte em UTC; para SP a véspera (dia 5, 14h) é o mesmo dia.
    const criadoEm = new Date("2026-10-05T01:00:00.000Z"); // dia 4, 22h em SP
    expect(degrausPendentes({ ...base, criadoEm, agora: new Date("2026-10-05T17:00:00.000Z") })).toEqual([1440]);
  });

  it("aviso curto no dia da marcação não é afetado", () => {
    // Marcou hoje às 10h para hoje às 18h: o aviso das 17h sai.
    const hoje18 = new Date("2026-10-05T21:00:00.000Z");
    expect(
      degrausPendentes({ ...base, comeca: hoje18, criadoEm: new Date("2026-10-05T13:00:00.000Z"), agora: new Date("2026-10-05T20:00:00.000Z") }),
    ).toEqual([60]);
  });

  it("sem fuso a guarda fica fora do caminho", () => {
    const criadoEm = new Date("2026-10-05T12:00:00.000Z");
    expect(degrausPendentes({ ...base, timezone: null, criadoEm, agora: new Date("2026-10-05T17:00:00.000Z") })).toEqual([1440]);
  });
});

describe("vesperaNoDiaDaMarcacao — fuso ilegível não derruba a rodada", () => {
  it("fuso inválido devolve false em vez de lançar (o cron é de todas as organizações)", async () => {
    const { vesperaNoDiaDaMarcacao } = await import("./route");
    const marcadoEm = new Date("2026-10-05T12:00:00Z");
    const comeca = new Date("2026-10-06T17:00:00Z");
    expect(() => vesperaNoDiaDaMarcacao(comeca, 1440, marcadoEm, "Brasilia")).not.toThrow();
    expect(vesperaNoDiaDaMarcacao(comeca, 1440, marcadoEm, "Brasilia")).toBe(false);
  });
});
