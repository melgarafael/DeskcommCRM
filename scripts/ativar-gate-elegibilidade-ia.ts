/**
 * ATIVA (ou desliga) o gate de elegibilidade da IA num canal de WhatsApp —
 * `channel_sessions.metadata.ai_gate = 'allowlist'`.
 *
 * ─── Por que este script existe ────────────────────────────────────────────
 *
 * O gate ainda não tem tela (dívida declarada em J20 do user-journey-map). Até
 * ela existir, liga-se por aqui — como o `roteamento_de_formulario`. Este NÃO é
 * um `UPDATE` seco: roda uma bateria de preflights ANTES de deixar escrever, e a
 * escrita só acontece com `--apply` explícito.
 *
 * ─── O que ele garante ─────────────────────────────────────────────────────
 *
 *  - DRY-RUN é o PADRÃO; `--apply` é obrigatório para qualquer escrita;
 *  - a ÚNICA escrita possível é UMA linha de `channel_sessions.metadata`;
 *  - NUNCA escreve em `contacts` — nada de autorização em massa. Um contato só
 *    fica elegível pelas quatro origens do produto (webhook do Respondi, match
 *    de campanha, ação `send_ai_message`, retomada manual pela tela);
 *  - fail-closed: qualquer preflight FAIL aborta o `--apply`;
 *  - `--rollback` desliga o gate (volta para `'open'`), com os mesmos preflights.
 *
 * ─── Uso ──────────────────────────────────────────────────────────────────
 *
 *   # listar os canais de uma organização e o estado do gate de cada um
 *   tsx --env-file=.env scripts/ativar-gate-elegibilidade-ia.ts --org <org_id>
 *
 *   # DRY-RUN (padrão) — roda todos os preflights, escreve NADA
 *   tsx --env-file=.env scripts/ativar-gate-elegibilidade-ia.ts --channel <id|telefone|nome>
 *
 *   # APLICAR — liga o gate (só se nenhum preflight for FAIL)
 *   tsx --env-file=.env scripts/ativar-gate-elegibilidade-ia.ts --channel <...> --apply
 *
 *   # ROLLBACK — dry-run de desligar / aplicar o desligamento
 *   tsx --env-file=.env scripts/ativar-gate-elegibilidade-ia.ts --channel <...> --rollback
 *   tsx --env-file=.env scripts/ativar-gate-elegibilidade-ia.ts --channel <...> --rollback --apply
 *
 * Flags de escape (cada uma afrouxa UM preflight — use com consciência):
 *   --permitir-sem-agente        segue mesmo sem agente publicado / roteador no canal
 *   --campanhas-perigosas-ok     segue mesmo com campanha de match genérico
 *   --amostra <n>                tamanho da amostra impressa (default 25)
 *
 * Conexão: `SUPABASE_DB_URL` (Postgres direto — o script conta linhas de toda a
 * organização, o que a anon/authenticated key não alcança).
 */
import pg from "pg";

import { carregarEnvLocal, credenciaisSupabaseDeTeste, anunciarDestino } from "./lib/env-de-teste";
import { montarPreflights, type CtxAtivacao, type Resultado, type Status } from "./lib/gate-ativacao";
import { lerModoDoGate, ttlDaAutorizacaoMs } from "../lib/ai/elegibilidade/gate";

// ─── Args ─────────────────────────────────────────────────────────────────

const ARGV = process.argv.slice(2);
const flag = (n: string) => ARGV.includes(`--${n}`);
const opcao = (n: string): string | undefined => {
  const i = ARGV.indexOf(`--${n}`);
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1]!.startsWith("--") ? ARGV[i + 1] : undefined;
};

const MODO_ORG = opcao("org");
const CANAL_REF = opcao("channel");
const APLICAR = flag("apply");
const ROLLBACK = flag("rollback");
const ALVO_MODO: "allowlist" | "open" = ROLLBACK ? "open" : "allowlist";
const ICONE: Record<Status, string> = { PASS: "✅", WARN: "⚠️ ", FAIL: "❌", INFO: "ℹ️ " };

// ─── Conexão ──────────────────────────────────────────────────────────────

const env = carregarEnvLocal();
const creds = credenciaisSupabaseDeTeste();
anunciarDestino("ativar-gate-elegibilidade-ia", creds);

const DB_URL = env.SUPABASE_DB_URL ?? creds.dbUrl ?? "";
if (DB_URL === "") {
  console.error("\n❌ SUPABASE_DB_URL ausente — este script fala direto com o Postgres.\n");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: DB_URL, max: 3 });

const RAIZ = process.cwd();
const TTL_MS = ttlDaAutorizacaoMs(process.env);

