/**
 * O LEMBRETE DE PRAZO DA TAREFA (#2529) — o que a rodada decide.
 *
 * `lembretesDaRodada` é puro de propósito: a regra de QUANDO um prazo pede
 * gente é exercitada de verdade, nas bordas, sem dublê de banco. O que NÃO é
 * função — o encadeamento da consulta, o recorte por organização, a ordem das
 * portas do WhatsApp — é prendido estruturalmente, lendo a fonte, no mesmo
 * estilo de `agenda-reminder/route.test.ts`: um dublê de Supabase provaria o
 * dublê, e a asserção sobre o TEXTO do caminho é o que sobrevive a refactor.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { preferenciaPadraoDeLembrete } from "@/lib/tarefas/preferencia-de-lembrete";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import {
  avisoDaCentral,
  chaveDoAviso,
  janelaDaVarredura,
  lembretesDaRodada,
  ocasiaoDaTarefa,
  type TarefaLida,
} from "./route";

const AGORA = new Date("2026-10-13T12:00:00.000Z");
const MIN = 60_000;

function pref(override: Partial<ReturnType<typeof preferenciaPadraoDeLembrete>> = {}) {
  return { ...preferenciaPadraoDeLembrete(), ...override };
}

function tarefa(override: Partial<TarefaLida> = {}): TarefaLida {
  return {
    id: "t1",
    organization_id: "org-1",
    assigned_to: "pessoa-1",
    due_date: new Date(AGORA.getTime() + 30 * MIN).toISOString(),
    status: "pending",
    title: "Ligar para o cliente",
    ...override,
  };
}

const SEM_PREF = new Map();
const NADA_VISTO = new Set<string>();
/** Quem ainda é da equipe, no par `${organization_id}:${user_id}` que a rota monta. */
const EQUIPE = new Set(["org-1:pessoa-1"]);

describe("lembretesDaRodada — a janela de aviso", () => {
  it("tarefa que vence em 2h, com a janela padrão de 1h: a rodada não avisa", () => {
    const r = lembretesDaRodada(
      { membrosAtivos: EQUIPE, tarefas: [tarefa({ due_date: new Date(AGORA.getTime() + 120 * MIN).toISOString() })], preferencias: SEM_PREF, jaAvisados: NADA_VISTO },
      AGORA,
    );
    expect(r).toEqual([]);
  });

  it("tarefa que vence em 30min: a rodada avisa, como task_due", () => {
    const r = lembretesDaRodada(
      { membrosAtivos: EQUIPE, tarefas: [tarefa({ due_date: new Date(AGORA.getTime() + 30 * MIN).toISOString() })], preferencias: SEM_PREF, jaAvisados: NADA_VISTO },
      AGORA,
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.categoria).toBe("task_due");
  });

  it("a janela que a PESSOA escolheu é a que vale", () => {
    const t = tarefa({ due_date: new Date(AGORA.getTime() + 30 * MIN).toISOString() });
    const preferencias = new Map([["pessoa-1", pref({ antecedencia_min: 15 })]]);
    expect(lembretesDaRodada({ membrosAtivos: EQUIPE, tarefas: [t], preferencias, jaAvisados: NADA_VISTO }, AGORA)).toEqual([]);

    const comDia = new Map([["pessoa-1", pref({ antecedencia_min: 1440 })]]);
    expect(lembretesDaRodada({ membrosAtivos: EQUIPE, tarefas: [t], preferencias: comDia, jaAvisados: NADA_VISTO }, AGORA)[0]?.categoria).toBe(
      "task_due",
    );
  });
});

describe("lembretesDaRodada — a vencida sem conclusão", () => {
  it("tarefa vencida e pendente, com task_overdue ligado: dispara", () => {
    const r = lembretesDaRodada(
      { membrosAtivos: EQUIPE,
        tarefas: [tarefa({ due_date: new Date(AGORA.getTime() - 5 * MIN).toISOString() })],
        preferencias: new Map([["pessoa-1", pref({ task_overdue: true })]]),
        jaAvisados: NADA_VISTO,
      },
      AGORA,
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.categoria).toBe("task_overdue");
  });

  it("tarefa vencida MAS concluída não gera aviso nenhum", () => {
    const r = lembretesDaRodada(
      { membrosAtivos: EQUIPE,
        tarefas: [tarefa({ due_date: new Date(AGORA.getTime() - 5 * MIN).toISOString(), status: "done" })],
        preferencias: new Map([["pessoa-1", pref({ task_overdue: true })]]),
        jaAvisados: NADA_VISTO,
      },
      AGORA,
    );
    expect(r).toEqual([]);
  });

  it("o padrão do produto NÃO repete em vencida — quem não escolheu recebe só o aviso de antecedência", () => {
    // A pessoa que nunca abriu a tela continua sendo avisada ANTES do prazo
    // (`task_due` ligado por padrão), e não a cada rodada depois que ele venceu
    // (`task_overdue` desligado por padrão): repetição é opt-in.
    const r = lembretesDaRodada(
      { membrosAtivos: EQUIPE, tarefas: [tarefa({ due_date: new Date(AGORA.getTime() - 5 * MIN).toISOString() })], preferencias: SEM_PREF, jaAvisados: NADA_VISTO },
      AGORA,
    );
    expect(r).toEqual([]);
  });
});

