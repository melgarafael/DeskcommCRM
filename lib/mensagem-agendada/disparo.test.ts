import { describe, expect, it } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";

import {
  createScheduledMessageHandler,
  type PacoteDb,
  type PacoteDoDisparo,
  type ParteDoDisparo,
} from "./disparo";
import type { FatosDoDisparo } from "./regras";

/**
 * O CONTRATO DO DISPARO, medido com dublês explícitos.
 *
 * Cada caso é uma das três invariantes do handler, e nenhum deles fala com
 * Postgres nem com canal: o banco entra por `PacoteDb` e o envio por
 * `enviarParte`. O que se mede é EFEITO — quantas partes saíram, com qual
 * `internal_message_id`, e em que estado o pacote fechou.
 */

const ORG = "org-1";

function parte(over: Partial<ParteDoDisparo> & Pick<ParteDoDisparo, "position">): ParteDoDisparo {
  return {
    id: `parte-${over.position}`,
    body: `texto ${over.position}`,
    media_storage_path: null,
    media_mime: null,
    media_size_bytes: null,
    status: "pending",
    internal_message_id: `interna-${over.position}`,
    message_id: null,
    ...over,
  };
}

function pacote(over: Partial<PacoteDoDisparo> = {}): PacoteDoDisparo {
  return {
    id: "pacote-1",
    conversation_id: "conv-1",
    contact_id: "contato-1",
    channel_session_id: "sessao-1",
    created_by: "user-1",
    cancel_if_contact_replies: false,
    attempts: 0,
    parts: [parte({ position: 0 })],
    ...over,
  };
}

function fatos(over: Partial<FatosDoDisparo> = {}): FatosDoDisparo {
  return {
    organizacaoOperante: true,
    contatoBloqueado: false,
    contatoAnonimizado: false,
    canalArquivado: false,
    sessaoEmDia: true,
    contatoRespondeu: false,
    janelaReabreEm: null,
    ...over,
  };
}

interface Mundo {
  db: PacoteDb;
  /** O pacote de verdade — o dublê muta o estado dele, como o banco faria. */
  pacote: PacoteDoDisparo;
  /** Partes enviadas, na ordem em que o handler chamou. */
  enviadas: string[];
  avisos: Array<{ titulo: string; corpo: string }>;
  reservas: number;
  fechamentos: Array<{ status: string; motivo: string | null }>;
  cancelamentos: string[];
  reagendamentos: Array<{ quando: Date; tentativas: number }>;
  cronsDesligados: number;
  falhaNaPosicao?: number;
  erroNaPosicao?: number;
}

function mundo(opts: {
  pacote: PacoteDoDisparo;
  fatos?: FatosDoDisparo;
  reserva?: boolean;
  falhaNaPosicao?: number;
  erroNaPosicao?: number;
}): Mundo {
  const estado = {
    enviadas: [] as string[],
    avisos: [] as Array<{ titulo: string; corpo: string }>,
    reservas: 0,
    fechamentos: [] as Array<{ status: string; motivo: string | null }>,
    cancelamentos: [] as string[],
    reagendamentos: [] as Array<{ quando: Date; tentativas: number }>,
    cronsDesligados: 0,
  };

  const db: PacoteDb = {
    async reserva() {
      estado.reservas += 1;
      return opts.reserva ?? true;
    },
    async carrega() {
      return opts.pacote;
    },
    async fatos() {
      return opts.fatos ?? fatos();
    },
    async marcaParteEnviada({ parteId }) {
      const alvo = opts.pacote.parts.find((p) => p.id === parteId);
      if (alvo) alvo.status = "sent";
    },
    async marcaParteFalha({ parteId }) {
      const alvo = opts.pacote.parts.find((p) => p.id === parteId);
      if (alvo) alvo.status = "failed";
    },
    async marcaPartePulada({ parteId }) {
      const alvo = opts.pacote.parts.find((p) => p.id === parteId);
      if (alvo) alvo.status = "skipped";
    },
    async fechaPacote({ status, motivo }) {
      estado.fechamentos.push({ status, motivo });
    },
    async cancelaPacote({ motivo }) {
      estado.cancelamentos.push(motivo);
    },
    async devolveParaAgenda({ quando, tentativas }) {
      estado.reagendamentos.push({ quando, tentativas });
    },
    async desligaCronDoPacote() {
      estado.cronsDesligados += 1;
    },
    async avisaNaCentral({ titulo, corpo }) {
      estado.avisos.push({ titulo, corpo });
    },
  };

  // Getters, e não espalhamento: número copiado no spread fica congelado no 0
  // e o teste mediria o valor de ANTES do handler rodar.
  return {
    db,
    pacote: opts.pacote,
    get enviadas() {
      return estado.enviadas;
    },
    get avisos() {
      return estado.avisos;
    },
    get reservas() {
      return estado.reservas;
    },
    get fechamentos() {
      return estado.fechamentos;
    },
    get cancelamentos() {
      return estado.cancelamentos;
    },
    get reagendamentos() {
      return estado.reagendamentos;
    },
    get cronsDesligados() {
      return estado.cronsDesligados;
    },
    get falhaNaPosicao() {
      return opts.falhaNaPosicao;
    },
    get erroNaPosicao() {
      return opts.erroNaPosicao;
    },
  };
}

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: "contato-1",
    kind: "scheduled_message",
    source_event_id: null,
    payload: { scheduled_message_id: "pacote-1" },
    status: "running",
    priority: 0,
    run_after: new Date(),
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    locked_by: "worker-1",
    locked_at: new Date(),
    created_at: new Date(),
    ...over,
  } as JobRow;
}

