/**
 * O MODELO ESCOLHENDO A CAPACIDADE — a prova que faltava (IA 360 · wave 2).
 *
 * ⚠️ POR QUE ESTE ARQUIVO EXISTE. Todo o resto da wave provou que a capacidade
 * FUNCIONA QUANDO CHAMADA: o E2E, o invariante e os unitários invocam o handler
 * diretamente. Nada provava que o agente **encontra** a capacidade, **escolhe** a
 * certa entre as que estão ligadas e **monta os argumentos** sozinho — que é
 * exatamente o que o dono da clínica compra.
 *
 * Aqui o turno é real: `runAgent` (o mesmo runtime que o botão "Testar agente"
 * chama), modelo real com credencial real da organização, tools de verdade. O
 * cenário é uma situação, NÃO uma instrução: em nenhum lugar se diz "use a
 * ferramenta de agendar retorno". Se o modelo escolher outra coisa, ou não
 * escolher nada, isso é o resultado — e é o achado.
 *
 * Dry-run: nada sai para o WhatsApp.
 *
 * Run: npx tsx scripts/prova-modelo-escolhe-retorno.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

const env = carregarEnvLocal();
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const AGENTE_NOME = "W2 Prova do Modelo Real";

/**
 * As capacidades LIGADAS neste agente: as seis do pacote `reter` mais duas de
 * leitura do funil. As de leitura entram porque o modelo precisa DESCOBRIR de
 * qual negócio se fala — dar o id mastigado no prompt esconderia metade do que
 * este teste existe para medir.
 */
const CAPACIDADES = (
  process.env.CAPACIDADES ??
  [
    "crm_list_leads",
    "crm_get_lead",
    "crm_schedule_followup",
    "crm_cancel_followup",
    "crm_list_followups",
    "crm_list_at_risk_leads",
    "crm_close_demand",
    "crm_propose_reactivation",
  ].join(",")
).split(",");

const SYSTEM_PROMPT = `Você é a assistente da Clínica Vida, que atende pelo WhatsApp.

Sua responsabilidade é não deixar nenhum interessado morrer sem resposta: quando um
cliente pede para ser procurado depois, você garante que isso vá acontecer.

Use as ferramentas disponíveis para registrar o que precisa ficar registrado. Depois
de agir, encerre o turno com uma frase curta para a equipe.`;

/**
 * O cenário. É uma SITUAÇÃO relatada pela recepção, não um comando: não nomeia
 * ferramenta, não dá id, não diz "agende". A decisão é do modelo.
 */
const MENSAGEM =
  process.env.MENSAGEM ??
  `Acabei de falar por telefone com o cliente do negócio "Demanda E2E do retorno".
Ele disse que só consegue decidir sobre a proposta daqui a três dias e pediu para a gente
procurar ele de novo nesse dia. Até lá ele não quer mais contato.`;

interface Creds {
  org_id: string;
}

async function referencia(orgId: string): Promise<{
  provider: string;
  model: string;
  credentialId: string;
  channelSessionId: string;
}> {
  // Copia provider/modelo/credencial/canal de uma version que JÁ roda nesta
  // organização — inventar valores aqui testaria a minha configuração, não o
  // caminho que a instalação usa.
  let query = admin
    .from("ai_agent_versions")
    .select("provider, model, credential_id, channel_session_id")
    .eq("organization_id", orgId)
    .not("credential_id", "is", null)
    .not("channel_session_id", "is", null);
  // `PROVIDER=openai npx tsx ...` para escolher; sem isso, a mais recente.
  if (process.env.PROVIDER) query = query.eq("provider", process.env.PROVIDER);
  // ⚠️ FIXE O MODELO. A organização é COMPARTILHADA com outras sessões, e sem
  // isto "a version mais recente" muda debaixo do teste: entre duas rodadas o
  // modelo trocou de gpt-4o para outro sem eu escolher, e comparar as duas
  // saídas viraria comparar coisas diferentes. Alvo em movimento não se mede.
  const { data } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) throw new Error("a organização não tem version com credencial e canal");
  const r = data as {
    provider: string;
    model: string;
    credential_id: string;
    channel_session_id: string;
  };
  return {
    provider: r.provider,
    // MODELO e CREDENCIAL podem ser fixados: sem isso, "a version mais recente"
    // muda debaixo do teste numa organização compartilhada.
    model: process.env.MODELO ?? r.model,
    credentialId: process.env.CREDENCIAL ?? r.credential_id,
    channelSessionId: r.channel_session_id,
  };
}

async function main(): Promise<void> {
  const { runAgent } = await import("../lib/ai/runtime/agent");
  const creds = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8"),
  ) as Creds;
  const orgId = creds.org_id;
  const ref = await referencia(orgId);

  const { data: existente } = await admin
    .from("ai_agents")
    .select("id")
    .eq("organization_id", orgId)
    .eq("name", AGENTE_NOME)
    .maybeSingle();

  const agentId =
    (existente as { id: string } | null)?.id ??
    ((
      await admin
        .from("ai_agents")
        .insert({
          organization_id: orgId,
          name: AGENTE_NOME,
          kind: "mcp_agent",
          system_prompt: SYSTEM_PROMPT,
        } as never)
        .select("id")
        .single()
    ).data as { id: string }).id;

  const { data: versionRow, error: vErr } = await admin
    .from("ai_agent_versions")
    .insert({
      organization_id: orgId,
      agent_id: agentId,
      status: "draft",
      version_number: Date.now() % 100_000,
      system_prompt: SYSTEM_PROMPT,
      provider: ref.provider,
      model: ref.model,
      credential_id: ref.credentialId,
      channel_session_id: ref.channelSessionId,
      tool_ids: CAPACIDADES,
      max_steps: 8,
    } as never)
    .select("id")
    .single();
  if (vErr || !versionRow) throw new Error(`insert version: ${vErr?.message}`);
  const versionId = (versionRow as { id: string }).id;

  const { data: runRow, error: rErr } = await admin
    .from("ai_agent_runs")
    .insert({
      organization_id: orgId,
      agent_id: agentId,
      agent_version_id: versionId,
      channel_session_id: ref.channelSessionId,
      status: "running",
      is_dry_run: true,
      started_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (rErr || !runRow) throw new Error(`insert run: ${rErr?.message}`);
  const runId = (runRow as { id: string }).id;

  const resultado = await runAgent({
    runId,
    override: { sampleMessage: MENSAGEM, sampleContact: { name: "Recepção da Clínica Vida" } },
  });

  // O que interessa é a ESCOLHA: quais ferramentas o modelo chamou, em que ordem
  // e com que argumentos.
  const chamadas = resultado.tool_calls ?? [];
  console.info(
    `PROVA_DO_MODELO=${JSON.stringify(
      {
        modelo: ref.model,
        status: resultado.status,
        passos: resultado.steps_count,
        capacidades_ligadas: CAPACIDADES,
        chamadas,
        texto_final: resultado.final_text ?? null,
        erro: resultado.error_message ?? null,
        run_id: runId,
      },
      null,
      2,
    )}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
