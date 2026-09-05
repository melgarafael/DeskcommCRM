import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * O CHECK do banco e o tipo do TypeScript falam o MESMO vocabulário.
 *
 * Achado do `@MaestroConexoes`/`@Arquiteto`: a entrega curou a divergência de
 * listas com gate de **compilador** — `Record<ActivityType, string>` exaustivo,
 * `satisfies keyof TimelineItem`. Isso resolve listas que vivem as duas em
 * TypeScript, e é elegante.
 *
 * **Mas o compilador não enxerga o banco.** Esta é a única classe de divergência
 * que o gate atual não pega *por construção*, e o modo de falha é o pior de
 * todos: passa no `typecheck`, passa no `lint`, passa no unitário — e aparece em
 * produção como `23514` num INSERT de caminho pouco exercitado. É o perfil exato
 * do intermitente que já custou duas rodadas de diagnóstico nesta entrega.
 *
 * A justificativa não é doutrina, é **taxa**: quatro pares desse eixo nasceram
 * em dois dias (`actor_kind` na 0071, `owner_kind` na 0070, `agent_inbox_items.kind`
 * e o que vier na 0073).
 *
 * ⚠️ **Ausência de CHECK aqui é DECISÃO, não lacuna.** `crm_lead_activities.type`
 * fica deliberadamente **sem** CHECK — está escrito com o motivo em
 * `lib/leads/activity-vocabulary.ts`: um clone com tipo legado quebraria no
 * `update.sh`, e a doutrina de migrations proíbe. Este invariante cobre **apenas
 * colunas que JÁ TÊM CHECK**. Quem ler isto daqui a três meses e quiser
 * "completar" adicionando um CHECK em `type` estaria consertando o que está
 * certo.
 */

/**
 * Os pares. Coluna nova com CHECK de conjunto → uma linha aqui.
 *
 * ⚠️ O par aponta para o ARQUIVO e o SÍMBOLO — nunca transcreve os valores.
 * A versão anterior os copiava, e o resultado é o defeito que este invariante
 * existe para pegar, uma camada acima: ele comparava o banco com uma cópia
 * MANUAL do TypeScript, então era ELE PRÓPRIO a terceira lista. Medido por
 * sabotagem: removendo um membro do union type DE VERDADE, o invariante passava
 * VERDE. Invariante presumido é pior que invariante nenhum — ele CONSOME a
 * atenção que iria para uma checagem de verdade.
 */
