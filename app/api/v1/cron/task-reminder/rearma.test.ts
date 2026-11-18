/**
 * O LEMBRETE DE TAREFA REARMA NA OCASIÃO (#3639).
 *
 * A trava da #2529 é o próprio item da Central: "esta tarefa já pediu gente".
 * Só que uma tarefa pede gente MAIS DE UMA VEZ — quando outro responsável
 * assume e quando o prazo é adiado. Com a identidade no par `kind + ref_id`, o
 * aviso antigo cobria a situação nova: quem assumia nunca era avisado, e adiar
 * para amanhã não rearmava a antecedência de amanhã.
 *
 * Aqui a decisão é exercitada de verdade (`lembretesDaRodada` é puro, sem
 * banco), com a leitura da trava vindo da MESMA função que a rota usa
 * (`chavesJaAvisadas`). O que não é função — o `select` que traz prazo e
 * responsável, o índice único que fecha a corrida, o espelho no baseline — é
 * preso lendo a fonte, no estilo de `route.test.ts`: um dublê de Supabase
 * provaria o dublê.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { preferenciaPadraoDeLembrete } from "@/lib/tarefas/preferencia-de-lembrete";
import {
  avisoDaCentral,
  chavesJaAvisadas,
  chaveDoAviso,
  lembretesDaRodada,
  ocasiaoDaTarefa,
  ocasiaoDoAvisoSalvo,
  prazoDaOcasiao,
  type AvisoGravado,
  type TarefaLida,
} from "./route";

const AGORA = new Date("2026-10-28T15:00:00.000Z");
const MIN = 60_000;

const PRAZO_HOJE = "2026-10-28T15:30:00Z";
const PRAZO_AMANHA = "2026-10-29T15:30:00Z";

function pref(override: Partial<ReturnType<typeof preferenciaPadraoDeLembrete>> = {}) {
  return { ...preferenciaPadraoDeLembrete(), ...override };
}

function tarefa(override: Partial<TarefaLida> = {}): TarefaLida {
  return {
    id: "tarefa-1",
    organization_id: "org-1",
    assigned_to: "A",
    due_date: PRAZO_HOJE,
    status: "pending",
    title: "Retornar ao cliente",
    ...override,
  };
}

const EQUIPE = new Set(["org-1:A", "org-1:B"]);
const SEM_PREF = new Map();

/**
 * O item que a rodada ANTERIOR gravou — construído pela função de produção
 * (`avisoDaCentral`), para a leitura ser exercitada contra o formato real.
 */
function avisoGravado(t: TarefaLida, categoria: "task_due" | "task_overdue" = "task_due"): AvisoGravado {
  const linha = avisoDaCentral({ tarefa: t, categoria });
  return {
    kind: linha.kind,
    ref_id: linha.ref_id,
    para_user_id: linha.para_user_id,
    task_reminder_due_at: linha.task_reminder_due_at,
  };
}

function rodada(tarefas: TarefaLida[], jaAvisados: ReadonlySet<string>) {
  return lembretesDaRodada({ tarefas, preferencias: SEM_PREF, membrosAtivos: EQUIPE, jaAvisados }, AGORA);
}

describe("#3639 — trocar o responsável rearma o lembrete para quem assumiu", () => {
  const avisoDeA = chavesJaAvisadas([avisoGravado(tarefa({ assigned_to: "A" }))]);

  it("o responsável NOVO recebe no prazo, e o ANTERIOR não é avisado de novo", () => {
    // Os dois lados do critério: B entra na rodada (a ocasião dele é nova) e A
    // não sai com nada (a ocasião dele já foi avisada). O aviso de A continua
    // na Central como histórico — o que não nasce é outro envio.
    const r = rodada([tarefa({ assigned_to: "B" })], avisoDeA);
    expect(r).toHaveLength(1);
    expect(r[0]?.categoria).toBe("task_due");
    expect(r.map((d) => d.tarefa.assigned_to)).toEqual(["B"]);
    expect(avisoDaCentral(r[0]!)).toMatchObject({ para_user_id: "B", ref_id: "tarefa-1" });
  });

  it("CONTROLE: sem mudança de responsável, a rodada repetida não duplica", () => {
    const aviso = chavesJaAvisadas([avisoGravado(tarefa({ assigned_to: "A" }))]);
    expect(rodada([tarefa({ assigned_to: "A" })], aviso)).toEqual([]);
  });

  it("CONTROLE: voltar ao responsável anterior reencontra a ocasião antiga e não repete", () => {
    // A→B (aviso de B gravado) e de volta para A: a ocasião de A já existia.
    // O rearme é para situação NOVA, não para toda edição da tarefa.
    const avisos = chavesJaAvisadas([
      avisoGravado(tarefa({ assigned_to: "A" })),
      avisoGravado(tarefa({ assigned_to: "B" })),
    ]);
    expect(rodada([tarefa({ assigned_to: "A" })], avisos)).toEqual([]);
  });
});

