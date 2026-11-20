/**
 * De que é feito o pedido de um agente — só leitura.
 *
 *   pnpm ops:count-prefix --org <uuid> --agent <uuid> [--dias 7]
 *
 * Na VPS (a imagem do worker tem o código e o tsx; o `.env` entra por env_file):
 *
 *   docker compose -f docker-compose.prod.yml run --rm --no-deps worker \
 *     node --import tsx scripts/ops-count-prefix.ts --org <uuid> --agent <uuid>
 *
 * `run`, e não `exec`: o `exec` roda DENTRO do contêiner do worker, que tem teto de
 * 512 MB (`mem_limit`), e este script sozinho chegou a 257–336 MB de pico (medido
 * em 31/10/2026); somado aos ~230 MB do worker, o OOM pode matar o atendimento.
 * O `run --rm` sobe um contêiner à parte, com o próprio teto, e o apaga no fim.
 *
 * Três seções:
 *  1. PRODUÇÃO — o que `llm_calls` gravou (migration 9105) nas chamadas `ok` do
 *     agente: passos, entrada real do 1º passo, caracteres por parte, rateio
 *     estimado dos tokens (só chamadas sem mídia) e prefixos distintos.
 *  2. SISTEMA POR BLOCO — os blocos fixos do sistema, montados pelas MESMAS
 *     funções e constantes do turno, em caracteres e tokens o200k.
 *  3. FERRAMENTAS CANDIDATAS — as ferramentas do agente serializadas como o
 *     provedor as recebe. Candidatas, não as enviadas: as regras de inclusão do
 *     turno não são reproduzidas; a diferença contra a produção sai como número.
 *
 * Imprime NOMES e NÚMEROS, nunca o texto de um bloco nem dado de lead. O pool
 * abre em `default_transaction_read_only`: uma escrita acidental vira erro.
 */
import { tool, type ToolSet } from "ai";
import pg from "pg";
import { z } from "zod";

import { loadPublishedAgentConfigById } from "@/lib/agent-engine/agent/agent-config";
import {
  AGENT_TOOL_DEFS,
  blocosDeAgendaResidentes,
  CASES_SYSTEM_BLOCK,
  TRANSPARENCIA_SYSTEM_BLOCK,
} from "@/lib/agent-engine/agent/inbound-turn";
import { composeSystemPrompt, loadOrgMemory, renderOrgMemory } from "@/lib/agent-engine/agent/org-memory";
import { loadPlaybook } from "@/lib/agent-engine/agent/playbook";
import { loadSkills, renderSkillIndex } from "@/lib/agent-engine/agent/skills";
import { BLOCKED_TOOL_IDS } from "@/lib/agent-engine/edge/crm/mcp-tools";
import { shapeToZodObject } from "@/lib/ai/runtime/tools";
import { allTools } from "@/lib/mcp/tools";
import { formatarMedida, medirPrefixo } from "./ops-count-prefix.leitura";

const Args = z.object({
  org: z.string().uuid(),
  agent: z.string().uuid(),
  dias: z.coerce.number().int().min(1).max(90).default(7),
});

function lerArgs(argv: string[]): z.infer<typeof Args> {
  const opcao = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return Args.parse({ org: opcao("org"), agent: opcao("agent"), dias: opcao("dias") });
}

const SQL_PRODUCAO = `
  select purpose,
    count(*)::int as chamadas,
    round(avg(passos), 2)::float as passos,
    round(avg(entrada_do_primeiro_passo))::int as entrada_1o_passo,
    round(avg(input_tokens))::int as entrada_total,
    round(avg(chars_sistema))::int as chars_sistema,
    round(avg(chars_ferramentas))::int as chars_ferramentas,
    round(avg(chars_mensagens))::int as chars_mensagens,
    (percentile_cont(0.5) within group (order by chars_sistema))::int as mediana_chars_sistema,
    (percentile_cont(0.5) within group (order by chars_ferramentas))::int as mediana_chars_ferramentas,
    (count(*) filter (where partes_de_midia > 0))::int as com_midia,
    round(avg(entrada_do_primeiro_passo * chars_sistema::numeric
      / nullif(chars_sistema + chars_ferramentas + chars_mensagens, 0)) filter (where partes_de_midia = 0))::int as est_tok_sistema,
    round(avg(entrada_do_primeiro_passo * chars_ferramentas::numeric
      / nullif(chars_sistema + chars_ferramentas + chars_mensagens, 0)) filter (where partes_de_midia = 0))::int as est_tok_ferramentas,
    round(avg(entrada_do_primeiro_passo * chars_mensagens::numeric
      / nullif(chars_sistema + chars_ferramentas + chars_mensagens, 0)) filter (where partes_de_midia = 0))::int as est_tok_mensagens,
    count(distinct prefixo_hash)::int as prefixos_distintos
  from llm_calls
  where organization_id = $1 and agent_id = $2 and status = 'ok' and passos is not null
    and created_at > now() - make_interval(days => $3)
  group by purpose
  order by chamadas desc`;

