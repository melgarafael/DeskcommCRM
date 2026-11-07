/** Contrato central de reconciliação. Checkpoints outbound guardam hashes, não PII. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  doEventoDoGoogle,
  paraEventoDoGoogle,
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
 * O hash do grupo `guest`: TODOS os e-mails gerenciados por nós, ordenados.
 *
 * O grupo tem mais de um dono desde o #4006 — o e-mail da ficha, o "e-mail do
 * convidado" e cada pessoa da equipe. Ordenar antes de juntar é o que faz
 * "A, B" e "B, A" serem o MESMO estado; sem isso, reordenar a lista na tela
 * viraria um PATCH `sendUpdates=all` para o cliente.
 *
 * Para um e-mail só o resultado é idêntico ao de antes (`hash(email)`): o
 * `guest_email` já era normalizado antes de entrar no hash.
 */
export const hashDosConvidados = (emails: readonly (string | null | undefined)[]) =>
  hash(
    emails
      .map((e) => e?.trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join(","),
);

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
      // #4006: os convidados da equipe entram no MESMO grupo do convidado
      // digitado. É por aqui que "convidar mais alguém na tela" vira publish.
      guest: hashDosConvidados([a.guest_email, ...(a.convidados_da_equipe ?? [])]),
    },
  };
}
export function remoteProjection(
  e: EventoDoGoogle,
  local: Projection,
  base: Base | null,
  /**
   * Os e-mails que NÓS gerenciamos neste compromisso (#4006): ficha, convidado
   * digitado e convidados da equipe. Quando vem, o filtro é por e-mail — é a
   * única forma de reconhecer VÁRIOS convidados, porque `base` guarda hash do
   * conjunto, não a lista. O hash resultante tem de ser o mesmo de
   * `hashDosConvidados` sobre esses e-mails.
   *
   * Sem o parâmetro o comportamento é o de sempre (hash a hash) — é o que
   * mantém os testes e os compromissos de um convidado idênticos.
   */
  gerenciados?: readonly (string | null | undefined)[],
): Projection {
  const read = doEventoDoGoogle(e, { fusoDoCalendario: local.shared.time_zone });
  if (read.tipo === "recusado") throw new Error(read.motivo);
  const porEmail = new Set(
    (gerenciados ?? []).map((x) => x?.trim().toLowerCase()).filter(Boolean) as string[],
  );
  const managed = new Set(
    [local.outbound.guest, base?.remote.guest, base?.local.guest].filter(Boolean),
  );
  const guests = (e.attendees ?? []).filter((p) => {
    const email = p.email?.trim().toLowerCase();
    if (!email || p.organizer) return false;
    return porEmail.size > 0 ? porEmail.has(email) : managed.has(hash(email));
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
    /** Todos os e-mails gerenciados, inclusive os que saíram do convite (#4006). */
    convidados_conhecidos?: readonly string[];
  },
  e: EventoDoGoogle,
  base: Base | null,
  changed: readonly Group[],
  shared: boolean,
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
      /**
       * O conjunto desejado — ficha, convidado digitado e EQUIPE (#4006), na
       * ordem em que a tela os mostra. Um e-mail repetido entra uma vez só: o
       * Google recusa o evento INTEIRO, não só o convidado.
       */
      const queridos: { email: string; nome?: string | null }[] = [];
      const juntar = (email: string | null | undefined, nome?: string | null) => {
        const limpo = email?.trim();
        if (!limpo) return;
        if (queridos.some((q) => q.email.toLowerCase() === limpo.toLowerCase())) return;
        queridos.push({ email: limpo, nome: nome ?? null });
      };
      juntar(a.guest_email);
      juntar(a.contact_email, a.contact_nome);
      for (const email of a.convidados_da_equipe ?? []) juntar(email);

      const quer = new Set(queridos.map((q) => q.email.toLowerCase()));
      // Os e-mails que JÁ gerenciamos, inclusive os que saíram do convite
      // (`removed_at`): são eles que podem ser REMOVIDOS do `attendees`. Sem
      // esta lista, tirar alguém na tela deixaria o convite vivo no Google.
      const conhecidos = new Set(
        (a.convidados_conhecidos ?? [])
          .map((x) => x?.trim().toLowerCase())
          .filter(Boolean) as string[],
      );
      const existing = e.attendees ?? [];
      const kept = existing.filter((p) => {
        if (p.organizer) return true;
        const email = p.email?.trim().toLowerCase() ?? "";
        if (!email) return true;
        if (quer.has(email)) return true;
        if (conhecidos.has(email)) return false;
        // Comportamento de sempre: o convidado digitado que saiu é removido.
        return hash(email) !== base?.remote.guest;
      });
      // O e-mail da ficha não entra no hash `guest` (stamp SQL só vê
      // `guest_email`). Sem este passo, um compromisso já publicado nunca
      // ganharia o lead como convidado. ponytail: troca de e-mail na ficha
      // depois da primeira ida não dispara push sozinha — o teto é o stamp;
      // upgrade é incluir o e-mail do contato em `fn_google_projection_stamp`.
      for (const convidado of queridos) {
        if (kept.some((p) => p.email?.trim().toLowerCase() === convidado.email.toLowerCase())) continue;
        const entrada: { email: string; responseStatus: "needsAction"; displayName?: string } = {
          email: convidado.email,
          responseStatus: "needsAction",
        };
        if (convidado.nome?.trim()) entrada.displayName = convidado.nome.trim();
        kept.push(entrada);
      }
      patch.attendees = kept;
    }
  }
  return patch;
}

/**
 * Quem o Google avisa por e-mail nesta escrita (#4006).
 *
 * `all` é o padrão do produto e continua sendo: convidar, remarcar, cancelar e
 * tirar convidado SÃO notícia para todo mundo. A exceção é o ajuste que só mexe
 * na DESCRIÇÃO — o bloco do negócio muda quando a etapa do funil muda, e um
 * `sendUpdates=all` ali mandaria e-mail a todo cliente com compromisso futuro
 * cada vez que alguém arrastasse um card.
 *
 * `none` só é seguro quando a mudança é SÓ a descrição: com `shared` (horário)
 * ou qualquer outro grupo no mesmo PATCH, o silêncio esconderia a mudança real.
 */
export function sendUpdatesDaEscrita(
  method: PendingWrite["method"],
  changed: readonly Group[],
  shared: boolean,
): "all" | "none" {
  if (method === "DELETE" || shared) return "all";
  if (changed.length > 0 && changed.every((g) => g === "description")) return "none";
  return "all";
}
