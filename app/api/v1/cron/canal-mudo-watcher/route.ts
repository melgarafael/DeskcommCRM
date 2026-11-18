/**
 * canal-mudo-watcher — o canal que nasce mudo não fica mudo em silêncio.
 *
 * Decisão do dono (doc 11, opção B): o canal de WhatsApp continua nascendo em
 * modo de teste, que é o certo — ninguém recebe resposta automática por
 * acidente durante a configuração —, e o SISTEMA passa a não deixar esquecer.
 *
 * O esquecimento é o defeito inteiro, e o sintoma é o pior possível: as
 * mensagens CHEGAM no Inbox, tudo parece funcionar, e a IA nunca responde. Quem
 * instalou conclui que o produto está quebrado, não que falta um clique. A tela
 * de Conexões já diz "Nenhum número autorizado — a IA não responde ninguém
 * neste canal"; este cron alcança quem não abre Conexões.
 *
 * ── O aviso diz QUAL canal, e qual dos dois problemas (#4909) ───────────────
 *
 * A primeira versão dizia "Este canal está em modo de teste" e nada mais. Numa
 * instalação com o WhatsApp principal respondendo e um Instagram em teste, o
 * operador leu o aviso como erro — porque não havia nada nele dizendo de qual
 * canal se tratava. Pior: o texto mandava "abra o canal ao público" também
 * quando nenhum agente atendia o canal, e ali abrir ao público não faz a IA
 * responder.
 *
 * Agora o aviso carrega o NOME do canal (o mesmo que a pessoa vê em Conexões) e
 * a rede, e existem DOIS textos: falta autorizar testador (o canal já tem
 * agente) e falta ligar/publicar o agente (não tem). Cada um oferece a saída que
 * resolve. Nada disto muda o `ai_gate`, o `ai_gate_mode` ou a decisão de
 * responder — só o que o aviso diz e para onde ele manda a pessoa.
 *
 * ── Por que um cron próprio, diário ─────────────────────────────────────────
 *
 * O `channel-health` roda de 5 em 5 minutos e faz uma chamada de REDE por
 * sessão (teto de 50). Esta varredura não fala com ninguém: é leitura de banco,
 * e a régua dela é "alguns dias". Pendurá-la lá custaria 288 varreduras por dia
 * para um estado que muda em dias, e ficaria limitada pelo teto de rede alheio.
 *
 * ── O laço de retorno (DoD 13) ──────────────────────────────────────────────
 *
 * A MESMA rodada que abre o aviso o fecha quando ele deixa de ser verdade:
 * canal que ganhou número, saiu do modo de teste ou foi arquivado tem o aviso
 * resolvido com o motivo no corpo. Aviso que só some no clique de alguém vira
 * lista que ninguém lê — e, aqui, viraria mentira: o canal já responde.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { copyDoCanalMudo } from "@/lib/ai/agent-inbox-copy";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  avaliarCanal,
  DIAS_ATE_AVISAR,
  KIND_CANAL_MUDO,
  nomeDoCanal,
  redeDoCanal,
  type CanalParaAvaliar,
  type MotivoDaResolucao,
} from "@/lib/channels/canal-mudo";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaDoAviso, preencher } from "@/lib/i18n/idioma-do-aviso";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

/** Teto por rodada. Leitura de banco, sem rede — cabe folgado numa instalação real. */
const LIMITE = 500;

const MOTIVO_LEGIVEL: Record<MotivoDaResolucao, string> = {
  ganhou_numero: "o canal ganhou número autorizado",
  saiu_do_modo_de_teste: "o canal saiu do modo de teste",
  canal_arquivado: "o canal foi arquivado",
};