const PARES: Array<{
  tabela: string;
  coluna: string;
  arquivo: string;
  simbolo: string;
}> = [
  {
    tabela: "crm_lead_activities",
    coluna: "actor_kind",
    // lib/leads/activity-emitter.ts → ActivityActorKind
    arquivo: "lib/leads/activity-emitter.ts",
    simbolo: "ActivityActorKind",
  },
  {
    tabela: "crm_leads",
    coluna: "owner_kind",
    // lib/types/leads.ts → OwnerKind (o `null` do tipo é a ausência de dono, e
    // não um valor do CHECK — por isso não entra na lista).
    arquivo: "lib/types/leads.ts",
    simbolo: "OwnerKind",
  },
  {
    tabela: "crm_lead_scores",
    coluna: "ai_probability_band",
    // lib/kanban/score-band.ts → ScoreBand. Nasce com o par no mesmo commit da
    // migration: a taxa deste eixo é de quatro pares em dois dias, e todos os
    // que divergiram divergiram por terem nascido sozinhos.
    arquivo: "lib/kanban/score-band.ts",
    simbolo: "ScoreBand",
  },
  {
    tabela: "crm_leads",
    coluna: "status",
    // lib/types/leads.ts → LeadStatus.
    //
    // Este par entra como PROVA do conserto do extrator, não por acaso: é a
    // coluna com DUAS constraints casando por substring (a que define o enum e a
    // que amarra `closed_at`). Com o extrator antigo, o `limit 1` sem `order by`
    // podia devolver [lost, won] — e o par reprovaria por motivo falso.
    arquivo: "lib/types/leads.ts",
    simbolo: "LeadStatus",
  },
  {
    tabela: "ai_invocations",
    coluna: "invocation_kind",
    // lib/ai/log-invocation.ts → InvocationKind.
    //
    // Par nascido de divergência REAL, achada junto com a issue #160: o tipo
    // oferecia quatro valores que o CHECK recusa (`sentiment_check`,
    // `embed_chunk`, `embed_query`, `intent_classify`) e omitia dois que ele
    // aceita (`triage_classify`, `embedding_generate`). Nenhum estava em uso,
    // então não havia sintoma — o defeito era uma armadilha carregada: o insert
    // é fire-and-forget, então quem escolhesse um deles pelo autocomplete
    // colheria um `23514` que nunca chega à tela de ninguém. É o mesmo modo de
    // falha que deixou esta tabela VAZIA numa VPS com tráfego real.
    arquivo: "lib/ai/log-invocation.ts",
    simbolo: "InvocationKind",
  },
  {
    tabela: "agent_inbox_items",
    coluna: "kind",
    // lib/agent-engine/db/repository.ts → InboxKind.
    //
    // Este par nasceu de um defeito REAL, não de zelo: a lista do TS ficou 3
    // valores atrás do banco e ninguém soube. Pior, o dev checkou a lista
    // contra o BANCO DE DEV, que estava numa versão ANTERIOR da constraint e
    // não aceitava `followup_dead` — enquanto lib/followup/engine.ts o insere.
    // O aviso que existe para salvar um follow-up travado era rejeitado pelo
    // banco, em silêncio, num caminho fire-and-forget.
    //
    // Por isso este invariante lê do Postgres DESCARTÁVEL que nasce do
    // `baseline.sql` versionado (TEST_DB_CONTAINER), nunca do banco de dev: o
    // banco de dev conta o que aconteceu com ele, não o que o sistema promete.
    arquivo: "lib/agent-engine/db/repository.ts",
    simbolo: "InboxKind",
  },
  {
    tabela: "agent_case_events",
    coluna: "kind",
    // lib/agent-engine/agent/human-cases.ts → CaseEventKind.
    //
    // O par nasce no MESMO commit da 0100, que acrescentou 'agent_noted' à
    // constraint. Antes dele o TypeScript não tinha lista nenhuma: cada INSERT
    // escrevia o kind como string literal, e o único aviso de divergência seria
    // um 23514 em produção, num caminho fire-and-forget (o registro do agente no
    // chamado) que ninguém exercita em dev.
    arquivo: "lib/agent-engine/agent/human-cases.ts",
    simbolo: "CaseEventKind",
  },
  {
    tabela: "system_update_runs",
    coluna: "status",
    // lib/system/update-run.ts → RunStatus
    arquivo: "lib/system/update-run.ts",
    simbolo: "RunStatus",
  },
  {
    tabela: "system_update_runs",
    coluna: "last_step",
    // lib/system/update-run.ts → RunStep
    arquivo: "lib/system/update-run.ts",
    simbolo: "RunStep",
  },
  {
    tabela: "channel_sessions",
    coluna: "provider",
    // lib/channels/types.ts → ChannelProvider
    //
    // ⚠️ O `comment on column public.channel_sessions.provider` do
    // `supabase/baseline.sql` já AFIRMA, desde a 0087, que este par é "cobrado
    // por tests/invariants/vocabulario-banco-x-typescript.test.ts". Era falso: o
    // par nunca estava nesta lista. Comentário não é gate, e um comentário que
    // promete cobertura inexistente é pior que silêncio — ele desliga a busca.
    //
    // Medido na triagem do PR que acrescenta o TERCEIRO canal: o `zernio` entrou
    // no CHECK do banco e em `ChannelProvider` no mesmo commit, e nenhum job do
    // CI compararia as duas listas se ele tivesse entrado em só uma. O sintoma
    // seria `23514` no INSERT da sessão — ou, pior, uma sessão que grava e um
    // `capabilitiesOf` que lança `unknown_channel_provider` no envio.
    //
    // `channel_sessions_provider_ref_check` menciona a coluna e tem literais,
    // mas NÃO é uma definidora para `literaisSeDefine` (é disjunção de ANDs, não
    // `col = ANY (ARRAY[...])`) — então este par não colide com ela. Medido, não
    // suposto: com as duas constraints no banco, `valoresDoCheck` devolve uma só.
    arquivo: "lib/channels/types.ts",
    simbolo: "ChannelProvider",
  },
  {
    tabela: "followup_enrollments",
    coluna: "status",
    // hooks/followup/useFollowupQueue.ts → FollowupEnrollmentStatus.
    //
    // O par aponta para o tipo da TELA, e não para `EnrollmentStatus` de
    // `lib/followup/node-handlers.ts`, porque são conjuntos diferentes de
    // propósito: o do motor enumera o que o motor manipula, e o motor nunca lê
    // nem escreve `paused_manual` (o claim filtra `active|waiting_reply`). Quem
    // precisa conhecer TODOS os estados é quem os mostra — a fila.
    //
    // Nasce junto com a 0145, que acrescentou o sétimo valor. Sem o par, um
    // status novo no CHECK vira linha na fila com rótulo cru: `rotuloDoStatus`
    // cai no fallback e a tela mostra o identificador do banco no rosto de quem
    // opera.
    arquivo: "hooks/followup/useFollowupQueue.ts",
    simbolo: "FollowupEnrollmentStatus",
  },
  {
    tabela: "ai_budgets",
    coluna: "enforcement_mode",
    // lib/agent-engine/edge/llm/orcamento.ts → ModoDeOrcamento.
    //
    // Nasce com um erro de classificação já cometido: a 0159 e o MANIFEST
    // declararam `ai_budgets_enforcement_mode_check` como "cross-coluna / de
    // domínio, não de vocabulário", e por isso a coluna ficou de fora daqui. É
    // falso — `check (enforcement_mode in ('off','avisar','bloquear'))` é
    // vocabulário puro de conjunto, e o par em TypeScript não só existe como
    // roda no caminho quente (é ele que decide se a IA responde).
    //
    // A OUTRA constraint da mesma coluna, `ai_budgets_bloquear_precisa_de_teto`
    // (`enforcement_mode <> 'bloquear' or monthly_limit_cents >= 100`), essa sim
    // é cross-coluna: `literaisSeDefine` a recusa por não casar
    // `col = ANY (ARRAY[...])`, então continua havendo UMA definidora só e o
    // extrator não precisa escolher.
    arquivo: "lib/agent-engine/edge/llm/orcamento.ts",
    simbolo: "ModoDeOrcamento",
  },
  {
    tabela: "followup_flow_pointers",
    coluna: "surface",
    // lib/followup/api-schemas.ts → FOLLOWUP_FLOW_SURFACES (tupla `as const`).
    // O type alias `FollowupFlowSurface = (typeof …)[number]` não carrega
    // literais no fonte — o extrator lê a const, que é a fonte em runtime
    // (`z.enum` / UI) e a que o CHECK do banco precisa espelhar.
    arquivo: "lib/followup/api-schemas.ts",
    simbolo: "FOLLOWUP_FLOW_SURFACES",
  },
  {
    tabela: "webhook_lead_captures",
    coluna: "outcome",
    // lib/schemas/lead-captures.ts → DESFECHOS_DA_CAPTACAO.
    //
    // A tela pinta um badge por valor ("Virou lead" / "Reenvio" / "Não entrou")
    // e filtra por ele. Um desfecho novo só no CHECK viraria linha sem rótulo e
    // opção de filtro que não existe; só no TypeScript viraria `23514` num
    // INSERT que roda dentro da rota PÚBLICA de captação — e ali o registro é
    // fire-and-forget, ou seja, o histórico simplesmente não apareceria.
    arquivo: "lib/schemas/lead-captures.ts",
    simbolo: "DESFECHOS_DA_CAPTACAO",
  },
  {
    tabela: "automation_rule_runs",
    coluna: "status",
    // hooks/webhooks/useAutomationRules.ts → AutomationRunStatus.
    //
    // O par aponta para o tipo da TELA porque é ela quem precisa conhecer TODOS
    // os estados: `statusBadgeLabel` mapeia cada um para um texto em português,
    // e um valor sem entrada cai no rótulo de "Parcial" — dizendo que algo
    // falhou quando nada foi sequer tentado.
    //
    // Nasce com a 0175, que acrescentou `adiado` (a espera é um estado; sem ele
    // a aba Atividade não mostrava NADA enquanto a regra aguardava a janela).
    arquivo: "hooks/webhooks/useAutomationRules.ts",
    simbolo: "AutomationRunStatus",
  },
  {
    tabela: "crm_tasks",
    coluna: "priority",
    // lib/tarefas/tipos.ts → PRIORIDADES_DA_TAREFA. Nasce com o par no mesmo
    // commit da migration 0210, que é a lição desta lista: todos os que
    // divergiram divergiram por terem nascido sozinhos.
    arquivo: "lib/tarefas/tipos.ts",
    simbolo: "PRIORIDADES_DA_TAREFA",
  },
  {
    tabela: "crm_tasks",
    coluna: "status",
    // lib/tarefas/tipos.ts → SITUACOES_DA_TAREFA.
    arquivo: "lib/tarefas/tipos.ts",
    simbolo: "SITUACOES_DA_TAREFA",
  },
];

