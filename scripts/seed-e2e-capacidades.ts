/**
 * Fixtures do E2E do painel de capacidades (IA 360 · W1).
 *
 * Cria um `mcp_agent` com versão rascunho e um histórico de uso que o painel
 * possa ler. Reaproveita a credencial e o número de WhatsApp de
 * `seed-e2e-followup-agent.ts` (os dois FKs not null da versão).
 *
 * AS CHAMADAS DE TOOL SÃO ESCRITAS PELO EMISSOR REAL. Este script importa
 * `auditMcpToolCall` de `lib/mcp/audit.ts` — o mesmo módulo que o runtime chama
 * depois de executar uma tool — em vez de montar o INSERT à mão. Um INSERT
 * artesanal provaria que o banco aceita a linha, não que o painel lê o que o
 * sistema de fato escreve: se alguém renomear `metadata.success`, o INSERT
 * caseiro continua verde e o painel zera na cara do usuário.
 *
 * O que o histórico contém, de propósito (é o que faz cada sinal aparecer):
 *   - uma capacidade saudável (usos, nenhuma falha);
 *   - uma que falha em TODA tentativa;
 *   - uma execução de teste (`is_dry_run`), para provar que o painel separa
 *     "usada de verdade" de "você clicou em Testar".
 *
 * Run: npx tsx scripts/seed-e2e-capacidades.ts
 */
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

// Este script JÁ respeitava `process.env` (o `.env.local` era só fallback), mas
// estourava se o arquivo não existisse — que é exatamente o caso do worktree
// dedicado de e2e, onde a ausência dele é a proteção. O helper trata os dois.
const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-capacidades", credenciais);
const SUPABASE_URL = credenciais.url;
const SERVICE_ROLE = credenciais.serviceRole;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const NOME_DO_AGENTE = "E2E Capacidades";

interface Creds {
  org_id: string;
  followup_agent_fixtures?: { credential_id: string; channel_session_id: string };
  capacidades?: { agent_id: string; version_id: string };
}