interface LinhaDeProducao {
  purpose: string;
  chamadas: number;
  passos: number | null;
  entrada_1o_passo: number | null;
  entrada_total: number | null;
  chars_sistema: number | null;
  chars_ferramentas: number | null;
  chars_mensagens: number | null;
  mediana_chars_sistema: number | null;
  mediana_chars_ferramentas: number | null;
  com_midia: number;
  est_tok_sistema: number | null;
  est_tok_ferramentas: number | null;
  est_tok_mensagens: number | null;
  prefixos_distintos: number;
}

function escrever(texto: string): void {
  process.stdout.write(`${texto}\n`);
}

async function main(): Promise<void> {
  const args = lerArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_DB_URL ?? "";
  if (url === "") {
    process.stderr.write("SUPABASE_DB_URL ausente — este script lê direto do Postgres.\n");
    process.exitCode = 2;
    return;
  }
  const pool = new pg.Pool({ connectionString: url, max: 2, options: "-c default_transaction_read_only=on" });
  try {
    const cfg = await loadPublishedAgentConfigById(pool, args.org, args.agent);
    if (cfg === null) {
      process.stderr.write("agente sem versão publicada nesta organização.\n");
      process.exitCode = 1;
      return;
    }

    const { rows: producao } = await pool.query<LinhaDeProducao>(SQL_PRODUCAO, [args.org, args.agent, args.dias]);
    escrever(`PRODUÇÃO (llm_calls, últimos ${args.dias} dias, chamadas ok com medição)`);
    if (producao.length === 0) escrever("  nenhuma chamada medida ainda");
    for (const p of producao) escrever(`  ${JSON.stringify(p)}`);
    escrever("");

    const [playbook, orgMemory, skills] = await Promise.all([
      loadPlaybook(pool, args.org, { agentLayer: cfg.systemPrompt }),
      loadOrgMemory(pool, args.org),
      loadSkills(pool, args.org),
    ]);
    const memoria = renderOrgMemory(orgMemory);
    const indice = renderSkillIndex(skills);
    const agenda = blocosDeAgendaResidentes(cfg.toolIds);
    const blocos: Array<[string, string]> = [
      ["playbook (plataforma + agente)", playbook.prompt],
      ["memória da organização", memoria],
      ["índice de skills", indice],
      ["transparência", TRANSPARENCIA_SYSTEM_BLOCK],
      ...(cfg.casesEnabled ? [["casos", CASES_SYSTEM_BLOCK] as [string, string]] : []),
      ...agenda.map((b, i): [string, string] => [`agenda ${i + 1}`, b]),
    ];

    // Largas de propósito: o laço trata toda definição igual (descrição + schema),
    // e a união dos schemas literais não infere o tipo de entrada de `tool()`.
    const defsDoAgente: Readonly<Record<string, { description: string; inputSchema: z.ZodTypeAny }>> =
      AGENT_TOOL_DEFS;
    const ferramentas: ToolSet = {};
    for (const [nome, def] of Object.entries(defsDoAgente)) {
      ferramentas[nome] = tool({ description: def.description, inputSchema: def.inputSchema });
    }
    for (const def of allTools) {
      if (!cfg.toolIds.includes(def.name) || BLOCKED_TOOL_IDS.has(def.name)) continue;
      ferramentas[def.name] = tool({
        description: def.description,
        inputSchema: shapeToZodObject(def.inputSchema as Record<string, z.ZodTypeAny>),
      });
    }

    // Vazio ou ausente = o default único do seam (undefined), como o env do worker lê.
    const knobDoEsquema = process.env.LLM_TOOL_SCHEMA_SEM_PADRAO?.trim();
    const medida = await medirPrefixo({
      blocos,
      ferramentas,
      esquemaSemPadrao: knobDoEsquema ? knobDoEsquema === "on" : undefined,
    });
    escrever(formatarMedida(medida));
    escrever("");

    // O sistema reconstruído pelo MESMO caminho do turno, contra a produção. A
    // diferença tem causas conhecidas: o contexto de prospecção por conversa e os
    // blocos de prévia entram no turno e não aqui; e `chars_ferramentas` da
    // produção inclui o rótulo `=== system ===\n` e o separador `\n\n` (17 caracteres).
    const reconstruido = [
      composeSystemPrompt({ playbookPrompt: playbook.prompt, orgMemoryBlock: memoria, skillIndex: indice }),
      TRANSPARENCIA_SYSTEM_BLOCK,
      ...(cfg.casesEnabled ? [CASES_SYSTEM_BLOCK] : []),
      ...agenda,
    ].join("\n\n").length;
    const turno = producao.find((p) => p.purpose === "agent_turn");
    escrever("COMPARAÇÃO COM A PRODUÇÃO (agent_turn, mediana)");
    escrever(`  sistema:     reconstruído ${reconstruido} chars, produção ${turno?.mediana_chars_sistema ?? "sem dado"}` +
      (turno?.mediana_chars_sistema != null ? `, diferença ${turno.mediana_chars_sistema - reconstruido}` : ""));
    escrever(`  ferramentas: candidatas ${medida.totalFerramentas.chars} chars, produção ${turno?.mediana_chars_ferramentas ?? "sem dado"}` +
      (turno?.mediana_chars_ferramentas != null ? `, diferença ${turno.mediana_chars_ferramentas - medida.totalFerramentas.chars}` : ""));
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`ops:count-prefix falhou: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