/** Tira um nível de parênteses externos, se ele envolver a expressão inteira. */
function desembrulha(expr: string): string {
  let e = expr.trim();
  while (e.startsWith("(") && e.endsWith(")")) {
    let nivel = 0;
    let fechaNoFim = true;
    for (let i = 0; i < e.length; i++) {
      if (e[i] === "(") nivel++;
      else if (e[i] === ")") {
        nivel--;
        if (nivel === 0 && i < e.length - 1) {
          fechaNoFim = false;
          break;
        }
      }
    }
    if (!fechaNoFim) break;
    e = e.slice(1, -1).trim();
  }
  return e;
}

/**
 * Os literais de uma constraint — **só se ela DEFINIR o vocabulário**.
 *
 * A versão anterior casava por substring (`like '%= ANY (ARRAY[%'`), e isso
 * seleciona qualquer constraint que MENCIONE valores da coluna. Medido no banco:
 * `crm_leads.status` tem duas, e a diferença entre elas é a diferença entre
 * medir o vocabulário e medir uma regra de negócio —
 *
 *   crm_leads_status_enum ............ CHECK (status = ANY (ARRAY[open, won, lost]))   ← DEFINE
 *   crm_leads_closed_at_consistency .. CHECK (... status = ANY (ARRAY[won, lost]) AND closed_at IS NOT NULL)  ← só menciona
 *
 * Hoje passaria por SORTE, porque `limit 1` sem `order by` escolhe uma das duas
 * e as duas têm literais parecidos. No dia em que uma regra composta injetar um
 * valor que não é vocabulário, o invariante aprova ou reprova por motivo FALSO —
 * e invariante que erra por motivo falso é pior que invariante nenhum, porque é
 * obedecido.
 *
 * Aceita as duas formas que DEFINEM: `col = ANY (ARRAY[...])` e a variante com
 * `col IS NULL OR ...`, que é como se escreve "opcional, mas se vier tem de ser
 * um destes".
 */
