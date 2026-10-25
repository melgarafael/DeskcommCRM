/**
 * Semeia a empresa de demonstração do curso ("Clínica Bem Viver") numa
 * instalação FRESCA (baseline.sql + scripts/bootstrap-owner.ts): equipe, número
 * de WhatsApp, agente de IA publicado, respostas rápidas e 12 conversas nos
 * estados que as lições fotografam. Grava curso/saida/contas.json.
 *
 *   set -a; . ./.env.e2e; set +a; pnpm exec tsx curso/semear-demonstracao.ts [modulo]
 *
 * Com [modulo], depois da base roda curso/semear/<modulo>.ts — os dados que só
 * aquela tela precisa (agenda, tarefas, casos…). Ela recebe o Contexto abaixo,
 * limpa SÓ as próprias linhas e recria: um módulo nunca apaga o dado de outro.
 *
 * Idempotente: apaga as conversas e os contatos da organização e recria tudo
 * com os mesmos ids — as lições mudam o estado (assumir, fechar, transferir),
 * então o capturador roda isto antes de cada lição (CURSO_ANTES_DA_LICAO).
 *
 * Recusa qualquer Supabase que não seja local. Rode com o worker PARADO: com ele
 * de pé, as mensagens semeadas acordam a IA. Horários são relativos ao seed.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type User, createClient } from "@supabase/supabase-js";

const URL_SUPABASE = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const CHAVE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const SENHA = process.env.CURSO_SENHA ?? "Curso!Demo2026";
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URL_SUPABASE)) {
  throw new Error(`recusado: ${URL_SUPABASE || "(vazio)"} não é um Supabase local`);
}
if (!CHAVE) throw new Error("defina SUPABASE_SERVICE_ROLE_KEY (o .env.e2e tem)");

const db = createClient(URL_SUPABASE, CHAVE, { auth: { autoRefreshToken: false, persistSession: false } });
const MIN = 60_000;
const agora = Date.now();
export const ha = (minutos: number) => new Date(agora - minutos * MIN).toISOString();
/** "Ontem às HH:MM" no fuso de São Paulo (UTC-3, sem horário de verão). */
export function ontemAs(h: number, m: number) {
  const sp = new Date(agora - 3 * 60 * MIN);
  return new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() - 1, h + 3, m)).toISOString();
}
export const conversaId = (n: number) => `be100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const contatoId = (n: number) => `be200000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function exigir<T>(r: { data: T | null; error: { message: string } | null }, onde: string): T {
  if (r.error) throw new Error(`${onde}: ${r.error.message}`);
  if (r.data === null) throw new Error(`${onde}: sem dados`);
  return r.data;
}
/** Respostas do GoTrue: no erro o `user` vem null, então o tipo não cabe no `exigir`. */
function usuarioDe(r: { data: { user: User | null }; error: { message: string } | null }, onde: string): User {
  if (r.error || !r.data.user) throw new Error(`${onde}: ${r.error?.message ?? "sem usuário"}`);
  return r.data.user;
}
async function todosOsUsuarios(): Promise<User[]> {
  const r = await db.auth.admin.listUsers({ perPage: 1000 });
  if (r.error) throw new Error(`listUsers: ${r.error.message}`);
  return r.data.users;
}
/** Para chamadas que não devolvem linha (RPC void, delete): só o erro importa. */
export function semErro(r: { error: { message: string } | null }, onde: string) {
  if (r.error) throw new Error(`${onde}: ${r.error.message}`);
}

const EMAIL = { helena: "helena@clinicabemviver.com.br", ana: "ana@clinicabemviver.com.br", carlos: "carlos@clinicabemviver.com.br" };

async function membro(email: string, nome: string, papel: "manager" | "agent", orgId: string) {
  let u = (await todosOsUsuarios()).find((x) => x.email === email);
  if (!u) {
    u = usuarioDe(await db.auth.admin.createUser({ email, password: SENHA, email_confirm: true, user_metadata: { full_name: nome } }), `createUser ${email}`);
  } else {
    // sem senha aqui: trocar a senha encerra as sessões abertas, e o capturador entra uma vez só
    usuarioDe(await db.auth.admin.updateUserById(u.id, { user_metadata: { full_name: nome } }), `updateUser ${email}`);
  }
  semErro(
    await db.from("user_organizations").upsert(
      { user_id: u.id, organization_id: orgId, role: papel, accepted_at: new Date().toISOString() },
      { onConflict: "user_id,organization_id" },
    ),
    `user_organizations ${email}`,
  );
  return u.id;
}