describe("#3639 — adiar o prazo rearma a antecedência nova", () => {
  const avisoDoPrazoDeHoje = chavesJaAvisadas([avisoGravado(tarefa())]);

  it("o prazo adiado tem uma nova ocasião de antecedência", () => {
    const amanhaNaJanela = new Date("2026-10-29T15:00:00.000Z");
    const r = lembretesDaRodada(
      {
        tarefas: [tarefa({ due_date: PRAZO_AMANHA })],
        preferencias: SEM_PREF,
        membrosAtivos: EQUIPE,
        jaAvisados: avisoDoPrazoDeHoje,
      },
      amanhaNaJanela,
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.categoria).toBe("task_due");
    expect(avisoDaCentral(r[0]!).task_reminder_due_at).toBe(new Date(PRAZO_AMANHA).toISOString());
  });

  it("a janela continua valendo: adiar para amanhã NÃO avisa hoje", () => {
    // O rearme não pode virar "avisa sempre": a antecedência da pessoa é a
    // régua, e o prazo novo ainda está a 24h.
    expect(rodada([tarefa({ due_date: PRAZO_AMANHA })], avisoDoPrazoDeHoje)).toEqual([]);
  });

  it("CONTROLE: o mesmo prazo, de novo, não duplica — a idempotência da #2529 segue de pé", () => {
    expect(rodada([tarefa()], avisoDoPrazoDeHoje)).toEqual([]);
  });

  it("CONTROLE: a trava é por CATEGORIA — o aviso de antecedência não engole a vencida", () => {
    const vencida = tarefa({ due_date: new Date(AGORA.getTime() - 5 * MIN).toISOString() });
    const r = lembretesDaRodada(
      {
        tarefas: [vencida],
        preferencias: new Map([["A", pref({ task_overdue: true })]]),
        membrosAtivos: EQUIPE,
        jaAvisados: chavesJaAvisadas([avisoGravado(tarefa({ due_date: vencida.due_date }), "task_due")]),
      },
      AGORA,
    );
    expect(r.map((d) => d.categoria)).toEqual(["task_overdue"]);
  });
});

describe("#3639 — a chave da ocasião é uma só, dos dois lados da trava", () => {
  it("ida e volta: o que a escrita grava é o que a leitura reconhece", () => {
    // O defeito silencioso deste desenho seria a escrita e a leitura
    // discordarem: a rodada reenviaria para sempre (ou nunca mais avisaria).
    const t = tarefa({ assigned_to: "B" });
    const linha = avisoGravado(t);
    const ocasiaoSalva = ocasiaoDoAvisoSalvo(linha);
    expect(ocasiaoSalva).not.toBeNull();
    expect(chaveDoAviso(ocasiaoSalva!)).toBe(chaveDoAviso(ocasiaoDaTarefa(t, "task_due")));
  });

  it("o MESMO instante escrito de duas formas é a MESMA ocasião", () => {
    // O PostgREST devolve `due_date` com o deslocamento que o cliente mandou, e
    // o Postgres devolve o que gravou: comparar texto cru faria `+00:00` e `Z`
    // virarem ocasiões diferentes e o rearme repetiria aviso a cada rodada.
    expect(prazoDaOcasiao("2026-10-28T15:30:00+00:00")).toBe(prazoDaOcasiao("2026-10-28T15:30:00Z"));
    const comDeslocamento = tarefa({ due_date: "2026-10-28T15:30:00+00:00" });
    const gravado = chavesJaAvisadas([avisoGravado(tarefa({ due_date: "2026-10-28T15:30:00Z" }))]);
    expect(rodada([comDeslocamento], gravado)).toEqual([]);
  });

  it("responsável diferente é ocasião diferente; prazo diferente também", () => {
    const base = ocasiaoDaTarefa(tarefa(), "task_due");
    expect(chaveDoAviso(ocasiaoDaTarefa(tarefa({ assigned_to: "B" }), "task_due"))).not.toBe(chaveDoAviso(base));
    expect(chaveDoAviso(ocasiaoDaTarefa(tarefa({ due_date: PRAZO_AMANHA }), "task_due"))).not.toBe(chaveDoAviso(base));
    expect(chaveDoAviso(ocasiaoDaTarefa(tarefa(), "task_overdue"))).not.toBe(chaveDoAviso(base));
  });

  it("aviso sem tarefa (ref_id nulo) não entra na trava — não há ocasião a comparar", () => {
    expect(ocasiaoDoAvisoSalvo({ kind: "task_due", ref_id: null, para_user_id: "A", task_reminder_due_at: null })).toBeNull();
    expect(chavesJaAvisadas([{ kind: "task_due", ref_id: null, para_user_id: "A", task_reminder_due_at: null }]).size).toBe(0);
  });

  it("prazo ilegível não vira instante inventado: fica o texto, e ele não avisa", () => {
    expect(prazoDaOcasiao("amanhã de manhã")).toBe("amanhã de manhã");
    expect(rodada([tarefa({ due_date: "amanhã de manhã" })], new Set())).toEqual([]);
  });
});

