/**
 * O compromisso marcado pela TELA leva quem vai ser atendido.
 *
 * `NovoAgendamento.contact_id` existe desde que o hook nasceu, a rota o resolve
 * contra a organização, a listagem já lê `contacts(name)` para exibir — e
 * `crm_book_appointment` chega a EXIGI-LO ("quem vai ser atendido"). Só a tela
 * não perguntava, e o resultado era o inverso do esperado: a IA marcava com
 * pessoa vinculada e o humano marcava órfão.
 *
 * Compromisso órfão não é só feio na lista: ele fica fora do alcance de
 * qualquer lembrete, porque o lembrete sai para `contact_id`.
 *
 * ⚠️ CERCA, NÃO PROVA. O que provaria de verdade é estender
 * `tests/e2e/agenda-marcar-pela-tela.spec.ts` — escolher um contato, marcar, e
 * conferir que a linha nasceu com ele. Está declarado como pendência no PR:
 * quem escreveu isto não tinha como rodar a suíte E2E, e spec não-executada
 * gasta o CI de quem revisa.
 *
 * O que esta cerca pega é a regressão pela qual o defeito voltaria: alguém
 * simplificar a chamada e o campo sumir de novo, em silêncio.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TELA = readFileSync(
  join(__dirname, "..", "..", "app", "app", "agenda", "_client.tsx"),
  "utf8",
);

const HOOK = readFileSync(
  join(__dirname, "..", "..", "hooks", "agenda", "useMarcarAgendamento.ts"),
  "utf8",
);

describe("marcar pela tela leva o contato", () => {
  it("o contrato do hook aceita contact_id", () => {
    expect(HOOK).toMatch(/contact_id\?:\s*string/);
  });

  it("a chamada de marcar manda contact_id", () => {
    // `event_type_id: tipo.id` aparece DUAS vezes — a primeira é a consulta de
    // horários livres. A âncora tem de ser o que só a marcação tem.
    const i = TELA.indexOf("starts_at: instante,");
    expect(i, "não achei a chamada de marcar").toBeGreaterThan(-1);
    expect(TELA.slice(i, i + 400)).toContain("contact_id");
  });

  it("a tela oferece como escolher o contato", () => {
    expect(TELA).toContain("ContactPickerDialog");
    expect(TELA).toContain('data-testid="escolher-contato"');
  });

  it("reusa o seletor do inbox em vez de um segundo", () => {
    // Um seletor próprio seria uma segunda régua de como se escreve o nome de um
    // contato — e no dia em que discordassem, a mesma pessoa apareceria de dois
    // jeitos em duas telas.
    expect(TELA).toContain("@/components/inbox/composer/ContactPickerDialog");
  });

  it("o contato é OPCIONAL, e a tela diz o que se perde sem ele", () => {
    // Bloqueio interno da equipe não tem paciente do outro lado; obrigar um
    // contato aqui inventaria um. Mas quem marcar sem precisa saber que ninguém
    // será lembrado.
    expect(TELA).toContain("Opcional");
    expect(TELA).toMatch(/lembrete/i);
  });

  it("não gruda o contato no próximo agendamento", () => {
    // Depois de marcar, o estado volta a nulo: herdar a pessoa do compromisso
    // anterior em silêncio marcaria o paciente errado.
    const depoisDeMarcar = TELA.slice(TELA.indexOf("contact_id: contato?.contactId"));
    expect(depoisDeMarcar.slice(0, 500)).toContain("setContato(null)");
  });
});