function literaisSeDefine(def: string, coluna: string): string[] | null {
  const semCheck = desembrulha(def.trim().replace(/^CHECK\s*/i, ""));
  const col = coluna.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // "col IS NULL OR <resto>" — a permissão de nulo não descaracteriza a definição.
  const semNulo = desembrulha(
    desembrulha(semCheck).replace(new RegExp(`^\\(?${col}\\)?\\s+IS NULL\\)?\\s+OR\\s+`, "i"), ""),
  );

  const m = new RegExp(`^\\(?${col}\\)?\\s*=\\s*ANY\\s*\\(ARRAY\\[(.+)\\]\\)$`, "is").exec(semNulo);
  if (!m) return null;
  return [...m[1]!.matchAll(/'([^']+)'::text/g)].map((x) => x[1]!).sort();
}

/**
 * O vocabulário que o banco aceita para a coluna.
 *
 * Se DUAS constraints definirem o conjunto, isto RECUSA em vez de escolher —
 * mesmo princípio do `resolveActiveLeadForContact`. Adivinhar num instrumento de
 * medição é pior que num roteador: o roteador erra um card, o instrumento erra o
 * veredito sobre todos.
 */
function valoresDoCheck(tabela: string, coluna: string): string[] {
  const bruto = sql(
    `select pg_get_constraintdef(k.oid)
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_attribute a on a.attrelid = c.oid and a.attnum = any(k.conkey)
      where k.contype = 'c'
        and c.relname = '${tabela}'
        and a.attname = '${coluna}'
      order by k.conname`,
  );

  const definidoras = bruto
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((def) => ({ def, valores: literaisSeDefine(def, coluna) }))
    .filter((x): x is { def: string; valores: string[] } => x.valores !== null);

  if (definidoras.length > 1) {
    throw new Error(
      `${tabela}.${coluna}: ${definidoras.length} constraints DEFINEM o vocabulário — ` +
        `me recuso a escolher uma, porque escolher errado dá veredito falso sobre ` +
        `todos os pares. Constraints:\n` +
        definidoras.map((d) => `  ${d.def}`).join("\n"),
    );
  }
  return definidoras[0]?.valores ?? [];
}


