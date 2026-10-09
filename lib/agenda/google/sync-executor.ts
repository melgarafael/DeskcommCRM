import { randomUUID } from "node:crypto";
import { observeMeeting, type MeetingObservation } from "./meet";
import type { SupabaseClient } from "@supabase/supabase-js";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import {
  paraEventoDoGoogle,
  participantesDoAgendamento,
  PREFIXO_PROPRIEDADE,
  type EventoDoGoogle,
} from "./evento";
import {
  compare,
  comConviteDaFicha,
  checkpoint,
  delta,
  groups,
  hash,
  localProjection,
  remoteProjection,
  sameShared,
  type GoogleConflict,
  type PendingWrite,
  type Projection,
} from "./sync-model";
import { googleTransport, GoogleHttpError, type GoogleFetch } from "./transport";
import {
  googleRpc,
  appointmentSnapshotSchema,
  expectedAppointment,
  type CalendarFence,
} from "./sync-store";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { classificarErroDoGoogle, type OperacaoNoGoogle } from "./erros";
import { deveCriarEspacoAberto } from "./oauth";
import { meetAbertoLigado } from "@/lib/schemas/settings";
import { logger } from "@/lib/logger";

/** A operação do Google que corresponde ao método HTTP usado na publicação. */
const OPERACAO_POR_METODO: Record<PendingWrite["method"], OperacaoNoGoogle> = {
  POST: "criar",
  PATCH: "atualizar",
  DELETE: "apagar",
};

/**
 * A frase que o caminho de publicação PERSISTE quando o Google recusa (#950).
 *
 * Antes disto a escrita persistia `erro.message`, que fora do 412 era apenas
 * `"Google HTTP 400"`: o Google já tinha dito o motivo (`errors[].reason`) e a
 * frase exibida não dizia o que consertar.
 *
 * O corpo cru da resposta NUNCA entra aqui — a frase é persistida e mostrada, e
 * o corpo carrega nome e e-mail de convidado. `classificarErroDoGoogle` monta a
 * frase a partir dos identificadores (status e `errors[].reason`), e é ele que
 * lê o corpo guardado no `GoogleHttpError`.
 *
 * O 412 fica de fora de propósito: o transporte tem frase própria e acionável
 * para ele ("O evento mudou no Google. Releia antes de publicar."), enquanto o
 * classificador não tem caso para 412 — cairia em `permanente`, "repetir não
 * muda o resultado", que é o oposto do que resolve uma pré-condição vencida.
 */
export function mensagemDaRecusaDePublicacao(
  erro: unknown,
  metodo: PendingWrite["method"],
): string {
  if (erro instanceof GoogleHttpError) {
    if (erro.status === 412) return erro.message;
    return classificarErroDoGoogle(erro, OPERACAO_POR_METODO[metodo]).mensagem;
  }
  return erro instanceof Error && "code" in erro
    ? "O compromisso mudou. A sincronização vai reler a versão atual."
    : "Não foi possível sincronizar. Confira a conexão e tente novamente.";
}

/**
 * E-mail da ficha do contato, para o convite do Google.
 *
 * A falta do e-mail (contato sem ficha, stub de teste sem `.from`, falha de
 * leitura, titular anonimizado) NÃO é falha de sincronização: o compromisso
 * continua indo para a agenda do atendente. Quem não tem e-mail é o caso
 * comum — lead que chegou pelo WhatsApp.
 */
export async function emailDoContato(
  db: SupabaseClient,
  org: string,
  contactId: string | null,
): Promise<{ email: string; nome: string | null } | null> {
  if (!contactId) return null;
  if (typeof db.from !== "function") return null;
  try {
    const { data, error } = await db
      .from("contacts")
      .select("email,name,display_name,is_anonymized")
      .eq("organization_id", org)
      .eq("id", contactId)
      .maybeSingle();
    if (error || !data || data.is_anonymized) return null;
    const email = typeof data.email === "string" ? data.email.trim() : "";
    if (!email) return null;
    return { email, nome: nomeDoContato(data) };
  } catch {
    return null;
  }
}

