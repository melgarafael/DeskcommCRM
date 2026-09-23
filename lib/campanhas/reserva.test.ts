/**
 * A RESERVA NÃO MENTE — e este arquivo existe porque ela mentiu.
 *
 * ## O que aconteceu, medido em produção em 19/09/2026
 *
 * A reserva do destinatário (`pending` → `sending`) lia só o `data` do update e
 * ignorava o `error`. Quando o update falhou de verdade — violação da FK de
 * `message_id`, que o desenho original gravava ANTES de a mensagem existir —, o
 * resultado foi "zero linhas afetadas", que o chamador lia como "outro worker
 * ganhou a corrida".
 *
 * O que se via: campanha `running` para sempre, destinatário `pending` com zero
 * tentativas, e o cron respondendo `ja_reservado` a cada minuto. Nenhum erro em
 * lugar nenhum. Um erro disfarçado de concorrência é a pior espécie — ele
 * descreve um sistema saudável, e ninguém vai procurar defeito onde o relatório
 * diz que está tudo certo.
 */
import { describe, expect, it, vi } from "vitest";

import { reservarDestinatario } from "./rodada";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** Supabase falso: devolve o desfecho que o teste mandar para o `update`. */
function fakeAdmin(desfecho: { data?: unknown[] | null; error?: { message: string } | null }) {
  const b: Record<string, unknown> = {
    update: () => b,
    eq: () => b,
    select: async () => ({ data: desfecho.data ?? null, error: desfecho.error ?? null }),
  };
  return { from: () => b } as never;
}

const AGORA = new Date("2026-09-19T12:00:00.000Z");

describe("reserva do destinatário", () => {
  it("uma linha afetada é reserva feita", async () => {
    const r = await reservarDestinatario(fakeAdmin({ data: [{ id: "r1" }] }), "r1", AGORA);
    expect(r).toEqual({ reservado: true });
  });

  it("zero linhas SEM erro é concorrência: outro worker ganhou", async () => {
    const r = await reservarDestinatario(fakeAdmin({ data: [] }), "r1", AGORA);
    expect(r).toEqual({ reservado: false });
    expect(r.erro).toBeUndefined();
  });

  it("ERRO do banco não vira concorrência — devolve o texto real", async () => {
    // É o caso que custou a descoberta: a FK de `message_id` recusando um id de
    // mensagem que ainda não existia.
    const r = await reservarDestinatario(
      fakeAdmin({
        error: {
          message:
            'insert or update on table "campaign_recipients" violates foreign key constraint "campaign_recipients_message_id_fkey"',
        },
      }),
      "r1",
      AGORA,
    );
    expect(r.reservado).toBe(false);
    expect(r.erro).toContain("foreign key constraint");
  });

  it("CONTROLE: os dois desfechos de recusa são distinguíveis", async () => {
    // Se um dia alguém voltar a colapsar os dois num `false` só, este caso fica
    // vermelho — que é a única coisa que impede o defeito de voltar calado.
    const concorrencia = await reservarDestinatario(fakeAdmin({ data: [] }), "r1", AGORA);
    const falha = await reservarDestinatario(fakeAdmin({ error: { message: "boom" } }), "r1", AGORA);
    expect(concorrencia.erro).toBeUndefined();
    expect(falha.erro).toBe("boom");
  });
});