describe("lembretesDaRodada — a preferência desligada não manda nada", () => {
  it("task_due desligado: a tarefa dentro da janela fica sem aviso", () => {
    const r = lembretesDaRodada(
      { membrosAtivos: EQUIPE,
        tarefas: [tarefa({ due_date: new Date(AGORA.getTime() + 5 * MIN).toISOString() })],
        preferencias: new Map([["pessoa-1", pref({ task_due: false })]]),
        jaAvisados: NADA_VISTO,
      },
      AGORA,
    );
    expect(r).toEqual([]);
  });

  it("task_overdue desligado: a tarefa vencida fica sem aviso", () => {
    const r = lembretesDaRodada(
      { membrosAtivos: EQUIPE,
        tarefas: [tarefa({ due_date: new Date(AGORA.getTime() - 5 * MIN).toISOString() })],
        preferencias: new Map([["pessoa-1", pref({ task_overdue: false })]]),
        jaAvisados: NADA_VISTO,
      },
      AGORA,
    );
    expect(r).toEqual([]);
  });

  it("as duas desligadas: nenhuma tarefa da rodada vira aviso", () => {
    const preferencias = new Map([["pessoa-1", pref({ task_due: false, task_overdue: false })]]);
    const tarefas = [
      tarefa({ id: "t1", due_date: new Date(AGORA.getTime() + 5 * MIN).toISOString() }),
      tarefa({ id: "t2", due_date: new Date(AGORA.getTime() - 5 * MIN).toISOString() }),
    ];
    expect(lembretesDaRodada({ membrosAtivos: EQUIPE, tarefas, preferencias, jaAvisados: NADA_VISTO }, AGORA)).toEqual([]);
  });
});

describe("lembretesDaRodada — o que nunca vira aviso", () => {
  it("tarefa sem responsável não avisa: não há a quem mandar", () => {
    const r = lembretesDaRodada(
      { membrosAtivos: EQUIPE, tarefas: [tarefa({ assigned_to: null })], preferencias: SEM_PREF, jaAvisados: NADA_VISTO },
      AGORA,
    );
    expect(r).toEqual([]);
  });

  it("a ocasião já avisada não repete — é a trava que o item da Central grava", () => {
    const t = tarefa({ due_date: new Date(AGORA.getTime() + 5 * MIN).toISOString() });
    const jaAvisados = new Set([chaveDoAviso(ocasiaoDaTarefa(t, "task_due"))]);
    expect(lembretesDaRodada({ membrosAtivos: EQUIPE, tarefas: [t], preferencias: SEM_PREF, jaAvisados }, AGORA)).toEqual([]);
  });

  it("a trava é POR CATEGORIA: task_due já avisado não impede o task_overdue", () => {
    // A mesma tarefa tem dois momentos, e o segundo não some porque o primeiro
    // virou item da Central — a pessoa ainda precisa saber que o prazo passou.
    const t = tarefa({ due_date: new Date(AGORA.getTime() - 5 * MIN).toISOString() });
    const r = lembretesDaRodada(
      { membrosAtivos: EQUIPE,
        tarefas: [t],
        preferencias: new Map([["pessoa-1", pref({ task_overdue: true })]]),
        jaAvisados: new Set([chaveDoAviso(ocasiaoDaTarefa(t, "task_due"))]),
      },
      AGORA,
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.categoria).toBe("task_overdue");
  });

  it("responsável sem preferência gravada cai no PADRÃO do produto, e não no silêncio", () => {
    // Ninguém nunca abriu a tela de notificações: continua sendo avisado de
    // prazo. Um `get` vazio não pode virar "ninguém é avisado" — seria o
    // silêncio que esta feature veio consertar, uma camada acima.
    const r = lembretesDaRodada(
      { membrosAtivos: EQUIPE, tarefas: [tarefa({ due_date: new Date(AGORA.getTime() + 5 * MIN).toISOString() })], preferencias: SEM_PREF, jaAvisados: NADA_VISTO },
      AGORA,
    );
    expect(r).toHaveLength(1);
  });
});