function eventoTemEmail(event: EventoDoGoogle | null | undefined, email: string): boolean {
  const chave = email.trim().toLowerCase();
  return (event?.attendees ?? []).some((p) => p.email?.trim().toLowerCase() === chave);
}

export async function tokenForConnection(db: SupabaseClient, org: string, connectionId: string) {
  const { data, error } = await db
    .from("calendar_connections")
    .select("oauth_access_token_encrypted,user_id,status")
    .eq("organization_id", org)
    .eq("id", connectionId)
    .single();
  if (error || data?.status !== "healthy")
    throw new Error("A conexão Google precisa de atenção nas configurações.");
  const { data: member, error: membershipError } = await db
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", org)
    .eq("user_id", data.user_id)
    .is("revoked_at", null)
    .maybeSingle();
  if (membershipError || !member) throw new Error("O responsável não possui vínculo ativo.");
  const token = await decryptWebhookSecret(db, data.oauth_access_token_encrypted);
  if (!token) throw new Error("Reconecte a conta Google para continuar.");
  return token;
}

/**
 * O gate de #2063: a reunião nasce aberta SÓ quando a organização ligou a opção
 * (off por padrão) E a conexão tem o escopo opcional. Ler opção + escopo é um
 * caminho frio (sem o gate, nada muda); erro de leitura vale como "desligado"
 * — falha fechada, mesma disciplina do resto do executor.
 */
