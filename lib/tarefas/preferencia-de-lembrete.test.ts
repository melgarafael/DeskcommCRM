/**
 * O LEMBRETE DE PRAZO DA TAREFA — a régua, medida nas bordas.
 *
 * A tarefa vencida era silêncio: a lista mostrava vermelho só para quem
 * abrisse a lista (issue #2529). As três decisões que este módulo toma são as
 * que o silêncio escondia, e as três precisam ser exercitáveis sem banco:
 *
 *   - ANTES do vencimento (`task_due`), dentro da janela que a pessoa escolheu;
 *   - NO vencimento sem conclusão (`task_overdue`);
 *   - e a terceira é uma RECUSA: preferência desligada não manda nada.
 *
 * A última é a que mais importa testar. Um aviso a mais é ruído; um aviso que
 * a pessoa desligou é o produto desobedecendo — e o modo de falha é mudo: nada
 * quebra, ninguém reclama, a pessoa simplesmente aprende a ignorar a Central.
 */
import { describe, expect, it } from "vitest";

import {
  ANTCEDENCIA_PADRAO_MIN,
  decidirLembreteDeTarefa,
  decidirWhatsappDoLembrete,
  lerPreferenciaDeLembrete,
  preferenciaPadraoDeLembrete,
} from "./preferencia-de-lembrete";

const AGORA = new Date("2026-10-13T12:00:00.000Z");
const MIN = 60_000;

/** Pref padrão, para os testes mudarem só o que o caso examina. */
function pref(override: Partial<ReturnType<typeof preferenciaPadraoDeLembrete>> = {}) {
  return { ...preferenciaPadraoDeLembrete(), ...override };
}

function venceEm(minutos: number): string {
  return new Date(AGORA.getTime() + minutos * MIN).toISOString();
}

describe("o padrão é avisar de 1h, e a repetição nasce desligada", () => {
  it("task_due ligado com janela de 1 hora", () => {
    const p = preferenciaPadraoDeLembrete();
    expect(p.task_due).toBe(true);
    expect(p.antecedencia_min).toBe(ANTCEDENCIA_PADRAO_MIN);
    expect(ANTCEDENCIA_PADRAO_MIN).toBe(60);
  });

  it("task_overdue nasce DESLIGADO — repetição é opcional, e opt-in não é o padrão", () => {
    expect(preferenciaPadraoDeLembrete().task_overdue).toBe(false);
  });

  it("WhatsApp nasce desligado e sem número — canal opcional", () => {
    const p = preferenciaPadraoDeLembrete();
    expect(p.whatsapp).toBe(false);
    expect(p.whatsapp_numero).toBeNull();
  });
});

describe("decidirLembreteDeTarefa — a janela de aviso", () => {
  it("tarefa que vence daqui a 2h, com janela de 1h: nada ainda", () => {
    expect(decidirLembreteDeTarefa({ due_date: venceEm(120), status: "pending" }, AGORA, pref())).toBeNull();
  });

  it("tarefa que vence daqui a 59min: task_due", () => {
    expect(decidirLembreteDeTarefa({ due_date: venceEm(59), status: "pending" }, AGORA, pref())).toBe("task_due");
  });

  it("na fronteira exata da janela (60min): task_due — quem configurou 1h quer 1h", () => {
    expect(decidirLembreteDeTarefa({ due_date: venceEm(60), status: "pending" }, AGORA, pref())).toBe("task_due");
  });

  it("janela de 15min não avisa 30min antes", () => {
    expect(
      decidirLembreteDeTarefa({ due_date: venceEm(30), status: "pending" }, AGORA, pref({ antecedencia_min: 15 })),
    ).toBeNull();
  });

  it("janela de 15min avisa faltando 10min", () => {
    expect(
      decidirLembreteDeTarefa({ due_date: venceEm(10), status: "pending" }, AGORA, pref({ antecedencia_min: 15 })),
    ).toBe("task_due");
  });

  it("janela de 1 dia avisa com 12h de antecedência", () => {
    expect(
      decidirLembreteDeTarefa({ due_date: venceEm(12 * 60), status: "pending" }, AGORA, pref({ antecedencia_min: 1440 })),
    ).toBe("task_due");
  });

  it("janela inválida cai na de 1h em vez de deixar a tarefa sem aviso", () => {
    // `antecedencia_min` vem de metadata alheio: um valor torto não pode virar
    // "nunca avisa" em silêncio, que é o defeito que este módulo existe para
    // não ter. O `as unknown` é proposital — é o caminho que um valor gravado
    // fora da tela realmente percorre até aqui.
    const p = { ...pref(), antecedencia_min: -5 } as unknown as ReturnType<typeof preferenciaPadraoDeLembrete>;
    expect(decidirLembreteDeTarefa({ due_date: venceEm(30), status: "pending" }, AGORA, p)).toBe("task_due");
  });
});

