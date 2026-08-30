/**
 * GET/POST /api/v1/cron/agenda-google-sync — a VOLTA: o que o Google diz que ocupa.
 *
 * ─── Por que esta rota existe ─────────────────────────────────────────────
 *
 * Medido pelo maestro e confirmado aqui: NINGUÉM escrevia em
 * `calendar_external_events` — `git grep` achava dois sítios e os dois eram
 * leitura, com controle positivo de 152 escritas no resto do repo. O pedido do
 * dono do produto diz "ida e volta"; havia só ida. E o tradutor
 * (`doEventoDoGoogle`), aprovado numa revisão independente com 40 itens
 * corretos, não traduzia nada porque não tinha quem o chamasse. Esta rota é o
 * consumidor dele.
 *
 * ─── O FILTRO ANTI-ECO É O CORAÇÃO, e sem ele a volta cria fantasma ───────
 *
 * Um agendamento nosso vira evento no Google e VOLTA nesta listagem. Gravá-lo
 * como evento externo faria o MESMO compromisso ocupar dois horários: a linha
 * externa e a linha de `calendar_appointments`. Pior no caso mais comum — a
 * pessoa MOVE o compromisso no Google: o externo passa a ocupar o horário novo
 * e o agendamento continua ocupando o antigo, sem nada que os ligue para
 * desfazer.
 *
 * Medido antes de escrever: nem `lib/agenda/ocupados.ts` nem
 * `lib/agenda/consulta.ts` descontam evento externo que seja nosso — os dois
 * contam tudo o que está na tabela. Logo o filtro tem de ser na ESCRITA, e é
 * `ehIcalUidNosso` que o faz. É o que tira aquela função da prateleira.
 *
 * ─── A RECONCILIAÇÃO, e o fantasma que a poda por prazo não alcança ──────
 *
 * No sync INCREMENTAL o Google manda uma lápide `cancelled` para o que foi
 * apagado, e a rodada remove a linha. No sync COMPLETO — o primeiro, e todo o
 * que vem depois de um `410` — não há lápide: o evento apagado simplesmente NÃO
 * VEM na lista. A linha antiga fica, e continua ocupando horário para sempre.
 *
 * A poda por prazo do `data-retention` não alcança isso: ela apaga o que está
 * VELHO, e este evento pode ser de semana que vem. O que o apaga é comparar o
 * que veio com o que está guardado, e remover a diferença — e só dá para fazer
 * isso quando a leitura foi COMPLETA.
 *
 * ⚠️ E é por isso que a reconciliação NÃO roda quando a listagem foi truncada
 * pelo teto de páginas: ali a ausência de um evento significa "não li", não
 * "foi apagado", e apagar por não ter lido é destruir dado por falta de
 * paciência. `listarEventos` já devolve `truncada` justamente para esta
 * decisão.
 *
 * ─── `410 fullSyncRequired` ────────────────────────────────────────────────
 *
 * O `syncToken` morre (expira, ou a ACL do calendário muda). O Google responde
 * 410 e manda recomeçar do zero. Aqui isso limpa o token e refaz a leitura na
 * MESMA rodada — sem isso o worker repetiria a mesma requisição com o mesmo
 * token morto para sempre, e a agenda congelaria em silêncio. É o defeito que a
 * referência do cal.com carrega até hoje.
 */

import { NextResponse, type NextRequest } from "next/server";
import { apenasDeMembrosAtivos } from "@/lib/agenda/google/membros";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { classificarErroDoGoogle } from "@/lib/agenda/google/erros";
import { doEventoDoGoogle, ehEventoNosso } from "@/lib/agenda/google/evento";
import { listarEventos } from "@/lib/agenda/google/eventos-remotos";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Teto por rodada: sincronizar tudo num tick estouraria a cota do Google. */
export const TETO_DE_CALENDARIOS = 25;

