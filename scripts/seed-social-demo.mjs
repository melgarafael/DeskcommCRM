/** Seed fictício e idempotente. Uso: node --env-file=.env.local scripts/seed-social-demo.mjs
 * Executa apenas no Supabase local desta validação. Não cria credencial real nem envia DMs.
 * Conserva a empresa original; a demonstração tem organização própria e o mesmo dono.
 */
import pg from "pg";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
const sourceSlug = "florida-auto-sales-and-repair";
const demoSlug = "demo-redes-sociais";
const tag = "seed-social-demo-v1";
const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname;
if (!["localhost", "127.0.0.1"].includes(host)) throw new Error("Este seed exige Supabase local.");
const key = Buffer.from(process.env.AI_CRED_AES_KEY ?? "", "base64");
if (key.length !== 32) throw new Error("Chave de cifra local ausente.");
function seal(text) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  return {
    ciphertext: Buffer.concat([c.update(text, "utf8"), c.final()]).toString("base64"),
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
  };
}
const uuid = (name) => {
  const h = createHash("sha256").update(`${tag}:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const org = uuid("org"),
  conn = uuid("connection"),
  pipeline = uuid("pipeline"),
  agent = uuid("agent");
const pool = new pg.Pool({
  connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});
const db = await pool.connect();
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const scenarios = [
  {
    key: "ana",
    name: "Ana Martins [DEMO]",
    network: "instagram",
    title: "Interesse em revisão preventiva",
    stage: 0,
    age: 8,
    inbound: "Olá! Vi o perfil de vocês e queria saber como funciona a revisão preventiva.",
    reply: "[DEMO — resposta de IA simulada] Posso ajudar. Qual é o modelo e o ano do veículo?",
    last: "É um Corolla 2021. Quero agendar uma avaliação.",
    mode: "ai",
    value: 18000,
  },
  {
    key: "bruno",
    name: "Bruno Costa [DEMO]",
    network: "messenger",
    title: "Orçamento de troca de pneus",
    stage: 1,
    age: 25,
    inbound: "Vocês têm pneus para um Civic?",
    reply: "[DEMO — atendente] Vou conferir as opções com a equipe e retorno nesta conversa.",
    last: "Obrigado! Prefiro conversar com uma pessoa.",
    mode: "human",
    value: 64000,
  },
  {
    key: "carla",
    name: "Carla Souza [DEMO]",
    network: "instagram",
    title: "Aguardando nova DM para responder",
    stage: 2,
    age: 26 * 60,
    inbound: "Gostaria de saber os horários para alinhamento.",
    reply: "[DEMO — resposta anterior] Podemos verificar a disponibilidade quando você retornar.",
    last: null,
    mode: "waiting",
    value: 12000,
  },
  {
    key: "diego",
    name: "Diego Alves [DEMO]",
    network: "messenger",
    title: "Falha de entrega para revisar",
    stage: 1,
    age: 40,
    inbound: "Pode me explicar o que está incluído no diagnóstico?",
    reply: "[DEMO] Seguem as informações do diagnóstico.",
    last: null,
    mode: "failed",
    value: 9500,
  },
  {
    key: "elisa",
    name: "Elisa Rocha [DEMO]",
    network: "instagram",
    title: "Avaliação confirmada — exemplo concluído",
    stage: 3,
    age: 180,
    inbound: "Quero confirmar a avaliação do meu carro.",
    reply: "[DEMO — atendente] Confirmação registrada neste exemplo de atendimento.",
    last: "Perfeito, obrigada!",
    mode: "won",
    value: 25000,
  },
  {
    key: "felipe",
    name: "Felipe Lima [DEMO]",
    network: "messenger",
    title: "Cliente desistiu — exemplo encerrado",
    stage: 4,
    age: 240,
    inbound: "Eu estava procurando um orçamento de manutenção.",
    reply: "[DEMO — atendente] Posso ajudar com mais alguma informação?",
    last: "Obrigado, mas não vou seguir com o serviço agora.",
    mode: "lost",
    value: 30000,
  },
];
try {
  await db.query("begin");
  await db.query("select pg_advisory_xact_lock(hashtext($1))", [tag]);
  const src = await db.query("select o.id,o.created_by from organizations o where slug=$1", [
    sourceSlug,
  ]);
  if (src.rows.length !== 1) throw new Error("Empresa original não encontrada; seed cancelado.");
  const membership = await db.query(
    "select user_id from user_organizations where organization_id=$1 and role='admin' and revoked_at is null order by (user_id=$2) desc limit 1",
    [src.rows[0].id, src.rows[0].created_by],
  );
  if (!membership.rows[0]) throw new Error("Dono da empresa não encontrado.");
  const owner = membership.rows[0].user_id;
  await db.query(
    "insert into organizations(id,slug,display_name,legal_name,created_by,onboarded_at,locale) values($1,$2,'DEMO — Redes Sociais','Demonstração local — dados fictícios',$3,now(),'pt-BR') on conflict(id) do nothing",
    [org, demoSlug, owner],
  );
  await db.query(
    "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'admin',now()) on conflict(user_id,organization_id) do nothing",
    [owner, org],
  );
  const prior = await db.query(
    "select 1 from api_audit_log where organization_id=$1 and action='demo.seed_created' and metadata->>'seed'=$2",
    [org, tag],
  );
  if (prior.rowCount) {
    await db.query("commit");
    process.stdout.write("Seed já existe; dados e interações preservados.\n");
  } else {
    await db.query(
      "insert into social_connections(id,organization_id,account_id,credential) values($1,$2,$3,$4) on conflict(id) do nothing",
      [conn, org, "demo-local-no-provider-account", seal("DEMO_LOCAL_SEM_CREDENCIAL_REAL")],
    );
    for (const network of ["instagram", "messenger"])
      await db.query(
        "insert into channel_sessions(id,organization_id,provider,social_connection_id,social_channel_id,social_network,display_name,status,webhook_secret_encrypted,metadata) values($1,$2,'socios_hub',$3,$4,$5,$6,'STOPPED','\\x00',$7) on conflict(id) do nothing",
        [
          uuid(network),
          org,
          conn,
          `${tag}-${network}`,
          network,
          network === "instagram"
            ? "Instagram [DEMO — sem envio]"
            : "Facebook Messenger [DEMO — sem envio]",
          {
            seed: tag,
            ai_gate: "allowlist",
            ai_gate_mode: "pre_go_live",
            ai_test_phone_numbers: [],
          },
        ],
      );
    await db.query(
      "insert into ai_agents(id,organization_id,name,description,system_prompt,is_active,kind,created_by) values($1,$2,'Assistente social [DEMO]','Rascunho fictício para explorar o editor. Não publicado.','Demonstração local. Não efetue envios nem assuma que os exemplos representam informações reais da empresa.',false,'mcp_agent',$3)",
      [agent, org, owner],
    );
    // A criação da organização já semeia um funil vazio pelo trigger do produto.
    await db.query(
      "update crm_pipelines set is_default=false,is_archived=true where organization_id=$1",
      [org],
    );
    await db.query(
      "insert into crm_pipelines(id,organization_id,name,slug,description,is_default) values($1,$2,'Atendimento social [DEMO]','atendimento-social-demo','Funil fictício para validação de DMs.',true)",
      [pipeline, org],
    );
    const stages = ["Nova DM", "Em atendimento", "Aguardando cliente", "Concluído", "Não avançou"];
    for (let i = 0; i < stages.length; i++)
      await db.query(
        "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position,color,is_won,is_lost) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          uuid(`stage-${i}`),
          org,
          pipeline,
          stages[i],
          `etapa-${i}`,
          i + 1,
          ["#3b82f6", "#8b5cf6", "#f59e0b", "#22c55e", "#ef4444"][i],
          i === 3,
          i === 4,
        ],
      );
    for (const [index, s] of scenarios.entries()) {
      const contact = uuid(`contact-${s.key}`),
        conversation = uuid(`conv-${s.key}`),
        lead = uuid(`lead-${s.key}`),
        session = uuid(s.network);
      await db.query(
        "insert into contacts(id,organization_id,name,display_name,source) values($1,$2,$3,$3,$4)",
        [contact, org, s.name, s.network],
      );
      const human = s.mode === "human";
      await db.query(
        "insert into conversations(id,organization_id,contact_id,channel_session_id,channel,status,assigned_to_user_id,assignee_kind,bot_silenced_until,active_ai_agent_id,provider_recipient_id,provider_conversation_id,metadata,tags) values($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          conversation,
          org,
          contact,
          session,
          s.network,
          human ? owner : null,
          human ? "user" : s.mode === "ai" ? "ai" : null,
          human ? "infinity" : null,
          s.mode === "ai" ? agent : null,
          `demo-person-${s.key}`,
          `demo-thread-${s.key}`,
          { seed: tag, scenario: s.mode },
          ["DEMO", s.network === "instagram" ? "Instagram" : "Facebook"],
        ],
      );
      const history = [
        { body: s.inbound, direction: "inbound", status: "received", via: "crm", age: s.age + 8 },
        {
          body: s.reply,
          direction: "outbound",
          status: s.mode === "failed" ? "failed" : "read",
          via: s.mode === "ai" ? "ai" : "user",
          age: s.age + 4,
        },
      ];
      if (s.last)
        history.push({
          body: s.last,
          direction: "inbound",
          status: "received",
          via: "crm",
          age: s.age,
        });
      for (const [n, m] of history.entries())
        await db.query(
          "insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_by_user_id,sent_at,created_at,external_id,error_code,error_message,metadata) values($1,$2,$3,$4,$5,'text',$6,$7,$8,$9,$10,$11,$11,$12,$13,$14,$15)",
          [
            uuid(`message-${s.key}-${n}`),
            org,
            conversation,
            session,
            contact,
            m.direction,
            m.status,
            m.body,
            m.via,
            m.via === "user" ? owner : null,
            at(m.age),
            `demo-message-${s.key}-${n}`,
            m.status === "failed" ? "demo_delivery_failed" : null,
            m.status === "failed"
              ? "Falha simulada de entrega para validação. Nenhum envio real foi tentado."
              : null,
            { seed: tag, simulated: true },
          ],
        );
      const done = ["won", "lost"].includes(s.mode);
      await db.query(
        "update conversations set status=$3,last_inbound_at=$4,last_outbound_at=$5,last_message_at=$6,last_message_preview=$7,unread_count_for_assignee=$8,bot_silenced_until=$9 where organization_id=$1 and id=$2",
        [
          org,
          conversation,
          done ? "closed" : "open",
          at(s.last ? s.age : s.age + 8),
          at(s.age + 4),
          at(s.last ? s.age : s.age + 4),
          s.last ?? s.reply,
          done ? 0 : 1,
          human ? "infinity" : null,
        ],
      );
      await db.query(
        "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,description,status,lost_reason,closed_at,value_cents,currency,owner_user_id,source,source_metadata,tags,position_in_stage) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'USD',$12,$13,$14,$15,$16)",
        [
          lead,
          org,
          pipeline,
          uuid(`stage-${s.stage}`),
          contact,
          `[DEMO] ${s.title}`,
          "Valores e diálogo fictícios para explorar o CRM.",
          done ? s.mode : "open",
          s.mode === "lost" ? "cancelled_by_customer" : null,
          done ? at(s.age) : null,
          s.value,
          human ? owner : null,
          s.network,
          { seed: tag },
          ["DEMO"],
          1000 + index,
        ],
      );
      await db.query(
        "insert into crm_lead_links(organization_id,lead_id,target_kind,target_id,link_kind,metadata) values($1,$2,'conversation',$3,'primary',$4)",
        [org, lead, conversation, { seed: tag }],
      );
      await db.query(
        "insert into crm_lead_activities(organization_id,lead_id,contact_id,source_module,type,payload,metadata,performed_by_user_id) values($1,$2,$3,'manual','note',$4,$5,$6)",
        [
          org,
          lead,
          contact,
          { text: `DEMO: ${s.title}. Histórico simulado; nenhuma DM real enviada.` },
          { seed: tag },
          owner,
        ],
      );
      if (!done)
        await db.query(
          "insert into crm_tasks(id,organization_id,title,description,contact_id,lead_id,due_date,assigned_to,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$8)",
          [
            uuid(`task-${s.key}`),
            org,
            `[DEMO] Validar ${s.title.toLowerCase()}`,
            "Exercício local: abra a conversa, verifique o histórico e experimente os controles de atendimento.",
            contact,
            lead,
            new Date(Date.now() + (index + 1) * 3600_000).toISOString(),
            owner,
          ],
        );
    }
    await db.query(
      "insert into api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,metadata,bypassed_rls) values($1,$2,'demo.seed_created','organization',$1,$3,true)",
      [org, owner, { seed: tag, contacts: 6, channels: 2, simulated: true }],
    );
    await db.query("commit");
  }
  const counts = await db.query(
    "select (select count(*) from conversations where organization_id=$1) conversations,(select count(*) from messages where organization_id=$1) messages,(select count(*) from crm_leads where organization_id=$1) leads,(select count(*) from crm_tasks where organization_id=$1) tasks",
    [org],
  );
  process.stdout.write(
    JSON.stringify({ organization_id: org, name: "DEMO — Redes Sociais", ...counts.rows[0] }) +
      "\n",
  );
} catch (error) {
  await db.query("rollback");
  throw error;
} finally {
  db.release();
  await pool.end();
}