type Quem = "cliente" | "ia" | "helena" | "ana";
type Msg = { em: string; quem: Quem; texto: string; status?: "read" | "delivered" | "failed"; grupo?: { name: string; phone: string } };
const m = (minutos: number, quem: Quem, texto: string, extra: Partial<Msg> = {}): Msg => ({ em: ha(minutos), quem, texto, ...extra });

type Conversa = {
  n: number;
  nome: string;
  telefone: string | null;
  etiquetasContato?: string[];
  etiquetasConversa?: string[];
  contato?: { force_human?: boolean; is_blocked?: boolean };
  mensagens: Msg[];
  dono?: "helena" | "ana" | "carlos";
  motivoDono?: "claim" | "routing";
  status?: "ai_handling" | "claimed" | "closed" | "archived";
  silencio?: boolean;
  naoLidas: number;
  exemplo?: boolean;
  grupo?: string;
};

const CONVERSAS: Conversa[] = [
  {
    n: 1, nome: "Mariana Souza", telefone: "+5511987650001", etiquetasContato: ["primeira-consulta", "particular"], etiquetasConversa: ["agendamento"],
    mensagens: [
      m(45, "cliente", "Oi, boa tarde! Queria marcar uma consulta com a nutricionista."),
      m(44, "ia", "Olá, Mariana! Posso te ajudar com o agendamento. Você já é paciente da clínica?"),
      m(40, "cliente", "Na verdade prefiro falar com uma pessoa, tenho umas dúvidas sobre o plano alimentar."),
      m(38, "cliente", "Pode ser?"),
    ],
    silencio: true, naoLidas: 2,
  },
  {
    n: 2, nome: "Roberto Almeida", telefone: "+5511987650002", contato: { force_human: true },
    mensagens: [m(12, "cliente", "Bom dia, preciso remarcar a fisioterapia de amanhã, surgiu um imprevisto no trabalho.")],
    naoLidas: 1,
  },
  {
    n: 3, nome: "Juliana Castro", telefone: "+5511987650003", etiquetasContato: ["convenio"],
    mensagens: [
      m(92, "cliente", "Vocês atendem pelo convênio Unimed?"),
      m(90, "ia", "Atendemos sim, Juliana! Para fisioterapia e nutrição. Quer que eu veja um horário para você?"),
    ],
    status: "ai_handling", naoLidas: 0,
  },
  {
    n: 4, nome: "Pedro Henrique Lima", telefone: "+5511987650004",
    mensagens: [
      m(6, "cliente", "Qual o valor da consulta particular com a nutricionista?"),
      m(5, "ia", "A consulta particular custa R$ 280,00, Pedro, e inclui o retorno em 30 dias."),
      m(3, "cliente", "E aceitam Pix?"),
    ],
    status: "ai_handling", naoLidas: 1,
  },
  {
    n: 5, nome: "Fernanda Oliveira", telefone: "+5511987650005", etiquetasContato: ["retorno", "convenio", "pos-operatorio"],
    mensagens: [
      { em: ontemAs(16, 2), quem: "cliente", texto: "Boa tarde! Fiz a cirurgia semana passada e preciso marcar o retorno com o Dr. Paulo." },
      { em: ontemAs(16, 3), quem: "ia", texto: "Oi, Fernanda! Que bom ter notícias suas. Vou verificar os horários do Dr. Paulo para você." },
      { em: ontemAs(16, 10), quem: "cliente", texto: "Pode ser na quinta de manhã?" },
      m(130, "helena", "Bom dia, Fernanda! Tenho quinta às 9h30 com o Dr. Paulo. Posso confirmar?"),
      m(125, "cliente", "Pode sim! Preciso levar algum exame?"),
      m(123, "helena", "Traga o laudo da cirurgia e a lista de remédios que está tomando.", { status: "delivered" }),
      m(122, "helena", "Endereço: Rua das Acácias, 120 — 3º andar.", { status: "failed" }),
    ],
    dono: "helena", status: "claimed", silencio: true, naoLidas: 0,
  },
  {
    n: 6, nome: "Lucas Martins", telefone: "+5511987650006",
    mensagens: [
      m(185, "ana", "Combinado, Lucas! Sua sessão fica para sexta às 18h."),
      m(180, "cliente", "Obrigado, Ana! Até sexta."),
    ],
    dono: "ana", status: "claimed", silencio: true, naoLidas: 0,
  },
  {
    n: 7, nome: "Camila Rocha", telefone: "+5511987650007",
    mensagens: [
      m(52, "cliente", "Oi! A avaliação postural é feita no mesmo dia da primeira sessão?"),
      m(50, "ia", "Oi, Camila! Sim, a avaliação acontece no início da primeira sessão e leva uns 20 minutos."),
    ],
    dono: "helena", motivoDono: "routing", status: "claimed", naoLidas: 0,
  },
  {
    n: 8, nome: "Beatriz Nogueira", telefone: "+5511987650008",
    mensagens: [m(2 * 24 * 60, "cliente", "Muito obrigada pelo atendimento, até a próxima!")],
    dono: "carlos", status: "closed", naoLidas: 0,
  },
  {
    n: 9, nome: "Antônio Ferreira", telefone: "+5511987650009",
    mensagens: [m(6 * 24 * 60, "cliente", "Vou ver com minha esposa e depois retorno.")],
    status: "archived", naoLidas: 0,
  },
  {
    n: 10, nome: "Turma de Pilates — Terça 19h", telefone: null, grupo: "120363025000000001@g.us",
    mensagens: [m(5, "cliente", "Gente, amanhã alguém consegue trocar de horário comigo?", { grupo: { name: "Sônia Prado", phone: "+5511987650020" } })],
    naoLidas: 1,
  },
  {
    n: 11, nome: "Osvaldo Pires", telefone: "+5511987650011", contato: { is_blocked: true },
    mensagens: [m(24 * 60, "cliente", "Parem de me mandar mensagem.")],
    status: "closed", naoLidas: 0,
  },
  {
    n: 12, nome: "Tereza Gomes", telefone: "+5511987650012",
    mensagens: [
      m(305, "cliente", "Consegui fazer os exercícios em casa, obrigada pelas dicas!"),
      m(300, "ana", "Que ótimo, Tereza! Continue 3 vezes por semana e me conte na próxima sessão."),
    ],
    dono: "ana", status: "closed", exemplo: true, naoLidas: 0,
  },
];

