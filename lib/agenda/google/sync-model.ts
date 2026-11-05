/** Contrato central de reconciliação. Checkpoints outbound guardam hashes, não PII. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  doEventoDoGoogle,
  paraEventoDoGoogle,
  participantesDoAgendamento,
  PREFIXO_PROPRIEDADE,
  propriedadesPrivadas,
  type AgendamentoParaGoogle,
  type EventoDoGoogle,
} from "./evento";

export const sharedSchema = z
  .object({
    starts_at: z.string(),
    ends_at: z.string(),
    time_zone: z.string(),
    cancelled: z.boolean(),
  })
  .strict();
const hashesSchema = z
  .object({ title: z.string(), description: z.string(), location: z.string(), guest: z.string() })
  .strict();
export const projectionSchema = z.object({ shared: sharedSchema, outbound: hashesSchema }).strict();
export const baseSchema = z
  .object({ shared: sharedSchema, local: hashesSchema, remote: hashesSchema })
  .strict();
export const groups = ["title", "description", "location", "guest"] as const;
export type Group = (typeof groups)[number];
export type Shared = z.infer<typeof sharedSchema>;
export type Projection = z.infer<typeof projectionSchema>;
export type Base = z.infer<typeof baseSchema>;
export const claimSchema = z.object({
  token: z.uuid(),
  epoch: z.string(),
  lease_until: z.string(),
});
export type GoogleClaim = z.infer<typeof claimSchema>;
export const cursorSchema = z.object({
  generation: z.uuid(),
  mode: z.enum(["full", "incremental"]),
  base_sync_token: z.string().nullable(),
  page_token: z.string().nullable(),
  window_start: z.string(),
  window_end: z.string(),
});
export type SyncCursor = z.infer<typeof cursorSchema>;
export const coverageSchema = z
  .object({
    generation: z.uuid(),
    window_start: z.string(),
    window_end: z.string(),
    completed_at: z.string(),
  })
  .strict();

export const writeSchema = z.object({
  conference_request_id: z.uuid().optional(),
  operation_id: z.uuid(),
  method: z.enum(["POST", "PATCH", "DELETE"]),
  etag: z.string().nullable(),
  revision: z.string(),
  local_revision: z.string(),
  desired: projectionSchema,
  groups: z.array(z.enum(groups)),
  shared: z.boolean(),
});
export type PendingWrite = z.infer<typeof writeSchema>;
export const pendingSchema = z.union([
  writeSchema,
  z.object({ reservation: z.literal(true) }).strict(),
]);
export const conflictSchema = z.object({
  reason: z.enum([
    "shared",
    "outbound",
    "legacy",
    "series",
    "outcome",
    "overlap",
    "missing",
    "identity",
  ]),
  local: sharedSchema,
  remote: sharedSchema.nullable(),
  groups: z.array(z.enum(groups)),
  etag: z.string().nullable(),
  revision: z.string(),
  local_revision: z.string(),
  resolution: z
    .object({ choice: z.enum(["google", "local", "preserve_remote"]), actor_id: z.uuid() })
    .optional(),
});
export type GoogleConflict = z.infer<typeof conflictSchema>;
export const hash = (value: string | null | undefined) =>
  createHash("sha256")
    .update(value?.trim() ?? "")
    .digest("hex");
export const sameShared = (a: Shared, b: Shared) =>
  a.cancelled === b.cancelled &&
  (a.cancelled ||
    (Date.parse(a.starts_at) === Date.parse(b.starts_at) &&
      Date.parse(a.ends_at) === Date.parse(b.ends_at) &&
      a.time_zone === b.time_zone));
/**
 * O hash do grupo `guest`: os e-mails que NÓS gerenciamos no evento.
 *
 * ⚠️ A forma é a mesma de antes para zero e um convidado (`hash("")`,
 * `hash(email)`) — é o que mantém válidos os checkpoints já gravados. Com dois
 * ou mais, a lista ordenada entra junta: mudar quem participa muda o hash, e é
 * assim que a alteração chega ao Google como qualquer outro campo.
 */
export function hashDosConvidados(emails: readonly (string | null | undefined)[]): string {
  return hash(
    emails
      .map((e) => e?.trim().toLowerCase() ?? "")
      .filter(Boolean)
      .sort()
      .join(","),
  );
}

const emailsDosConvidadosDaEquipe = (
  a: AgendamentoParaGoogle,
): string[] => (a.convidados_da_equipe ?? []).map((g) => g.email).filter(Boolean);

