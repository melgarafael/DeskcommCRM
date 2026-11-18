/**
 * FOTO SÓ PASSA PELA VISÃO QUANDO ALGUÉM DA EMPRESA VAI LER A DESCRIÇÃO.
 *
 * Quem lê a descrição que a visão paga escreve (`media_derived_text` de
 * `type='image'`) são as IAs e as integrações. O atendente vê a própria foto na
 * Inbox (`components/inbox/media/MediaRenderer.tsx`) e só lê texto derivado de
 * áudio. Numa empresa sem NENHUM leitor, a descrição era gasto sem consumidor —
 * medido em produção de 15 a 30/10: 38 chamadas de visão, 23,4% do custo de LLM
 * do período, todas numa empresa assim.
 *
 * Quem lê "por meio de um agente" só conta quando o agente QUER ver a foto: a
 * opção `ai_agent_versions.image_vision_enabled` (migration 9108, ligada por
 * padrão). A empresa cujos agentes desligaram a opção, e que não tem leitor sem
 * agente, não paga a visão — "as pessoas querem que a IA possa ver as imagens que
 * o cliente envia; fora isso não precisa; e isso precisa ser opcional" (dono, 31/10).
 *
 * Três peças, uma fonte:
 *   - o `media-persist-worker` ADIA a foto (status `skipped`, marca
 *     `metadata.derivacao_adiada`) quando o knob está em `defer` (o padrão) e a
 *     empresa não tem leitor;
 *   - o dreno do turno REABRE as fotos adiadas da conversa antes do primeiro
 *     turno, e espera por elas — se o agente do turno vê imagens;
 *   - o cron `media-leitura-adiada` reabre, de 5 em 5 minutos, as adiadas das
 *     empresas que passaram a ter leitor (follow-up, rascunho, caso, REST, MCP,
 *     Meta — quem lê fora do dreno).
 *
 * Fica fora de `derivable.ts` porque aquele módulo vai para o bundle do cliente
 * (MediaRenderer) e não pode carregar SQL.
 */
import type pg from "pg";

import { vendaPeloCanalLigada } from "@/lib/conversoes/venda-pelo-canal";
import { aiDispatchModeSchema } from "@/lib/schemas/settings";

/**
 * A chave em `messages.metadata`. ⚠️ O nome está no predicado do índice parcial
 * `idx_messages_derivacao_adiada` (migration 9106): renomear exige migration.
 */
export const CHAVE_ADIADA = "derivacao_adiada";

/**
 * A âncora do pedido de leitura em `messages.metadata`: o dreno conta a espera
 * da mídia reaberta a partir dela.
 */
export const CHAVE_PEDIDA_EM = "derivacao_pedida_em";

/**
 * Chaves de `messages.metadata` que só o servidor escreve, e em que o dreno, o
 * cron e os workers confiam. Quem grava `metadata` vindo do cliente
 * (`POST /api/v1/messages`) as tira antes: um valor forjado em
 * `derivacao_pedida_em` derrubava a consulta de espera do dreno (cast) e calava
 * a IA da própria empresa, e um `derivacao_adiada` forjado pedia visão paga.
 */
export const CHAVES_DA_DERIVACAO = [CHAVE_ADIADA, CHAVE_PEDIDA_EM, "media_derived_motivo"] as const;

/** Cópia do `metadata` do cliente sem as chaves que o servidor decide. */
export function semChavesDaDerivacao(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const limpo = { ...(metadata ?? {}) };
  for (const chave of CHAVES_DA_DERIVACAO) delete limpo[chave];
  return limpo;
}

/**
 * A âncora só vira data (`::timestamptz`) quando o texto casa este ISO-8601 — o
 * formato que `jsonb_build_object(…, now())` grava, em qualquer fuso — e a data
 * existe no calendário (29 de fevereiro só em ano bissexto). Um padrão só de
 * FORMA deixaria passar `2026-02-31`, que o Postgres recusa no cast. O mesmo
 * texto roda no motor de regex do Postgres (parâmetro da consulta de espera).
 * ponytail: anos 2000–2099, porque a âncora é escrita por now(); alargue antes de 2100.
 */