/** O que a base deixa pronto para a semente de um módulo. */
export type Contexto = {
  db: typeof db;
  org: string;
  pessoa: { helena: string; ana: string; carlos: string };
  sessao: string;
  agenteId: string;
  funil: { id: string; etapas: string[] };
};

async function main(): Promise<Contexto> {
  // ---------- organização: a única da instalação fresca ----------
  const orgs = exigir(await db.from("organizations").select("id"), "organizations") as Array<{ id: string }>;
  if (orgs.length !== 1) throw new Error(`esperava 1 organização (instalação fresca), achei ${orgs.length}`);
  const org = orgs[0]!.id;
  semErro(await db.from("organizations").update({
    display_name: "Clínica Bem Viver", legal_name: "Clínica Bem Viver Saúde Integrada Ltda", status: "active", onboarded_at: new Date().toISOString(),
  }).eq("id", org), "organização");

  // ---------- equipe: o dono do bootstrap vira a Helena, da recepção ----------
  const dono = exigir(
    await db.from("user_organizations").select("user_id").eq("organization_id", org).eq("role", "admin").order("created_at").limit(1).single(),
    "dono",
  ) as { user_id: string };
  const atual = usuarioDe(await db.auth.admin.getUserById(dono.user_id), "dono");
  // e-mail e senha só na primeira vez: trocar a senha encerra as sessões abertas do capturador
  usuarioDe(await db.auth.admin.updateUserById(dono.user_id, {
    user_metadata: { full_name: "Helena Prado" },
    ...(atual.email === EMAIL.helena ? {} : { email: EMAIL.helena, email_confirm: true, password: SENHA }),
  }), "Helena");
  const pessoa = {
    helena: dono.user_id,
    ana: await membro(EMAIL.ana, "Ana Ribeiro", "agent", org),
    carlos: await membro(EMAIL.carlos, "Carlos Mendes", "manager", org),
  };

  // ---------- recomeça do zero ----------
  semErro(await db.from("conversations").delete().eq("organization_id", org), "limpar conversas");
  semErro(await db.from("crm_leads").delete().eq("organization_id", org), "limpar leads");
  semErro(await db.from("contacts").delete().eq("organization_id", org), "limpar contatos");
  semErro(await db.from("message_templates").delete().eq("organization_id", org), "limpar respostas rápidas");
  semErro(await db.from("channel_session_groups").delete().eq("organization_id", org), "limpar grupos");

  // ---------- número de WhatsApp (um só: sem seletor de número nem faixa de queda) ----------
  // reaproveita o canal que já existir (o agente publicado aponta para ele) e arquiva os demais
  const sessoes = exigir(await db.from("channel_sessions").select("id").eq("organization_id", org).is("archived_at", null).order("created_at"), "sessões") as Array<{ id: string }>;
  const sessao = sessoes[0]?.id ?? (exigir(
    await db.from("channel_sessions").insert({
      organization_id: org, provider: "waha", waha_session_name: "bemviver-recepcao", webhook_secret_encrypted: "\\x00",
      status: "WORKING", phone_number: "+551140028922", display_name: "Recepção Bem Viver",
    }).select("id").single(),
    "channel_sessions",
  ) as { id: string }).id;
  for (const outra of sessoes.slice(1)) semErro(await db.from("channel_sessions").update({ archived_at: new Date().toISOString() }).eq("id", outra.id), "arquivar canal");
  semErro(await db.from("channel_sessions").update({
    status: "WORKING", display_name: "Recepção Bem Viver", waha_session_name: "bemviver-recepcao", phone_number: "+551140028922",
  }).eq("id", sessao), "sessão no ar");

  // ---------- agente de IA publicado (liga a aba Automático; nunca é chamado) ----------
  const PROMPT = "Você é a Bia, recepcionista virtual da Clínica Bem Viver.";
  // o formato que a tela do agente conhece; com o prefixo do gateway, o campo "Modelo" aparecia vazio
  const MODELO = "claude-sonnet-4-6";
  const agentes = exigir(await db.from("ai_agents").select("id, published_version_id").eq("organization_id", org), "ai_agents") as Array<{ id: string; published_version_id: string | null }>;
  const agenteId = agentes[0]?.id ?? (exigir(
    await db.from("ai_agents").insert({ organization_id: org, name: "Bia — Recepção virtual", system_prompt: PROMPT, is_default: true, is_active: true }).select("id").single(),
    "agente",
  ) as { id: string }).id;
  semErro(await db.from("ai_agents").update({ name: "Bia — Recepção virtual" }).eq("id", agenteId), "nome do agente");
  if (!agentes[0]?.published_version_id) {
    const versao = exigir(
      await db.from("ai_agent_versions").insert({
        organization_id: org, agent_id: agenteId, version_number: 1, system_prompt: PROMPT, provider: "anthropic", model: MODELO,
        credential_id: null, channel_session_id: sessao, status: "published", published_at: new Date().toISOString(),
      }).select("id").single(),
      "versão do agente",
    ) as { id: string };
    semErro(await db.from("ai_agents").update({ published_version_id: versao.id }).eq("id", agenteId), "publicar agente");
  }

  // ---------- respostas rápidas ----------
  semErro(await db.from("message_templates").insert([
    { title: "Horários da nutricionista", shortcut: "horarios", body: "Oi, {{primeiro_nome}}! A Dra. Lívia atende às terças e quintas, das 8h às 12h. Qual dia fica melhor para você?" },
    { title: "Endereço da clínica", shortcut: "endereco", body: "Estamos na Rua das Acácias, 120 — 3º andar, Vila Mariana. Temos estacionamento conveniado no prédio ao lado." },
    { title: "Preparo para exame de sangue", shortcut: "jejum", body: "Para o exame, é preciso jejum de 8 horas. Pode beber água normalmente." },
  ].map((t) => ({ ...t, organization_id: org, created_by_user_id: pessoa.helena }))), "respostas rápidas");

  // ---------- funil: o "Pedidos" que a org ganha ao nascer vira "Pacientes" ----------
  const funil = exigir(await db.from("crm_pipelines").select("id").eq("organization_id", org).eq("is_default", true).limit(1).single(), "funil") as { id: string };
  semErro(await db.from("crm_pipelines").update({ name: "Pacientes" }).eq("id", funil.id), "nome do funil");
  const etapas = exigir(await db.from("crm_stages").select("id").eq("pipeline_id", funil.id).order("position"), "etapas") as Array<{ id: string }>;
  const NOMES = ["Primeiro contato", "Consulta agendada", "Em tratamento", "Retorno"];
  for (const [i, nome] of NOMES.entries()) {
    if (etapas[i]) semErro(await db.from("crm_stages").update({ name: nome }).eq("id", etapas[i]!.id), `etapa ${nome}`);
  }

  // ---------- conversas ----------
  for (const c of CONVERSAS) {
    const contato = contatoId(c.n), conversa = conversaId(c.n);
    semErro(await db.from("contacts").insert({
      id: contato, organization_id: org, name: c.nome, phone_number: c.telefone, tags: c.etiquetasContato ?? [], ...c.contato,
    }), `contato ${c.nome}`);
    semErro(await db.from("conversations").insert({
      id: conversa, organization_id: org, contact_id: contato, channel_session_id: sessao, status: "open",
      tags: c.etiquetasConversa ?? [], is_group: Boolean(c.grupo), group_chat_id: c.grupo ?? null,
    }), `conversa ${c.nome}`);
    if (c.grupo) {
      semErro(await db.from("channel_session_groups").insert({
        organization_id: org, channel_session_id: sessao, group_chat_id: c.grupo, subject: c.nome, enabled: true,
        enabled_at: ha(60 * 24 * 7), enabled_by_user_id: pessoa.helena, contact_id: contato, conversation_id: conversa,
      }), "grupo");
    }
    // mensagens ANTES de dono e status: uma recebida reabre conversa fechada
    for (const msg of c.mensagens) {
      const recebida = msg.quem === "cliente";
      const humano = msg.quem === "helena" || msg.quem === "ana";
      semErro(await db.from("messages").insert({
        organization_id: org, conversation_id: conversa, channel_session_id: sessao, contact_id: contato,
        type: "text", body: msg.texto, direction: recebida ? "inbound" : "outbound",
        status: recebida ? "received" : (msg.status ?? "read"),
        sent_via: recebida ? "external_device" : humano ? "user" : "ai",
        sent_by_user_id: humano ? pessoa[msg.quem as "helena" | "ana"] : null,
        sent_at: msg.em, created_at: msg.em,
        ...(msg.status === "failed" ? { error_message: "Não foi possível enviar esta mensagem." } : {}),
        ...(msg.quem === "ia" ? { metadata: { ai_generated: true } } : {}),
        ...(msg.grupo ? { metadata: { group_sender: msg.grupo } } : {}),
      }), `mensagem de ${c.nome}`);
      semErro(await db.rpc("fn_mark_conversation_message", {
        p_conv: conversa, p_direction: recebida ? "inbound" : "outbound", p_preview: msg.texto, p_at: msg.em,
      }), `carimbo de ${c.nome}`);
    }
    if (c.dono) {
      semErro(await db.rpc("fn_conversation_assign", {
        p_organization_id: org, p_conversation_id: conversa, p_to_user_id: pessoa[c.dono], p_reason: c.motivoDono ?? "claim",
      }), `atribuir ${c.nome}`);
    }
    const ultima = c.mensagens.at(-1)!.em;
    semErro(await db.from("conversations").update({
      ...(c.status ? { status: c.status } : {}),
      // claim também cala o robô; só o silêncio pedido pelo roteiro fica
      bot_silenced_until: c.silencio ? "infinity" : null,
      ...(c.silencio && !c.dono ? { last_handoff_at: ha(39), last_handoff_reason: "requested_human" } : {}),
      ...(c.exemplo ? { usable_for_rag: true, usable_for_rag_marked_at: ultima, usable_for_rag_marked_by: pessoa.ana } : {}),
      unread_count_for_assignee: c.naoLidas,
    }).eq("id", conversa), `estado de ${c.nome}`);
  }

  // ---------- extras das lições ----------
  semErro(await db.from("passagens_de_atendimento").insert({
    organization_id: org, contact_id: contatoId(1), conversation_id: conversaId(1), criado_em: ha(39),
    motor: "engine", origem: "pedido_explicito", motivo_codigo: "requested_human",
    title: "Marcar a primeira consulta com a nutricionista",
    body: "Paciente quer marcar a primeira consulta com a nutricionista e pediu para falar com uma pessoa sobre o plano alimentar.",
    notes: "Na verdade prefiro falar com uma pessoa, tenho umas dúvidas sobre o plano alimentar.",
    tentativas: [{ o_que: "Perguntou se ela já é paciente da clínica" }], cliente_avisado: true,
  }), "passagem");
  semErro(await db.from("conversation_notes").insert({
    organization_id: org, conversation_id: conversaId(5), created_at: ha(110), created_by_user_id: pessoa.carlos, created_by_name: "Carlos Mendes",
    body: "Paciente pós-operatória. Confirmar com o Dr. Paulo se precisa trocar o curativo no retorno.",
  }), "nota");
  // a demanda da Fernanda fica sem próximo passo: é o destaque que a lição da ficha ensina a resolver
  const c5 = exigir(await db.from("conversations").select("current_demanda_id").eq("id", conversaId(5)).single(), "demanda C05") as { current_demanda_id: string | null };
  if (c5.current_demanda_id) semErro(await db.from("demandas").update({ proximo_passo: null }).eq("id", c5.current_demanda_id), "próximo passo");
  for (const [n, titulo, etapa, reais] of [[1, "Primeira consulta nutricional — Mariana", 0, 280], [5, "Retorno pós-cirúrgico — Fernanda Oliveira", 1, 350]] as const) {
    semErro(await db.from("crm_leads").insert({
      organization_id: org, pipeline_id: funil.id, stage_id: etapas[etapa]!.id, title: titulo, contact_id: contatoId(n),
      value_cents: reais * 100, currency: "BRL", status: "open",
    }), `lead ${titulo}`);
  }

  const saida = path.join(path.dirname(new URL(import.meta.url).pathname), "saida");
  mkdirSync(saida, { recursive: true });
  writeFileSync(path.join(saida, "contas.json"), JSON.stringify({
    admin: { email: EMAIL.helena, senha: SENHA },
    manager: { email: EMAIL.carlos, senha: SENHA },
    agent: { email: EMAIL.ana, senha: SENHA },
  }, null, 2));
  console.info(`demonstração semeada: ${CONVERSAS.length} conversas na org ${org}`);
  return { db, org, pessoa, sessao, agenteId, funil: { id: funil.id, etapas: etapas.map((e) => e.id) } };
}

async function rodar() {
  const ctx = await main();
  const modulo = process.argv[2];
  if (!modulo || modulo === "inbox") return;
  if (!/^[a-z0-9-]+$/.test(modulo)) throw new Error(`módulo inválido: ${modulo}`);
  const arquivo = path.join(path.dirname(new URL(import.meta.url).pathname), "semear", `${modulo}.ts`);
  if (!existsSync(arquivo)) return;
  const semente = (await import(arquivo)) as { semear: (c: Contexto) => Promise<void> };
  await semente.semear(ctx);
  console.info(`semente do módulo ${modulo} aplicada`);
}

// só roda quando chamado direto; as sementes de módulo importam os ajudantes daqui
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  rodar().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