describe("#3639 — a trava é gravada e lida no item da Central, com prazo e dono", () => {
  const RAIZ = process.cwd();
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");
  const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
  const migrations = readdirSync(join(RAIZ, "supabase", "migrations")).filter((f) => f.endsWith(".sql"));

  it("a leitura traz o prazo e o responsável — sem eles a ocasião não existe", () => {
    const consulta = fonte.slice(fonte.indexOf('.from("agent_inbox_items")'));
    expect(consulta.slice(0, 400)).toContain('.select("kind, ref_id, para_user_id, task_reminder_due_at")');
  });

  it("a escrita grava o prazo que motivou o aviso", () => {
    expect(fonte).toContain("task_reminder_due_at: prazoDaOcasiao(tarefa.due_date)");
  });

  it("a corrida de duas rodadas na MESMA ocasião é a trava trabalhando, não erro", () => {
    // O índice único (9038) recusa o segundo INSERT da mesma ocasião: registrar
    // isso como `aviso_falhou` seria mentira no log, porque o aviso saiu.
    expect(fonte).toContain('erroInbox.code === "23505"');
    expect(fonte).toContain('pular("corrida_na_mesma_ocasiao")');
  });

  it("a migration existe, é idempotente e fecha a ocasião com índice único", () => {
    const arquivo = migrations.find((f) => f.includes("9038") && f.includes("rearma_na_ocasiao"));
    expect(arquivo, "migration 9038 ausente").toBeTruthy();
    const sql = readFileSync(join(RAIZ, "supabase", "migrations", arquivo!), "utf8");
    expect(sql.startsWith("-- manifest: ")).toBe(true);
    expect(sql).toContain("add column if not exists task_reminder_due_at timestamptz");
    expect(sql).toContain("create unique index if not exists inbox_task_reminder_ocasiao_unique");
    // Dedupe ANTES do índice: o `update.sh` do self-host reaplica o bloco num
    // banco que pode já ter duplicado da corrida antiga, e o índice falharia.
    expect(sql.indexOf("with repetidas as")).toBeLessThan(sql.indexOf("create unique index"));
    // O dedupe RESOLVE a repetida; ela só sai do índice se o índice deixar o
    // `resolved` de fora — sem o filtro, a duplicata fica e o índice falha.
    expect(indiceDaOcasiao(sql)).toContain("status <> 'resolved'");
  });

  it("o baseline do self-host espelha a coluna e o índice (senão o kit não recebe)", () => {
    expect(baseline).toContain("add column if not exists task_reminder_due_at timestamptz");
    expect(baseline).toContain("create unique index if not exists inbox_task_reminder_ocasiao_unique");
    expect(indiceDaOcasiao(baseline)).toContain("status <> 'resolved'");
  });
});

/** O comando do índice único da ocasião, até o `;` que o fecha. */
function indiceDaOcasiao(sql: string): string {
  const inicio = sql.indexOf("create unique index if not exists inbox_task_reminder_ocasiao_unique");
  return sql.slice(inicio, sql.indexOf(";", inicio));
}