export function localProjection(
  a: AgendamentoParaGoogle & { guest_email?: string | null },
): Projection {
  const body = paraEventoDoGoogle(a);
  return {
    shared: {
      starts_at: body.start.dateTime,
      ends_at: body.end.dateTime,
      time_zone: body.start.timeZone,
      cancelled: a.status === "cancelled",
    },
    outbound: {
      title: hash(body.summary),
      description: hash(body.description),
      location: hash(body.location),
      guest: hashDosConvidados([a.guest_email, ...emailsDosConvidadosDaEquipe(a)]),
    },
  };
}
export function remoteProjection(
  e: EventoDoGoogle,
  local: Projection,
  base: Base | null,
  /**
   * Os e-mails que gerenciamos, quando o chamador os conhece (#4006).
   *
   * Sem eles, um evento com DOIS convidados nossos não teria como saber quais
   * `attendees` são nossos — o checkpoint guarda o hash da lista inteira, não
   * e-mail por e-mail. O caminho sem a lista continua valendo para os casos de
   * zero/um convidado, que é todo checkpoint antigo.
   */
  gerenciados?: readonly (string | null | undefined)[] | null,
): Projection {
  const read = doEventoDoGoogle(e, { fusoDoCalendario: local.shared.time_zone });
  if (read.tipo === "recusado") throw new Error(read.motivo);
  const lista = new Set((gerenciados ?? []).map((x) => x?.trim().toLowerCase() ?? "").filter(Boolean));
  const managed = new Set(
    [local.outbound.guest, base?.remote.guest, base?.local.guest].filter(Boolean),
  );
  const guests = (e.attendees ?? []).filter((p) => {
    if (p.organizer) return false;
    const email = p.email?.trim().toLowerCase() ?? "";
    if (!email) return false;
    // SOMA, nunca troca: o hash do checkpoint é o que reconhece o convidado
    // ÚNICO de uma escrita histórica (B aceito com CAS perdido, e a lista atual
    // já em C) e o convidado de antes que precisa sair. Trocar pela lista atual
    // cegava essas duas leituras (invariante I2 de agenda-google-recovery).
    return lista.has(email) || managed.has(hash(email));
  });
  return {
    shared:
      read.tipo === "cancelado"
        ? { ...local.shared, cancelled: true }
        : {
            starts_at: read.evento.starts_at,
            ends_at: read.evento.ends_at,
            time_zone: e.start?.timeZone || local.shared.time_zone,
            cancelled: false,
          },
    outbound: {
      title: hash(e.summary),
      description: hash(e.description),
      location: hash(e.location),
      guest: hashDosConvidados(guests.map((p) => p.email)),
    },
  };
}
export type Comparison = {
  kind: "accept_remote" | "publish" | "converged" | "conflict";
  shared: boolean;
  groups: Group[];
  reason?: "legacy" | "shared" | "outbound";
};
export function compare(base: Base | null, local: Projection, remote: Projection): Comparison {
  if (!base)
    return sameShared(local.shared, remote.shared) &&
      groups.every((g) => local.outbound[g] === remote.outbound[g])
      ? { kind: "converged", shared: true, groups: [...groups] }
      : {
          kind: "conflict",
          shared: false,
          groups: groups.filter((g) => local.outbound[g] !== remote.outbound[g]),
          reason: "legacy",
        };
  const lc = !sameShared(base.shared, local.shared),
    rc = !sameShared(base.shared, remote.shared);
  if (lc && rc && !sameShared(local.shared, remote.shared))
    return { kind: "conflict", shared: true, groups: [], reason: "shared" };
  const dirty = groups.filter((g) => base.local[g] !== local.outbound[g]);
  const conflicting = dirty.filter(
    (g) => remote.outbound[g] !== base.remote[g] && remote.outbound[g] !== local.outbound[g],
  );
  if (conflicting.length)
    return { kind: "conflict", shared: lc || rc, groups: conflicting, reason: "outbound" };
  if (rc && !lc) return { kind: "accept_remote", shared: true, groups: [] };
  const send = dirty.filter((g) => local.outbound[g] !== remote.outbound[g]);
  return {
    kind: (lc && !sameShared(local.shared, remote.shared)) || send.length ? "publish" : "converged",
    shared: lc || rc,
    groups: dirty,
  };
}
/**
 * O convite do Google para o e-mail da FICHA vai junto de uma ALTERAÇÃO, nunca
 * sozinho.
 *
 * O e-mail da ficha não entra no stamp (`fn_google_projection_stamp` só vê
 * `guest_email`), então `compare` não enxerga quando ele falta no evento. A
 * primeira versão deste PR forçava o grupo `guest` também no `converged` — e
 * `sendUpdates=all` transformava isso em convite: na 1ª sincronização depois
 * da atualização, TODO compromisso futuro já publicado com e-mail na ficha
 * mandava e-mail real ao cliente, de uma vez, sem o dono da empresa ter pedido.
 *
 * Decisão do dono (doc 36, opção b): o convite vale só para compromisso
 * criado ou alterado DEPOIS da atualização. Criado sai pelo POST, que já leva
 * os participantes. Alterado é `publish` — há um grupo local sujo indo para o
 * Google de qualquer jeito, e o e-mail da ficha vai junto. `converged`, que é
 * o compromisso antigo que ninguém tocou, fica como está.
 */