interface AvisoAberto {
  id: string;
  ref_id: string | null;
  organization_id?: string | null;
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * QUAIS CANAIS TÊM AGENTE ATENDENDO — o dado que separa os dois avisos.
 *
 * "Atende" é a mesma pergunta que o runtime faz antes de responder: versão
 * PUBLICADA de um agente vivo presa ao canal (`ai_agent_versions.
 * channel_session_id`), vínculo em `ai_agent_version_channels` (o agente
 * publicado declarou aquele número), ou roteador ativo apontando para ele.
 * Nenhum dos três ⇒ a IA não responde por falta de agente, e não por falta de
 * testador.
 *
 * Erro de leitura NÃO degrada para "sem agente": supor que falta agente mandaria
 * a pessoa publicar o que já está publicado. A rodada falha e a próxima tenta
 * outra vez — o mesmo contrato das outras leituras desta rota.
 */
async function canaisComAgente(admin: Admin): Promise<Set<string>> {
  const cobertos = new Set<string>();

  const { data: agentes, error: erroAgentes } = await admin
    .from("ai_agents")
    .select("published_version_id")
    .is("archived_at", null)
    .eq("is_active", true)
    .limit(LIMITE);
  if (erroAgentes) throw new Error(`agentes: ${erroAgentes.message}`);

  const versoes = [
    ...new Set(
      (agentes ?? [])
        .map((a) => a.published_version_id)
        .filter((v): v is string => typeof v === "string"),
    ),
  ];

  if (versoes.length > 0) {
    const { data: publicadas, error: erroVersoes } = await admin
      .from("ai_agent_versions")
      .select("channel_session_id")
      .in("id", versoes);
    if (erroVersoes) throw new Error(`versões: ${erroVersoes.message}`);
    for (const v of publicadas ?? []) {
      if (v.channel_session_id) cobertos.add(v.channel_session_id);
    }

    const { data: vinculos, error: erroVinculos } = await admin
      .from("ai_agent_version_channels")
      .select("channel_session_id")
      .in("agent_version_id", versoes);
    if (erroVinculos) throw new Error(`vínculos: ${erroVinculos.message}`);
    for (const v of vinculos ?? []) {
      if (v.channel_session_id) cobertos.add(v.channel_session_id);
    }
  }

  const { data: roteadores, error: erroRoteadores } = await admin
    .from("ai_routers")
    .select("channel_session_id")
    .eq("is_active", true)
    .limit(LIMITE);
  if (erroRoteadores) throw new Error(`roteadores: ${erroRoteadores.message}`);
  for (const r of roteadores ?? []) {
    if (r.channel_session_id) cobertos.add(r.channel_session_id);
  }

  return cobertos;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  // Os avisos abertos vêm ANTES das conexões: eles são a lista do que pode
  // precisar ser fechado, inclusive de canal que sumiu da varredura (arquivado).
  const { data: abertosBruto, error: erroAvisos } = await admin
    .from("agent_inbox_items")
    .select("id, ref_id, organization_id")
    .eq("kind", KIND_CANAL_MUDO)
    .eq("status", "open")
    .limit(LIMITE);

  if (erroAvisos) {
    logger.error("[canal-mudo-watcher] leitura dos avisos falhou", {
      detail: erroAvisos.message,
      requestId,
    });
    return fail("internal_error", erroAvisos.message, 500, { requestId });
  }

  const abertos = new Map<string, AvisoAberto>();
  for (const a of (abertosBruto ?? []) as AvisoAberto[]) {
    if (a.ref_id !== null) abertos.set(a.ref_id, a);
  }

  // `display_name`/`phone_number`/`provider` entram na MESMA consulta: o aviso
  // precisa nomear o canal, e uma segunda ida ao banco por canal releria a
  // mesma linha.
  const { data: canaisBruto, error: erroCanais } = await admin
    .from("channel_sessions")
    .select(
      "id, organization_id, status, archived_at, last_status_change_at, metadata, display_name, phone_number, waha_session_name, provider",
    )
    .is("archived_at", null)
    .limit(LIMITE);

  if (erroCanais) {
    logger.error("[canal-mudo-watcher] leitura das conexões falhou", {
      detail: erroCanais.message,
      requestId,
    });
    return fail("internal_error", erroCanais.message, 500, { requestId });
  }

  let comAgente: Set<string>;
  try {
    comAgente = await canaisComAgente(admin);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[canal-mudo-watcher] leitura dos agentes falhou", { detail, requestId });
    // Sem saber se o canal tem agente não dá para escolher entre os dois avisos,
    // e o aviso errado manda a pessoa para o clique que não resolve.
    return fail("internal_error", detail, 500, { requestId });
  }

  const canais: CanalParaAvaliar[] = (
    (canaisBruto ?? []) as Omit<CanalParaAvaliar, "tem_agente">[]
  ).map((canal) => ({ ...canal, tem_agente: comAgente.has(canal.id) }));
  let avisados = 0;
  let resolvidos = 0;
  const idiomas = new Map<string, Idioma>();

  const resolver = async (aviso: AvisoAberto, motivo: MotivoDaResolucao): Promise<void> => {
    const idioma = await idiomaDoAviso(admin, aviso.organization_id, idiomas);
    const { data } = await admin
      .from("agent_inbox_items")
      .update({
        status: "resolved",
        // Só o motivo: reescrever o corpo com a frase de abertura seria repetir
        // o problema que acabou, e a frase certa depende do caso que o aviso
        // tinha quando nasceu — que o `title` da linha já guarda.
        body: preencher(traduzir("Resolvido pelo sistema: {motivo}.", idioma), {
          motivo: traduzir(MOTIVO_LEGIVEL[motivo], idioma),
        }),
      })
      .eq("id", aviso.id)
      // O `status` no filtro é a trava: duas rodadas simultâneas (cron + curl à
      // mão) não fecham o mesmo aviso duas vezes nem inflam a contagem.
      .eq("status", "open")
      .select("id")
      .maybeSingle();
    if (data) resolvidos++;
  };

  for (const canal of canais) {
    const desfecho = avaliarCanal(canal, agora);
    const aberto = abertos.get(canal.id);
    abertos.delete(canal.id);

    if (desfecho.acao === "resolver") {
      if (aberto) await resolver(aberto, desfecho.motivo);
      continue;
    }
    if (desfecho.acao === "aguardar" || aberto) continue;

    const idioma = await idiomaDoAviso(admin, canal.organization_id, idiomas);
    const copy = copyDoCanalMudo(desfecho.caso, nomeDoCanal(canal), redeDoCanal(canal), idioma);
    const { data } = await admin
      .from("agent_inbox_items")
      .insert({
        organization_id: canal.organization_id,
        kind: KIND_CANAL_MUDO,
        // `warn`, não `critical`: nada está quebrado, e o canal foi configurado
        // assim de propósito. Crítico aqui gastaria o alarme que a Central
        // reserva para o que já custou dinheiro ou cliente.
        severity: "warn",
        title: copy.title,
        body:
          `${copy.body}\n\n` +
          preencher(traduzir("Assim há {dias} dia(s).", idioma), { dias: desfecho.diasMudo }),
        ref_kind: "channel_session",
        ref_id: canal.id,
      })
      .select("id")
      .maybeSingle();
    if (data) avisados++;
  }

  // O que sobrou no mapa é aviso cujo canal não apareceu na varredura: ele foi
  // arquivado (o filtro acima) ou apagado. Nos dois casos deixou de ser problema.
  for (const aviso of abertos.values()) await resolver(aviso, "canal_arquivado");

  // Rodada que não abriu nem fechou nada NÃO é mutação e não ocupa linha na
  // auditoria: 365 batidas por ano numa instalação que configurou tudo no
  // primeiro dia seriam 365 linhas dizendo que nada aconteceu.
  if (avisados > 0 || resolvidos > 0) {
    void audit({
      action: "channel.canal_mudo_watcher_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { canais: canais.length, avisados, resolvidos, diasAteAvisar: DIAS_ATE_AVISAR },
      requestId,
    });
  }

  return ok({ canais: canais.length, avisados, resolvidos }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