function lerCreds(): Creds {
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

async function main(): Promise<void> {
  const creds = lerCreds();
  const orgId = creds.org_id;
  let fixtures = creds.followup_agent_fixtures;
  if (!fixtures) {
    // RODA o pré-requisito em vez de mandar rodar. As fixtures moram no mesmo
    // `.e2e-creds.json` que `seed-e2e-credentials.ts` reescreve por inteiro —
    // e ele é chamado de dentro do login quando o fator TOTP foi rotacionado
    // por outra sessão. O resultado é este bloco sumir no meio de uma execução
    // do Playwright, onde ninguém pode "rodar antes" coisa nenhuma: a bateria
    // morre citando um comando que ela mesma sabia executar.
    execFileSync("npx", ["tsx", "scripts/seed-e2e-followup-agent.ts"], { stdio: "inherit" });
    fixtures = lerCreds().followup_agent_fixtures;
  }
  if (!fixtures) {
    throw new Error(
      "`followup_agent_fixtures` continua ausente mesmo depois de rodar " +
        "seed-e2e-followup-agent.ts — o problema não é a ordem dos seeds.",
    );
  }

  // 1) Agente + versão rascunho, idempotentes pelo nome.
  const { data: existente } = await admin
    .from("ai_agents")
    .select("id")
    .eq("organization_id", orgId)
    .eq("name", NOME_DO_AGENTE)
    .maybeSingle();

  let agentId = existente?.id as string | undefined;
  if (!agentId) {
    const { data, error } = await admin
      .from("ai_agents")
      .insert({
        organization_id: orgId,
        name: NOME_DO_AGENTE,
        description: "Agente do E2E do painel de capacidades",
        kind: "mcp_agent",
        system_prompt: "Você atende clientes da clínica com educação e objetividade.",
        model: "claude-sonnet-4-6",
      })
      .select("id")
      .single();
    if (error) throw error;
    agentId = data.id as string;
  }

  const { data: versaoExistente } = await admin
    .from("ai_agent_versions")
    .select("id")
    .eq("organization_id", orgId)
    .eq("agent_id", agentId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  const TOOLS_LIGADAS = [
    // As três originais primeiro: o caso do teto desliga `TOOLS_DO_SEED[2]` para
    // liberar exatamente uma vaga, e a ordem é o que mantém esse índice válido.
    "crm_get_lead",
    "crm_move_lead_stage",
    "crm_list_leads",
    // ⚠️ AS SEIS ABAIXO NÃO SÃO ENFEITE: elas existem para o cenário ESTOURAR.
    //
    // A jornada do teto (issue #162) só existe se a soma passar do teto: eram 3
    // do seed + 18 de "Atender" = 21 contra teto 20, e a tela recusava dizendo
    // "faltam 1 vaga". Com teto 25 essas mesmas 21 passam, a recusa nunca acontece
    // e o caso vira um clique que sempre dá certo — verde sem medir nada.
    //
    // Nove reproduzem a MESMA aritmética no teto novo: 9 + 17 = 26 > 25, recusa
    // por 1 vaga; desligar uma deixa 8 + 17 = 25, que é o teto exato e passa.
    //
    // Os 17 são o pacote "Atender" DEPOIS da #528, e foi ela que mudou o número:
    // a crítica que o pacote contava (o envio de WhatsApp, que o motor descarta
    // em todo turno) deixou de ser oferecida, e com ela saiu uma vaga da conta.
    // Com as oito antigas, 8 + 17 = 25 exatas — o pacote passaria a caber e o
    // caso de recusa morreria calado, que é o desfecho que se quer evitar.
    //
    // As escolhidas ficam FORA do pacote "Atender" de propósito — se alguma
    // estivesse dentro, a união seria menor que a soma e a conta acima não valeria.
    // Quatro são a família de agenda, que é o assunto do defeito que subiu o teto.
    "crm_find_free_slots",
    "crm_list_appointments",
    "crm_book_appointment",
    "crm_reschedule_appointment",
    "crm_list_pipelines",
    // A NONA: leitura pura, fora de "Atender" — que é o que a conta acima exige.
    // Existe para a aritmética continuar estourando depois da #528; sem ela o
    // cenário de recusa vira um clique que sempre dá certo.
    "crm_list_knowledge_sources",
  ];

  // REPÕE TODAS AS VERSÕES DRAFT DESTE AGENTE, não só a de maior número.
  //
  // A tela SALVA criando draft novo. Depois de uma rodada do e2e o agente fica
  // com vários drafts, e o seed — que buscava só o de `version_number` mais
  // alto — repunha um enquanto a tela editava outro. Resultado: a segunda
  // execução media o resto da primeira. Foi assim que a jornada do teto (issue
  // #162) apareceu passando num banco onde o pacote já estava ligado de antes:
  // as 3 capacidades do cenário eram na verdade 17.
  {
    const { error } = await admin
      .from("ai_agent_versions")
      .update({
        tool_ids: TOOLS_LIGADAS,
        // Coluna da 0125, e o mesmo motivo do `tool_ids`: a tela do escopo de
        // funis SALVA aqui, então sem repor, a segunda execução acha o funil
        // que a primeira marcou e o caso "nasce fechada" passa a medir sujeira.
        pipeline_ids: [],
        created_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
      })
      .eq("organization_id", orgId)
      .eq("agent_id", agentId)
      .eq("status", "draft");
    if (error) throw error;
  }

  let versionId = versaoExistente?.id as string | undefined;
  if (versionId) {
    // Repõe o estado conhecido. O E2E mexe na configuração pela tela (é o que
    // ele existe para provar), então rodar o seed de novo tem de DEVOLVER o
    // cenário — senão o segundo `pnpm test:e2e` mede o resto do primeiro.
    const { error } = await admin
      .from("ai_agent_versions")
      .update({
        tool_ids: TOOLS_LIGADAS,
        pipeline_ids: [],
        // Configuração DATADA de 60 dias atrás de propósito. O painel distingue
        // "ligada agora" (não pede decisão) de "ligada há tempo e nunca usada"
        // (pede), e uma versão criada neste instante só alcançaria o primeiro
        // caso — o segundo, que é o diagnóstico útil, ficaria sem prova em tela.
        created_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
      })
      .eq("id", versionId);
    if (error) throw error;
  }
  if (!versionId) {
    const { data, error } = await admin
      .from("ai_agent_versions")
      .insert({
        organization_id: orgId,
        agent_id: agentId,
        version_number: 1,
        system_prompt: "Você atende clientes da clínica com educação e objetividade.",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        credential_id: fixtures.credential_id,
        channel_session_id: fixtures.channel_session_id,
        status: "draft",
        // Ligadas de propósito: o painel só mostra a mistura real (uma
        // saudável, uma que só falha, uma ligada e nunca usada, e uma usada
        // sem estar ligada) se a configuração e o histórico discordarem em
        // algum ponto. Com tool_ids vazio, TUDO vira "usada sem estar ligada"
        // e três dos quatro sinais nunca aparecem na tela.
        tool_ids: TOOLS_LIGADAS,
      })
      .select("id")
      .single();
    if (error) throw error;
    versionId = data.id as string;
  }

  // 2) Histórico de uso. Limpa o anterior para o número na tela ser previsível.
  const { data: runsAntigos } = await admin
    .from("ai_agent_runs")
    .select("id")
    .eq("organization_id", orgId)
    .eq("agent_id", agentId);
  const idsAntigos = (runsAntigos ?? []).map((r) => r.id as string);
  // Só os runs saem. `api_audit_log` não aceita DELETE de service_role (migration
  // 0258), e não precisa: `fn_agent_tool_usage` conta a auditoria pelo JOIN com
  // `ai_agent_runs`, então a linha cujo run foi apagado deixa de contar na tela.
  if (idsAntigos.length > 0) {
    await admin.from("ai_agent_runs").delete().in("id", idsAntigos);
  }

  const HISTORICO: Array<{ dryRun: boolean; chamadas: Array<[string, boolean]> }> = [
    { dryRun: false, chamadas: [["crm_get_lead", true], ["crm_get_lead", true], ["crm_move_lead_stage", false]] },
    { dryRun: false, chamadas: [["crm_get_lead", true], ["crm_move_lead_stage", false]] },
    { dryRun: true, chamadas: [["crm_search_contacts", true]] },
  ];

  // O emissor real. Importado aqui (e não no topo) porque ele puxa `lib/env`,
  // que valida o ambiente na importação — as variáveis precisam já estar em
  // process.env.
  const { auditMcpToolCall } = await import("../lib/mcp/audit");

  for (const execucao of HISTORICO) {
    const { data: run, error } = await admin
      .from("ai_agent_runs")
      .insert({
        organization_id: orgId,
        agent_id: agentId,
        agent_version_id: versionId,
        status: "completed",
        is_dry_run: execucao.dryRun,
      })
      .select("id")
      .single();
    if (error) throw error;

    for (const [tool, ok] of execucao.chamadas) {
      await auditMcpToolCall({
        ctx: {
          organizationId: orgId,
          role: "agent",
          actor: { type: "ai_agent", id: run.id as string, role: "agent" },
          apiTokenId: null,
          // O runtime usa o id do run como requestId — é esse o elo que
          // `fn_agent_tool_usage` segue para achar as chamadas do agente.
          requestId: run.id as string,
        } as never,
        toolName: tool,
        args: {},
        durationMs: 42,
        success: ok,
        errorMessage: ok ? undefined : "stage_not_found",
      });
    }
  }

  const atualizado = { ...lerCreds(), capacidades: { agent_id: agentId, version_id: versionId } };
  fs.writeFileSync(CREDS_PATH, `${JSON.stringify(atualizado, null, 2)}\n`);

  const { count } = await admin
    .from("api_audit_log")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("action", "mcp.tool_called");

  console.info(
    `\n✅ Seed de capacidades completo. agent=${agentId} version=${versionId} ` +
      `chamadas auditadas na org=${count ?? "?"}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