export async function decidirEspacoAberto(
  db: SupabaseClient,
  org: string,
  connectionId: string | null,
): Promise<boolean> {
  if (!connectionId) return false;
  try {
    // As DUAS leituras vêm no envelope do PostgREST (`{data, error}`), não a
    // linha crua: ler `scopes` do envelope achava `undefined` sempre, o gate
    // ficava falso para TODO organização e a opção nunca abria espaço nenhum.
    // Medido no executor de mentira de `agenda-google-meet-aberto-no-corpo`.
    const [{ data: orgRow, error: erroOrg }, { data: connRow, error: erroConexao }] = await Promise.all([
      db.from("organizations").select("settings").eq("id", org).maybeSingle(),
      db
        .from("calendar_connections")
        .select("scopes")
        .eq("organization_id", org)
        .eq("id", connectionId)
        .maybeSingle(),
    ]);
    if (erroOrg || erroConexao) return false;
    const ligada = meetAbertoLigado((orgRow as { settings?: unknown } | null)?.settings);
    const escopos = (connRow as { scopes?: string[] | null } | null)?.scopes ?? [];
    return deveCriarEspacoAberto({ ligada }, escopos);
  } catch {
    return false;
  }
}
export interface ExecuteOptions {
  transport?: GoogleFetch;
  calendarFence?: CalendarFence;
  remote?: EventoDoGoogle;
  token?: string;
}
export async function reconcileAppointment(
  db: SupabaseClient,
  org: string,
  id: string,
  options: ExecuteOptions = {},
): Promise<"busy" | "processed" | "unchanged" | "terminal" | "failed"> {
  const raw = await googleRpc(db, "fn_google_appointment", {
    p_org: org,
    p_id: id,
    p_action: "claim",
    p_args: options.calendarFence ? { calendar_fence: options.calendarFence } : {},
  });
  if (!raw) return "busy";
  if (typeof raw === "object" && "terminal" in raw && raw.terminal === "redacted")
    return "terminal";
  let a = appointmentSnapshotSchema.parse(raw);
  const call = (action: string, extra: Record<string, unknown> = {}) =>
    googleRpc(db, "fn_google_appointment", {
      p_org: org,
      p_id: id,
      p_action: action,
      p_args: { ...expectedAppointment(a, options.calendarFence), ...extra },
    });
  const commit = async (result: Record<string, unknown>) => {
    const saved = await call("commit", { result });
    if (saved && typeof saved === "object" && "overlap" in saved) return false;
    a = appointmentSnapshotSchema.parse(saved);
    return true;
  };
  // Qual método estava em voo quando o Google recusou. O `catch` está FORA do
  // `send`, então o parâmetro dele não alcança a frase persistida — e o método
  // muda o significado da recusa (404 e 410 querem dizer coisas opostas em
  // `apagar` e em `criar`).
  let metodoEmVoo: PendingWrite["method"] = "PATCH";
  try {
    if (!a.google_event_id && a.status === "cancelled") {
      await commit({ ack: true });
      return "processed";
    }
    const contato = await emailDoContato(db, org, a.contact_id);
    if (!a.google_connection_id || !a.google_calendar_id || !a.google_event_id)
      throw new Error("Publicação antiga sem identidade completa. Revise a conexão.");
    const api = googleTransport(
      options.token ?? (await tokenForConnection(db, org, a.google_connection_id)),
      options.transport,
    );
    let meetingObserved = false;
    const meetingDue =
      a.meeting_state === "pending" &&
      (!a.meeting_next_attempt_at || Date.parse(a.meeting_next_attempt_at) <= Date.now());
    const saveMeeting = async (observation: MeetingObservation, etag?: string | null) => {
      a = appointmentSnapshotSchema.parse(await call("meet", { result: { ...observation, etag } }));
      meetingObserved = true;
    };
    /**
     * O espaço aberto do Meet (#2063): cria o espaço pela API do Meet e grava o
     * link como `ready`. Devolve `false` em QUALQUER recusa — API desativada,
     * cota, 403, escopo que o Google ignora.
     *
     * ⚠️ É chamado ANTES de o corpo ser finalizado (`send`), e não depois: a
     * primeira publicação do caminho aberto sai JÁ com o link no `location`.
     * O corpo é (re)montado da projeção que o link acabou de mudar, nunca
     * injetado campo a campo — a montagem fica num lugar só, `localDoEvento`.
     *
     * ⚠️ A recusa NÃO segura a publicação: quem cai no Meet "confiável" do
     * Calendar é o chamador — um link com "pedir para participar" é melhor que
     * nenhum link, e um erro da API do Meet não pode deixar a reunião sem
     * evento nenhum nessa passada.
     */
    const criarEspacoAberto = async (): Promise<boolean> => {
      try {
        const { meetingUri } = await api.criarEspacoAberto();
        await saveMeeting({ state: "ready", received: true, url: meetingUri, error: null });
        return true;
      } catch (e) {
        // Só o status: o corpo da recusa do Google não vai nem para o log.
        logger.warn("[meet-aberto] a API do Meet recusou; o evento nasce com o Meet do Calendar", {
          organization_id: org,
          appointment_id: id,
          meet_status: e instanceof GoogleHttpError ? e.status : null,
        });
        return false;
      }
    };
    /** Se o espaço aberto nasceu nesta passada, o corpo ainda vai sair dele. */
    let espacoAbertoAgora = false;
    /**
     * O marcador PERSISTENTE do espaço aberto (#2063, caminho 2 do review de
     * 08/10): o `location` que mandamos ao Google é o link do espaço aberto.
     *
     * Não há coluna nova nem migration: a prova está no registro da própria
     * publicação, que já existe — `google_base_projection.local.location` é o
     * hash do `location` publicado, e ele é igual ao hash do `meeting_url` de
     * hoje SÓ quando o link publicado é este. `meeting_url` sozinho não
     * distingue: o link "confiável" do Calendar também mora ali.
     *
     * As duas regras da main valem por construção. Compromisso publicado com
     * Meet do Calendar: `base.local.location` é o hash dos `location_details`,
     * nunca o do link — sem marcador, `localDoEvento` devolve os detalhes e a
     * projeção não muda. E ainda que mudasse por acaso (a pessoa escreveu o
     * próprio link nos detalhes), o hash publicado e o do link seriam do MESMO
     * texto: nada sai do lugar, nenhum PATCH.
     */
    const espacoAbertoPublicado = () =>
      Boolean(a.meeting_url?.trim() && base?.local.location === hash(a.meeting_url));
    let base = a.google_base_projection;
    let local = localProjection({ ...a, meet_aberto: espacoAbertoPublicado() });
    // Listagem é sinal de mudança, não versão para um PATCH: GET exato revalida.
    const event = await api.get(a.google_calendar_id, a.google_event_id);
    const linked = event?.extendedProperties?.private;
    const association =
      linked?.[`${PREFIXO_PROPRIEDADE}_org`] === org &&
      linked?.[`${PREFIXO_PROPRIEDADE}_appointment`] === id;
    const wasPublished = base !== null;
    const conflict = async (
      reason: GoogleConflict["reason"],
      remote: Projection | null,
      fields: (typeof groups)[number][] = [],
    ) => {
      await commit({
        conflict: {
          reason,
          local: local.shared,
          remote: remote?.shared ?? null,
          groups: fields,
          etag: event?.etag ?? null,
          revision: a.revision,
          local_revision: a.google_local_revision,
        },
        etag: event?.etag ?? null,
      });
    };
    if (
      event &&
      !wasPublished &&
      a.google_pending_write &&
      ("reservation" in a.google_pending_write || a.google_pending_write.method === "POST") &&
      !association
    ) {
      await conflict("identity", null);
      return "processed";
    }
    if (event?.recurrence?.length || event?.recurringEventId) {
      await conflict("series", null);
      return "processed";
    }
    let remote = event ? remoteProjection(event, local, base) : null;
    if (a.google_conflict?.reason === "series" && event && remote) {
      // As guardas acima provaram que o recurso é novamente único e válido.
      // Refaça as três vias; não reconheça a intenção nem desfaça o domínio aqui.
      await commit({ conflict: null, etag: event.etag ?? null });
    }

    if (
      meetingDue &&
      event &&
      event.status !== "cancelled" &&
      a.status !== "cancelled" &&
      !a.google_conflict &&
      a.meeting_request_id
    ) {
      const observed = observeMeeting(event, a.meeting_request_id, a.meeting_requested_at === null);
      if (observed) await saveMeeting(observed, event.etag);
      else if (a.meeting_received_at)
        await saveMeeting(
          { state: "pending", received: false, url: null, error: null },
          event.etag,
        );
    }

    if (a.google_pending_write && "operation_id" in a.google_pending_write) {
      const pending = a.google_pending_write;
      // Observe a escrita no contexto capturado (A → B), antes de comparar
      // a intenção atual (C). O checkpoint histórico não reconhece C.
      const historical = event ? remoteProjection(event, pending.desired, base) : null;
      const reached =
        pending.method === "DELETE"
          ? !event || event.status === "cancelled"
          : historical &&
            (!pending.shared || sameShared(pending.desired.shared, historical.shared)) &&
            pending.groups.every((g) => pending.desired.outbound[g] === historical.outbound[g]);
      if (reached) {
        const observed = historical ?? {
          ...pending.desired,
          shared: { ...pending.desired.shared, cancelled: true },
        };
        base = checkpoint(base, pending.desired, observed, pending.groups, pending.shared);
        const ack =
          a.google_local_revision === pending.local_revision &&
          sameShared(local.shared, observed.shared);
        await commit({
          base,
          etag: event?.etag ?? null,
          clear_pending: true,
          operation_id: pending.operation_id,
          ack,
        });
        if (ack) return "processed";
      } else if (
        (pending.method === "POST" && !event) ||
        (event?.etag && event.etag === pending.etag)
      ) {
        // Não prova que a chamada antiga parou: repetir segue MESMO ID/etag.
        // O servidor remoto cerca PATCH/DELETE; insert duplicado força GET.
        await commit({
          clear_pending: true,
          operation_id: pending.operation_id,
          retry_creation: pending.method === "POST" && !event,
        });
      } else if (
        event?.etag &&
        pending.method !== "POST" &&
        base &&
        remote &&
        compare(base, local, remote).kind !== "conflict"
      ) {
        // Mudança de etag só em grupo não tocado/RSVP: a comparação ainda
        // permite publicar. O etag novo cerca qualquer request antigo em voo.
        await commit({ clear_pending: true, operation_id: pending.operation_id });
      } else {
        await conflict("shared", remote);
        return "processed";
      }
    }
    // Uma escrita histórica reconhecida pode mudar quem é o convidado gerido.
    remote = event ? remoteProjection(event, local, base) : null;
    if (a.google_conflict) {
      const conflictState = a.google_conflict;
      const resolution = conflictState.resolution;
      if (!resolution) {
        if (
          conflictState.etag !== (event?.etag ?? null) ||
          conflictState.revision !== a.revision ||
          conflictState.local_revision !== a.google_local_revision
        )
          await conflict(conflictState.reason, remote, conflictState.groups);
        return "processed";
      }
      if (
        conflictState.revision !== a.revision ||
        conflictState.local_revision !== a.google_local_revision ||
        conflictState.etag !== (event?.etag ?? null)
      ) {
        await conflict(conflictState.reason, remote, conflictState.groups);
        return "processed";
      }
      if (!remote) {
        await conflict("missing", remote);
        return "processed";
      }
      base ??= checkpoint(null, local, remote, groups, true);
      if (resolution.choice === "google") {
        if (conflictState.groups.length || !["pending", "confirmed"].includes(a.status)) {
          await conflict("outcome", remote);
          return "processed";
        }
        const next = checkpoint(base, local, remote, [], true);
        const accepted = await commit({
          base: next,
          remote: remote.shared,
          apply_remote: true,
          conflict: null,
          clear_pending: true,
          etag: event?.etag ?? null,
          ack: groups.every((g) => next.local[g] === local.outbound[g]),
        });
        if (!accepted) await conflict("overlap", remote);
        return "processed";
      }
      if (resolution.choice === "preserve_remote") {
        if (!conflictState.groups.length) {
          await conflict("shared", remote);
          return "processed";
        }
        const next = structuredClone(base);
        for (const group of conflictState.groups) next.local[group] = local.outbound[group];
        await commit({
          base: next,
          conflict: null,
          clear_pending: true,
          etag: event?.etag ?? null,
        });
      } else {
        if (!event || event.status === "cancelled") {
          await conflict("missing", remote);
          return "processed";
        }
        // A decisão explícita reconhece a versão relida só para esta intenção.
        const next = structuredClone(base);
        next.shared = remote.shared;
        for (const group of conflictState.groups) {
          next.remote[group] = remote.outbound[group];
          if (conflictState.reason === "legacy") next.local[group] = remote.outbound[group];
        }
        await commit({ base: next, conflict: null, clear_pending: true, etag: event.etag });
      }
    }
    local = localProjection({ ...a, meet_aberto: espacoAbertoPublicado() });
    base = a.google_base_projection;
    if (!event) {
      if (wasPublished) {
        remote = { ...local, shared: { ...base!.shared, cancelled: true } };
      } else if (a.status === "cancelled") {
        await commit({ ack: true, clear_pending: true });
        return "processed";
      } else if (!a.google_pending_write || !("reservation" in a.google_pending_write)) {
        await conflict("missing", null);
        return "processed";
      } else {
        await send(
          "POST",
          paraEventoDoGoogle({
            ...a,
            participantes: participantesDoAgendamento({
              contactEmail: contato?.email,
              contactName: contato?.nome,
              guestEmail: a.guest_email,
            }),
          }) as unknown as Record<string, unknown>,
          null,
          [...groups],
          true,
        );
        return "processed";
      }
    }
    if (!remote) throw new Error("Evento sem projeção válida.");
    // O e-mail da ficha vai junto de uma alteração, nunca sozinho — ver
    // `comConviteDaFicha` (decisão do dono, doc 36: sem convite em massa na
    // 1ª sincronização depois da atualização).
    const decision = comConviteDaFicha(compare(base, local, remote), {
      temEmail: Boolean(contato?.email),
      eventoJaTemOEmail: Boolean(contato?.email && event && eventoTemEmail(event, contato.email)),
      cancelado: event?.status === "cancelled" || a.status === "cancelled",
    });
    if (decision.kind === "conflict") {
      await conflict(decision.reason!, remote, decision.groups);
      return "processed";
    }
    if (decision.kind === "accept_remote") {
      if (!["pending", "confirmed"].includes(a.status)) {
        await conflict("outcome", remote);
        return "processed";
      }
      const next = checkpoint(base, local, remote, [], true);
      const accepted = await commit({
        base: next,
        remote: remote.shared,
        apply_remote: true,
        etag: event?.etag ?? null,
        ack: groups.every((g) => next.local[g] === local.outbound[g]),
      });
      if (!accepted) await conflict("overlap", remote);
      return "processed";
    }
    if (
      decision.kind === "converged" &&
      meetingDue &&
      a.meeting_state === "pending" &&
      !a.meeting_received_at &&
      event &&
      event.status !== "cancelled" &&
      a.status !== "cancelled"
    ) {
      await send("PATCH", {}, event.etag ?? null, [], false);
      return "processed";
    }
    if (
      decision.kind === "converged" &&
      !a.google_pending_write &&
      a.google_local_revision === a.google_synced_local_revision &&
      a.google_etag === (event?.etag ?? null) &&
      !decision.shared &&
      !decision.groups.length
    ) {
      await call("idle");
      return meetingObserved ? "processed" : "unchanged";
    }
    if (decision.kind === "converged") {
      await commit({
        base: checkpoint(base, local, remote, decision.groups, decision.shared),
        etag: event?.etag ?? null,
        ack: true,
        clear_pending: true,
      });
      return "processed";
    }
    if (!event || event.status === "cancelled") {
      await conflict("missing", remote);
      return "processed";
    }
    await send(
      local.shared.cancelled ? "DELETE" : "PATCH",
      local.shared.cancelled
        ? undefined
        : delta(
            {
              ...a,
              contact_email: contato?.email ?? null,
              contact_nome: contato?.nome ?? null,
            },
            event,
            base,
            decision.groups,
            decision.shared,
          ),
      event.etag ?? null,
      decision.groups,
      decision.shared,
    );
    return "processed";

    async function send(
      method: PendingWrite["method"],
      body: Record<string, unknown> | undefined,
      etag: string | null,
      fields: (typeof groups)[number][],
      shared: boolean,
    ) {
      let conferenceRequestId: string | undefined;
      // O grupo `location` pode entrar AQUI, depois da decisão: quando o
      // espaço aberto nasce nesta passada, a projeção nova manda o link e o
      // `delta` tem de levá-lo. Fora disto `campos` é `fields`, sem mudança.
      let campos = fields;
      if (
        method !== "DELETE" &&
        a.meeting_state === "pending" &&
        !a.meeting_received_at &&
        a.meeting_request_id &&
        (meetingDue || method === "POST")
      ) {
        if (!a.meeting_allowed_types?.includes("hangoutsMeet")) {
          await saveMeeting({
            state: "failed",
            received: false,
            url: null,
            error: a.meeting_allowed_types === null ? "unknown" : "unsupported",
          });
        } else {
          // #2063 — o espaço aberto SÓ quando a organização ligou a opção E a
          // conexão tem o escopo opcional; o link nasce via `spaces.create`
          // (accessType OPEN) e entra no `location` pela projeção
          // (`localDoEvento`, com o marcador `meet_aberto`) — nunca injetado
          // campo a campo.
          //
          // Qualquer recusa da API do Meet (desativada, escopo ausente, 403,
          // cota) cai no Meet "confiável" do Calendar: um link com "pedir para
          // participar" é melhor que nenhum link, e a recusa não segura a
          // publicação do evento nesta passada.
          espacoAbertoAgora =
            (await decidirEspacoAberto(db, org, a.google_connection_id)) && (await criarEspacoAberto());
          if (!espacoAbertoAgora) {
            conferenceRequestId = a.meeting_request_id;
            body = {
              ...body,
              conferenceData: {
                createRequest: {
                  requestId: conferenceRequestId,
                  conferenceSolutionKey: { type: "hangoutsMeet" },
                },
              },
            };
          }
        }
      }
      if (espacoAbertoAgora) {
        // O espaço nasceu ANTES do envio, então esta escrita já sai com o
        // link: o convidado recebe UM convite com a sala, não um convite sem
        // link e um "alterado" cinco minutos depois (#2063, item 3).
        //
        // O corpo é remontado da projeção nova — o mesmo `localDoEvento` de
        // sempre, agora com o marcador ligado —, nunca montado à mão aqui.
        local = localProjection({ ...a, meet_aberto: true });
        if (method === "POST") {
          body = paraEventoDoGoogle({
            ...a,
            meet_aberto: true,
            participantes: participantesDoAgendamento({
              contactEmail: contato?.email,
              contactName: contato?.nome,
              guestEmail: a.guest_email,
            }),
          }) as unknown as Record<string, unknown>;
        } else if (method === "PATCH") {
          campos = [...new Set([...campos, "location" as const])];
          body = delta(
            {
              ...a,
              meet_aberto: true,
              contact_email: contato?.email ?? null,
              contact_nome: contato?.nome ?? null,
            },
            event!,
            base,
            campos,
            shared,
          );
        }
      }
      // Se só faltava conferência e a capacidade foi recusada, nenhum PATCH vazio.
      if (method === "PATCH" && !shared && !campos.length && !conferenceRequestId) return;
      const pending: PendingWrite = {
        ...(conferenceRequestId ? { conference_request_id: conferenceRequestId } : {}),
        operation_id: randomUUID(),
        method,
        etag,
        revision: a.revision,
        local_revision: a.google_local_revision,
        desired: local,
        groups: campos,
        shared,
      };
      await call("prepare", { operation: pending });
      // Imediatamente antes do efeito: mesma aquisição/revisão e membership.
      await call("renew");
      // O método que está em voo — é ele que a frase da recusa vai usar.
      metodoEmVoo = method;
      const response = await api.write(
        a.google_calendar_id!,
        a.google_event_id!,
        method,
        body,
        etag,
      );
      const observed = response
        ? remoteProjection(response, local, base)
        : { ...local, shared: { ...local.shared, cancelled: true } };
      await commit({
        base: checkpoint(base, local, observed, campos, shared),
        etag: response?.etag ?? null,
        operation_id: pending.operation_id,
        clear_pending: true,
        ack: shared || campos.length > 0,
      });
      if (conferenceRequestId && response && a.status !== "cancelled") {
        const observation = observeMeeting(response, conferenceRequestId) ?? {
          state: "pending" as const,
          received: false,
          url: null,
          error: null,
        };
        await saveMeeting(observation, response.etag);
      }
    }
  } catch (e) {
    // Nunca persistir corpo remoto, e-mail ou payload no erro exibido: a frase
    // sai dos identificadores da recusa, nunca do texto livre do Google.
    const message = mensagemDaRecusaDePublicacao(e, metodoEmVoo);
    try {
      await call("error", { message });
    } catch {
      /* aquisição perdida não escreve erro tardio */
    }
    return "failed";
  } finally {
    try {
      await call("release");
    } catch {
      /* só a aquisição original pode liberar */
    }
  }
}