// ─── Descoberta de canal ──────────────────────────────────────────────────

interface Canal {
  id: string;
  organization_id: string;
  org_nome: string;
  waha_session_name: string;
  phone_number: string | null;
  display_name: string | null;
  status: string;
  metadata: Record<string, unknown>;
}

async function listarCanaisDaOrg(orgId: string): Promise<void> {
  const { rows } = await pool.query(
    `select cs.id, cs.waha_session_name, cs.phone_number, cs.display_name, cs.status,
            cs.metadata->>'ai_gate' as ai_gate, coalesce(o.display_name, o.legal_name, o.slug) as org_nome
       from channel_sessions cs join organizations o on o.id = cs.organization_id
      where cs.organization_id = $1 order by cs.created_at`,
    [orgId],
  );
  if (rows.length === 0) {
    console.info(`\nNenhum canal para a organização ${orgId}.\n`);
    return;
  }
  console.info(`\nCanais da organização "${rows[0].org_nome as string}" (${orgId}):\n`);
  for (const r of rows) {
    const modo = lerModoDoGate(r.ai_gate);
    console.info(
      `  ${r.id as string}\n` +
        `    sessão: ${r.waha_session_name as string}  ·  número: ${(r.phone_number as string) ?? "(sem)"}  ·  nome: ${(r.display_name as string) ?? "(sem)"}\n` +
        `    status: ${r.status as string}  ·  gate: ${modo === "allowlist" ? "🔒 allowlist" : "🔓 open (padrão)"}\n`,
    );
  }
  console.info("Inspecionar um: --channel <id> (dry-run). Ligar: --channel <id> --apply.\n");
}

async function resolverCanal(ref: string): Promise<Canal> {
  const ehUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  const digitos = ref.replace(/\D/g, "");
  const { rows } = await pool.query(
    `select cs.id, cs.organization_id, coalesce(o.display_name, o.legal_name, o.slug) as org_nome, cs.waha_session_name,
            cs.phone_number, cs.display_name, cs.status, cs.metadata
       from channel_sessions cs join organizations o on o.id = cs.organization_id
      where ($1::boolean and cs.id = $2::uuid)
         or (length($3) >= 8 and regexp_replace(coalesce(cs.phone_number,''), '\\D', '', 'g') like '%' || $3)
         or cs.waha_session_name = $4 or cs.display_name = $4`,
    [ehUuid, ehUuid ? ref : "00000000-0000-0000-0000-000000000000", digitos, ref],
  );
  if (rows.length === 0) throw new Error(`Nenhum canal casa "${ref}" (id, telefone, waha_session_name ou display_name).`);
  if (rows.length > 1) {
    throw new Error(
      `"${ref}" casa ${rows.length} canais: ${rows.map((r) => `${r.id as string} (${(r.display_name as string) ?? (r.waha_session_name as string)})`).join(", ")}. Use o id.`,
    );
  }
  const r = rows[0];
  return {
    id: r.id as string,
    organization_id: r.organization_id as string,
    org_nome: r.org_nome as string,
    waha_session_name: r.waha_session_name as string,
    phone_number: (r.phone_number as string | null) ?? null,
    display_name: (r.display_name as string | null) ?? null,
    status: r.status as string,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
  };
}

// ─── Escrita (a ÚNICA) ────────────────────────────────────────────────────

