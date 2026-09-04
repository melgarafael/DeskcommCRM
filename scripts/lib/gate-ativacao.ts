/**
 * A bateria de PREFLIGHTS do `scripts/ativar-gate-elegibilidade-ia.ts`, separada
 * do encanamento (args, `pg.Pool`, `process.exit`) para ser testável — unit com
 * um pool falso, invariante com Postgres real.
 *
 * Cada preflight é uma função `(ctx) => Promise<Resultado>`. Nenhuma escreve
 * nada: a única escrita do fluxo (`channel_sessions.metadata.ai_gate`) mora no
 * script, atrás de `--apply`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  campanhaWhatsappSchema,
  normalizarParaMatch,
  parseCampanhas,
  type CampanhaWhatsapp,
} from "../../lib/ai/elegibilidade/campanha";
import {
  decidirElegibilidade,
  lerModoDoGate,
  montarEstadoDeElegibilidade,
} from "../../lib/ai/elegibilidade/gate";

// ───────────────────────────────────────────────────────────────────────────
// Tipos
// ───────────────────────────────────────────────────────────────────────────

export type Status = "PASS" | "WARN" | "FAIL" | "INFO";
export interface Resultado {
  status: Status;
  detalhe: string;
  linhas?: string[];
}

/** O mínimo de `pg.Pool` que os preflights usam. */
export interface ConsultaPg {
  query: (
    texto: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface CtxAtivacao {
  pool: ConsultaPg;
  organizationId: string;
  channelSessionId: string;
  channelMetadata: Record<string, unknown>;
  /** raiz do repo — para as checagens de código-fonte (INFO se ausente). */
  raiz: string;
  ttlMs: number;
  alvoModo: "allowlist" | "open";
  rollback: boolean;
  opcoes: {
    permitirSemAgente: boolean;
    campanhasPerigosasOk: boolean;
    tamAmostra: number;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Heurística: campanha perigosa (casa conversa comum)
// ───────────────────────────────────────────────────────────────────────────

export const TOKENS_GENERICOS = new Set([
  "oi", "ola", "opa", "hey", "bom", "boa", "dia", "tarde", "noite", "tudo", "bem",
  "obrigado", "obrigada", "quero", "gostaria", "saber", "mais", "informacao",
  "informacoes", "info", "duvida", "duvidas", "ajuda", "orcamento", "orcamentos",
  "preco", "precos", "valor", "valores", "quanto", "custa", "custo", "interesse",
  "interessado", "interessada", "contratar", "comprar", "atendimento", "falar",
  "contato", "e", "de", "do", "da", "um", "uma", "para", "pra", "por", "favor",
  "me", "chama", "voces", "voce", "sobre",
]);

/**
 * `null` = a campanha é específica o suficiente. String = por que casa demais.
 *   - `contains`:  < 15 chars normalizados, OU < 3 palavras, OU todas genéricas;
 *   - `starts_with`: prefixo < 12 chars, OU 1 palavra só.
 */
export function campanhaPerigosa(c: CampanhaWhatsapp): string | null {
  campanhaWhatsappSchema.parse(c); // sanidade — não lança (veio de parseCampanhas)
  const v = normalizarParaMatch(c.match.valor);
  const palavras = v.split(" ").filter(Boolean);
  if (c.match.tipo === "contains") {
    if (v.length < 15) return `match 'contains' com frase de ${v.length} chars — casa conversa comum`;
    if (palavras.length < 3) return `match 'contains' com só ${palavras.length} palavra(s)`;
    if (palavras.every((p) => TOKENS_GENERICOS.has(p))) return `todas as palavras da frase são genéricas ("${v}")`;
    return null;
  }
  if (v.length < 12) return `match 'starts_with' com prefixo de ${v.length} chars`;
  if (palavras.length < 2) return `match 'starts_with' com uma palavra só`;
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function estado(
  r: Record<string, unknown>,
  modo: "open" | "allowlist",
  ttlMs: number,
  agora: Date,
) {
  return montarEstadoDeElegibilidade({
    aiGate: modo,
    forceHuman: r.force_human,
    assigneeKind: (r.assignee_kind as string | null) ?? null,
    botSilencedUntil: r.bot_silenced_until as string | null,
    aiAuthorizedAt: r.ai_authorized_at as string | null,
    agora,
    ttlMs,
  });
}

function lerFonte(raiz: string, arq: string): string | null {
  try {
    return readFileSync(resolve(raiz, arq), "utf-8");
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Preflights
// ───────────────────────────────────────────────────────────────────────────

export async function checkSchema0203(ctx: CtxAtivacao): Promise<Resultado> {
  const { rows } = await ctx.pool.query(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = 'contacts'
        and column_name in ('ai_authorized_at','ai_authorized_reason')
      order by column_name`,
  );
  const nomes = rows.map((r) => r.column_name);
  if (!nomes.includes("ai_authorized_at") || !nomes.includes("ai_authorized_reason")) {
    return {
      status: "FAIL",
      detalhe:
        "colunas ausentes — a migration 0203 não foi aplicada nesta instalação. " +
        "Aplique o supabase/baseline.sql (o `update.sh` do kit) ANTES de ligar o gate.",
      linhas: [`encontradas: ${nomes.join(", ") || "(nenhuma)"}`],
    };
  }
  const at = rows.find((r) => r.column_name === "ai_authorized_at")!;
  const rz = rows.find((r) => r.column_name === "ai_authorized_reason")!;
  const problemas: string[] = [];
  if (at.data_type !== "timestamp with time zone") problemas.push(`ai_authorized_at é ${at.data_type as string}, esperado timestamptz`);
  if (at.is_nullable !== "YES") problemas.push("ai_authorized_at NOT NULL — a migration certa cria a coluna anulável");
  if (at.column_default !== null) problemas.push(`ai_authorized_at tem default (${at.column_default as string}) — não deveria`);
  if (rz.is_nullable !== "YES") problemas.push("ai_authorized_reason NOT NULL — deveria ser anulável");
  if (problemas.length > 0) return { status: "FAIL", detalhe: "colunas existem mas com forma errada", linhas: problemas };
  return { status: "PASS", detalhe: "ai_authorized_at + ai_authorized_reason presentes, anuláveis, sem default/constraint" };
}

export async function checkQueryElegibilidade(ctx: CtxAtivacao): Promise<Resultado> {
  const linhas: string[] = [];
  try {
    const { rows } = await ctx.pool.query(
      `select cs.metadata->>'ai_gate' as ai_gate, ct.force_human, cv.assignee_kind,
              cv.bot_silenced_until, ct.ai_authorized_at
         from conversations cv
         join contacts ct on ct.id = cv.contact_id and ct.organization_id = cv.organization_id
         join channel_sessions cs on cs.id = cv.channel_session_id and cs.organization_id = cv.organization_id
        where cv.organization_id = $1 and cv.id = $2`,
      [ctx.organizationId, "00000000-0000-4000-8000-000000000000"],
    );
    linhas.push(`query base (consulta-pg.ts) resolveu — ${rows.length} linha(s) para o id de teste`);
  } catch (e) {
    return {
      status: "FAIL",
      detalhe: "a query base da elegibilidade não roda neste schema",
      linhas: [e instanceof Error ? e.message : String(e)],
    };
  }
  const { rows: real } = await ctx.pool.query(
    `select cv.id, cs.metadata->>'ai_gate' as ai_gate, ct.force_human, cv.assignee_kind,
            cv.bot_silenced_until, ct.ai_authorized_at
       from conversations cv
       join contacts ct on ct.id = cv.contact_id and ct.organization_id = cv.organization_id
       join channel_sessions cs on cs.id = cv.channel_session_id and cs.organization_id = cv.organization_id
      where cv.organization_id = $1 and cv.channel_session_id = $2 and cv.is_group = false
      order by cv.last_message_at desc nulls last
      limit 1`,
    [ctx.organizationId, ctx.channelSessionId],
  );
  if (real[0]) {
    const agora = new Date();
    const hoje = decidirElegibilidade(estado(real[0], lerModoDoGate(real[0].ai_gate), ctx.ttlMs, agora));
    const comGate = decidirElegibilidade(estado(real[0], "allowlist", ctx.ttlMs, agora));
    linhas.push(
      `conversa real ${real[0].id as string}: hoje → ${hoje.permite ? "responde" : "não responde"} (${hoje.motivo}); ` +
        `com allowlist → ${comGate.permite ? "responde" : "não responde"} (${comGate.motivo})`,
    );
  } else {
    linhas.push("nenhuma conversa neste canal para exercitar a regra com dado real");
  }
  return { status: "PASS", detalhe: "a leitura de elegibilidade funciona", linhas };
}

export async function checkAgentePublicado(ctx: CtxAtivacao): Promise<Resultado> {
  const { rows } = await ctx.pool.query(
    `select
       exists(select 1 from ai_agents a
                join ai_agent_versions v on v.id = a.published_version_id
               where a.organization_id = $1 and a.archived_at is null
                 and v.status = 'published' and v.channel_session_id = $2) as tem_agente,
       exists(select 1 from ai_routers r
               where r.organization_id = $1 and r.is_active and r.channel_session_id = $2
                 and (r.fallback_agent_id is not null
                      or exists(select 1 from ai_router_members m where m.router_id = r.id))) as tem_roteador,
       exists(select 1 from ai_agents a
               where a.organization_id = $1 and a.is_active and a.archived_at is null) as tem_agente_legado`,
    [ctx.organizationId, ctx.channelSessionId],
  );
  const { tem_agente, tem_roteador, tem_agente_legado } = rows[0] as Record<string, boolean>;
  if (tem_agente || tem_roteador) {
    return {
      status: "PASS",
      detalhe: `caminho do agent-engine ativo (agente publicado: ${tem_agente}, roteador: ${tem_roteador})`,
    };
  }
  const linhas = [
    "nenhuma versão de agente publicada nem roteador ativo para este canal.",
    tem_agente_legado
      ? "há agente com `is_active` (caminho legado do ai-response-worker) — que também respeita o gate."
      : "não há agente algum configurado — ligar o gate não tem efeito visível até publicar um.",
  ];
  if (ctx.opcoes.permitirSemAgente) {
    return { status: "WARN", detalhe: "sem agente publicado — seguindo por --permitir-sem-agente", linhas };
  }
  return {
    status: "FAIL",
    detalhe: "sem agente publicado no canal. Publique um antes, ou passe --permitir-sem-agente.",
    linhas,
  };
}

const CAMINHOS_COM_GATE: Array<[string, string]> = [
  ["lib/agent-engine/edge/crm/drain.ts", "decidirElegibilidadeDaConversa"],
  ["lib/agent-engine/agent/inbound-turn.ts", "decidirElegibilidadeDaConversa"],
  ["workers/ai-response-worker.ts", "decidirElegibilidadeDaConversaViaSupabase"],
  ["lib/followup/enviar-texto-fixo.ts", "decidirElegibilidadeDaConversaViaSupabase"],
  ["lib/ai/runtime/agent.ts", "decidirElegibilidadeDaConversaViaSupabase"],
  ["lib/ai/handoff/orchestrator.ts", "decidirElegibilidadeDaConversaViaSupabase"],
  ["workers/ai-sentiment-worker.ts", "decidirElegibilidadeDaConversaViaSupabase"],
  ["lib/followup/silence-sweep.ts", "ai_gate"],
];

export async function checkCoberturaDosCaminhos(ctx: CtxAtivacao): Promise<Resultado> {
  const faltando: string[] = [];
  let semFonte = 0;
  for (const [arq, marcador] of CAMINHOS_COM_GATE) {
    const src = lerFonte(ctx.raiz, arq);
    if (src === null) {
      semFonte++;
      continue;
    }
    if (!src.includes(marcador)) faltando.push(`${arq} — sem \`${marcador}\``);
  }
  if (faltando.length > 0) {
    return { status: "FAIL", detalhe: "um caminho de resposta perdeu o gate — NÃO ative até consertar", linhas: faltando };
  }
  if (semFonte === CAMINHOS_COM_GATE.length) {
    return {
      status: "INFO",
      detalhe:
        "código-fonte não disponível aqui (imagem buildada) — a cobertura dos caminhos é garantida pelo CI " +
        "(testes J20 em docs/testing/user-journey-map.md). Rode de um checkout para a verificação estática.",
    };
  }
  return {
    status: "PASS",
    detalhe: `${CAMINHOS_COM_GATE.length - semFonte}/${CAMINHOS_COM_GATE.length} caminhos verificados — todos consultam a mesma regra`,
  };
}

export async function checkImpactoConversas(ctx: CtxAtivacao): Promise<Resultado> {
  const CAP = 50000;
  const { rows } = await ctx.pool.query(
    `select cv.id as conversation_id, cv.status, cv.last_inbound_at, cv.bot_silenced_until, cv.assignee_kind,
            coalesce(ct.name, ct.display_name) as name, ct.phone_number, ct.force_human, ct.ai_authorized_at
       from conversations cv
       join contacts ct on ct.id = cv.contact_id and ct.organization_id = cv.organization_id
      where cv.organization_id = $1 and cv.channel_session_id = $2 and cv.is_group = false
      limit ${CAP}`,
    [ctx.organizationId, ctx.channelSessionId],
  );
  const agora = new Date();
  const perdem: Array<Record<string, unknown>> = [];
  let mantem = 0;
  let jaBloqueada = 0;
  for (const r of rows) {
    const hoje = decidirElegibilidade(estado(r, "open", ctx.ttlMs, agora));
    const depois = decidirElegibilidade(estado(r, "allowlist", ctx.ttlMs, agora));
    if (hoje.permite && !depois.permite) perdem.push(r);
    else if (depois.permite) mantem++;
    else jaBloqueada++;
  }
  const capado = rows.length === CAP;
  const recente = (r: Record<string, unknown>) =>
    r.last_inbound_at != null &&
    agora.getTime() - new Date(r.last_inbound_at as string).getTime() < 7 * 24 * 3600 * 1000;
  const perdemAtivas = perdem.filter(recente).length;
  const mascara = (t: unknown) => (typeof t === "string" && t ? t.replace(/\d(?=\d{4})/g, "•") : "(sem)");
  const amostra = perdem
    .sort(
      (a, b) =>
        new Date((b.last_inbound_at as string) ?? 0).getTime() -
        new Date((a.last_inbound_at as string) ?? 0).getTime(),
    )
    .slice(0, ctx.opcoes.tamAmostra)
    .map(
      (r) =>
        `  ${r.conversation_id as string}  ·  ${((r.name as string) ?? "(sem nome)").slice(0, 24).padEnd(24)}  ·  ` +
        `${mascara(r.phone_number)}  ·  status=${r.status as string}  ·  ` +
        `último inbound: ${r.last_inbound_at ? new Date(r.last_inbound_at as string).toISOString().slice(0, 10) : "(nunca)"}`,
    );
  return {
    status: "INFO",
    detalhe:
      `${perdem.length} conversa(s) deixam de ser atendidas pela IA ao ligar (dessas, ${perdemAtivas} com inbound nos últimos 7 dias). ` +
      `${mantem} seguem elegíveis (contato já autorizado por origem). ` +
      `${jaBloqueada} já não recebiam IA hoje (handoff/silêncio/dono humano).` +
      (capado ? ` ⚠️  amostrado em ${CAP} conversas — o total pode ser maior.` : ""),
    linhas: amostra.length
      ? [`amostra (as ${amostra.length} mais recentes que perdem a IA — telefone mascarado):`, ...amostra]
      : ["nenhuma conversa perde a IA (nenhuma estava sendo atendida automaticamente)"],
  };
}

export async function checkCampanhas(ctx: CtxAtivacao): Promise<Resultado> {
  const { rows } = await ctx.pool.query(
    `select settings->'campanhas_whatsapp' as c from organizations where id = $1`,
    [ctx.organizationId],
  );
  const raw = rows[0]?.c ?? null;
  if (raw === null || (Array.isArray(raw) && raw.length === 0)) {
    return {
      status: "INFO",
      detalhe:
        "nenhuma campanha registrada. OK — o Respondi e a retomada manual continuam autorizando. " +
        "Campanha Meta/Google que cai direto no WhatsApp só autoriza quando registrada aqui.",
    };
  }
  if (!Array.isArray(raw)) {
    return { status: "FAIL", detalhe: "`campanhas_whatsapp` existe mas não é um array — corrija o JSON antes de ligar" };
  }
  const validas = parseCampanhas(raw);
  const invalidas = raw.length - validas.length;
  const linhas: string[] = [];
  if (invalidas > 0) linhas.push(`${invalidas} entrada(s) descartada(s) por formato inválido (schema Zod) — ignoradas em runtime`);

  const perigos: string[] = [];
  for (const c of validas) {
    const motivo = campanhaPerigosa(c);
    const escopo = c.channel_session_id
      ? c.channel_session_id === ctx.channelSessionId
        ? "ESTE canal"
        : `outro canal (${c.channel_session_id})`
      : "qualquer canal da org";
    linhas.push(`  "${c.id}" [${escopo}] · ${c.match.tipo} "${c.match.valor}"` + (motivo ? `  ⚠️  ${motivo}` : "  ✓"));
    if (motivo && (!c.channel_session_id || c.channel_session_id === ctx.channelSessionId)) {
      perigos.push(`"${c.id}": ${motivo}`);
    }
  }
  if (perigos.length > 0) {
    if (ctx.opcoes.campanhasPerigosasOk) {
      return { status: "WARN", detalhe: "campanha de match genérico — seguindo por --campanhas-perigosas-ok", linhas: [...linhas, ...perigos] };
    }
    return {
      status: "FAIL",
      detalhe:
        `${perigos.length} campanha(s) com match que casa conversa comum — ligariam a IA para quase todo mundo, ` +
        `derrotando o gate. Ajuste a frase (específica, longa) ou passe --campanhas-perigosas-ok.`,
      linhas: [...linhas, "", "perigosas:", ...perigos],
    };
  }
  if (invalidas > 0) {
    return {
      status: "WARN",
      detalhe:
        `${invalidas} de ${raw.length} entrada(s) de campanha são inválidas e serão IGNORADAS em runtime — ` +
        `o operador provavelmente acha que elas funcionam. Corrija o JSON (schema em lib/ai/elegibilidade/campanha.ts).`,
      linhas,
    };
  }
  return { status: "PASS", detalhe: `${validas.length} campanha(s) válida(s), nenhuma com match genérico`, linhas };
}

export async function checkRespondiAutoriza(ctx: CtxAtivacao): Promise<Resultado> {
  const linhas: string[] = [];
  const { rows } = await ctx.pool.query(
    `select name, is_active from webhook_sources where organization_id = $1 order by created_at`,
    [ctx.organizationId],
  );
  const ativas = rows.filter((r) => r.is_active);
  linhas.push(
    rows.length === 0
      ? "nenhuma `webhook_sources` — nenhum formulário externo entrega leads nesta org ainda."
      : `${ativas.length}/${rows.length} fonte(s) de webhook ativa(s): ${ativas.map((r) => r.name as string).join(", ") || "(nenhuma ativa)"}`,
  );

  const rota = lerFonte(ctx.raiz, "app/api/v1/webhooks/in/[token]/route.ts");
  const fonteOk = rota === null ? null : rota.includes("autorizarContatoParaIA") && rota.includes("respondi:");
  if (fonteOk === false) {
    return { status: "FAIL", detalhe: "a rota de webhook NÃO chama `autorizarContatoParaIA` — o Respondi não autorizaria", linhas };
  }
  linhas.push(
    fonteOk === true
      ? "rota de webhook chama `autorizarContatoParaIA` com reason `respondi:<form>:<sub>` — cada submissão autoriza SÓ aquele contato"
      : "código não verificável aqui — comportamento coberto por J20.6 no user-journey-map",
  );

  const { rows: g } = await ctx.pool.query(
    `select has_column_privilege('service_role', 'public.contacts', 'ai_authorized_at', 'UPDATE') as pode`,
  );
  if (g[0]?.pode === false) {
    return { status: "FAIL", detalhe: "service_role NÃO tem UPDATE em contacts.ai_authorized_at — o webhook não conseguiria autorizar", linhas };
  }
  linhas.push("service_role pode UPDATE contacts.ai_authorized_at — autorização individual funciona");
  return {
    status: rows.length === 0 ? "WARN" : "PASS",
    detalhe:
      rows.length === 0
        ? "sem fonte de webhook configurada — configure o Respondi para os leads novos entrarem e se autorizarem"
        : "leads novos do Respondi conseguem se autorizar individualmente pela origem elegível",
    linhas,
  };
}

export async function checkDenyByDefault(ctx: CtxAtivacao): Promise<Resultado> {
  const linhas: string[] = [];
  const agora = new Date();

  const { rows: rebeldes } = await ctx.pool.query(
    `select count(*)::int as n from contacts
      where organization_id = $1 and ai_authorized_at is not null
        and (ai_authorized_reason is null
             or ai_authorized_reason !~ '^(respondi:|campanha:|automacao:|retomada_manual)')`,
    [ctx.organizationId],
  );
  const nRebeldes = Number(rebeldes[0]?.n ?? 0);
  if (nRebeldes > 0) {
    return {
      status: "FAIL",
      detalhe:
        `${nRebeldes} contato(s) com ai_authorized_at mas SEM reason de origem elegível — ` +
        `alguém autorizou fora do produto. Investigue antes de ligar o gate.`,
    };
  }
  linhas.push("toda autorização existente veio de uma origem elegível (respondi:/campanha:/automacao:/retomada_manual)");

  const { rows: antigos } = await ctx.pool.query(
    `select ct.id, ct.created_at, ct.ai_authorized_at, ct.force_human,
            cv.assignee_kind, cv.bot_silenced_until
       from contacts ct
       join conversations cv on cv.contact_id = ct.id and cv.organization_id = ct.organization_id
      where ct.organization_id = $1 and cv.channel_session_id = $2 and ct.ai_authorized_at is null
      order by ct.created_at asc
      limit 8`,
    [ctx.organizationId, ctx.channelSessionId],
  );
  let todosNegados = true;
  for (const r of antigos) {
    const d = decidirElegibilidade(estado(r, "allowlist", ctx.ttlMs, agora));
    if (d.permite) todosNegados = false;
    linhas.push(
      `  contato ${r.id as string} (desde ${new Date(r.created_at as string).toISOString().slice(0, 10)}) → ` +
        `${d.permite ? "❌ AUTORIZADO?!" : "não autorizado"} (${d.motivo})`,
    );
  }
  if (antigos.length === 0) linhas.push("  (nenhum contato antigo sem autorização neste canal para amostrar)");
  if (!todosNegados) {
    return { status: "FAIL", detalhe: "um contato antigo/sem-origem seria atendido pela IA em modo allowlist — a regra está furada", linhas };
  }

  const simNova = decidirElegibilidade(
    montarEstadoDeElegibilidade({ aiGate: "allowlist", forceHuman: false, assigneeKind: "ai", botSilencedUntil: null, aiAuthorizedAt: null, agora, ttlMs: ctx.ttlMs }),
  );
  const simExpirada = decidirElegibilidade(
    montarEstadoDeElegibilidade({
      aiGate: "allowlist", forceHuman: false, assigneeKind: "ai", botSilencedUntil: null,
      aiAuthorizedAt: new Date(agora.getTime() - ctx.ttlMs - 86_400_000), agora, ttlMs: ctx.ttlMs,
    }),
  );
  linhas.push(
    `  simulação "mensagem nova, contato nunca autorizado" → ${simNova.permite ? "❌" : "não responde"} (${simNova.motivo})`,
    `  simulação "autorização mais velha que o TTL (${Math.round(ctx.ttlMs / 86_400_000)}d)" → ${simExpirada.permite ? "❌" : "não responde"} (${simExpirada.motivo})`,
  );
  if (simNova.permite || simExpirada.permite) {
    return { status: "FAIL", detalhe: "a regra pura autorizou um caso que não deveria", linhas };
  }
  return { status: "PASS", detalhe: "histórico, contato antigo, conversa anterior e submissão vencida NÃO autorizam", linhas };
}

export function checkPlanoDeEscrita(ctx: CtxAtivacao): Resultado {
  const atual = lerModoDoGate(ctx.channelMetadata.ai_gate);
  const linhas = [
    `ALVO: ${ctx.alvoModo === "allowlist" ? "LIGAR (allowlist)" : "DESLIGAR (open)"} o gate do canal ${ctx.channelSessionId}`,
    `estado atual: metadata.ai_gate = ${JSON.stringify(ctx.channelMetadata.ai_gate ?? null)} (${atual})`,
    "",
    "ÚNICA escrita que o --apply faz:",
    `  update channel_sessions`,
    `     set metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{ai_gate}', '"${ctx.alvoModo}"'), updated_at = now()`,
    `   where id = '${ctx.channelSessionId}' and organization_id = '${ctx.organizationId}';`,
    "",
    "NÃO escreve em: contacts (ZERO autorização em massa), conversations, ai_agents, organizations.",
  ];
  if (atual === ctx.alvoModo) {
    return { status: "WARN", detalhe: `o gate JÁ está em '${atual}' — o --apply seria no-op`, linhas };
  }
  return { status: "INFO", detalhe: `transição ${atual} → ${ctx.alvoModo}`, linhas };
}

// ───────────────────────────────────────────────────────────────────────────
// A lista ordenada
// ───────────────────────────────────────────────────────────────────────────

export function montarPreflights(
  ctx: CtxAtivacao,
): Array<{ nome: string; run: () => Promise<Resultado> }> {
  return [
    { nome: "Schema · migration 0203 (contacts.ai_authorized_at)", run: () => checkSchema0203(ctx) },
    { nome: "Query de elegibilidade · executa sem erro", run: () => checkQueryElegibilidade(ctx) },
    { nome: "Agente · há quem a IA use neste canal", run: () => checkAgentePublicado(ctx) },
    { nome: "Cobertura · todo caminho de resposta automática respeita o gate", run: () => checkCoberturaDosCaminhos(ctx) },
    { nome: "Impacto · conversas que ficam sem IA ao ligar 'allowlist'", run: () => checkImpactoConversas(ctx) },
    { nome: "Campanhas · organizations.settings.campanhas_whatsapp", run: () => checkCampanhas(ctx) },
    { nome: "Respondi · leads novos podem se autorizar pela origem", run: () => checkRespondiAutoriza(ctx) },
    { nome: "Deny-by-default · histórico / contato antigo / mensagem sem origem NÃO autoriza", run: () => checkDenyByDefault(ctx) },
    { nome: "Escrita · o que o --apply vai (e não vai) mudar", run: async () => checkPlanoDeEscrita(ctx) },
  ];
}

export type { CampanhaWhatsapp };
