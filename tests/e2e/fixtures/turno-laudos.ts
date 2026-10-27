import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import pg from "pg";

import { createInboundTurnHandler, type InboundTurnDeps } from "../../../lib/agent-engine/agent/inbound-turn";
import { seedPlatformPlaybook } from "../../../lib/agent-engine/agent/playbook-seed";
import { completeJob, enqueueJob, type JobRow } from "../../../lib/agent-engine/queue/queue";
import { ehVistoAzul } from "../../support/waha-visto-azul";
import { slugDeFunil } from "../../../lib/pipelines/pipeline-editing";
import type { AtoresDasExtensoes } from "./catalogo-extensoes";
import type { ProvedorDoTurnoLaudos } from "./provedores-turno-laudos";

export interface ConversaDoLaudo {
  org: string;
  contato: string;
  conversa: string;
  canal: string;
  provedor: ProvedorDoTurnoLaudos;
}

/**
 * Só a aquisição do job é controlada pela fixture (como autonomia-assistida).
 * Handler, contexto, guardas, ledger, passagem e adapter de canal são os reais.
 */
export async function criarTurnosDoLaudo(atores: AtoresDasExtensoes, registry: InboundTurnDeps["registry"]) {
  const dbUrl = process.env.SUPABASE_DB_URL;
  const wahaUrl = process.env.WAHA_API_BASE_URL;
  if (!dbUrl || !wahaUrl) throw new Error("Runner não publicou Postgres e receiver WAHA.");
  for (const url of [new URL(dbUrl), new URL(wahaUrl)]) {
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.port) {
      throw new Error("A fixture do turno só aceita serviços loopback com porta.");
    }
  }
  const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
  const entregas: Array<{ session: string; text: string }> = [];
  const falhasHttp: string[] = [];
  const alvo = new URL(wahaUrl);
  const servidor = createServer(async (req, res) => {
    if (ehVistoAzul(req.url) || /\/(?:startTyping|stopTyping)(?:\?|$)/.test(req.url ?? "")) {
      res.setHeader("content-type", "application/json"); res.end("{}"); return;
    }
    try {
      const presenca = /^\/api\/[^/?]+\/presence$/.test(req.url ?? "");
      if (req.method !== "POST" || (req.url !== "/api/sendText" && !presenca)) {
        throw new Error("Receiver WAHA recebeu operação inesperada.");
      }
      let raw = "";
      for await (const chunk of req) {
        raw += String(chunk);
        if (raw.length > 100_000) throw new Error("Corpo WAHA excedeu o limite da fixture.");
      }
      const body = JSON.parse(raw) as { session?: unknown; text?: unknown; chatId?: unknown; presence?: unknown };
      if (presenca) {
        // O adapter real usa sessão no path; presença não conta como entrega.
        if (typeof body.chatId !== "string" || !body.chatId || body.presence !== "typing") {
          throw new Error("Presença WAHA fora do contrato da jornada.");
        }
        res.setHeader("content-type", "application/json"); res.end("{}"); return;
      }
      if (typeof body.session !== "string" || typeof body.text !== "string") {
        throw new Error("Corpo WAHA sem sessão/texto.");
      }
      entregas.push({ session: body.session, text: body.text });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: randomUUID() }));
    } catch {
      falhasHttp.push("operação WAHA inesperada");
      res.writeHead(500, { "content-type": "application/json" }); res.end("{}");
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      servidor.once("error", reject); servidor.listen(Number(alvo.port), alvo.hostname, resolve);
    });
    await seedPlatformPlaybook(pool);
    const inserir = async (tabela: string, valor: Record<string, unknown>) => {
      const { data, error } = await atores.db.from(tabela).insert(valor).select("id").single();
      if (error || !data) throw new Error(`${tabela}: ${error?.message ?? "linha ausente"}`);
      return data.id as string;
    };
    const funis = new Map<string, { pipeline: string; stage: string }>();
    const novaConversa = async (provedor: ProvedorDoTurnoLaudos, org = atores.organizacaoA, contatoExistente?: string): Promise<ConversaDoLaudo> => {
      const canal = await inserir("channel_sessions", {
        organization_id: org, waha_session_name: `laudo-${randomUUID()}`,
        display_name: "Canal sintético do laudo", status: "WORKING",
        webhook_secret_encrypted: "\\x00", metadata: { ai_gate: "open" },
      });
      const knobs = await atores.db.from("channel_knobs").insert({
        organization_id: org, channel_session_id: canal,
        throttle_ms: 0, jitter_max_ms: 0, window_start_hour: 0, window_end_hour: 24,
      });
      if (knobs.error) throw new Error(knobs.error.message);
      const contato = contatoExistente ?? await inserir("contacts", {
        organization_id: org, name: "Pessoa Sintética", display_name: "Pessoa Sintética",
        phone_number: `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`,
        force_human: false,
      });
      const conversa = await inserir("conversations", {
        organization_id: org, contact_id: contato, channel_session_id: canal,
        status: "ai_handling", is_group: false,
      });
      const agente = await inserir("ai_agents", {
        organization_id: org, name: "Agente sintético do laudo", operation_mode: "automatic",
        system_prompt: "Use somente fatos confirmados. Não diagnostique nem prometa resultado de laudo.",
      });
      const versao = await inserir("ai_agent_versions", {
        organization_id: org, agent_id: agente, version_number: 1, status: "published",
        channel_session_id: canal, provider: provedor,
        model: provedor === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o-mini",
        system_prompt: "Use somente fatos confirmados. Não diagnostique nem prometa resultado de laudo.",
        max_steps: 3, split_messages: false, multimodal_input: false,
        operator_enabled: false, knowledge_source_ids: [], tool_ids: [], handoff_keywords: [], followup: {},
      });
      await pool.query("update ai_agents set published_version_id=$1 where organization_id=$2 and id=$3", [versao, org, agente]);
      await pool.query("update conversations set active_ai_agent_id=$1 where organization_id=$2 and id=$3", [agente, org, conversa]);
      let funil = funis.get(org);
      if (!funil) {
        const pipeline = await inserir("crm_pipelines", { organization_id: org, name: "Laudos sintéticos", slug: slugDeFunil(`laudos-${randomUUID().replaceAll("-", "")}`) });
        const stage = await inserir("crm_stages", { organization_id: org, pipeline_id: pipeline, name: "Entrada", slug: "entrada", position: 1 });
        funil = { pipeline, stage }; funis.set(org, funil);
      }
      if (!contatoExistente) await inserir("crm_leads", {
        organization_id: org, contact_id: contato, pipeline_id: funil.pipeline, stage_id: funil.stage,
        title: "Conferência sintética de laudo", owner_user_id: atores.usuarios.owner.id,
      });
      return { org, contato, conversa, canal, provedor };
    };
    const mensagem = async (c: ConversaDoLaudo, body: string, direction = "inbound") => {
      const agora = new Date().toISOString();
      const id = await inserir("messages", {
        organization_id: c.org, contact_id: c.contato, conversation_id: c.conversa,
        channel_session_id: c.canal, direction, type: "text", status: direction === "inbound" ? "received" : "sent",
        external_id: randomUUID(), body, sent_at: agora,
      });
      const { error } = await atores.db.rpc("fn_mark_conversation_message", {
        p_conv: c.conversa, p_direction: direction, p_preview: body, p_at: agora,
      });
      if (error) throw new Error(error.message);
      return id;
    };
    const handler = createInboundTurnHandler({
      crmCfg: { supabase: atores.db }, registry,
      llmCfg: { anthropicApiKey: "chave-sintetica-anthropic", openaiApiKey: "chave-sintetica-openai" },
      knobs: {
        historyLimit: 30, maxContextTokens: 8000, notesIndexMaxTokens: 500,
        maxSteps: 3, queuedRetryDelayMs: 1000,
        breaker: { exactFailureWarn: 2, exactFailureBlock: 5, sameToolFailureWarn: 3,
          sameToolFailureHalt: 8, noProgressWarn: 3, noProgressBlock: 5 },
      },
      // Não persistir corpos, respostas, telefone, e-mail ou headers no log da prova.
      log: { info() {}, warn() {}, error() {} }, sleep: async () => {},
    });
    return {
      pool, novaConversa, mensagem,
      totalEntregas: () => entregas.length,
      async executar(c: ConversaDoLaudo, body: string) {
        const inbound = await mensagem(c, body);
        const { job } = await enqueueJob(pool, c.org, {
          kind: "inbound_turn", leadId: c.contato, maxAttempts: 1,
          payload: { conversation_id: c.conversa, contact_id: c.contato, channel_session_id: c.canal,
            inbound_message_id: inbound, crm_event_id: randomUUID() },
        });
        const workerId = `turno-laudos-${job.id}`;
        // Nunca reivindicar nem atualizar a fila inteira do runner compartilhado.
        const { rows } = await pool.query<JobRow>(
          "update job_queue set status='running',locked_by=$3,locked_at=clock_timestamp(),attempts=attempts+1 where organization_id=$1 and id=$2 and status='pending' returning *,locked_at::text claim_acquired_at",
          [c.org, job.id, workerId],
        );
        if (rows.length !== 1) throw new Error("Fixture não adquiriu seu próprio job.");
        await handler(rows[0]!, pool, { workerId });
        await completeJob(pool, job.id, workerId, undefined, rows[0]!.claim_acquired_at);
        if (falhasHttp.length) throw new Error(falhasHttp[0]);
        const { rows: bolhas } = await pool.query<{ body: string; status: string }>(
          "select m.body,l.status from send_ledger l join messages m on m.id=l.crm_message_id and m.organization_id=l.organization_id where l.organization_id=$1 and l.job_id=$2 order by l.seq",
          [c.org, job.id],
        );
        const { rows: chamadas } = await pool.query<{ provider: string; purpose: string; status: string }>(
          "select provider,purpose,status from llm_calls where organization_id=$1 and job_id=$2 order by created_at", [c.org, job.id],
        );
        return { jobId: job.id, bolhas, chamadas };
      },
      async estado(c: ConversaDoLaudo) {
        const { rows } = await pool.query("select metadata->'gancho_de_extensao' estado from conversations where organization_id=$1 and id=$2", [c.org, c.conversa]);
        return rows[0]?.estado ?? null;
      },
      async passagem(c: ConversaDoLaudo) {
        const { rows } = await pool.query("select body,cliente_avisado,motivo_codigo from passagens_de_atendimento where organization_id=$1 and conversation_id=$2", [c.org, c.conversa]);
        return rows;
      },
      async atividades(c: ConversaDoLaudo) {
        const { rows } = await pool.query("select type,payload from crm_lead_activities where organization_id=$1 and contact_id=$2 and type like 'extension_turn_%' order by created_at", [c.org, c.contato]);
        return rows;
      },
      async close() {
        servidor.closeAllConnections();
        await new Promise<void>((resolve) => servidor.close(() => resolve()));
        await pool.end();
      },
    };
  } catch (erro) {
    servidor.closeAllConnections(); servidor.close(); await pool.end(); throw erro;
  }
}