function rodar(
  cenario: Mundo,
  deps: {
    falhaNaPosicao?: number;
    erroNaPosicao?: number;
    janela?: string | null;
  } = {},
) {
  // O MESMO array que o dublê expõe por getter: empurrar aqui é o que o teste lê.
  const enviadas: string[] = cenario.enviadas;
  const enviarParte = async ({ parte }: { parte: ParteDoDisparo }) => {
    if (cenario.falhaNaPosicao === parte.position || deps.falhaNaPosicao === parte.position) {
      return { ok: false, motivo: "channel_disabled" };
    }
    if (cenario.erroNaPosicao === parte.position || deps.erroNaPosicao === parte.position) {
      throw new Error("canal fora do ar");
    }
    enviadas.push(parte.internal_message_id);
    return { ok: true, messageId: `msg-${parte.position}` };
  };
  const handler = createScheduledMessageHandler(
    {
      log: { info: () => {}, warn: () => {}, error: () => {} },
      enviarParte: enviarParte as never,
      dormir: async () => {},
      agora: () => new Date("2026-10-26T12:00:00.000Z"),
      janelaReabreEm: async () => (deps.janela === undefined ? null : deps.janela),
      db: cenario.db,
    },
    () => cenario.db,
  );
  return handler(job(), {} as never);
}

