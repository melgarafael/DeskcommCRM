/**
 * A HORA DE CADA FALA CONGELADA NO CASO HUMANO.
 *
 * Defeito medido em `origin/main`: o turno congelava as cinco últimas mensagens
 * em `agent_cases.context_snapshot` SEM o carimbo delas
 * (`{direction, body}`), e `falasDoSnapshot` — que decide a hora por
 * `typeof r.sent_at === "string"` — caía SEMPRE no `abertoEm`. Resultado: a tela
 * do caso e o prompt do atendente mostravam cinco mensagens trocadas ao longo de
 * horas com o MESMO horário, o da abertura do caso. Nada quebrava, nada logava:
 * a régua respondia o default em silêncio, que é exatamente o modo de falha do
 * #3846 (a guarda lê uma data e decide por tipo).
 *
 * Este arquivo prende as duas pontas no MESMO teste, porque o defeito morava no
 * vão entre elas:
 *
 *   1. a ESCRITA (`snapshotDoCaso`, o que o turno grava) carrega `sent_at`;
 *   2. a LEITURA (`falasDoSnapshot`) devolve a hora da fala — e não o `abertoEm`;
 *   3. e aceita as DUAS formas do carimbo: string (o `jsonb` que o app grava) e
 *      `Date` (a forma que o driver `pg` entrega quando o valor vem de coluna).
 *
 * O caso (3) é o contrato que faltava: com `typeof === "string"` puro, um `Date`
 * virava `abertoEm` — a mesma substituição silenciosa, agora invisível.
 */
import { describe, expect, it } from "vitest";

import {
  snapshotDoCaso,
  type FalaDaConversa,
} from "@/lib/agent-engine/agent/conversa-do-caso/contexto";
import { falasDoSnapshot } from "@/lib/agent-engine/agent/conversa-do-caso/leitura";

const ABERTO_EM = "2026-11-04T12:00:00.000Z";

/** O histórico como o turno o recebe (`LeadContextMessage`): ISO com offset. */
const HISTORICO = [
  { direction: "inbound", body: "oi, bom dia", sent_at: "2026-11-04T09:10:00-03:00" },
  { direction: "outbound", body: "bom dia! como posso ajudar?", sent_at: "2026-11-04T09:11:30-03:00" },
  { direction: "inbound", body: "quero remarcar", sent_at: "2026-11-04T10:42:00-03:00" },
];

function quando(falas: FalaDaConversa[]): string[] {
  return falas.map((f) => f.quando);
}

describe("as falas congeladas no caso humano carregam a hora de cada fala", () => {
  it("a ESCRITA grava o carimbo de cada mensagem, não só o texto", () => {
    const snapshot = snapshotDoCaso("Ana", HISTORICO);
    const falas = snapshot.last_messages as Array<Record<string, unknown>>;
    expect(falas.map((f) => f.sent_at)).toEqual(HISTORICO.map((m) => m.sent_at));
  });

  it("ida e volta: o que o turno grava é o que a tela mostra", () => {
    const snapshot = snapshotDoCaso("Ana", HISTORICO);
    expect(quando(falasDoSnapshot(snapshot, ABERTO_EM))).toEqual([
      "2026-11-04T12:10:00.000Z",
      "2026-11-04T12:11:30.000Z",
      "2026-11-04T13:42:00.000Z",
    ]);
  });

  it("a LEITURA aceita a forma do driver (`Date`), não só a do jsonb (string)", () => {
    const snapshot = {
      last_messages: [
        {
          direction: "inbound",
          body: "oi",
          // O que uma coluna `timestamptz` entrega pelo pool `pg`.
          sent_at: new Date("2026-11-04T09:10:00-03:00"),
        },
      ],
    };
    expect(quando(falasDoSnapshot(snapshot, ABERTO_EM))).toEqual(["2026-11-04T12:10:00.000Z"]);
  });

  it("snapshot ANTIGO (sem carimbo) e hora ilegível caem no `abertoEm`, nunca em `NaN`", () => {
    expect(
      quando(falasDoSnapshot({ last_messages: [{ direction: "inbound", body: "oi" }] }, ABERTO_EM)),
    ).toEqual([ABERTO_EM]);
    expect(
      quando(
        falasDoSnapshot(
          { last_messages: [{ direction: "inbound", body: "oi", sent_at: "nem data" }] },
          ABERTO_EM,
        ),
      ),
    ).toEqual([ABERTO_EM]);
  });
});