export const ANCORA_ISO_8601 =
  "^(?:20[0-9]{2}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)" +
  "|02-(?:0[1-9]|1[0-9]|2[0-8]))|20(?:[02468][048]|[13579][26])-02-29)" +
  "T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,6})?(?:Z|[+-](?:0[0-9]|1[0-4]):[0-5][0-9])$";

/** Diagnóstico em `metadata.media_derived_motivo`; nenhum código lê este texto. */
export const MOTIVO_SEM_LEITOR =
  "foto guardada sem descrição: nenhuma IA nem integração desta empresa lê a descrição agora; ela é feita quando aparecer quem a leia";

/** Fotos reabertas por empresa (cron) ou por conversa (dreno) numa rodada. */
export const LOTE_DE_REABERTURA = 100;

/**
 * Idade máxima da foto que o CRON reabre com o knob em `defer`.
 *
 * O dreno não usa esta janela: ele reabre na hora em que um agente vai ler a
 * conversa, até a janela de histórico desse agente — idade não importa ali. O
 * cron serve quem lê fora do dreno (follow-up, rascunho, caso, REST, MCP, Meta),
 * e todos leem as últimas mensagens de uma conversa. O mais longe que um deles
 * alcança sozinho é o follow-up de silêncio: `threshold_minutes` e
 * `max_silence_minutes` têm teto de 10.080 minutos (7 dias,
 * lib/followup/api-schemas.ts). Foto mais velha que isso numa empresa que acabou
 * de ganhar leitor é descrita quando a conversa voltar (o dreno), não de lote.
 * Sem esta janela, ligar a opção num agente pagava visão de meses de fotos, 100
 * a cada 5 minutos, que ninguém ia abrir.
 *
 * ponytail: janela fixa; o caso que fica de fora é o REST/MCP lendo foto de mais
 * de 7 dias, adiada antes de a empresa ganhar leitor — vira knob se alguém medir.
 */
export const JANELA_DO_CRON_DIAS = 7;

/**
 * `MEDIA_VISION_WITHOUT_READER`: o padrão é `defer` (a trava ligada). Só
 * `always`, a válvula do operador, a desliga e descreve toda foto. Ausente, vazio
 * ou grafia torta ficam no padrão: quem perde descrição com a trava ligada é só
 * quem não a lê, e o agente que lê decide pela própria opção.
 */
export function adiarSemLeitorLigado(valor: string): boolean {
  return valor.trim().toLowerCase() !== "always";
}

/**
 * Cada arquivo que contém `media_derived_text`, e o componente do predicado de
 * `haLeitorDaDescricao` que cobre a leitura dele. A cerca
 * `tests/unit/leitores-da-descricao-de-midia.test.ts` reprova quando aparece
 * arquivo novo sem entrada aqui: leitor novo que não é coberto pelo predicado
 * perderia a descrição de foto em empresa sem leitor.
 */