export interface ResumoDoSync {
  calendarios: number;
  gravados: number;
  removidos: number;
  nossosIgnorados: number;
  recusados: number;
  ressincronizados: number;
  /** Linhas apagadas por não virem numa leitura COMPLETA. */
  reconciliados: number;
  falhas: number;
}

interface CalendarioParaSincronizar {
  id: string;
  organization_id: string;
  connection_id: string;
  user_id: string;
  external_calendar_id: string;
  sync_token: string | null;
  fuso: string | null;
  access_token_encrypted: string | null;
}

export async function sincronizarAgendasDoGoogle(
  admin: ReturnType<typeof createAdminClient>,
  opcoes: { agora: Date; calendarios: CalendarioParaSincronizar[] },
): Promise<ResumoDoSync> {
  const resumo: ResumoDoSync = {
    calendarios: 0,
    gravados: 0,
    removidos: 0,
    nossosIgnorados: 0,
    recusados: 0,
    ressincronizados: 0,
    reconciliados: 0,
    falhas: 0,
  };

  // Fuso de cada organização envolvida, buscado UMA vez — segundo degrau do
  // fallback do fuso (ver o comentário no `const fuso` abaixo).
  const fusoDaOrg = new Map<string, string>();
  const orgsDoLote = [...new Set(opcoes.calendarios.map((c) => c.organization_id))];
  if (orgsDoLote.length > 0) {
    const { data: linhasDeOrg } = await admin.from("organizations").select("id, timezone").in("id", orgsDoLote);
    for (const o of (linhasDeOrg ?? []) as { id: string; timezone: string | null }[]) {
      const tz = o.timezone?.trim();
      if (tz) fusoDaOrg.set(String(o.id), tz);
    }
  }

  for (const cal of opcoes.calendarios.slice(0, TETO_DE_CALENDARIOS)) {
    resumo.calendarios += 1;

    if (!cal.access_token_encrypted) {
      resumo.falhas += 1;
      continue;
    }
    const accessToken = await decryptWebhookSecret(admin, cal.access_token_encrypted);
    if (!accessToken) {
      // Chave de cifra da instalação ausente. Não rebaixa nada: o problema é do
      // servidor, não da autorização.
      resumo.falhas += 1;
      continue;
    }

    // Leitura COMPLETA é a que não usou `syncToken`: a primeira da agenda, ou a
    // que veio depois de um `410`. Só ela permite reconciliar.
    let leituraCompleta = !cal.sync_token;
    let leitura = await listarEventos(accessToken, cal.external_calendar_id, {
      syncToken: cal.sync_token,
      agora: opcoes.agora,
    });

    if (!leitura.ok) {
      const classificacao = classificarErroDoGoogle(leitura.erro, "sincronizar");
      if (classificacao.desfecho === "ressincronizar") {
        // O token morreu. Limpa e refaz do zero NA MESMA RODADA — repetir com o
        // token morto congelaria esta agenda para sempre.
        await admin
          .from("calendar_connection_calendars")
          .update({ sync_token: null })
          .eq("id", cal.id);
        resumo.ressincronizados += 1;
        leituraCompleta = true;
        leitura = await listarEventos(accessToken, cal.external_calendar_id, {
          syncToken: null,
          agora: opcoes.agora,
        });
      }
      if (!leitura.ok) {
        resumo.falhas += 1;
        continue;
      }
    }

    // O fuso do CALENDÁRIO, depois o da ORGANIZAÇÃO. `UTC` é o último recurso e hoje é
    // inalcançável — `organizations.timezone` é NOT NULL com default.
    //
    // ⚠️ Era `cal.fuso?.trim() || "UTC"` com `cal.fuso` cravado em `null` no mapeamento
    // da rota: o fallback disparava SEMPRE. Em `America/Sao_Paulo`, evento de dia inteiro
    // lido como UTC bloqueia das 21h do dia anterior às 21h do seguinte — a noite do
    // próprio dia vaza, e a agenda recusa hora que existe.
    //
    // Enquanto ninguém grava `calendar_connection_calendars.time_zone` (medido: zero
    // inserts na tabela hoje), o fuso da organização é o palpite CERTO — o mesmo que a
    // pessoa escolheu no onboarding. UTC nunca foi palpite: era ausência disfarçada.
    const fuso = cal.fuso?.trim() || fusoDaOrg.get(cal.organization_id) || "UTC";
    const vistos = new Set<string>();
    for (const bruto of leitura.pagina.eventos) {
      const lido = doEventoDoGoogle(bruto, { fusoDoCalendario: fuso });

      if (lido.tipo === "recusado") {
        resumo.recusados += 1;
        continue;
      }

      // Todo evento que o tradutor conseguiu ler entra em `vistos`, inclusive o
      // cancelado: a reconciliação lá embaixo apaga o que NÃO veio, e um evento
      // que veio como cancelado JÁ foi tratado — contá-lo como sumido seria
      // apagá-lo duas vezes.
      //
      // Não há guarda contra `recusado` aqui: o `continue` acima já o eliminou,
      // e a guarda que eu tinha escrito era um ramo INALCANÇÁVEL — o compilador
      // acusou (TS2367, "os tipos não têm sobreposição"). É a mesma classe da
      // guarda morta que este mesmo dia me fez apagar em `config.ts`: defesa que
      // não pode ser exercitada dá sensação de proteção sem proteger.
      vistos.add(lido.tipo === "cancelado" ? lido.externalEventId : lido.evento.external_event_id);

      if (lido.tipo === "cancelado") {
        await admin
          .from("calendar_external_events")
          .delete()
          .eq("organization_id", cal.organization_id)
          .eq("connection_id", cal.connection_id)
          .eq("external_calendar_id", cal.external_calendar_id)
          .eq("external_event_id", lido.externalEventId);
        resumo.removidos += 1;
        continue;
      }

      // ⚠️ O FILTRO ANTI-ECO. Ver o cabeçalho: gravar o que nós mesmos criamos
      // faz o mesmo compromisso ocupar dois horários.
      //
      // Pergunta ao `bruto`, e não ao `lido`, de propósito: os três sinais que
      // `ehEventoNosso` usa incluem as `extendedProperties`, que a tradução para
      // `EventoExternoLido` não carrega (ela guarda o que vira COLUNA). O evento
      // cru já está aqui, na variável do laço — perguntar a ele custa nada e não
      // obriga a alargar a linha guardada por causa de uma decisão de leitura.

      if (ehEventoNosso(bruto)) {
        resumo.nossosIgnorados += 1;
        continue;
      }

      const { error } = await admin.from("calendar_external_events").upsert(
        {
          organization_id: cal.organization_id,
          connection_id: cal.connection_id,
          external_calendar_id: cal.external_calendar_id,
          external_event_id: lido.evento.external_event_id,
          title: lido.evento.title,
          starts_at: lido.evento.starts_at,
          ends_at: lido.evento.ends_at,
          is_all_day: lido.evento.is_all_day,
          status: lido.evento.status,
          transparency: lido.evento.transparency,
          external_updated_at: lido.evento.external_updated_at,
          ical_uid: lido.evento.ical_uid,
        },
        { onConflict: "organization_id,connection_id,external_calendar_id,external_event_id" },
      );
      if (error) resumo.falhas += 1;
      else resumo.gravados += 1;
    }

    // A RECONCILIAÇÃO. Ver o cabeçalho: só em leitura COMPLETA e NÃO truncada.
    if (leituraCompleta && !leitura.pagina.truncada) {
      const { data: guardados } = await admin
        .from("calendar_external_events")
        .select("external_event_id")
        .eq("organization_id", cal.organization_id)
        .eq("connection_id", cal.connection_id)
        .eq("external_calendar_id", cal.external_calendar_id);

      const sumidos = (guardados ?? [])
        .map((l) => String((l as { external_event_id: unknown }).external_event_id))
        .filter((id) => !vistos.has(id));

      for (const id of sumidos) {
        await admin
          .from("calendar_external_events")
          .delete()
          .eq("organization_id", cal.organization_id)
          .eq("connection_id", cal.connection_id)
          .eq("external_calendar_id", cal.external_calendar_id)
          .eq("external_event_id", id);
        resumo.reconciliados += 1;
      }
    }

    // Só guarda o token quando a leitura chegou ao fim — `listarEventos` já
    // devolve `null` quando cortou.
    if (leitura.pagina.syncToken) {
      await admin
        .from("calendar_connection_calendars")
        .update({ sync_token: leitura.pagina.syncToken })
        .eq("id", cal.id);
    }
  }

  if (
    resumo.gravados > 0 ||
    resumo.removidos > 0 ||
    resumo.reconciliados > 0 ||
    resumo.ressincronizados > 0 ||
    resumo.falhas > 0
  ) {
    await audit({
      action: "agenda.google.sync_executado",
      metadata: {
        calendarios: resumo.calendarios,
        gravados: resumo.gravados,
        removidos: resumo.removidos,
        nossos_ignorados: resumo.nossosIgnorados,
        recusados: resumo.recusados,
        reconciliados: resumo.reconciliados,
        ressincronizados: resumo.ressincronizados,
        falhas: resumo.falhas,
      },
    });
  }

  return resumo;
}

