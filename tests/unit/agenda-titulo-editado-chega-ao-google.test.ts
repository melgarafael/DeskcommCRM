import { describe, expect, it } from "vitest";

import type { AgendamentoParaGoogle } from "@/lib/agenda/google/evento";
import {
  checkpoint,
  compare,
  delta,
  hash,
  localProjection,
  remoteProjection,
} from "@/lib/agenda/google/sync-model";

/**
 * O TÍTULO EDITADO AQUI CHEGA AO GOOGLE — e não é revertido na sincronização
 * seguinte (#3776).
 *
 * ─── O risco que este arquivo prende ───────────────────────────────────────
 *
 * `title` é um dos quatro grupos de hash do sincronizador
 * (`lib/agenda/google/sync-model.ts`). Se a edição não mexesse no hash, o
 * evento remoto seguiria com o nome antigo e a reconciliação classificaria o
 * compromisso como `converged` — a edição local sumiria sem erro nenhum, e o
 * usuário veria o título "voltar sozinho". O outro extremo também é ruim: sem
 * o `delta` do grupo `title`, a decisão diria `publish` e o PATCH sairia sem
 * `summary`, escrevendo um ACK que não muda o evento.
 *
 * ─── Por que ele mora no unit e não no invariant ───────────────────────────
 *
 * A projeção é TypeScript puro: `fn_google_projection_stamp` (baseline) já põe
 * `new.title` na lista do que marca `google_local_revision`, e isso é medido no
 * case de banco (`tests/invariants/titulo-do-compromisso-edicao.test.ts`). Aqui
 * se mede a metade de cá — a que transforma a linha em hash, compara e monta o
 * PATCH.
 */

const AGENDAMENTO: AgendamentoParaGoogle & { guest_email: string | null } = {
  id: "a1",
  organization_id: "o1",
  title: "Avaliação inicial",
  starts_at: "2026-11-02T15:00:00Z",
  ends_at: "2026-11-02T16:00:00Z",
  time_zone: "America/Sao_Paulo",
  status: "confirmed",
  location_kind: "in_person",
  guest_email: null,
};

/** O evento remoto como o Google o devolve — mesma projeção da linha acima. */
const eventoRemoto = {
  id: "remote-1",
  summary: AGENDAMENTO.title,
  start: { dateTime: AGENDAMENTO.starts_at, timeZone: AGENDAMENTO.time_zone },
  end: { dateTime: AGENDAMENTO.ends_at },
};

/** O checkpoint de uma sincronização anterior, já convergida nos quatro grupos. */
const localInicial = localProjection(AGENDAMENTO);
const remotoInicial = remoteProjection(eventoRemoto, localInicial, null);
const base = checkpoint(null, localInicial, remotoInicial, ["title", "description", "location", "guest"], true);

describe("título editado no CRM vira `publish` do grupo `title` (#3776)", () => {
  it("o hash do título muda quando o título muda — e o checkpoint guarda o ANTIGO", () => {
    const editado = localProjection({ ...AGENDAMENTO, title: "Consulta de retorno" });

    expect(editado.outbound.title).toBe(hash("Consulta de retorno"));
    expect(editado.outbound.title).not.toBe(base.local.title);
    // O checkpoint é hash, não texto: o nome do compromisso não vaza para lá.
    expect(JSON.stringify(base)).not.toContain("Avaliação inicial");
  });

  it("a reconciliação diz `publish` com o grupo `title` sujo", () => {
    const editado = localProjection({ ...AGENDAMENTO, title: "Consulta de retorno" });
    // O remoto não mudou: ele continua com o nome antigo.
    const remoto = remoteProjection(eventoRemoto, editado, base);

    const decisao = compare(base, editado, remoto);

    expect(decisao.kind).toBe("publish");
    expect(decisao.groups).toContain("title");
  });

  it("o PATCH que vai ao Google leva o `summary` NOVO — não um ACK vazio", () => {
    const editado = localProjection({ ...AGENDAMENTO, title: "Consulta de retorno" });
    const remoto = remoteProjection(eventoRemoto, editado, base);
    const decisao = compare(base, editado, remoto);

    const patch = delta(
      { ...AGENDAMENTO, title: "Consulta de retorno" },
      eventoRemoto,
      base,
      decisao.groups,
      decisao.shared,
    );

    expect(patch.summary).toBe("Consulta de retorno");
  });

  it("título igual ao da última sincronização não gera escrita", () => {
    const remoto = remoteProjection(eventoRemoto, localInicial, base);

    expect(compare(base, localInicial, remoto).kind).toBe("converged");
  });
});