export const LEITORES_DA_DESCRICAO: Record<string, string> = {
  "lib/agent-engine/agent/contexto-do-atendimento.ts": "agente que vê imagens",
  "lib/agent-engine/agent/conversa-do-caso/leitura.ts": "agente que vê imagens | caso aberto sem agente no ar",
  "lib/agent-engine/agent/inbound-turn.ts": "agente que vê imagens",
  "lib/agent-engine/agent/palavra-chave-do-gatilho.ts": "agente que vê imagens",
  "lib/agent-engine/agent/resolve-turn-agent.ts": "agente que vê imagens",
  "lib/agent-engine/edge/crm/get-lead-context.ts": "agente que vê imagens | inscrição sem agente",
  "lib/agent-engine/edge/crm/send-message.ts": "agente que vê imagens (só cita a coluna)",
  "lib/ai/voz/texto-falavel.ts": "agente que vê imagens (só cita a coluna)",
  "workers/ai-sentiment-worker.pedidos.ts": "agente que vê imagens",
  "lib/followup/atendimento.ts": "agente que vê imagens | inscrição sem agente",
  "lib/mcp/conferencia-de-campos.ts": "agente que vê imagens | token vivo",
  "lib/mcp/media-derived-read.ts": "token vivo (só com o escopo messages:derived:read)",
  "lib/mcp/tools/propostas.ts": "agente que vê imagens | token vivo",
  "app/api/v1/messages/_handler.ts": "token vivo | humano: só áudio",
  "lib/conversoes/valor-da-conversa.ts": "conexão de anúncio | venda pelo canal",
  "components/inbox/media/MediaRenderer.tsx": "humano: só áudio",
  "lib/lgpd/export-collector.ts": "minimização",
  "lib/lgpd/pdf-renderer.tsx": "minimização",
  "app/api/v1/lgpd/requests/[id]/preview/route.ts": "minimização",
  "lib/lgpd/cascata.ts": "só zera",
  "lib/conversas/exporta-pdf.ts": "fora: decisão do dono",
  "workers/media-derive-worker.ts": "escritor",
  "lib/messaging/media/escada-de-transcricao.ts": "escritor (áudio)",
  "lib/api/handlers/types.ts": "tipo",
  "lib/types/messaging.ts": "tipo",
  "lib/messaging/media/leitura-adiada.ts": "este mapa",
  // A máscara do texto retido (#4500): lê a coluna só para saber se HÁ texto a
  // esconder e devolve `null` no lugar. Não entrega descrição a ninguém — pelo
  // contrário, é o caminho que a tira do payload —, então não pede componente
  // novo no predicado.
  "lib/messaging/texto-retido.ts": "só mascara",
};

/**
 * A empresa tem quem QUEIRA a descrição de uma foto?
 *
 * Por meio de um agente: agente não arquivado (pausado conta) cuja versão vigente
 * tem `image_vision_enabled`. A vigente é a PUBLICADA — é ela que atende; o
 * rascunho de um agente publicado só roda no "Testar", que não recebe foto. O
 * agente que nunca publicou conta pelo rascunho (é o que vai ao ar), e o que não
 * tem versão nenhuma conta como antes (na dúvida, descreve). Caso aberto de agente
 * no ar, fluxo de follow-up ativo e inscrição conduzida por agente leem por meio do agente
 * dono deles (o caso nasce no turno, com `agent_id`; o gatilho automático com nó
 * de IA só inscreve com um agente publicado armando o fluxo) e por isso não
 * contam sozinhos: contavam como componentes próprios, e com isso qualquer
 * follow-up ligado anulava a opção de todos os agentes.
 *
 * Sem agente: token de API vivo, conexão de anúncio, modo external, venda pelo
 * canal e a inscrição viva SEM agente (`agent_id` nulo: inscrição manual ou por
 * webhook, cujo nó `ai_classify` lê com o modelo da organização). Esses ficam
 * como estavam. E o caso aberto cujo agente NÃO está no ar (sem agente,
 * arquivado, pausado ou sem versão publicada): a conversa do caso responde à
 * equipe com a persona padrão da organização, que vê as fotos
 * (`conversa-do-caso/persona.ts`, a mesma régua de `estadoDoAgente`).
 *
 * Sem linha da organização, responde `true`: na dúvida, descreve.
 *
 * ponytail: a inscrição sem agente conta mesmo quando o grafo é só de texto fixo
 * (que não lê a descrição); separar exige ler o grafo, como `fluxoPedeAgente`.
 */
