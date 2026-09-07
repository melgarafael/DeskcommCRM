import { randomUUID } from "node:crypto";
import { observeMeeting, type MeetingObservation } from "./meet";
import type { SupabaseClient } from "@supabase/supabase-js";
import { paraEventoDoGoogle, PREFIXO_PROPRIEDADE, type EventoDoGoogle } from "./evento";
import {
  compare,
  checkpoint,
  delta,
  groups,
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
  try {
    if (!a.google_event_id && a.status === "cancelled") {
      await commit({ ack: true });
      return "processed";
    }
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
    let local = localProjection(a);
    let base = a.google_base_projection;
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
    local = localProjection(a);
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
            participantes: a.guest_email
              ? [{ email: a.guest_email, aguardandoResposta: true }]
              : [],
          }) as unknown as Record<string, unknown>,
          null,
          [...groups],
          true,
        );
        return "processed";
      }
    }
    if (!remote) throw new Error("Evento sem projeção válida.");
    const decision = compare(base, local, remote);
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
      local.shared.cancelled ? undefined : delta(a, event, base, decision.groups, decision.shared),
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
      // Se só faltava conferência e a capacidade foi recusada, nenhum PATCH vazio.
      if (method === "PATCH" && !shared && !fields.length && !conferenceRequestId) return;
      const pending: PendingWrite = {
        ...(conferenceRequestId ? { conference_request_id: conferenceRequestId } : {}),
        operation_id: randomUUID(),
        method,
        etag,
        revision: a.revision,
        local_revision: a.google_local_revision,
        desired: local,
        groups: fields,
        shared,
      };
      await call("prepare", { operation: pending });
      // Imediatamente antes do efeito: mesma aquisição/revisão e membership.
      await call("renew");
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
        base: checkpoint(base, local, observed, fields, shared),
        etag: response?.etag ?? null,
        operation_id: pending.operation_id,
        clear_pending: true,
        ack: shared || fields.length > 0,
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
    // Nunca persistir corpo remoto, e-mail ou payload no erro exibido.
    const message =
      e instanceof GoogleHttpError
        ? e.message
        : e instanceof Error && "code" in e
          ? "O compromisso mudou. A sincronização vai reler a versão atual."
          : "Não foi possível sincronizar. Confira a conexão e tente novamente.";
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