async function aplicarEscrita(canal: Canal): Promise<void> {
  const cliente = await pool.connect();
  try {
    await cliente.query("begin");
    const antes = await cliente.query(
      `select metadata->>'ai_gate' as g from channel_sessions where id = $1 and organization_id = $2 for update`,
      [canal.id, canal.organization_id],
    );
    if (antes.rows.length === 0) throw new Error("o canal sumiu entre o preflight e a escrita");
    if (lerModoDoGate(antes.rows[0].g) === ALVO_MODO) {
      await cliente.query("rollback");
      console.info(`\nℹ️  o gate JÁ estava em "${ALVO_MODO}" — nada a escrever.\n`);
      return;
    }
    const res = await cliente.query(
      `update channel_sessions
          set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{ai_gate}', $3::jsonb), updated_at = now()
        where id = $1 and organization_id = $2`,
      [canal.id, canal.organization_id, JSON.stringify(ALVO_MODO)],
    );
    if (res.rowCount !== 1) throw new Error(`update afetou ${res.rowCount} linha(s), esperado 1 — revertendo`);
    const depois = await cliente.query(
      `select metadata->>'ai_gate' as g from channel_sessions where id = $1 and organization_id = $2`,
      [canal.id, canal.organization_id],
    );
    if (lerModoDoGate(depois.rows[0].g) !== ALVO_MODO) throw new Error("leitura pós-escrita não bate — revertendo");
    await cliente.query("commit");
    console.info(`\n✅ ESCRITO. channel_sessions.metadata.ai_gate: ${JSON.stringify(antes.rows[0].g ?? null)} → "${ALVO_MODO}"\n`);
  } catch (e) {
    await cliente.query("rollback").catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  console.info(`\n${"═".repeat(78)}`);
  console.info(
    `  GATE DE ELEGIBILIDADE DA IA — ${ROLLBACK ? "ROLLBACK (desligar)" : "ativação"} · ` +
      `${APLICAR ? "MODO --apply (ESCREVE)" : "DRY-RUN (não escreve nada)"}`,
  );
  console.info(`${"═".repeat(78)}\n`);

  if (MODO_ORG) {
    await listarCanaisDaOrg(MODO_ORG);
    return 0;
  }
  if (!CANAL_REF) {
    console.error("Faltou --channel <id|telefone|nome>  (ou --org <id> para listar).\n");
    return 2;
  }

  const canal = await resolverCanal(CANAL_REF);
  console.info(
    `Canal: ${canal.id}\n` +
      `  org: "${canal.org_nome}" (${canal.organization_id})\n` +
      `  sessão: ${canal.waha_session_name}  ·  número: ${canal.phone_number ?? "(sem)"}  ·  status: ${canal.status}\n` +
      `  gate agora: ${lerModoDoGate(canal.metadata.ai_gate)}\n` +
      `  TTL de autorização: ${Math.round(TTL_MS / 86_400_000)} dias (AI_ALLOWLIST_TTL_DAYS)\n`,
  );

  const ctx: CtxAtivacao = {
    pool,
    organizationId: canal.organization_id,
    channelSessionId: canal.id,
    channelMetadata: canal.metadata,
    raiz: RAIZ,
    ttlMs: TTL_MS,
    alvoModo: ALVO_MODO,
    rollback: ROLLBACK,
    opcoes: {
      permitirSemAgente: flag("permitir-sem-agente"),
      campanhasPerigosasOk: flag("campanhas-perigosas-ok"),
      tamAmostra: Number(opcao("amostra") ?? "25") || 25,
    },
  };

  let houveFail = false;
  let houveWarn = false;
  for (const { nome, run } of montarPreflights(ctx)) {
    let r: Resultado;
    try {
      r = await run();
    } catch (e) {
      r = { status: "FAIL", detalhe: `o preflight lançou: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (r.status === "FAIL") houveFail = true;
    if (r.status === "WARN") houveWarn = true;
    console.info(`${ICONE[r.status]} ${nome}`);
    console.info(`   ${r.detalhe}`);
    for (const l of r.linhas ?? []) console.info(`   ${l}`);
    console.info("");
  }

  console.info("─".repeat(78));
  const cmdApply = `tsx --env-file=.env scripts/ativar-gate-elegibilidade-ia.ts --channel ${canal.id}${ROLLBACK ? " --rollback" : ""} --apply`;
  const cmdRollback = `tsx --env-file=.env scripts/ativar-gate-elegibilidade-ia.ts --channel ${canal.id} --rollback --apply`;

  if (!APLICAR) {
    console.info("DRY-RUN — nada foi escrito.");
    if (houveFail) {
      console.info("\n❌ Há preflight(s) FAIL — o --apply seria RECUSADO. Resolva-os primeiro.\n");
      return 1;
    }
    console.info(
      `\n${houveWarn ? "⚠️  Há WARN(s) — leia acima antes de aplicar." : "Todos os preflights passaram."}\n` +
        `Para APLICAR:\n  ${cmdApply}\n` +
        `Para DESLIGAR depois:\n  ${cmdRollback}\n`,
    );
    return 0;
  }

  if (houveFail) {
    console.info("\n❌ --apply RECUSADO: há preflight(s) FAIL acima. Nada foi escrito.\n");
    return 1;
  }
  console.info(`Preflights ok. Aplicando a ÚNICA escrita (metadata.ai_gate = "${ALVO_MODO}")...`);
  await aplicarEscrita(canal);
  console.info(
    `Rollback a qualquer momento:\n  ${
      ROLLBACK
        ? `tsx --env-file=.env scripts/ativar-gate-elegibilidade-ia.ts --channel ${canal.id} --apply`
        : cmdRollback
    }\n`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error("\n💥", e instanceof Error ? e.message : e);
    await pool.end().catch(() => {});
    process.exit(3);
  });