describe("decidirLembreteDeTarefa — o vencimento sem conclusão", () => {
  it("tarefa vencida e ainda pendente: task_overdue (com a preferência ligada)", () => {
    expect(
      decidirLembreteDeTarefa({ due_date: venceEm(-5), status: "pending" }, AGORA, pref({ task_overdue: true })),
    ).toBe("task_overdue");
  });

  it("tarefa vencida em andamento (in_progress) também conta como sem conclusão", () => {
    expect(
      decidirLembreteDeTarefa({ due_date: venceEm(-60), status: "in_progress" }, AGORA, pref({ task_overdue: true })),
    ).toBe("task_overdue");
  });

  it("tarefa vencida MAS concluída: nada — não há o que avisar", () => {
    expect(
      decidirLembreteDeTarefa({ due_date: venceEm(-5), status: "done" }, AGORA, pref({ task_overdue: true })),
    ).toBeNull();
  });

  it("tarefa vencida e cancelada: nada", () => {
    expect(
      decidirLembreteDeTarefa({ due_date: venceEm(-5), status: "cancelled" }, AGORA, pref({ task_overdue: true })),
    ).toBeNull();
  });

  it("vencida não recai em task_due: os dois avisos não empilham", () => {
    expect(decidirLembreteDeTarefa({ due_date: venceEm(-5), status: "pending" }, AGORA, pref())).toBeNull();
  });

  it("tarefa vence EXATAMENTE agora: já é vencimento, não mais antecedência", () => {
    expect(
      decidirLembreteDeTarefa({ due_date: AGORA.toISOString(), status: "pending" }, AGORA, pref({ task_overdue: true })),
    ).toBe("task_overdue");
  });
});

describe("decidirLembreteDeTarefa — o que nunca é aviso", () => {
  it("tarefa sem prazo não gera lembrete nenhum", () => {
    expect(decidirLembreteDeTarefa({ due_date: null, status: "pending" }, AGORA, pref())).toBeNull();
  });

  it("data ilegível não gera lembrete nem lança", () => {
    expect(() => decidirLembreteDeTarefa({ due_date: "ontem", status: "pending" }, AGORA, pref())).not.toThrow();
    expect(decidirLembreteDeTarefa({ due_date: "ontem", status: "pending" }, AGORA, pref())).toBeNull();
  });
});

describe("a preferência desligada não manda nada", () => {
  it("task_due desligado: a tarefa dentro da janela fica sem aviso", () => {
    expect(decidirLembreteDeTarefa({ due_date: venceEm(10), status: "pending" }, AGORA, pref({ task_due: false }))).toBeNull();
  });

  it("task_overdue desligado: a tarefa vencida fica sem aviso", () => {
    expect(
      decidirLembreteDeTarefa({ due_date: venceEm(-10), status: "pending" }, AGORA, pref({ task_overdue: false })),
    ).toBeNull();
  });

  it("as duas desligadas: nenhuma tarefa vira aviso, por mais perto que esteja", () => {
    const p = pref({ task_due: false, task_overdue: false });
    expect(decidirLembreteDeTarefa({ due_date: venceEm(1), status: "pending" }, AGORA, p)).toBeNull();
    expect(decidirLembreteDeTarefa({ due_date: venceEm(-1), status: "pending" }, AGORA, p)).toBeNull();
  });
});

