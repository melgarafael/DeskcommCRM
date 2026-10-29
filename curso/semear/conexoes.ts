/**
 * Semente do módulo "Conexões": um SEGUNDO número, "Fisioterapia Bem Viver",
 * que caiu (status FAILED) e ainda está em modo de teste da IA, sem nenhum
 * número autorizado — o estado de todo canal novo. É nele que as lições pausam,
 * renomeiam e autorizam números; o "Recepção Bem Viver" da base só é lido.
 *
 * Mais uma janela de manutenção agendada para daqui a alguns dias, só para este
 * número (nunca "para todas": o cron pausaria o número da base).
 *
 * Por que um canal à parte: a base arquiva todo canal que não seja o primeiro,
 * então este some sozinho antes da captura de qualquer outro módulo — uma lição
 * que falhe no meio de um "Pausar" não deixa a Inbox dos outros sem conversas.
 *
 * Idempotente: upsert por id fixo (desarquiva, repõe nome, estado e metadata) e
 * apaga só as janelas e os avisos da Central deste canal.
 */
import { type Contexto, semErro } from "../semear-demonstracao";

const CANAL = "c0e00000-0000-4000-8000-000000000001";
const JANELA = "c0e10000-0000-4000-8000-000000000001";
const DIA = 24 * 60 * 60_000;

/** `dias` a partir de hoje, às HH:MM em São Paulo (UTC-3). */
function daquiA(dias: number, h: number, m: number) {
  const sp = new Date(Date.now() - 3 * 60 * 60_000);
  return new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() + dias, h + 3, m)).toISOString();
}

export async function semear(c: Contexto) {
  const { db, org, sessao } = c;

  // a lição de pausa mexe só no canal daqui; se uma rodada antiga deixou o da base pausado, volta ao normal
  const base = (await db.from("channel_sessions").select("metadata").eq("id", sessao).single()).data as { metadata: Record<string, unknown> } | null;
  if (base?.metadata?.disabled === true) {
    semErro(await db.rpc("fn_definir_canal_desativado", { p_org: org, p_canal: sessao, p_desativado: false }), "retomar canal da base");
  }

  semErro(await db.from("channel_sessions").upsert({
    id: CANAL, organization_id: org, provider: "waha", waha_session_name: "bemviver-fisioterapia",
    webhook_secret_encrypted: "\\x00", status: "FAILED", phone_number: "+551140028933",
    display_name: "Fisioterapia Bem Viver", archived_at: null, last_health_check_at: null,
    // o que todo canal novo recebe (metadataInicialDoCanal): IA em modo de teste, lista vazia
    metadata: { ai_gate: "allowlist", ai_gate_mode: "pre_go_live", ai_test_phone_numbers: [] },
  }, { onConflict: "id" }), "canal Fisioterapia");

  // pausar abre um aviso na Central (sino); sem isto ele sobra nas fotos dos outros módulos
  semErro(await db.from("agent_inbox_items").delete().eq("organization_id", org).eq("ref_id", CANAL), "limpar avisos do canal");

  semErro(await db.from("channel_schedules").delete().eq("organization_id", org).eq("channel_session_id", CANAL), "limpar janelas");
  semErro(await db.from("channel_schedules").insert({
    id: JANELA, organization_id: org, channel_session_id: CANAL, status: "scheduled",
    starts_at: daquiA(4, 22, 0), ends_at: new Date(Date.parse(daquiA(4, 22, 0)) + DIA / 3).toISOString(),
    created_by: c.pessoa.helena,
  }), "janela de manutenção");
}
