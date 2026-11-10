import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { z } from "zod";

import type { InboundTurnDeps } from "../../../lib/agent-engine/agent/inbound-turn";
import type { McpContext } from "../../../lib/mcp/types";
import { TEXTO_DO_PAR } from "../../support/prospeccao-ofertas-fixture";

const entradaSchema = z.object({
  org: z.uuid(), conversation: z.uuid(), contact: z.uuid(), agent: z.uuid(), channel: z.uuid(),
  texto: z.literal(TEXTO_DO_PAR),
});
const leituraSchema = z.object({
  disponivel: z.literal(true), ofertas_da_campanha: z.array(z.string()),
  estrategia_de_abordagem: z.object({ complementar: z.string().nullable() }),
});
type Entrada = z.infer<typeof entradaSchema>;

function exigirLoopback(value: string | undefined, nome: string): string {
  if (!value || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)) {
    throw new Error(`A prova exige ${nome} de uma bancada QA local.`);
  }
  return value;
}

/** Só o modelo e o canal são sintéticos neste modo; handler, SQL, token e tools são reais. */
export async function medirOfertasNoTurno(pool: pg.Pool, bruto: Entrada) {
  const input = entradaSchema.parse(bruto);
  const { rows: escopo } = await pool.query<{ campaign_id: string; channel_session_id: string }>(
    `select p.campaign_id,c.channel_session_id from conversations c
       join prospecting_candidates p on p.organization_id=c.organization_id and p.conversation_id=c.id and p.contact_id=c.contact_id
       join prospecting_campaigns k on k.organization_id=p.organization_id and k.id=p.campaign_id
     where c.organization_id=$1 and c.id=$2 and c.contact_id=$3 and c.active_ai_agent_id=$4
       and c.channel_session_id=$5 and k.config->>'agent_id'=$4::text and k.name like 'Ofertas QA %'`,
    [input.org, input.conversation, input.contact, input.agent, input.channel],
  );
  if (escopo.length !== 1) throw new Error("A conversa não pertence à fixture de ofertas indicada.");
  const [{ requestTurnDeps }, { createInboundTurnHandler }, { crmGetProspectingSiteAudit },
    { prospectingConversationContext }, { enqueueJob, completeJob }] = await Promise.all([
    import("../../../lib/agent-engine/agent/request-deps"),
    import("../../../lib/agent-engine/agent/inbound-turn"),
    import("../../../lib/mcp/tools/prospeccao-site"),
    import("../../../lib/prospecting/context"),
    import("../../../lib/agent-engine/queue/queue"),
  ]);
  // A credencial fixada na versão é da fixture e nasce com enfeite; cifrá-la com
  // a chave da suíte é o que torna o turno independente das credenciais que
  // outras specs deixam na org dividida (ver criarFixtureDeOfertas).
  const { encryptKey } = await import("../../../lib/crypto/aes_gcm");
  const envelope = encryptKey("provedor-controlado-da-prova");
  const { rowCount: cifradas } = await pool.query(
    `update ai_provider_credentials k set api_key_encrypted=$3,api_key_iv=$4,api_key_tag=$5,api_key_last4=$6
       from ai_agent_versions v
      where k.organization_id=$1 and v.organization_id=$1 and v.agent_id=$2 and v.status='published'
        and k.id=v.credential_id and k.label like 'Ofertas QA %'`,
    [input.org, input.agent, envelope.ciphertext, envelope.iv, envelope.tag, envelope.last4],
  );
  if (cifradas !== 1) throw new Error("A versão do agente não tem a credencial própria da fixture.");
  const deps: InboundTurnDeps = requestTurnDeps();
  // Nenhuma autorização é criada aqui: o handler relê o agente e sua revisão a cada efeito.
  const ctx: McpContext = {
    organizationId: input.org, contatoDoTurno: input.contact, role: "ai_operator",
    actor: { type: "ai_agent", id: input.agent, agent_id: input.agent, role: "ai_operator" },
    apiTokenId: randomUUID(), requestId: randomUUID(), supabase: deps.crmCfg.supabase,
  };
  const direto = leituraSchema.parse(await crmGetProspectingSiteAudit.handler({}, ctx));
  const contexto = await prospectingConversationContext(pool, input.org, input.conversation);
  const rotulos = ["Site profissional", "Automação do atendimento (CRM)", "Automações e integrações (N8N)"];
  if (!isDeepStrictEqual(direto.ofertas_da_campanha, rotulos) || !direto.estrategia_de_abordagem.complementar ||
      !contexto.includes(`O que esta campanha vende, em ordem: ${rotulos.join("; ")}.`)) {
    throw new Error("A configuração real não chegou ao contexto e à ferramenta.");
  }
  let recebeuContexto = false;
  let recebeuTool = false;
  const textos: string[] = [];
  const [{ createFakeRegistry }, { previewFixtureRegistry }] = await Promise.all([
    import("../../../lib/agent-engine/edge/llm/providers"),
    import("../../../lib/agent-engine/agent/preview-fixture"),
  ]);
  const auxiliar = previewFixtureRegistry().anthropic!("local-controlled-provider", "fixture");
  if (typeof auxiliar === "string" || auxiliar.specificationVersion !== "v3") throw new Error("Fixture de modelo incompatível.");
  deps.llmCfg.anthropicApiKey = "local-controlled-provider";
  deps.embed = async () => ({ embedding: Array(1536).fill(0), promptTokens: 0, model: "fixture" });
  deps.registry = createFakeRegistry(async (options) => {
    if (!options.tools?.length) return auxiliar.doGenerate(options);
    const sistema = options.prompt.flatMap((m) => m.role === "system" ? [m.content] : []).join("\n");
    const recebeuTextoCru = options.prompt.some((m) => m.role === "user" &&
      m.content.some((p) => p.type === "text" && p.text.includes(input.texto)));
    if (!sistema.includes(contexto.trim()) || !recebeuTextoCru) {
      throw new Error("O turno não recebeu o contexto e o texto cru pareados.");
    }
    recebeuContexto = true;
    const resultados = options.prompt.flatMap((m) => m.role === "tool" ? m.content : [])
      .filter((p) => p.type === "tool-result");
    const leitura = resultados.find((r) => r.toolName === "crm_get_prospecting_site_audit");
    let toolName = "crm_get_prospecting_site_audit";
    let args: Record<string, unknown> = {};
    if (leitura) {
      const recebido = leituraSchema.parse(leitura.output.type === "json" ? leitura.output.value : null);
      if (!isDeepStrictEqual(recebido, direto)) throw new Error("Agente e chamada direta leram ofertas diferentes.");
      recebeuTool = true;
      toolName = "send_message";
      args = { body: `Podemos trabalhar o site profissional. ${recebido.estrategia_de_abordagem.complementar}` };
      if (resultados.some((r) => r.toolName === "send_message")) return {
        content: [{ type: "text", text: "Conferência concluída." }],
        finishReason: { unified: "stop", raw: undefined }, warnings: [],
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      };
    }
    return {
      content: [{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify(args) }],
      finishReason: { unified: "tool-calls", raw: undefined }, warnings: [],
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
    };
  });
  deps.channel = () => ({
    channel: "ofertas-qa-controlado",
    send: async (message) => {
      textos.push(message.body);
      return { kind: "sent", idempotencyKey: `${message.jobId}:${message.seq}`, messageId: randomUUID() };
    },
    sessionHealth: async () => ({ healthy: true, status: "WORKING", since: null }),
    capabilities: () => ({ freeformAnytime: true, serviceWindowHours: null }),
    costPerMessage: () => ({ perMessageUsdCents: 0, model: "flat" }),
  });
  const inbound = randomUUID();
  await pool.query(
    `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at)
     values($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',now())`,
    [inbound, input.org, input.conversation, input.channel, input.contact, input.texto],
  );
  let jobId: string | undefined;
  try {
    const { job } = await enqueueJob(pool, input.org, {
      kind: "inbound_turn", leadId: input.contact, maxAttempts: 1,
      payload: { conversation_id: input.conversation, contact_id: input.contact,
        channel_session_id: input.channel, inbound_message_id: inbound, crm_event_id: randomUUID() },
    });
    jobId = job.id;
    const worker = `ofertas-qa-${randomUUID()}`;
    const { rows: claimed } = await pool.query<typeof job>(
      `update job_queue set status='running',locked_by=$3,locked_at=now(),attempts=attempts+1
        where organization_id=$1 and id=$2 and status='pending' returning *,locked_at::text as claim_acquired_at`,
      [input.org, job.id, worker],
    );
    if (claimed.length !== 1) throw new Error("O instrumento não adquiriu seu job próprio.");
    await createInboundTurnHandler(deps)(claimed[0]!, pool, { workerId: worker });
    await completeJob(pool, job.id, worker);
    if (!recebeuContexto || !recebeuTool || textos.length !== 1) {
      throw new Error("O turno não atravessou contexto, ferramenta e resposta esperados.");
    }
    return {
      tipo: "encadeamento-controlado",
      texto_cru: input.texto, mesma_conversa: true, consulta_direta: true,
      contexto_visto_pelo_provider: recebeuContexto, tool_vista_pelo_provider: recebeuTool,
      ofertas: direto.ofertas_da_campanha, complementar: direto.estrategia_de_abordagem.complementar,
      respostas: textos, modelo_real: false, semantica_aprovada: false, canal_controlado: true,
    };
  } finally {
    if (jobId) await pool.query("delete from job_queue where organization_id=$1 and id=$2", [input.org, jobId]);
    await pool.query("delete from messages where organization_id=$1 and id=$2", [input.org, inbound]);
  }
}

