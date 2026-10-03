/**
 * O SILÊNCIO DA JANELA ANTI-BAN TEM QUE DEIXAR RASTRO.
 *
 * ─── O defeito, medido em produção (VPS, domingo 2026-08-30) ──────────────
 *
 * `channel_knobs.allow_sunday = false` fazia `inbound-turn.ts` adiar TODO turno
 * de domingo para segunda às 7h. O adiamento é a decisão certa. O problema era
 * o registro: `runLog.info(...)` + `throw JobSettledError` e **nada mais** —
 * sem linha em `agent_inbox_items`, sem atividade no lead, sem marca na Inbox.
 *
 * Um turno adiado também não aparece em `llm_calls`, porque não houve chamada de
 * modelo. Resultado: a instalação passou um domingo inteiro muda, com todos os
 * contêineres `healthy`, e o dono sem UM lugar para olhar.
 *
 * ─── As duas pontas, e por que as duas são necessárias ────────────────────
 *
 * Só abrir o aviso resolveria metade e criaria outro problema: na segunda o
 * número volta a atender e o painel seguiria dizendo que está calado. Por isso
 * o teste guarda ABRIR e RESOLVER — e a resolução mora no mesmo ponto do turno
 * que a abertura, não num cron.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  avisarJanelaFechada,
  resolverAvisoDeJanela,
  REF_KIND_JANELA,
} from "@/lib/agent-engine/pacing/aviso-de-janela";

const ORG = "22222222-2222-4222-8222-222222222222";
const CANAL = "66666666-6666-4666-8666-666666666666";

interface Executado {
  sql: string;
  params: unknown[];
}

function dublePool(rowCount = 1) {
  const executados: Executado[] = [];
  const db = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      executados.push({ sql, params: params ?? [] });
      return { rows: [], rowCount };
    }),
  };
  return { db, executados };
}

const BASE = {
  tenantId: ORG,
  channelSessionId: CANAL,
  abertura: new Date("2026-08-31T10:00:00.000Z"),
  janela: "7h-22h",
  timezone: "America/Sao_Paulo",
  domingoDesligado: true,
};

describe("aviso de janela fechada", () => {
  it("abre UM aviso por CANAL, com dedup — 50 pessoas no domingo não viram 50 avisos", async () => {
    const { db, executados } = dublePool();
    await avisarJanelaFechada(db as never, BASE);

    const { sql, params } = executados[0]!;
    expect(sql).toContain("insert into agent_inbox_items");
    // O dedup é o que separa um aviso de uma tempestade: sem o `not exists`,
    // cada mensagem recebida no domingo abriria um item.
    expect(
      sql.replace(/\s+/g, " "),
      "sem `where not exists`, cada mensagem recebida vira um aviso novo",
    ).toContain("where not exists");
    expect(sql).toContain("status = 'open'");
    // ref_id é o CANAL, não a conversa: a janela fecha para o número inteiro.
    expect(params).toContain(CANAL);
    expect(params).toContain(REF_KIND_JANELA);
  });

  it("severity está no vocabulário que o banco aceita", () => {
    // Medido contra o CHECK real de `agent_inbox_items.severity`:
    // info | warn | critical. A primeira versão deste arquivo escreveu
    // 'warning', que o dublê aceita e o Postgres recusa — e como a chamada é
    // fire-and-forget, o erro seria engolido e o silêncio voltaria a ser
    // invisível. Um dublê não valida CHECK; esta asserção valida.
    const fonte = readFileSync(
      join(process.cwd(), "lib/agent-engine/pacing/aviso-de-janela.ts"),
      "utf8",
    );
    // Mede o VALOR na linha do INSERT, não o arquivo inteiro: a primeira versão
    // desta asserção varria tudo e reprovava por causa da palavra "warning"
    // escrita DENTRO do comentário que explica o conserto — uma sonda que acusa
    // o texto que documenta o acerto.
    const linhaDoSelect = /select \$1, '[^']+', '([^']+)', \$2/.exec(fonte);
    expect(
      linhaDoSelect,
      "não achei a linha do INSERT — a sonda ficou cega para a forma do SQL",
    ).not.toBeNull();
    expect(
      ["info", "warn", "critical"],
      `severity '${linhaDoSelect?.[1]}' estoura o CHECK de agent_inbox_items.severity`,
    ).toContain(linhaDoSelect?.[1]);
  });

  it("o corpo diz QUANDO volta e O QUE FAZER — informação com propósito", async () => {
    const { db, executados } = dublePool();
    await avisarJanelaFechada(db as never, BASE);

    const corpo = String(executados[0]!.params[2]);
    // Sem a hora de volta, o aviso informa um problema e nenhuma decisão.
    // Formato ISO-like (`sv-SE`): o corpo é persistido e o produto tem duas
    // línguas — data em pt-BR apareceria em português para quem lê em espanhol.
    expect(corpo).toMatch(/2026-08-31/);
    expect(
      corpo,
      "a data do aviso não pode ser formatada em pt-BR — o corpo é persistido e o produto é bilíngue",
    ).not.toMatch(/31\/08/);
    // Com o domingo desligado existe uma AÇÃO concreta, e ela tem de estar dita.
    expect(corpo).toContain("Enviar aos domingos");
    expect(corpo).toContain("Anti-ban");
    // E a garantia que evita o pânico: nada se perdeu.
    expect(corpo).toMatch(/nenhuma mensagem se perde/i);
  });

  it("fora do domingo, o aviso NÃO manda mexer no botão de domingo", async () => {
    // O mesmo texto nos dois casos mandaria o operador desligar uma proteção
    // que não tem nada a ver com o silêncio das 23h.
    const { db, executados } = dublePool();
    await avisarJanelaFechada(db as never, { ...BASE, domingoDesligado: false });

    const corpo = String(executados[0]!.params[2]);
    expect(corpo).not.toContain("Enviar aos domingos");
    expect(corpo).toMatch(/não é preciso fazer nada/i);
  });

  it("resolve o aviso quando a janela reabre — o laço fecha onde foi aberto", async () => {
    const { db, executados } = dublePool();
    const n = await resolverAvisoDeJanela(db as never, {
      tenantId: ORG,
      channelSessionId: CANAL,
    });

    const { sql, params } = executados[0]!;
    expect(sql).toContain("update agent_inbox_items");
    expect(sql).toContain("'resolved'");
    // Só os abertos DESTE canal: resolver por org apagaria avisos de outro número.
    expect(sql).toContain("status = 'open'");
    expect(params).toEqual([ORG, REF_KIND_JANELA, CANAL]);
    expect(n).toBe(1);
  });

  it("devolve 0 quando já havia aviso aberto — o chamador sabe não logar de novo", async () => {
    const { db } = dublePool(0);
    expect(await avisarJanelaFechada(db as never, BASE)).toBe(0);
  });
});

/**
 * As funções acima podem estar perfeitas e não serem chamadas por ninguém — é o
 * ponto cego clássico de teste de unidade: ele guarda a FUNÇÃO, não o CALL SITE.
 * Um aviso que existe e nunca é aberto deixa o defeito original de pé, com a
 * suíte verde.
 *
 * A cerca é sobre o fonte porque o caminho do turno exige job, pool, provider e
 * orçamento para ser alcançado — exercitá-lo mediria o dublê. O que ela prende é
 * a LIGAÇÃO, e ela vale nas duas direções: abrir sem resolver deixaria um aviso
 * eterno pendurado na segunda-feira.
 */
describe("o turno realmente CHAMA o aviso — nas duas direções", () => {
  const turno = readFileSync(
    join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
    "utf8",
  );

  it("o adiamento por janela abre o aviso", () => {
    expect(
      /avisarJanelaFechada\s*\(/.test(turno),
      "inbound-turn.ts não chama avisarJanelaFechada — o silêncio volta a ser invisível",
    ).toBe(true);
  });

  it("a janela aberta resolve o aviso", () => {
    expect(
      /resolverAvisoDeJanela\s*\(/.test(turno),
      "inbound-turn.ts não chama resolverAvisoDeJanela — o aviso ficaria pendurado depois que o número volta a atender",
    ).toBe(true);
  });

  it("as duas chamadas estão no MESMO gate — a resolução não pode viver noutro lugar", () => {
    // Se a resolução migrar para um cron ou para outro ponto do turno, o laço
    // deixa de fechar onde foi aberto e volta a depender de varredura.
    const gate = turno.slice(
      turno.indexOf("janelaDeEnvioAberta(agora, knobs"),
      turno.indexOf("Fase 3: stickiness do router"),
    );
    expect(gate).toContain("avisarJanelaFechada");
    expect(gate).toContain("resolverAvisoDeJanela");
  });
});
