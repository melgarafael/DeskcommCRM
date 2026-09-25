import { expect, it } from "vitest";

import { recusaMudancaNaAgendaAlheia } from "@/app/api/v1/agenda/agendamentos/_handler";
import { colegasPodemMexerNaAgendaLigado } from "@/lib/schemas/settings";

/**
 * A MATRIZ DA OPÇÃO "ATENDENTES PODEM MEXER NA AGENDA DOS COLEGAS" (issue #978).
 *
 * `recusaMudancaNaAgendaAlheia` é a régua SEM I/O — a mesma que a mudança
 * (alterar/cancelar) e a criação chamam depois de ler a opção no banco. Fixar a
 * matriz inteira aqui é o que impede a divergência clássica: a mudança recusar e
 * a criação aceitar, ou o contrário.
 *
 * ─── As duas posições da opção ───────────────────────────────────────────────
 *
 *   LIGADA    — o padrão, e o estado de quem já instalou (a chave nem existe no
 *               jsonb): ninguém é recusado por dono. Nada mudou para eles.
 *   DESLIGADA — só o dono mexe, e Gerente/Administrador seguem mexendo em tudo.
 *
 * ─── Os papéis, e o que a decisão diz de cada um ─────────────────────────────
 *
 *   `agent`   recusado quando o compromisso é de outra pessoa.
 *   `viewer`  recusado pelo mesmo motivo (o piso `agent` da rota é outra
 *             camada, e quem o cobra é `requireRole`).
 *   `manager` nunca recusado por esta regra.
 *   `admin`   idem.
 *   IA/token  idem: não são "um atendente" e não têm agenda própria.
 */

const OUTRO = "00000000-0000-4000-8000-0000000000bb";

it("opção LIGADA (o padrão) não recusa ninguém por dono", () => {
  for (const papel of ["viewer", "agent", "manager", "admin"]) {
    expect(
      recusaMudancaNaAgendaAlheia({ type: "user", id: OUTRO, role: papel }, true, false),
      `papel ${papel} com a opção ligada`,
    ).toBe(false);
  }
  for (const actor of [
    { type: "ai_agent", id: "run-1", role: "agent" },
    { type: "api_token", id: "tok-1" },
    { type: "webhook_source", id: "wh-1" },
  ] as const) {
    expect(recusaMudancaNaAgendaAlheia(actor, true, false)).toBe(false);
  }
});

it("opção DESLIGADA: o Atendente só mexe no que é dele", () => {
  const atendente = { type: "user", id: OUTRO, role: "agent" } as const;
  // Compromisso de outra pessoa: recusado.
  expect(recusaMudancaNaAgendaAlheia(atendente, false, false)).toBe(true);
  // Compromisso dele: passa. A regra recorta por dono, não proíbe a própria agenda.
  expect(recusaMudancaNaAgendaAlheia(atendente, false, true)).toBe(false);
});

it("opção DESLIGADA: Gerente e Administrador seguem mexendo em tudo", () => {
  for (const papel of ["manager", "admin"]) {
    const chefe = { type: "user", id: OUTRO, role: papel } as const;
    expect(recusaMudancaNaAgendaAlheia(chefe, false, false), papel).toBe(false);
    expect(recusaMudancaNaAgendaAlheia(chefe, false, true), papel).toBe(false);
  }
});

it("opção DESLIGADA: um papel desconhecido NÃO vira passe livre", () => {
  // `roleAtLeast(null | lixo, "manager")` é falso — um papel que o produto não
  // conhece cai do lado de quem é recusado, nunca do lado de quem manda.
  expect(recusaMudancaNaAgendaAlheia({ type: "user", id: OUTRO }, false, false)).toBe(true);
  expect(recusaMudancaNaAgendaAlheia({ type: "user", id: OUTRO, role: "root" }, false, false)).toBe(
    true,
  );
});

it("opção DESLIGADA: IA e integração não são recortadas por dono (escopo declarado)", () => {
  for (const actor of [
    { type: "ai_agent", id: "run-1", role: "agent" },
    { type: "api_token", id: "tok-1", role: "agent" },
    { type: "webhook_source", id: "wh-1" },
  ] as const) {
    expect(recusaMudancaNaAgendaAlheia(actor, false, false)).toBe(false);
  }
});

it("opção DESLIGADA: compromisso sem dono fica com quem manda", () => {
  // `ehDono` é falso para todo mundo quando `owner_user_id` é nulo: o Atendente
  // não mexe (não é a agenda dele), o Gerente resolve. É o lado conservador da
  // mesma frase, e é o que o banco também faz (`is distinct from auth.uid()`).
  expect(recusaMudancaNaAgendaAlheia({ type: "user", id: OUTRO, role: "agent" }, false, false)).toBe(
    true,
  );
  expect(
    recusaMudancaNaAgendaAlheia({ type: "user", id: OUTRO, role: "manager" }, false, false),
  ).toBe(false);
});

/**
 * A RÉGUA DO TYPESCRIPT É A MESMA DO BANCO.
 *
 * O banco desliga por `(settings->'colegas_podem_mexer_na_agenda') is distinct
 * from 'false'::jsonb`; a tela desliga por esta função. Se as duas divergissem,
 * a tela mostraria ligada uma regra que o banco aplica desligada — ou o
 * contrário, e é pior: o operador desliga, a tela diz "desligado", e o Atendente
 * continua mexendo na agenda dos colegas.
 */
it("a régua da tela: só o `false` booleano explícito desliga", () => {
  expect(colegasPodemMexerNaAgendaLigado({}), "chave ausente = o padrão").toBe(true);
  expect(colegasPodemMexerNaAgendaLigado({ colegas_podem_mexer_na_agenda: true })).toBe(true);
  expect(colegasPodemMexerNaAgendaLigado({ colegas_podem_mexer_na_agenda: false })).toBe(false);
  // Lixo, string e o objeto inteiro torto NÃO desligam: a chave é um booleano, e
  // qualquer outra coisa é "não sei disso" — que vale o padrão, ligado.
  expect(colegasPodemMexerNaAgendaLigado({ colegas_podem_mexer_na_agenda: "false" })).toBe(true);
  expect(colegasPodemMexerNaAgendaLigado({ colegas_podem_mexer_na_agenda: 0 })).toBe(true);
  expect(colegasPodemMexerNaAgendaLigado(null)).toBe(true);
  expect(colegasPodemMexerNaAgendaLigado([])).toBe(true);
  expect(colegasPodemMexerNaAgendaLigado({ crm: { cliente_pela_agenda: true } })).toBe(true);
});

it("a opção não mora em settings.agenda, e é de propósito", () => {
  // `fn_agenda_settings` SUBSTITUI `settings.agenda` inteiro e recusa chave que
  // não conheça: uma chave nossa ali seria recusada por ele e apagada na
  // primeira vez que um Gerente salvasse os prazos. `settings.agenda` ligado não
  // pode, portanto, mexer nesta regra.
  expect(colegasPodemMexerNaAgendaLigado({ agenda: { atraso_de_confirmacao: 10 } })).toBe(true);
  expect(
    colegasPodemMexerNaAgendaLigado({
      agenda: { atraso_de_confirmacao: 10 },
      colegas_podem_mexer_na_agenda: false,
    }),
  ).toBe(false);
});
