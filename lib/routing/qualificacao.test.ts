import { describe, expect, it } from "vitest";

import {
  ESPERA_PADRAO_MINUTOS,
  decidirEsperaPelaQualificacao,
  esperaDaLigada,
  leadJaQualificado,
  lerEsperaDoCanal,
  type FatosDaQualificacao,
} from "./qualificacao";

/**
 * A ESPERA PELA QUALIFICAÇÃO (issue #3966) — a regra pura, caso a caso.
 *
 * O defeito que ela fecha: com rodízio/carga a conversa era distribuída no
 * nascimento, a atribuição gravava `assignee_kind='user'` e o gate da IA
 * (`conversa_de_humano`) calava quem deveria qualificar. Aqui se prova QUANDO a
 * distribuição espera e — mais importante — os seis motivos de NÃO esperar: um
 * deles faltando é uma conversa presa sem dono.
 */

const AGORA = new Date("2026-11-05T12:00:00Z");
const NASCIDA_AGORA = "2026-11-05T11:59:00Z";
const NASCIDA_ONTEM = "2026-11-04T11:00:00Z";

const fatos = (over: Partial<FatosDaQualificacao> = {}): FatosDaQualificacao => ({
  ligada: true,
  iaAtende: true,
  forceHuman: false,
  aiOptOut: false,
  contatoBloqueado: false,
  botSilencedUntil: null,
  casoPedePessoa: false,
  leadQualificado: false,
  nasceuEm: NASCIDA_AGORA,
  agora: AGORA,
  limiteMinutos: ESPERA_PADRAO_MINUTOS,
  ...over,
});

describe("o caminho da ESPERA", () => {
  it("opção ligada + IA atendendo + nada sinalizou ⇒ espera, com o limite do nascimento", () => {
    const d = decidirEsperaPelaQualificacao(fatos());
    expect(d).toMatchObject({ espera: true, motivo: "ia_qualificando" });
    expect(d.limiteEm).toBe("2026-11-06T11:59:00.000Z");
  });

  it("o limite é contado do NASCIMENTO, não da última mensagem: 23h59 depois ainda espera", () => {
    const d = decidirEsperaPelaQualificacao(
      fatos({ nasceuEm: "2026-11-04T12:01:00Z", agora: new Date("2026-11-05T12:00:00Z") }),
    );
    expect(d.espera).toBe(true);
  });
});