/**
 * Os literais do union type, LIDOS DO ARQUIVO — nunca transcritos.
 *
 * ⚠️ TODA FALHA DE EXTRAÇÃO ESTOURA, e isso não é zelo: se o regex deixar de
 * casar — o type ganha um comentário no meio, muda de arquivo, é reformatado, é
 * trocado por um `const ... as const` — a lista extraída viraria `[]` e a
 * comparação passaria POR VACUIDADE. O instrumento diria "banco e TypeScript
 * concordam" quando o que houve foi ele deixar de ler.
 *
 * Zero valores extraídos é ERRO DO INSTRUMENTO, jamais conjunto vazio legítimo:
 * não existe union type de vocabulário sem membro nenhum. A mesma regra do lado
 * do banco, onde duas constraints definidoras fazem o extrator se RECUSAR a
 * escolher em vez de chutar.
 */
function literaisDoUnionType(arquivo: string, simbolo: string): string[] {
  let fonte: string;
  try {
    fonte = readFileSync(arquivo, "utf8");
  } catch {
    throw new Error(
      `extrator de vocabulário: não consegui ler ${arquivo} (par ${simbolo}). ` +
        `O arquivo mudou de lugar? Corrigir o caminho é o conserto; apagar o par NÃO.`,
    );
  }

  // ⚠️ COMENTÁRIOS SAEM ANTES DE PROCURAR A DECLARAÇÃO, e a ordem é o conserto.
  //
  // A versão anterior recortava `type X =([^;]*);` do fonte CRU e só então
  // limpava comentários. Como `[^;]*` para no primeiro ponto e vírgula, um `;`
  // escrito dentro de um comentário NO MEIO do union truncava a lista — e os
  // membros abaixo dele sumiam sem que nada estourasse.
  //
  // Não é hipotético: aconteceu com `InboxKind`, num comentário que explicava a
  // diferença entre dois kinds — "um relata que algo ACONTECEU e a IA segue; o
  // outro, que ela parou". A extração parou em `segue`, devolveu 19 dos 21
  // membros, e o par reprovou dizendo que o TypeScript não declarava
  // `budget_warning` nem `other`. Os dois estavam lá, seis linhas abaixo.
  //
  // O modo de falha é o pior possível para um gate: ele acusa o CÓDIGO por um
  // defeito do INSTRUMENTO, com uma mensagem convincente, e manda o próximo
  // consertar o que estava certo. A guarda de "zero literais" logo abaixo não
  // pega este caso — a lista truncada não é vazia.
  //
  // Prosa em português tem ponto e vírgula. O extrator é que não podia depender
  // de a prosa não ter.
  const semComentarios = fonte.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  // DUAS FORMAS, e as duas são vocabulário legítimo neste repo:
  //
  //   type X = "a" | "b";                 ← union puro
  //   const X = ["a", "b"] as const;      ← tupla congelada
  //
  // A segunda existe porque o Zod precisa do ARRAY em runtime (`z.enum(X)`), e
  // escrever o union ao lado seria a terceira lista — exatamente o que este
  // invariante existe para proibir. O extrator lia só a primeira e mandava
  // "ENSINE O EXTRATOR"; esta é a lição aprendida, e não uma exceção aberta:
  // as duas formas caem no MESMO caminho de comparação abaixo.
  const decl =
    new RegExp(`type\\s+${simbolo}\\s*=([^;]*);`, "s").exec(semComentarios) ??
    new RegExp(`const\\s+${simbolo}\\s*=\\s*(\\[[^\\]]*\\])\\s*as\\s+const`, "s").exec(
      semComentarios,
    );
  if (!decl) {
    throw new Error(
      `extrator de vocabulário: não achei \`type ${simbolo} = ...;\` nem ` +
        `\`const ${simbolo} = [...] as const\` em ${arquivo}. Se o símbolo mudou de nome ou ` +
        `de forma, ENSINE O EXTRATOR — deixar isto falhar em silêncio devolveria lista vazia ` +
        `e o par passaria sem ler nada.`,
    );
  }

  // Comentários saem ANTES da extração: um `// "user" era o default` no meio do
  // union entraria como valor e o par reprovaria por motivo falso.
  const corpo = decl[1]!.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const valores = [...corpo.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!);

  if (valores.length === 0) {
    throw new Error(
      `extrator de vocabulário: \`type ${simbolo}\` em ${arquivo} não rendeu literal nenhum. ` +
        `Isso é falha do INSTRUMENTO, não vocabulário vazio — union type de vocabulário ` +
        `sem membro não existe.`,
    );
  }
  return [...valores].sort();
}

describe("vocabulário: banco × TypeScript", () => {
  it("a tabela de pares não pode vir vazia", () => {
    // Sem esta guarda, esvaziar PARES faria a suíte passar sem verificar nada —
    // verde vácuo no nível do arquivo, que esta entrega já pegou duas vezes.
    expect(PARES.length).toBeGreaterThan(0);
  });

  for (const par of PARES) {
    it(`${par.tabela}.${par.coluna} aceita exatamente o que ${par.simbolo} (${par.arquivo}) declara`, () => {
      const noBanco = valoresDoCheck(par.tabela, par.coluna);
      expect(
        noBanco.length,
        `${par.tabela}.${par.coluna} não tem CHECK de conjunto — ou a coluna mudou, ou o par saiu da lista`,
      ).toBeGreaterThan(0);

      const noTs = literaisDoUnionType(par.arquivo, par.simbolo);
      expect(
        noBanco,
        `divergência de vocabulário — o compilador NÃO pega esta:\n` +
          `  banco aceita: ${noBanco.join(", ")}\n` +
          `  ${par.simbolo} (${par.arquivo}) declara: ${noTs.join(", ")}`,
      ).toEqual(noTs);
    });
  }
});