describe("lerPreferenciaDeLembrete — o metadata é dado alheio", () => {
  it("sem nada gravado: o padrão do produto", () => {
    expect(lerPreferenciaDeLembrete(undefined)).toEqual(preferenciaPadraoDeLembrete());
    expect(lerPreferenciaDeLembrete(null)).toEqual(preferenciaPadraoDeLembrete());
    expect(lerPreferenciaDeLembrete({})).toEqual(preferenciaPadraoDeLembrete());
  });

  it("o que a pessoa escolheu volta integral", () => {
    expect(
      lerPreferenciaDeLembrete({
        lembretes_de_tarefa: { task_due: false, task_overdue: true, antecedencia_min: 15, whatsapp: true, whatsapp_numero: "5511999990000" },
      }),
    ).toEqual({ task_due: false, task_overdue: true, antecedencia_min: 15, whatsapp: true, whatsapp_numero: "5511999990000" });
  });

  it("antecedência fora das que a tela oferece cai na de 1h", () => {
    for (const torta of [0, -1, 17, 999999, "1 hora", null]) {
      const lida = lerPreferenciaDeLembrete({ lembretes_de_tarefa: { antecedencia_min: torta } });
      expect(lida.antecedencia_min).toBe(ANTCEDENCIA_PADRAO_MIN);
    }
  });

  it("as três antecedências que a tela oferece são aceitas", () => {
    for (const valida of [15, 60, 1440]) {
      expect(lerPreferenciaDeLembrete({ lembretes_de_tarefa: { antecedencia_min: valida } }).antecedencia_min).toBe(valida);
    }
  });

  it("booleano malformado volta ao padrão daquilo, não ao contrario", () => {
    const lida = lerPreferenciaDeLembrete({ lembretes_de_tarefa: { task_due: "sim", task_overdue: 1 } });
    expect(lida.task_due).toBe(true);
    expect(lida.task_overdue).toBe(false);
  });

  it("número de WhatsApp que não é string é ignorado", () => {
    expect(lerPreferenciaDeLembrete({ lembretes_de_tarefa: { whatsapp: true, whatsapp_numero: 55119 } }).whatsapp_numero).toBeNull();
  });
});

describe("decidirWhatsappDoLembrete — o canal opcional", () => {
  const comCanal = { temCanal: true, temTelefone: true, temContato: true };

  it("quem não escolheu WhatsApp não recebe, mesmo com canal e número prontos", () => {
    const r = decidirWhatsappDoLembrete({ ...comCanal, pref: pref({ whatsapp: false }) });
    expect(r.enviar).toBe(false);
    expect(r.motivo).toBe("whatsapp_desligado");
  });

  it("escolheu, mas a organização não tem sessão de canal: NÃO TENTA", () => {
    // Esta é a guarda da issue: sem canal da organização o cron nem tenta —
    // não resolve contato, não abre conversa, não chama a API do provedor.
    const r = decidirWhatsappDoLembrete({ ...comCanal, temCanal: false, pref: pref({ whatsapp: true }) });
    expect(r.enviar).toBe(false);
    expect(r.motivo).toBe("sem_canal");
  });

  it("escolheu e há canal, mas o responsável não deixou número: não tenta", () => {
    const r = decidirWhatsappDoLembrete({ ...comCanal, temTelefone: false, pref: pref({ whatsapp: true }) });
    expect(r.enviar).toBe(false);
    expect(r.motivo).toBe("sem_telefone");
  });

  it("escolheu, há canal e número, mas o responsável não é contato da empresa: não tenta", () => {
    const r = decidirWhatsappDoLembrete({ ...comCanal, temContato: false, pref: pref({ whatsapp: true }) });
    expect(r.enviar).toBe(false);
    expect(r.motivo).toBe("sem_contato");
  });

  it("escolheu, com canal, número e contato: envia", () => {
    const r = decidirWhatsappDoLembrete({ ...comCanal, pref: pref({ whatsapp: true, whatsapp_numero: "5511999990000" }) });
    expect(r.enviar).toBe(true);
    expect(r.motivo).toBeNull();
  });
});
