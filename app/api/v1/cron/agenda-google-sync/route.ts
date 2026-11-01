import { NextResponse, type NextRequest } from "next/server";
import { refreshCatalog, syncCalendar } from "@/lib/agenda/google/calendar-executor";
import { apenasDeMembrosAtivos } from "@/lib/agenda/google/membros";
import { janelaDaRodada, LOTE_DE_CONEXOES } from "@/lib/agenda/google/rodizio-de-conexoes";
import { ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
export const dynamic = "force-dynamic";
/** O mesmo prazo que a RPC dá à agenda que falhou (`sync_next_attempt_at` + 15 min). */
const RECUO_DO_CATALOGO_MS = 15 * 60_000;

/**
 * O QUE RODA DEPOIS DO PORTÃO DO PISO OCIOSO (#3773), na ordem do arquivo.
 *
 * O `if (await recursoOcioso(...))` desta rota é saída antecipada da ROTA
 * INTEIRA: o que vier depois dele não roda em instalação ociosa. Esta lista é a
 * declaração do que roda ali — `tests/unit/cron-passa-pelo-portao.test.ts` lê o
 * AST deste arquivo e reprova, com arquivo e linha, quando o que está de fato
 * abaixo do portão divergir dela. Passo novo abaixo do portão entra aqui, e só
 * depois de a pessoa ver que ele NÃO roda na instalação parada, que é o caso
 * comum. O #3650 mediu o custo de não haver essa cerca: três passos novos na
 * `historico-import` ficaram fora do sinal do portão e o autor teve de alargá-lo
 * à mão.
 *
 * Em runtime a constante não serve para nada — o `void` existe só para o lint
 * não acusar variável sem uso.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "const db",
  "const {count}",
  "const conexoesElegiveis",
  "const janela",
  "const {data, error}",
  "if (error)",
  "const connections",
  "const effects",
  "let remainingCalendars",
  "for (connection of connections)",
  "for ([organizationId, quantidade] of effects)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

async function executar(req: NextRequest) {
  if (!autorizaCron(req))
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "cron secret inválido" } },
      { status: 401 },
    );
  // O PISO OCIOSO (#3731): instalação sem conexão Google saudável não tem
  // calendário a sincronizar, e a rodada de todo minuto ia ao banco (contagem +
  // leitura das conexões) só para descobrir isso. A saída vem antes das duas,
  // pelo retrato em memória de lib/cron/piso-ocioso.ts.
  if (await recursoOcioso("agenda_google")) return ok({ pulado: "recurso_ocioso" });
  const db = createAdminClient();
  // ─── O RODÍZIO, SEM CARIMBAR NADA (#3695) ─────────────────────────────────
  //
  // Até aqui o rodízio ERA o `updated_at` da conexão: a rodada lia
  // `order=updated_at.asc&limit=25` e carimbava `updated_at` em cada conexão do
  // lote, sincronizando ou não — o carimbo empurrava a linha para o fim da fila.
  // Numa instalação OCIOSA isso era um UPDATE por conexão por minuto, para
  // sempre, e o único valor que mudava era o próprio `updated_at`: WAL, tupla
  // morta e IO para escrever o mesmo estado (é o que a #3695 mediu).
  //
  // Agora o avanço vem do RELÓGIO — uma PÁGINA sobre a ordem estável `id`
  // (`lib/agenda/google/rodizio-de-conexoes.ts`, que também prova o rodízio com
  // mais de 25 conexões e a cobertura de todas elas). Sem leitura concluída,
  // nenhuma linha é escrita.
  //
  // A contagem é `head` (nenhuma linha transferida) e SÓ existe para o
  // deslocamento não passar do fim. Se ela falhar, a rodada lê o começo da fila
  // como antes: um rodízio sem cobertura é ruim, uma rodada que não lê nada é
  // pior.
  const { count: totalDeElegiveis } = await db
    .from("calendar_connections")
    .select("id", { count: "exact", head: true })
    .eq("status", "healthy")
    .eq("provider", "google_calendar");
  const conexoesElegiveis = () =>
    db
      .from("calendar_connections")
      .select("id,organization_id,user_id,calendar_selection_revision,catalog_retry_at")
      .eq("status", "healthy")
      .eq("provider", "google_calendar")
      .order("id");
  const janela = janelaDaRodada(totalDeElegiveis, new Date());
  const { data: raw, error } = janela
    ? await conexoesElegiveis().range(janela.inicio, janela.fim)
    : await conexoesElegiveis().limit(LOTE_DE_CONEXOES);
  if (error)
    return NextResponse.json(
      { error: { code: "internal_error", message: "Não foi possível ler as conexões Google." } },
      { status: 500 },
    );
  const connections = await apenasDeMembrosAtivos(db, raw ?? []);
  const effects = new Map<string, number>();
  let remainingCalendars = 25;
  for (const connection of connections) {
    if (remainingCalendars === 0) break;
    const org = connection.organization_id;
    let complete = true;
    let completedCalendars = 0;
    try {
      const { data: catalog } = await db
        .from("calendar_connection_calendars")
        .select("catalog_checked_at")
        .eq("organization_id", org)
        .eq("connection_id", connection.id)
        .order("catalog_checked_at", { nullsFirst: true })
        .limit(1);
      if (
        !catalog?.[0]?.catalog_checked_at ||
        Date.parse(catalog[0].catalog_checked_at) < Date.now() - 86_400_000
      ) {
        // Só o sucesso grava `catalog_checked_at`. Sem este recuo, a leitura do
        // catálogo que falha (429, 5xx, 403) seria repetida a cada tick do cron
        // de 1 min: 60 chamadas e 60 audits por hora. No recuo, a conexão espera
        // como esperava antes, sem ler as agendas com o catálogo vencido.
        if (connection.catalog_retry_at && Date.parse(connection.catalog_retry_at) > Date.now()) continue;
        try {
          await refreshCatalog(db, org, connection.id);
        } catch (catalogError) {
          await db
            .from("calendar_connections")
            .update({ catalog_retry_at: new Date(Date.now() + RECUO_DO_CATALOGO_MS).toISOString() })
            .eq("organization_id", org)
            .eq("id", connection.id);
          throw catalogError;
        }
        effects.set(org, (effects.get(org) ?? 0) + 1);
      }
      const { data: calendars, error: calendarError } = await db
        .from("calendar_connection_calendars")
        .select("id,external_calendar_id,counts_for_conflicts,is_destination")
        .eq("organization_id", org)
        .eq("connection_id", connection.id)
        .eq("available", true)
        .lte("sync_next_attempt_at", new Date().toISOString())
        .order("sync_next_attempt_at")
        .limit(remainingCalendars);
      if (calendarError) throw calendarError;
      for (const calendar of calendars ?? []) {
        if (!calendar.counts_for_conflicts && !calendar.is_destination) {
          const { data: serviceSources, error: sourceError } = await db.from("calendar_service_calendar_sources")
            .select("event_type_id").eq("organization_id", org).eq("calendar_id", calendar.id).limit(1);
          const { data: serviceDestinations, error: destinationError } = await db.from("calendar_event_types")
            .select("id").eq("organization_id", org).eq("destination_calendar_id", calendar.id).eq("service_enabled", true).limit(1);
          if (sourceError || destinationError) throw sourceError ?? destinationError;
          const { data: linked, error: linkError } = await db
            .from("calendar_google_reconcilable_appointments")
            .select("id")
            .eq("organization_id", org)
            .eq("google_connection_id", connection.id)
            .eq("google_calendar_id", calendar.external_calendar_id)
            .limit(1);
          if (linkError) throw linkError;
          if (!linked?.length && !serviceSources?.length && !serviceDestinations?.length) {
            // Sem consumidor agora: retire do início do lote. Uma escolha
            // futura rearma o prazo na própria RPC de seleção.
            const { error: deferredError } = await db
              .from("calendar_connection_calendars")
              .update({ sync_next_attempt_at: new Date(Date.now() + 86_400_000).toISOString() })
              .eq("organization_id", org)
              .eq("connection_id", connection.id)
              .eq("id", calendar.id);
            if (deferredError) throw deferredError;
            continue;
          }
        }
        remainingCalendars -= 1;
        const result = await syncCalendar(db, org, calendar.id);
        if (result !== "complete") complete = false;
        else completedCalendars += 1;
        if (result !== "busy") effects.set(org, (effects.get(org) ?? 0) + 1);
        // O marco da PRÓPRIA leitura desta agenda. `last_sync_at` é por agenda,
        // não por conta: quem só bloqueia horário foi lida na mesma rodada que a
        // de destino, e a tela ("Ainda não sincronizada") não pode dizer o
        // contrário. Só quem leu de verdade carimba: `busy` não leu nada (outra
        // rodada segura a aquisição ou a agenda está indisponível) e `failed`
        // não terminou — nesse caso é a `sync_error` da própria linha que conta
        // o que houve, e um carimbo aqui mentiria. `partial` avançou um
        // checkpoint do ciclo (página gravada no cursor), então é leitura real.
        if (result === "complete" || result === "partial") {
          const { error: stampError } = await db
            .from("calendar_connection_calendars")
            .update({ last_sync_at: new Date().toISOString() })
            .eq("organization_id", org)
            .eq("connection_id", connection.id)
            .eq("id", calendar.id);
          if (stampError) throw stampError;
        }
      }
      // SÓ GRAVA O QUE MUDOU (#3695). Este `update` era incondicional: carimbava
      // `updated_at` em toda conexão do lote a cada rodada para servir de
      // cursor do rodízio (agora o rodízio é o deslocamento sobre `id`, ver o
      // topo da rota). Sem leitura concluída nada aqui é verdade — e escrever
      // "nada aconteceu" é o custo que a #3695 mediu. `last_sync_error` só é
      // limpo quando alguma agenda terminou de verdade: é o mesmo critério de
      // antes, agora sem a escrita quando ele não vale.
      if (complete && completedCalendars > 0) {
        const { error: stampError } = await db
          .from("calendar_connections")
          .update({
            last_sync_error: null,
            last_sync_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("organization_id", org)
          .eq("id", connection.id);
        if (stampError) throw stampError;
      }
    } catch {
      await db
        .from("calendar_connections")
        .update({
          last_sync_error:
            "Não foi possível atualizar as agendas. Confira a conexão nas configurações.",
        })
        .eq("organization_id", org)
        .eq("id", connection.id);
      effects.set(org, (effects.get(org) ?? 0) + 1);
    }
  }
  for (const [organizationId, quantidade] of effects) {
    if (quantidade > 0)
      await audit({
        action: "agenda.google.sync_executado",
        organizationId,
        metadata: { direcao: "volta", calendarios: quantidade },
      });
  }
  return NextResponse.json({ data: { conexoes: connections.length, organizacoes: effects.size } });
}
export const GET = executar;
export const POST = executar;