function autorizado(req: NextRequest): boolean {
  const cabecalho = req.headers.get("authorization") ?? "";
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  return aceitos.length > 0 && aceitos.some((s) => cabecalho === `Bearer ${s}`);
}

async function executar(req: NextRequest): Promise<Response> {
  if (!autorizado(req)) {
    return NextResponse.json({ error: { code: "unauthenticated", message: "cron secret inválido" } }, { status: 401 });
  }
  const admin = createAdminClient();
  const { data } = await admin
    .from("calendar_connection_calendars")
    .select(
      "id, organization_id, connection_id, external_calendar_id, sync_token, time_zone, calendar_connections!inner(status, oauth_access_token_encrypted, user_id)",
    )
    .eq("counts_for_conflicts", true)
    .limit(TETO_DE_CALENDARIOS);

  const calendarios: CalendarioParaSincronizar[] = (data ?? []).flatMap((linha) => {
    const l = linha as unknown as Record<string, unknown>;
    const conexao = l.calendar_connections as { status?: string; oauth_access_token_encrypted?: string; user_id?: string } | null;
    // Só agenda saudável entra: token vencido não lista, e insistir gastaria
    // cota para receber 401.
    if (!conexao || conexao.status !== "healthy") return [];
    return [
      {
        id: String(l.id),
        organization_id: String(l.organization_id),
        connection_id: String(l.connection_id),
        // Dono da conexão: é por ele que `apenasDeMembrosAtivos` decide se a agenda
        // ainda pode ser lida. Sem propagar aqui, o filtro não teria como perguntar.
        user_id: String(conexao.user_id ?? ""),
        external_calendar_id: String(l.external_calendar_id),
        sync_token: (l.sync_token as string | null) ?? null,
        fuso: (l.time_zone as string | null) ?? null,
        access_token_encrypted: conexao.oauth_access_token_encrypted ?? null,
      },
    ];
  });

  // Calendário de quem saiu da organização não é lido. O filtro é no CONSUMO e não
  // só na rota de revogar: quem sair por outro caminho — SQL de suporte, migração,
  // uma segunda rota amanhã — também para de ser sincronizado.
  const doTime = await apenasDeMembrosAtivos(admin, calendarios);
  const resumo = await sincronizarAgendasDoGoogle(admin, { agora: new Date(), calendarios: doTime });
  return NextResponse.json({ data: resumo });
}

export async function GET(req: NextRequest): Promise<Response> {
  return executar(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return executar(req);
}