export async function haLeitorDaDescricao(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ settings: unknown; tem_leitor: boolean }>(
    `select o.settings, (
       exists(select 1 from ai_agents a
               where a.organization_id = o.id and a.archived_at is null
                 and coalesce((select v.image_vision_enabled from ai_agent_versions v
                                where v.organization_id = a.organization_id and v.agent_id = a.id
                                  and (v.id = a.published_version_id
                                       or (a.published_version_id is null and v.status = 'draft'))
                                order by v.version_number desc limit 1), true))
       or exists(select 1 from agent_cases c where c.organization_id = o.id
                   and c.status in ('awaiting_human','awaiting_lead')
                   and not exists(select 1 from ai_agents a
                                   where a.organization_id = c.organization_id and a.id = c.agent_id
                                     and a.archived_at is null and a.paused_at is null
                                     and a.published_version_id is not null))
       or exists(select 1 from api_tokens t where t.organization_id = o.id and t.revoked_at is null
                   and (t.expires_at is null or t.expires_at > now()))
       or exists(select 1 from ad_platform_connections x where x.organization_id = o.id)
       or exists(select 1 from followup_enrollments e where e.organization_id = o.id
                   and e.status in ('active','waiting_reply') and e.agent_id is null)
     ) as tem_leitor
     from organizations o where o.id = $1`,
    [organizationId],
  );
  const linha = rows[0];
  if (linha === undefined) return true;
  const settings = (linha.settings ?? {}) as { ai_dispatch_mode?: unknown };
  return (
    linha.tem_leitor ||
    aiDispatchModeSchema.parse(settings.ai_dispatch_mode) === "external" ||
    vendaPeloCanalLigada(linha.settings)
  );
}

/**
 * Reabre fotos adiadas (as mais novas primeiro) e pede a descrição pelo MESMO
 * evento do persist (`media.derive_requested`), num comando só. O UPDATE
 * reconfere a marca na linha travada: dreno e cron concorrentes nunca emitem
 * duas vezes. `media_storage_path is not null` deixa de fora o que a LGPD ou a
 * retenção zeraram. `derivacao_pedida_em` é a âncora do teto de espera do dreno.
 * `maxIdadeDias` deixa de fora a foto que chegou antes disso (`JANELA_DO_CRON_DIAS`).
 * Devolve quantas reabriu.
 */
export async function reabrirLeituraAdiada(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
  alvo: { conversationId?: string; limite: number; maxIdadeDias?: number },
): Promise<number> {
  const { rows } = await db.query(
    `with alvo as (
       select id from messages
        where organization_id = $1 and metadata ? 'derivacao_adiada' and media_storage_path is not null
          and ($2::uuid is null or conversation_id = $2::uuid)
          and ($4::int is null or created_at > now() - make_interval(days => $4::int))
        order by created_at desc
        limit $3
     ), reabertas as (
       update messages m
          set media_derived_status = null,
              metadata = (m.metadata - 'derivacao_adiada' - 'media_derived_motivo')
                         || jsonb_build_object('derivacao_pedida_em', now())
         from alvo
        where m.id = alvo.id and m.organization_id = $1 and m.metadata ? 'derivacao_adiada'
       returning m.id
     )
     select public.emit_event('media.derive_requested', 'message', r.id,
                              jsonb_build_object('message_id', r.id),
                              jsonb_build_object('source', 'leitura_adiada'), $1)
       from reabertas r`,
    [organizationId, alvo.conversationId ?? null, alvo.limite, alvo.maxIdadeDias ?? null],
  );
  return rows.length;
}

/**
 * Empresas OPERANTES com foto adiada reabrível — a varredura do cron, servida
 * pelo índice parcial (vazio na maioria das instalações). Organização parada
 * não gasta visão; quando volta, a rodada seguinte a alcança.
 */
export async function organizacoesComLeituraAdiada(db: Pick<pg.Pool, "query">): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select d.id from (
       select distinct organization_id as id from messages
        where metadata ? 'derivacao_adiada' and media_storage_path is not null
     ) d
     where public.fn_org_operante(d.id)`,
  );
  return rows.map((r) => r.id);
}
