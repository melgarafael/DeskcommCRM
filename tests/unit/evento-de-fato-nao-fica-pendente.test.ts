/**
 * REGISTRO NÃO FICA `pending` (issue #753).
 *
 * ## O defeito que fez este arquivo existir
 *
 * O irmão deste arquivo (`evento-comando-tem-consumidor.test.ts`) cobra
 * consumidor para os `*_requested` e diz, no cabeçalho dele, que evento-FATO
 * "existe para realtime da UI, auditoria e consulta. Ninguém precisa
 * consumi-los". Isso está certo — e é metade do problema.
 *
 * O fato não precisa de consumidor, mas nasce `pending` do mesmo jeito:
 * `event_log.status` tem `DEFAULT 'pending'` e `emit_event` não escolhe status.
 * E quem DRENA filtra por tipo — `lib/event-log/drain.ts` seleciona
 * `status='pending'` **E** `event_type in (tipos com handler registrado)`; o
 * drain do agent-engine filtra `event_type='ai_agent.dispatch_requested'`.
 * Nenhum dos dois olha um tipo-fato: a linha nasce `pending` e morre `pending`.
 *
 * Na instalação da issue isso deu 626 linhas, 8 tipos, `consumed_by` vazio em
 * todas. A linha fica indistinguível de fila entupida para quem olha o painel —
 * e é invisível para quem deveria limpá-la, porque "na fila" e "sem dono" são o
 * mesmo estado no banco.
 *
 * ## O que este arquivo mede
 *
 *   (1) todo tipo emitido que não seja comando (`*_requested`) e não tenha
 *       consumidor está declarado como REGISTRO em `fn_event_log_e_registro`
 *       (migration 0239) — é essa lista que faz a linha nascer `done`;
 *   (2) a lista de registro não engole comando nem tipo consumido: fechar um
 *       consumido deixaria o handler no registry sem nunca rodar;
 *   (3) as listas declaradas aqui não envelhecem (tipo que deixou de ser
 *       emitido, emissor dinâmico que sumiu, namespace que fechou).
 *
 * A lista fica exaustiva por cobrança, não por promessa: é a asserção (1) que
 * aponta o tipo novo quando alguém emite sem consumidor.
 *
 * ## Por que lê também o SQL, e não só o TypeScript
 *
 * O irmão varre `p_event_type:` em `app/`, `lib/` e `workers/`. Metade dos
 * órfãos da issue nasce do outro lado:
 *
 *   - em SQL (`fn_log_event(<org>, 'tipo')` e o `CASE` que alimenta `v_event`
 *     em `fn_emit_message_event`, no baseline), e
 *   - em parâmetro que não é literal (`eventType`, `eventLogType`,
 *     `target.event`), que nenhum regex de literal alcança.
 *
 * Este arquivo varre os dois lados e DECLARA o que não é literal. É o
 * complemento do irmão, não uma cópia dele.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getRegisteredHandlers } from "@/lib/event-log/dispatcher";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";

const RAIZ = process.cwd();
const RAIZES = ["app", "lib", "workers"];
const BASELINE = join(RAIZ, "supabase", "baseline.sql");
const DIR_MIGRACOES = join(RAIZ, "supabase", "migrations");

/** Emissão por RPC (`emit_event` / `fn_log_event`) com o tipo literal. */
const EMISSAO_RPC = /p_event_type:\s*"([a-z0-9_.]+)"/g;
/** `from("event_log")` — o insert logo depois é o alvo (o de `followup_enrollment_events` não é). */
const EVENT_LOG_FROM = /from\("event_log"\)([\s\S]{0,600})/g;
const EMISSAO_INSERT = /\.insert\(\s*\{[^}]*?event_type:\s*"([a-z0-9_.]+)"/;
/** SQL cru dentro de TS (`pool.query(\`insert into event_log …\`)`). */
const EMISSAO_SQL_CRU = /insert\s+into\s+event_log\b[\s\S]{0,300}?values\s*\(\s*[^,()]+,\s*'([a-z0-9_.]+)'/g;
/** SQL: `fn_log_event(<org>, 'tipo'` — a forma do baseline e das migrations. */
const SQL_FN_LOG = /fn_log_event\s*\(\s*[^,()]+,\s*'([a-z0-9_.]+)'/g;
/** SQL: `insert into event_log(…) values (<org>, 'tipo'` — tipo sempre na 2ª posição. */
const SQL_INSERT = /insert\s+into\s+(?:public\.)?event_log\b[\s\S]{0,400}?values\s*\(\s*[^,()]+,\s*'([a-z0-9_.]+)'/g;
/** A definição da lista: `fn_event_log_e_registro(…) … array[ … ]`. */
const DEF_REGISTRO = new RegExp(
  String.raw`fn_event_log_e_registro\s*\([\s\S]{0,400}?array\[([\s\S]*?)\]`,
);

/**
 * Consumidores que NÃO são handlers do `event_log`. Mesma lista (e mesma razão)
 * do arquivo irmão: o registry não os conhece porque eles leem o `event_log`
 * direto, de outro processo.
 */
const CONSUMIDORES_FORA_DO_REGISTRY: Record<string, string> = {
  "ai_agent.dispatch_requested":
    "lib/agent-engine/edge/crm/drain.ts — o agent-engine roda em processo próprio " +
    "(serviço `worker` do docker-compose.prod.yml) e drena direto do event_log. " +
    "Quem é o dono é config: AGENT_DISPATCH_CONSUMER ('engine' default | 'native'), " +
    "e tests/invariants/agent-dispatch-single-consumer.test.ts prova que nunca são os dois.",
  "conversation.routing_requested":
    "lib/routing/worker.ts — o worker de distribuição roda pelo cron " +
    "`/api/v1/cron/routing-worker` e drena este tipo direto do event_log (migration 0040).",
};

/**
 * Emissões cujo TIPO não é literal no ponto da emissão: ou o SQL monta o valor
 * numa variável, ou o TS escolhe o tipo em runtime. Nenhum regex de literal as
 * acha — e é por isso que elas entram na conta por DECLARAÇÃO.
 *
 * `onde` é conferido pelo teste: o dia em que a emissão sumir daqui, a entrada
 * reprova em vez de mentir que aquilo ainda é emitido.
 */
const EMISSOES_DINAMICAS: Record<string, { onde: string[]; porque: string }> = {
  "message.sending": {
    onde: ["supabase/baseline.sql"],
    porque:
      "fn_emit_message_event monta `v_event` num CASE por `new.status` ('sending' → " +
      "'message.sending'), e chama fn_log_event com a variável.",
  },
  "message.outbound": {
    onde: ["supabase/baseline.sql"],
    porque: "mesmo CASE: qualquer status outbound fora de sending/sent/failed cai no `else`.",
  },
  "ai_agent.run_completed": {
    onde: ["lib/ai/runtime/finalize.ts"],
    porque: "o tipo é escolhido por ternário sobre `input.status` antes do emit_event.",
  },
  "ai_agent.run_failed": {
    onde: ["lib/ai/runtime/finalize.ts"],
    porque: "mesmo ternário — o ramo de falha do run.",
  },
  "lead.bulk_assigned": {
    onde: ["app/api/v1/leads/bulk/route.ts"],
    porque: "o tipo vem de `input.action` (assign | tag | delete) antes do emit_event.",
  },
  "lead.bulk_tagged": {
    onde: ["app/api/v1/leads/bulk/route.ts"],
    porque: "mesmo mapa de `input.action` no bulk de leads.",
  },
  "lead.bulk_deleted": {
    onde: ["app/api/v1/leads/bulk/route.ts"],
    porque: "mesmo mapa de `input.action` no bulk de leads.",
  },
};

/**
 * Tipo que já nasce `done` na ORIGEM, sem passar pela lista: quem emite escolhe
 * o status porque sabe que não há consumidor. É o precedente que a migration
 * 0239 generaliza, e a razão de estes tipos não precisarem aparecer em
 * `fn_event_log_e_registro` — o insert deles já fecha a linha em `done`, então a
 * lista não teria o que fazer. O teste cobra que continuem nascendo assim.
 */
const NASCE_DONE_NA_ORIGEM: Record<string, { onde: string[]; porque: string }> = {
  "agent.operator_turn": {
    onde: ["lib/agent-engine/agent/operator-turn.ts"],
    porque:
      "inserido com `status='done'` no mesmo statement (o turno do Operador é registro " +
      "por decisão explícita, documentada no cabeçalho do módulo).",
  },
  "voice_call.ended": {
    onde: ["lib/wacalls/events-bridge.ts"],
    porque:
      "inserido com `status='done'` no mesmo statement, com o comentário dizendo que a " +
      "linha nascia `pending` e ficava pendurada para sempre — o defeito da issue #753.",
  },
};

/**
 * Emissores cujo tipo é escolhido por DADO, não por código: nenhuma lista fixa
 * os alcança. Ficam declarados como dívida — a linha deles segue `pending` — e o
 * teste cobra que o emissor continue existindo, para a dívida não virar
 * esquecimento. Fechar isto é decidir o vocabulário, não escrever SQL.
 */
const NAMESPACE_ABERTO: Record<string, { onde: string; expressao: string }> = {
  "nuvemshop.<evento>": {
    onde: "app/api/v1/webhooks/nuvemshop/[event]/route.ts",
    expressao: "p_event_type: eventLogType",
  },
  "<target da regra de automacao>": {
    onde: "lib/automation/actions/add-tag.ts",
    expressao: "p_event_type: target.event",
  },
};

function arquivos(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : arquivos(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Baseline + todas as migrations: os dois caminhos de schema do repo. */
function arquivosSql(): string[] {
  return [
    BASELINE,
    ...readdirSync(DIR_MIGRACOES)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => join(DIR_MIGRACOES, f)),
  ];
}

/** Comentário `--` vira espaço do mesmo tamanho: prosa não é código. */
function semComentarios(sql: string): string {
  return sql.replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}

function tiposEmitidos(): Set<string> {
  const achados = new Set<string>();

  for (const f of RAIZES.flatMap(arquivos)) {
    const texto = readFileSync(f, "utf8");
    for (const m of texto.matchAll(EMISSAO_RPC)) achados.add(m[1]!);
    for (const m of texto.matchAll(EVENT_LOG_FROM)) {
      const ins = EMISSAO_INSERT.exec(m[1]!);
      if (ins) achados.add(ins[1]!);
    }
    for (const m of texto.matchAll(EMISSAO_SQL_CRU)) achados.add(m[1]!);
  }

  for (const f of arquivosSql()) {
    const texto = semComentarios(readFileSync(f, "utf8"));
    for (const m of texto.matchAll(SQL_FN_LOG)) achados.add(m[1]!);
    for (const m of texto.matchAll(SQL_INSERT)) achados.add(m[1]!);
  }

  for (const tipo of Object.keys(EMISSOES_DINAMICAS)) achados.add(tipo);
  for (const tipo of Object.keys(NASCE_DONE_NA_ORIGEM)) achados.add(tipo);

  return achados;
}

function tiposConsumidos(): Set<string> {
  ensureHandlersRegistered();
  const doRegistry = getRegisteredHandlers().flatMap((h) => h.events);
  return new Set([...doRegistry, ...Object.keys(CONSUMIDORES_FORA_DO_REGISTRY)]);
}

/** A lista que o banco usa para fechar o registro no nascimento. */
function tiposDeRegistro(): Set<string> {
  const achados = new Set<string>();
  for (const f of arquivosSql()) {
    const m = DEF_REGISTRO.exec(semComentarios(readFileSync(f, "utf8")));
    if (m) for (const x of m[1]!.matchAll(/'([a-z0-9_.]+)'/g)) achados.add(x[1]!);
  }
  return achados;
}

/**
 * O detector, isolado das fontes para poder ter controle negativo: um tipo
 * emitido, sem consumidor e fora da lista de registro é órfão — e órfão aqui
 * significa linha `pending` para sempre.
 *
 * `nascidosDone` sai da conta porque esses já fecham a própria linha na origem:
 * não é dívida, é outro caminho para o mesmo desfecho (e o teste cobra que
 * continuem sendo inseridos com `status='done'`).
 */
function orfaos(
  emitidos: Iterable<string>,
  consumidos: Set<string>,
  registro: Set<string>,
  nascidosDone: Set<string>,
): string[] {
  return [...emitidos]
    .filter((t) => !t.endsWith("_requested"))
    .filter((t) => !consumidos.has(t))
    .filter((t) => !registro.has(t))
    .filter((t) => !nascidosDone.has(t))
    .sort();
}

describe("evento-fato (registro) não fica `pending`", () => {
  describe("guardas de vacuidade (sem elas, verde por não medir nada)", () => {
    it("a varredura acha emissões nos dois lados", () => {
      // O irmão guarda `>= 20` só do lado TS. Aqui o piso é mais alto porque a
      // varredura inclui SQL: um regex que parasse de casar (`p_event_type` com
      // outro nome, `fn_log_event` com assinatura nova) devolveria poucos tipos
      // e as asserções abaixo ficariam verdes por ausência de dado.
      expect(tiposEmitidos().size).toBeGreaterThanOrEqual(30);
    });

    it("a lista de registro existe e não é vazia", () => {
      expect(tiposDeRegistro().size).toBeGreaterThanOrEqual(20);
    });

    it("o registry de handlers não vem vazio", () => {
      expect(tiposConsumidos().size).toBeGreaterThanOrEqual(5);
    });

    it("os dois caminhos de schema estão na varredura", () => {
      expect(arquivosSql().length).toBeGreaterThan(50);
    });
  });

  it("todo tipo emitido sem consumidor está declarado como registro", () => {
    const emitidos = tiposEmitidos();
    expect(
      orfaos(
        emitidos,
        tiposConsumidos(),
        tiposDeRegistro(),
        new Set(Object.keys(NASCE_DONE_NA_ORIGEM)),
      ),
      "tipo de evento emitido que ninguém consome e que NÃO está em " +
        "fn_event_log_e_registro (migration 0239) — a linha fica `pending` para " +
        "sempre (issue #753), indistinguível de fila entupida. Conserto: ou o " +
        "tipo entra na lista (é registro), ou ganha handler em " +
        "lib/event-log/register-handlers.ts, ou vira comando (`*_requested`). " +
        "Se a emissão escolhe o tipo em runtime, declare-a em EMISSOES_DINAMICAS; " +
        "se ela já insere com `status='done'`, declare em NASCE_DONE_NA_ORIGEM.",
    ).toEqual([]);
  });

  it("a lista de registro não engole comando nem tipo consumido", () => {
    // Fechar um tipo CONSUMIDO deixaria o handler no registry sem nunca rodar:
    // o drain seleciona `status='pending'` E `event_type in (handlers)`.
    const registro = [...tiposDeRegistro()].sort();
    const consumidos = tiposConsumidos();
    expect(
      registro.filter((t) => t.endsWith("_requested")),
      "comando (`*_requested`) na lista de registro: sem consumidor, o pedido não foi " +
        "atendido e a linha PRECISA ficar visível na fila (issue #129).",
    ).toEqual([]);
    expect(
      registro.filter((t) => consumidos.has(t)),
      "tipo com consumidor na lista de registro: ele nasceria `done` e o handler " +
        "registrado nunca rodaria.",
    ).toEqual([]);
  });

  it("todo tipo do registro é realmente emitido (a lista não envelhece)", () => {
    // Tipo que deixou de ser emitido e continua na lista mente para a próxima
    // pessoa: ela lê "isto é registro" sobre algo que não existe mais.
    const emitidos = tiposEmitidos();
    expect(
      [...tiposDeRegistro()].filter((t) => !emitidos.has(t)).sort(),
      "tipo na lista de registro que ninguém emite — remova de fn_event_log_e_registro",
    ).toEqual([]);
  });

  it("o backfill e o trigger estão nos DOIS caminhos de schema", () => {
    // A lista sozinha não conserta nada: quem faz a linha nascer `done` é o
    // trigger, e quem conserta o estoque é o backfill. Sem isto, um PR que
    // declarasse a lista "para o teste parar de reclamar" passaria.
    const comTrigger = arquivosSql().filter((f) => {
      const texto = readFileSync(f, "utf8");
      return texto.includes("trg_event_log_marca_registro") && texto.includes("fn_event_log_e_registro");
    });
    expect(comTrigger.length, "nem o baseline nem migration alguma liga o trigger").toBeGreaterThanOrEqual(2);
    for (const f of comTrigger) {
      const texto = semComentarios(readFileSync(f, "utf8"));
      expect(texto, `${f} não tem o trigger BEFORE INSERT`).toMatch(
        /before\s+insert\s+on\s+public\.event_log/,
      );
      expect(texto, `${f} não tem o backfill do estoque`).toMatch(
        /update\s+public\.event_log[\s\S]{0,200}?set\s+status\s*=\s*'done'/,
      );
    }
  });

  describe("as listas declaradas não envelhecem", () => {
    it("as emissões dinâmicas continuam sendo emitidas onde foram declaradas", () => {
      for (const [tipo, { onde, porque }] of Object.entries(EMISSOES_DINAMICAS)) {
        const achado = onde.some((f) => readFileSync(join(RAIZ, f), "utf8").includes(tipo));
        expect(
          achado,
          `${tipo} já não aparece em ${onde.join(" / ")} — remova de EMISSOES_DINAMICAS ` +
            `(declarado porque: ${porque})`,
        ).toBe(true);
      }
    });

    it("os tipos que nascem `done` na origem continuam nascendo assim", () => {
      for (const [tipo, { onde, porque }] of Object.entries(NASCE_DONE_NA_ORIGEM)) {
        // Não basta a string existir no arquivo: o insert tem de continuar
        // escrevendo `'done'` NO MESMO statement. Sem `done`, o tipo vira
        // exatamente o defeito da issue — linha `pending` sem dono — e a
        // declaração aqui passaria a ser uma anistia.
        const achado = onde.some((f) =>
          new RegExp(
            `insert\\s+into\\s+event_log[\\s\\S]{0,300}?'${tipo.replace(/\./g, "\\.")}'[\\s\\S]{0,120}?'done'`,
          ).test(readFileSync(join(RAIZ, f), "utf8")),
        );
        expect(achado, `${tipo} já não nasce 'done' em ${onde.join(" / ")} — ${porque}`).toBe(true);
      }
    });

    it("os emissores de namespace aberto continuam existindo", () => {
      for (const [nome, { onde, expressao }] of Object.entries(NAMESPACE_ABERTO)) {
        expect(
          readFileSync(join(RAIZ, onde), "utf8").includes(expressao),
          `${nome}: ${onde} já não emite com \`${expressao}\` — a dívida mudou de forma, ` +
            "reveja NAMESPACE_ABERTO (e a nota de dívida no cabeçalho da migration 0239).",
        ).toBe(true);
      }
    });
  });

  describe("controle negativo — o detector enxerga o órfão quando ele existe", () => {
    it("acusa um tipo emitido sem consumidor e fora da lista", () => {
      const emitidos = new Set(["lead.created", "lead.etapa_nova_sem_dono"]);
      const consumidos = new Set(["lead.created"]);
      expect(orfaos(emitidos, consumidos, new Set(), new Set())).toEqual([
        "lead.etapa_nova_sem_dono",
      ]);
    });

    it("não acusa comando, nem tipo consumido, nem tipo na lista, nem quem nasce `done`", () => {
      const emitidos = new Set([
        "message.send_requested",
        "lead.created",
        "message.sent",
        "agent.operator_turn",
      ]);
      const consumidos = new Set(["lead.created"]);
      expect(
        orfaos(emitidos, consumidos, new Set(["message.sent"]), new Set(["agent.operator_turn"])),
      ).toEqual([]);
    });

    it("a extração da lista distingue lista ausente de lista vazia", () => {
      // Sem esta distinção, um regex que parasse de casar devolveria conjunto
      // vazio e a asserção principal passaria com a lista INTEIRA acusada de
      // órfã — ou, pior, ninguém saberia qual dos dois aconteceu.
      const semDefinicao = "create or replace function public.fn_outra() returns boolean as $$ select true; $$;";
      expect(DEF_REGISTRO.exec(semComentarios(semDefinicao))).toBeNull();
      const comDefinicao =
        "create or replace function public.fn_event_log_e_registro(p text) returns boolean " +
        "language sql as $$ select p = any (array['a.b']::text[]); $$;";
      expect(DEF_REGISTRO.exec(comDefinicao)?.[1]).toContain("'a.b'");
    });
  });
});