describe("disparo da mensagem agendada", () => {
  it("manda as partes na ordem, e o pacote fecha em sent", async () => {
    const c = mundo({
      pacote: pacote({
        parts: [parte({ position: 0 }), parte({ position: 1 }), parte({ position: 2 })],
      }),
    });
    await rodar(c);

    expect(c.enviadas).toEqual(["interna-0", "interna-1", "interna-2"]);
    expect(c.fechamentos).toEqual([{ status: "sent", motivo: null }]);
    expect(c.avisos).toEqual([]);
  });

  it("NÃO reenvia a parte que já saiu (o internal_message_id é a chave)", async () => {
    const c = mundo({
      pacote: pacote({
        parts: [parte({ position: 0, status: "sent", message_id: "msg-ja" }), parte({ position: 1 })],
      }),
    });
    await rodar(c);

    expect(c.enviadas).toEqual(["interna-1"]);
    expect(c.fechamentos).toEqual([{ status: "sent", motivo: null }]);
  });

  it("sem reserva (já foi ou foi cancelado): não envia nada", async () => {
    const c = mundo({ pacote: pacote(), reserva: false });
    await rodar(c);

    expect(c.enviadas).toEqual([]);
    expect(c.fechamentos).toEqual([]);
    expect(c.avisos).toEqual([]);
  });

  it("para na parte que falhou: as seguintes viram skipped, o pacote fica partial e há aviso", async () => {
    const c = mundo({
      pacote: pacote({
        parts: [parte({ position: 0 }), parte({ position: 1 }), parte({ position: 2 })],
      }),
      falhaNaPosicao: 1,
    });
    await rodar(c);

    expect(c.enviadas).toEqual(["interna-0"]);
    expect(c.fechamentos).toEqual([{ status: "partial", motivo: "channel_disabled" }]);
    expect(c.avisos).toHaveLength(1);
    expect(c.avisos[0]?.titulo).toContain("metade");
    expect(c.pacote.parts.map((p) => p.status)).toEqual(["sent", "failed", "skipped"]);
  });

  it("exceção do canal conta como falha da parte, com motivo — e não derruba o job", async () => {
    const c = mundo({
      pacote: pacote({ parts: [parte({ position: 0 }), parte({ position: 1 })] }),
      erroNaPosicao: 0,
    });
    await rodar(c);

    expect(c.enviadas).toEqual([]);
    expect(c.fechamentos).toEqual([{ status: "failed", motivo: "canal fora do ar" }]);
    expect(c.avisos).toHaveLength(1);
  });

  it("primeira parte falha: pacote failed (nada saiu)", async () => {
    const c = mundo({
      pacote: pacote({ parts: [parte({ position: 0 }), parte({ position: 1 })] }),
      falhaNaPosicao: 0,
    });
    await rodar(c);

    expect(c.fechamentos).toEqual([{ status: "failed", motivo: "channel_disabled" }]);
    expect(c.pacote.parts.map((p) => p.status)).toEqual(["failed", "skipped"]);
  });

  it("opt-out do contato cancela o pacote, com motivo — não falha", async () => {
    const c = mundo({ pacote: pacote(), fatos: fatos({ contatoBloqueado: true }) });
    await rodar(c);

    expect(c.cancelamentos).toEqual(["Contato pediu para parar (opt-out)"]);
    expect(c.enviadas).toEqual([]);
    expect(c.fechamentos).toEqual([]);
  });

  it("cancel_if_contact_replies + resposta do contato cancela", async () => {
    const c = mundo({
      pacote: pacote({ cancel_if_contact_replies: true }),
      fatos: fatos({ contatoRespondeu: true }),
    });
    await rodar(c);

    expect(c.cancelamentos).toEqual(["contato_respondeu"]);
    expect(c.enviadas).toEqual([]);
  });

  it("resposta do contato SEM a marca não cancela", async () => {
    const c = mundo({ pacote: pacote(), fatos: fatos({ contatoRespondeu: true }) });
    await rodar(c);

    expect(c.cancelamentos).toEqual([]);
    expect(c.enviadas).toEqual(["interna-0"]);
  });

  it("sessão fora de WORKING reagenda (não vira failed nem some em queued)", async () => {
    const c = mundo({ pacote: pacote({ attempts: 0 }), fatos: fatos({ sessaoEmDia: false }) });
    await rodar(c);

    expect(c.enviadas).toEqual([]);
    expect(c.fechamentos).toEqual([]);
    expect(c.reagendamentos).toHaveLength(1);
    expect(c.reagendamentos[0]?.tentativas).toBe(1);
    expect(c.reagendamentos[0]?.quando.toISOString()).toBe("2026-10-26T12:01:00.000Z");
  });

  it("fora da janela do número reagenda para a abertura", async () => {
    const c = mundo({ pacote: pacote() });
    await rodar(c, { janela: "2026-10-27T11:00:00.000Z" });

    expect(c.enviadas).toEqual([]);
    expect(c.reagendamentos).toHaveLength(1);
    expect(c.reagendamentos[0]?.quando.toISOString()).toBe("2026-10-27T11:00:00.000Z");
  });

  it("tentativas esgotadas: failed com aviso, e o cron não fica armado", async () => {
    const c = mundo({ pacote: pacote({ attempts: 5 }), fatos: fatos({ sessaoEmDia: false }) });
    await rodar(c);

    expect(c.reagendamentos).toEqual([]);
    expect(c.fechamentos).toEqual([{ status: "failed", motivo: "tentativas_esgotadas" }]);
    expect(c.avisos).toHaveLength(1);
    expect(c.cronsDesligados).toBe(1);
  });

  it("organização parada falha sem tentar enviar", async () => {
    const c = mundo({ pacote: pacote(), fatos: fatos({ organizacaoOperante: false }) });
    await rodar(c);

    expect(c.enviadas).toEqual([]);
    expect(c.fechamentos).toEqual([{ status: "failed", motivo: "org_nao_operante" }]);
  });

  it("canal arquivado falha (não cancela: o pacote não tem culpa)", async () => {
    const c = mundo({ pacote: pacote(), fatos: fatos({ canalArquivado: true }) });
    await rodar(c);

    expect(c.fechamentos).toEqual([{ status: "failed", motivo: "canal_arquivado" }]);
  });
});