describe("a rota escreve na ORGANIZAÇÃO DA TAREFA, e com o par que a trava lê", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");

  it("o item da Central nasce com organization_id vindo da linha da tarefa", () => {
    // A cerca do `agenda-reminder`: sem o recorte por org, esta rota viraria a
    // organização A avisando tarefa da B. O corte vem da LINHA, nunca de
    // parâmetro de requisição.
    expect(fonte).toContain("organization_id: tarefa.organization_id");
    expect(fonte).not.toContain('searchParams.get("organization_id")');
  });

  it("o aviso carrega `ref_kind: task` e o id da tarefa — é o par que a trava lê", () => {
    expect(fonte).toContain('ref_kind: "task"');
    expect(fonte).toContain("ref_id: tarefa.id");
  });

  it("a trava lê a MESMA ocasião que a escrita grava (categoria + tarefa + responsável + prazo)", () => {
    // Sem esta asserção, trocar a chave na escrita e não na leitura faria a
    // rodada reenviar para sempre sem erro nenhum — o defeito que a trava
    // existe para impedir, nascendo calado. Desde a #3639 a chave é a OCASIÃO,
    // e a conta mora numa função só (`chaveDoAviso`), usada pelos dois lados.
    expect(fonte).toContain("chaveDoAviso(");
    expect(fonte.match(/chaveDoAviso\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(fonte).toContain("para_user_id, task_reminder_due_at");
    expect(fonte).toContain("task_reminder_due_at: prazoDaOcasiao(tarefa.due_date)");
  });

  it("o push vai ao RESPONSÁVEL, e não à organização", () => {
    expect(fonte).toContain("enviarPushAoUsuario(tarefa.organization_id, responsavel");
  });

  it("o toque no push abre as tarefas do responsável", () => {
    expect(fonte).toContain("href: HREF_MINHAS_TAREFAS");
  });

  it("audit só quando houve efeito", () => {
    expect(fonte).toMatch(/if \(resultado\.avisadas > 0\) \{\s*void audit\(/);
  });
});

describe("a porta do WhatsApp é decidida ANTES de qualquer consulta", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");

  it("sem opt-in a rodada nem busca canal da organização", () => {
    // A guarda da issue: quem não escolheu WhatsApp não gera consulta de canal,
    // não gera consulta de contato, não abre conversa. O `if (pref.whatsapp)`
    // é a porta, e ele vem antes de `sessaoProntaParaEnvio`.
    const optIn = fonte.indexOf("if (pref.whatsapp)");
    const canal = fonte.indexOf("sessaoProntaParaEnvio(");
    expect(optIn).toBeGreaterThan(-1);
    expect(canal).toBeGreaterThan(-1);
    expect(optIn).toBeLessThan(canal);
  });

  it("o número da pessoa é procurado na forma em que o contato é gravado", () => {
    // A tela grava só dígitos; `contacts.phone_number` só aceita E.164 com `+`.
    // Comparar o número cru deixava o opt-in de WhatsApp sempre em `sem_contato`.
    const busca = fonte.slice(fonte.indexOf('.from("contacts")'));
    expect(busca.slice(0, 400)).toContain('.in("phone_number", variantes)');
    expect(fonte).toContain("phoneLookupVariants(telefone)");
  });

  it("o número só de dígitos, como a tela grava, vira uma variante que o CHECK do contato aceita", () => {
    // `contacts_phone_e164_format` é `^\+\d{8,15}$`: sem uma variante nessa forma
    // a busca nunca casa, qualquer que seja o texto da consulta.
    const e164 = /^\+\d{8,15}$/;
    expect(e164.test("5511999990000")).toBe(false);
    expect(phoneLookupVariants("5511999990000").some((v) => e164.test(v))).toBe(true);
  });

  it("o contato é buscado DENTRO da organização da tarefa", () => {
    const busca = fonte.slice(fonte.indexOf('.from("contacts")'));
    expect(busca.slice(0, 400)).toContain('.eq("organization_id", tarefa.organization_id)');
  });

  it("a decisão passa por `decidirWhatsappDoLembrete` — a regra mora no módulo puro", () => {
    expect(fonte).toContain("decidirWhatsappDoLembrete(");
  });

  it("o pulo do WhatsApp é registrado, nunca silencioso", () => {
    expect(fonte).toContain("pular(`whatsapp_${decisao.motivo}`)");
  });
});

describe("lembretesDaRodada — só quem ainda é da equipe recebe", () => {
  // Revogar um membro não limpa `crm_tasks.assigned_to`: o responsável gravado
  // pode ser quem já saiu. A régua é a do `send_email` (#2794) e do
  // `assign-owner`: vínculo em `user_organizations` com `revoked_at` nulo, NA
  // organização da tarefa.
  const vencendo = () => tarefa({ due_date: new Date(AGORA.getTime() + 5 * MIN).toISOString() });

  it("responsável que saiu da organização não vira aviso", () => {
    const r = lembretesDaRodada(
      { membrosAtivos: new Set<string>(), tarefas: [vencendo()], preferencias: SEM_PREF, jaAvisados: NADA_VISTO },
      AGORA,
    );
    expect(r).toEqual([]);
  });

  it("vínculo ativo em OUTRA organização não conta", () => {
    const r = lembretesDaRodada(
      { membrosAtivos: new Set(["org-2:pessoa-1"]), tarefas: [vencendo()], preferencias: SEM_PREF, jaAvisados: NADA_VISTO },
      AGORA,
    );
    expect(r).toEqual([]);
  });
});

describe("a varredura que alimenta a régua", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");

  it("tem PISO no prazo: vencida antiga não ocupa o teto da rodada", () => {
    // Sem piso, a consulta ordenada por prazo devolve primeiro as vencidas mais
    // antigas, e 200 delas em aberto (somadas de todas as organizações) tomam o
    // teto inteiro: a tarefa que vence daqui a 30 minutos nunca é examinada.
    expect(fonte).toMatch(/\.gte\("due_date", piso\)/);
    expect(fonte).toMatch(/\.lte\("due_date", corte\)/);
  });

  it("a janela vai de 1 dia atrás até a maior antecedência: o sentido do piso e do corte", () => {
    const { piso, corte } = janelaDaVarredura(AGORA);
    const p = Date.parse(piso);
    const c = Date.parse(corte);
    expect(p).toBeLessThan(AGORA.getTime());
    expect(c).toBeGreaterThan(AGORA.getTime());
    const dentro = (ms: number) => ms >= p && ms <= c;
    expect(dentro(AGORA.getTime() + 30 * MIN)).toBe(true); // vence daqui a 30 min
    expect(dentro(AGORA.getTime() - 10 * MIN)).toBe(true); // venceu há 10 min
    expect(dentro(AGORA.getTime() - 2 * 1440 * MIN)).toBe(false); // vencida há 2 dias
  });

  it("lê o vínculo ATIVO de cada responsável", () => {
    const busca = fonte.slice(fonte.indexOf('.from("user_organizations")'));
    expect(fonte).toContain('.from("user_organizations")');
    expect(busca.slice(0, 300)).toContain('.is("revoked_at", null)');
  });
});

describe("avisoDaCentral — o aviso de prazo é do RESPONSÁVEL (doc 162, migration 0689)", () => {
  it("leva o responsável em para_user_id: o colega não vê, e o Marcar todos dele não resolve", () => {
    const linha = avisoDaCentral({ tarefa: tarefa({ assigned_to: "pessoa-7" }), categoria: "task_due" });
    expect(linha.para_user_id).toBe("pessoa-7");
    expect(linha.organization_id).toBe("org-1");
    expect(linha).toMatchObject({ kind: "task_due", ref_kind: "task", ref_id: "t1" });
  });

  it("o título do item é o NOME da tarefa — a frase do push não vai para a Central", () => {
    for (const categoria of ["task_due", "task_overdue"] as const) {
      const linha = avisoDaCentral({ tarefa: tarefa({ title: "  Ligar para a Ana  " }), categoria });
      expect(linha.title).toBe("Ligar para a Ana");
      expect(linha).not.toHaveProperty("body");
    }
  });

  it("a rodada grava pela função, e não por um insert à mão que perderia o dono", () => {
    const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(fonte).toMatch(/\.from\("agent_inbox_items"\)\s*\.insert\(avisoDaCentral\(/);
  });
});

describe("o lembrete por telefone pede o canal que alcança o aparelho (#3358)", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");

  it("a porta que escolhe a sessão recebe a preferência por telefone", () => {
    // O destino DESTE envio é um TELEFONE: o número que a pessoa deixou, casado
    // com `contacts.phone_number`. Sem a preferência, a porta devolvia a sessão
    // WORKING mais ANTIGA da organização — e numa organização que conectou o
    // Instagram antes do WhatsApp essa é a social, que não alcança telefone
    // nenhum: o lembrete ia para o Instagram e era recusado pela janela de 24h.
    expect(fonte).toContain(
      "sessaoProntaParaEnvio(admin, tarefa.organization_id, { preferirTelefone: true })",
    );
  });

  it("a sessão escolhida é a MESMA que vai para `ensureConversation`", () => {
    // A preferência só vale se chegar ao envio: é este `canalId` que abre a
    // conversa e por onde o texto sai.
    expect(fonte).toContain("ensureConversation(admin, tarefa.organization_id, contatoId, canalId)");
  });
});
