import { describe, expect, it } from "vitest";

import {
  MAXIMO_DE_CONVIDADOS_DA_EQUIPE,
  equipeParaSalvar,
  estaNaAgendaDe,
  normalizarConvidadosDaEquipe,
} from "./convidados-da-equipe";

const ANA = "11111111-1111-4111-8111-111111111111";
const BRUNO = "22222222-2222-4222-8222-222222222222";
const CAIO = "33333333-3333-4333-8333-333333333333";

/**
 * EDITAR A EQUIPE DE UM COMPROMISSO QUE JÁ EXISTE (#4006).
 *
 * O PATCH distingue campo AUSENTE (não mexe) de `[]` (tira todo mundo). A tela
 * de remarcação, porém, já vai mandar `starts_at` e `guest_email` em todo
 * salvamento — se a equipe fosse junto por omissão, remarcar um compromisso
 * desconvidaria a equipe inteira, e o defeito seria mudo: o PATCH responde 200.
 *
 * Daí `equipeParaSalvar`: a lista só entra no corpo quando o conjunto MUDOU.
 * Compara como conjunto (a ordem dos chips não é a informação), devolve `[]`
 * quando a pessoa tirou todo mundo — que é edição legítima, não campo vazio.
 */
describe("equipeParaSalvar", () => {
  it("não manda nada quando ninguém foi mexido", () => {
    expect(equipeParaSalvar([ANA, BRUNO], [ANA, BRUNO])).toBeUndefined();
  });

  it("não manda nada quando a ordem mudou mas o conjunto é o mesmo", () => {
    expect(equipeParaSalvar([ANA, BRUNO], [BRUNO, ANA])).toBeUndefined();
  });

  it("manda a lista nova quando alguém entrou", () => {
    expect(equipeParaSalvar([ANA], [ANA, BRUNO])).toEqual([ANA, BRUNO]);
  });

  it("manda a lista nova quando alguém saiu", () => {
    expect(equipeParaSalvar([ANA, BRUNO], [ANA])).toEqual([ANA]);
  });

  it("manda lista vazia quando a pessoa tirou todo mundo", () => {
    expect(equipeParaSalvar([ANA, BRUNO], [])).toEqual([]);
  });

  it("trata ausente e vazio como o mesmo ponto de partida", () => {
    expect(equipeParaSalvar(undefined, [])).toBeUndefined();
    expect(equipeParaSalvar(null, [ANA])).toEqual([ANA]);
  });

  it("ignora id inválido de um lado só, sem inventar diferença", () => {
    expect(equipeParaSalvar([ANA, "lixo"], [ANA])).toBeUndefined();
  });

  it("respeita o teto da mesma régua do schema", () => {
    const muitos = Array.from(
      { length: MAXIMO_DE_CONVIDADOS_DA_EQUIPE + 5 },
      (_, i) => `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
    );
    expect(equipeParaSalvar([], muitos)).toHaveLength(MAXIMO_DE_CONVIDADOS_DA_EQUIPE);
  });
});

describe("as réguas que já existiam continuam valendo", () => {
  it("deduplica e derruba id que não é uuid", () => {
    expect(normalizarConvidadosDaEquipe([ANA, ANA, "x", BRUNO])).toEqual([ANA, BRUNO]);
  });

  it("a agenda da pessoa inclui o compromisso em que ela é convidada", () => {
    expect(estaNaAgendaDe({ responsavelId: CAIO, convidadosDaEquipe: [ANA] }, ANA)).toBe(true);
    expect(estaNaAgendaDe({ responsavelId: CAIO, convidadosDaEquipe: [ANA] }, BRUNO)).toBe(false);
  });
});