describe("os motivos de NÃO esperar — cada um é uma conversa que não pode ficar presa", () => {
  it("opção desligada (o padrão): distribui no nascimento, como hoje", () => {
    expect(decidirEsperaPelaQualificacao(fatos({ ligada: false }))).toMatchObject({
      espera: false,
      motivo: "opcao_desligada",
    });
  });

  it("sem agente de IA no número: não há qualificação para esperar", () => {
    expect(decidirEsperaPelaQualificacao(fatos({ iaAtende: false }))).toMatchObject({
      espera: false,
      motivo: "sem_agente_de_ia",
    });
  });

  it.each([
    ["force_human (passagem já feita)", { forceHuman: true }],
    ["ai_opt_out (sempre humano)", { aiOptOut: true }],
    ["contato bloqueado", { contatoBloqueado: true }],
    ["bot_silenced_until no futuro", { botSilencedUntil: "2026-11-05T12:30:00Z" }],
    ["bot_silenced_until = infinity (silêncio durável)", { botSilencedUntil: "infinity" }],
  ])("IA calada — %s ⇒ distribui", (_nome, over) => {
    expect(decidirEsperaPelaQualificacao(fatos(over))).toMatchObject({
      espera: false,
      motivo: "ia_calada",
    });
  });

  it("silêncio que já EXPIROU não conta como calada (a IA voltou)", () => {
    expect(
      decidirEsperaPelaQualificacao(fatos({ botSilencedUntil: "2026-11-05T11:00:00Z" })).espera,
    ).toBe(true);
  });

  it("o caso pedindo pessoa é o FIM da qualificação", () => {
    expect(decidirEsperaPelaQualificacao(fatos({ casoPedePessoa: true }))).toMatchObject({
      espera: false,
      motivo: "caso_pede_pessoa",
    });
  });

  it("lead já qualificado (qualified/negotiating/won) ⇒ a IA fez o trabalho dela", () => {
    expect(decidirEsperaPelaQualificacao(fatos({ leadQualificado: true }))).toMatchObject({
      espera: false,
      motivo: "lead_qualificado",
    });
  });

  it("limite esgotado sem sinal nenhum ⇒ distribui mesmo assim", () => {
    const d = decidirEsperaPelaQualificacao(fatos({ nasceuEm: NASCIDA_ONTEM }));
    expect(d).toMatchObject({ espera: false, motivo: "limite_esgotado" });
    expect(d.limiteEm).toBe("2026-11-05T11:00:00.000Z");
  });

  it("o limite é o da config, não uma constante: 60 min vence o default de um dia", () => {
    expect(
      decidirEsperaPelaQualificacao(fatos({ nasceuEm: NASCIDA_ONTEM, limiteMinutos: 60 })),
    ).toMatchObject({ espera: false, motivo: "limite_esgotado" });
  });

  it("nascimento ilegível ⇒ falha ABERTA (distribui, não prende)", () => {
    expect(
      decidirEsperaPelaQualificacao(fatos({ nasceuEm: null, limiteMinutos: 1440 })),
    ).toMatchObject({ espera: false, motivo: "sem_nascimento" });
  });
});

describe("leadJaQualificado", () => {
  it.each(["qualified", "negotiating", "won"])("%s já passou da qualificação", (stage) => {
    expect(leadJaQualificado(stage)).toBe(true);
  });

  it.each(["new", "contacted", "qualifying", "lost", "estado_do_futuro", null, undefined])(
    "%s NÃO libera a distribuição",
    (stage) => {
      expect(leadJaQualificado(stage)).toBe(false);
    },
  );
});

describe("a opção do número e a herança da organização", () => {
  it("metadata ausente/estranho = o número não decidiu (herda)", () => {
    expect(lerEsperaDoCanal(null)).toBeNull();
    expect(lerEsperaDoCanal(undefined)).toBeNull();
    expect(lerEsperaDoCanal("open")).toBeNull();
    expect(lerEsperaDoCanal([])).toBeNull();
    expect(lerEsperaDoCanal({})).toBeNull();
    expect(lerEsperaDoCanal({ routing: null })).toBeNull();
    expect(lerEsperaDoCanal({ routing: {} })).toBeNull();
    // Texto NÃO é booleano: um jsonb editado à mão não desliga o que a
    // organização ligou, nem liga o que ela desligou.
    expect(lerEsperaDoCanal({ routing: { distribute_only_after_qualification: "true" } })).toBeNull();
    expect(lerEsperaDoCanal({ routing: { distribute_only_after_qualification: 1 } })).toBeNull();
  });

  it("o número que decidiu vence a organização nos DOIS sentidos", () => {
    expect(lerEsperaDoCanal({ routing: { distribute_only_after_qualification: true } })).toBe(true);
    expect(lerEsperaDoCanal({ routing: { distribute_only_after_qualification: false } })).toBe(
      false,
    );
    expect(esperaDaLigada(false, true)).toBe(true);
    expect(esperaDaLigada(true, false)).toBe(false);
    expect(esperaDaLigada(true, null)).toBe(true);
    expect(esperaDaLigada(false, null)).toBe(false);
  });

  it("o metadata do canal convive com outras opções no mesmo jsonb (ai_gate, por exemplo)", () => {
    expect(
      lerEsperaDoCanal({ ai_gate: "allowlist", routing: { distribute_only_after_qualification: true } }),
    ).toBe(true);
  });
});