export function comConviteDaFicha(
  decision: Comparison,
  ficha: { temEmail: boolean; eventoJaTemOEmail: boolean; cancelado: boolean },
): Comparison {
  if (decision.kind !== "publish") return decision;
  if (!ficha.temEmail || ficha.eventoJaTemOEmail || ficha.cancelado) return decision;
  if (decision.groups.includes("guest")) return decision;
  return { ...decision, groups: [...decision.groups, "guest"] };
}
export function checkpoint(
  base: Base | null,
  local: Projection,
  remote: Projection,
  changed: readonly Group[],
  shared: boolean,
): Base {
  const next: Base = base
    ? structuredClone(base)
    : { shared: remote.shared, local: { ...local.outbound }, remote: { ...remote.outbound } };
  if (shared) next.shared = remote.shared;
  for (const g of changed) {
    next.local[g] = local.outbound[g];
    next.remote[g] = remote.outbound[g];
  }
  return next;
}
/** Só grupos locais dirty entram no PATCH; RSVP e participantes externos sobrevivem. */
export function delta(
  a: AgendamentoParaGoogle & {
    guest_email?: string | null;
    contact_email?: string | null;
    contact_nome?: string | null;
  },
  e: EventoDoGoogle,
  base: Base | null,
  changed: readonly Group[],
  shared: boolean,
  /**
   * Os e-mails de quem ERA convidado da equipe e deixou de ser (#4006).
   *
   * O checkpoint guarda o hash da lista, não os endereços, então a única forma
   * de DESconvidar alguém é o chamador dizer quem saiu — e ele sabe: o evento
   * carrega os ids publicados em `deskcomm_guests` (`propriedadesPrivadas`).
   */
  opcoes?: { convidadosAnteriores?: readonly (string | null | undefined)[] | null },
): Record<string, unknown> {
  const body = paraEventoDoGoogle(a);
  const patch: Record<string, unknown> = {};
  if (shared) {
    patch.start = body.start;
    patch.end = body.end;
  }
  for (const g of changed) {
    if (g === "title") patch.summary = body.summary;
    if (g === "description") patch.description = body.description ?? "";
    if (g === "location") patch.location = body.location ?? "";
    if (g === "guest") {
      const baixo = (x: string | null | undefined) => x?.trim().toLowerCase() ?? "";
      const desejados = participantesDoAgendamento({
        contactEmail: a.contact_email,
        contactName: a.contact_nome,
        guestEmail: a.guest_email,
        teamGuests: a.convidados_da_equipe,
      });
      const querem = new Set(desejados.map((p) => baixo(p.email)));
      const saiu = new Set((opcoes?.convidadosAnteriores ?? []).map(baixo).filter(Boolean));
      const existentes = e.attendees ?? [];
      /**
       * ⚠️ Quem fica, fica COM o `responseStatus` que está lá.
       *
       * Reenviar todo mundo como `needsAction` apagaria o "aceito" de quem já
       * respondeu, e o convite voltaria a pedir resposta a cada edição. Quem
       * sai é só: (a) o convidado da equipe que foi tirado da lista, e (b) o
       * convidado único de antes (`guest_email`), que o checkpoint sabe
       * reconhecer pelo hash. Convidado posto direto no Google por uma pessoa
       * não é nosso e sobrevive — é a mesma regra de sempre.
       */
      const mantidos = existentes.filter((p) => {
        const email = baixo(p.email);
        if (p.organizer) return true;
        if (!email) return false;
        if (querem.has(email)) return true;
        if (saiu.has(email)) return false;
        if (base?.remote.guest && hash(email) === base.remote.guest) return false;
        return true;
      });
      const final = [...mantidos];
      for (const convidado of desejados) {
        if (final.some((p) => baixo(p.email) === baixo(convidado.email))) continue;
        const entrada: {
          email: string;
          responseStatus: "needsAction";
          displayName?: string;
        } = { email: convidado.email, responseStatus: "needsAction" };
        if (convidado.nome?.trim()) entrada.displayName = convidado.nome.trim();
        final.push(entrada);
      }
      patch.attendees = final;
      /**
       * Os ids publicados são o que torna a remoção possível na próxima
       * passada. Vão junto do PATCH que mexe em convidado, com as MESMAS chaves
       * do POST (sem elas o evento deixaria de ser reconhecido) — e SÓ quando
       * há lista nossa para registrar ou para apagar.
       *
       * Compromisso sem equipe continua com o PATCH de antes, byte por byte:
       * mandar `extendedProperties` em toda edição de convidado só aumentaria
       * a chance de conflito com quem edita o evento no Google.
       */
      const tinhaListaPublicada = Boolean(
        e.extendedProperties?.private?.[`${PREFIXO_PROPRIEDADE}_guests`],
      );
      if (a.convidados_equipe_ids?.length || tinhaListaPublicada) {
        const privadas: Record<string, string | null> = propriedadesPrivadas(a);
        // Chave privada com valor `null` é como o Google APAGA a propriedade:
        // sem isto, os ids de quem já saiu ficariam no evento para sempre e a
        // próxima passada tentaria desconvidar gente que não está mais lá.
        if (!a.convidados_equipe_ids?.length) {
          privadas[`${PREFIXO_PROPRIEDADE}_guests`] = null;
        }
        patch.extendedProperties = { private: privadas };
      }
    }
  }
  return patch;
}