// O JSON de entrada tem somente IDs sintéticos e o texto acima; não recebe segredo.
const indice = process.argv.indexOf("--medir-ofertas-controladas");
if (indice >= 0) {
  const executar = async () => {
    const arquivo = process.argv[indice + 1];
    const saida = process.argv[indice + 2];
    if (!arquivo || !saida || /(^|\/)\.env/.test(arquivo)) throw new Error("Informe entrada sintética e recibo de saída.");
    const dbUrl = exigirLoopback(process.env.E2E_TURNO_DB_URL ?? process.env.SUPABASE_DB_URL, "SUPABASE_DB_URL");
    exigirLoopback(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL");
    if (process.env.SUPABASE_SERVER_URL?.trim()) exigirLoopback(process.env.SUPABASE_SERVER_URL, "SUPABASE_SERVER_URL");
    // O filho usa a mesma conexão explícita do pai; não carrega arquivo de ambiente.
    process.env.SUPABASE_DB_URL = dbUrl;
    const pool = new pg.Pool({ connectionString: dbUrl, max: 2, statement_timeout: 10000 });
    try {
      const resultado = await medirOfertasNoTurno(pool, entradaSchema.parse(JSON.parse(readFileSync(arquivo, "utf8"))));
      writeFileSync(saida, JSON.stringify(resultado, null, 2));
    } finally {
      await pool.end();
    }
  };
  void executar().catch((erro: unknown) => {
    process.stderr.write(`${erro instanceof Error ? erro.message : "Falha na prova de ofertas."}\n`);
    process.exitCode = 1;
  });
}
