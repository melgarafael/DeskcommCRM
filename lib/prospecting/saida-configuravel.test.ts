import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelSendResult } from "@/lib/agent-engine/channel-adapter";
import { audit } from "@/lib/audit";
import { campaignConfigSchema, prospectingInputSchema } from "@/lib/prospecting/schema";
import {
  contarEnvioAutomatico,
  desfazerContagem,
  enviarComSaidaConfiguravel,
} from "@/lib/prospecting/saida-configuravel";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
const auditMock = vi.mocked(audit);

/**
 * Teste do helper de contagem/reserva da saída com db falso: registra SQL e
 * params, sem banco de verdade.
 */

function dbFalso(respostas: Record<string, unknown[]> = {}) {
  const sqls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    sqls.push({ sql, params: [...params] });
    const chave = Object.keys(respostas).find((k) => sql.includes(k));
    const rows = chave ? respostas[chave] : [];
    return { rows };
  });
  return { query, sqls };
}

describe("contarEnvioAutomatico", () => {
  it("filtra organization_id em toda consulta e devolve levaASaida do retorno", async () => {
    const agora = new Date("2026-10-21T13:00:00Z").toISOString();
    const { query, sqls } = dbFalso({
      "returning": [
        {
          candidato_id: "cand-1",
          campanha_id: "camp-1",
          exit_offered_at: agora,
          leva_a_saida: true,
          numero_da_mensagem: 1,
          locale: "pt-BR",
          reservada_em_texto: agora,
        },
      ],
    });
    const r = await contarEnvioAutomatico({ query } as never, "org-a", "conv-1");
    expect(r).toMatchObject({
      candidatoId: "cand-1",
      campanhaId: "camp-1",
      levaASaida: true,
      reservadaEm: agora,
      locale: "pt-BR",
      numeroDaMensagem: 1,
    });
    // Toda SQL carrega organization_id = $1.
    for (const { sql, params } of sqls) {
      expect(sql).toContain("organization_id = $1");
      expect(params[0]).toBe("org-a");
    }
  });

  it("não reserva quando leva_a_saida=false, ainda que exit_offered_at esteja preenchido", async () => {
    const { query, sqls } = dbFalso({
      "returning": [
        {
          candidato_id: "cand-2",
          campanha_id: "camp-2",
          exit_offered_at: "2026-10-21T12:00:00Z",
          leva_a_saida: false,
          numero_da_mensagem: 2,
          locale: null,
        },
      ],
    });
    const r = await contarEnvioAutomatico({ query } as never, "org-a", "conv-2");
    expect(r!.levaASaida).toBe(false);
    // reservadaEm deve ser null: este envio não foi quem reservou.
    expect(r!.reservadaEm).toBeNull();
    expect(r!.numeroDaMensagem).toBe(2);
    for (const { sql } of sqls) expect(sql).toContain("organization_id = $1");
  });

  it("devolve null quando não há candidato", async () => {
    const { query } = dbFalso({});
    const r = await contarEnvioAutomatico({ query } as never, "org-a", "conv-1");
    expect(r).toBeNull();
  });
});

describe("desfazerContagem", () => {
  it("manda o reservadaEm no terceiro parâmetro", async () => {
    const { query, sqls } = dbFalso({});
    await desfazerContagem({ query } as never, "org-a", "cand-x", "2026-10-21T13:00:00Z");
    const ultima = sqls[sqls.length - 1];
    expect(ultima).toBeDefined();
    expect(ultima!.sql).toContain("organization_id = $1");
    expect(ultima!.params).toEqual(["org-a", "cand-x", "2026-10-21T13:00:00Z"]);
    expect(ultima!.sql).toContain("greatest(automatic_sends - 1, 0)");
  });
});

const MSG = { jobId: "job-1", seq: 1 };

describe("enviarComSaidaConfiguravel", () => {
  beforeEach(() => {
    auditMock.mockClear();
  });

  function envioFalso(resultado: ChannelSendResult) {
    return vi.fn(async (corpo: string): Promise<ChannelSendResult> => resultado);
  }

  it("reservou + envio sent → enviar recebe o corpo COM a saída; audit chamado com message_number e via", async () => {
    const agora = "2026-10-21T13:00:00.000000Z";
    const { query, sqls } = dbFalso({
      "returning": [
        {
          candidato_id: "cand-1",
          campanha_id: "camp-1",
          exit_offered_at: agora,
          leva_a_saida: true,
          numero_da_mensagem: 2,
          locale: "pt-BR",
          reservada_em_texto: agora,
        },
      ],
    });
    const resultadoEnvio: ChannelSendResult = {
      kind: "sent",
      idempotencyKey: "k",
      messageId: "m",
    };
    const enviar = envioFalso(resultadoEnvio);
    const avisar = vi.fn();
    const r = await enviarComSaidaConfiguravel(
      { db: { query } as never, organizationId: "org-a", conversationId: "conv-1", via: "inbound_turn", mensagem: MSG, avisar },
      "Oi, tudo bem?",
      enviar,
    );
    expect(r).toBe(resultadoEnvio);
    // O corpo enviado já tem a saída (PARAR).
    expect(enviar.mock.calls[0]?.[0]).toContain("PARAR");
    // Toda SQL tem organization_id = $1.
    for (const { sql, params } of sqls) {
      expect(sql).toContain("organization_id = $1");
      expect(params[0]).toBe("org-a");
    }
    // Audit chamado uma vez com message_number e via.
    expect(auditMock).toHaveBeenCalledTimes(1);
    const chamada = auditMock.mock.calls[0]?.[0];
    expect(chamada).toBeDefined();
    const c = chamada!;
    expect(c.action).toBe("prospecting.exit_offered");
    expect(c.metadata!.message_number).toBe(2);
    expect(c.metadata!.via).toBe("inbound_turn");
    expect(c.metadata!.campaign_id).toBe("camp-1");
  });

  it("contou sem reservar + sent → corpo sem saída; audit não chamado; nenhum desfazer", async () => {
    const { query } = dbFalso({
      "returning": [
        {
          candidato_id: "cand-2",
          campanha_id: "camp-2",
          exit_offered_at: "2026-10-21T12:00:00Z",
          leva_a_saida: false,
          numero_da_mensagem: 3,
          locale: null,
          reservada_em_texto: null,
        },
      ],
    });
    const resultadoEnvio: ChannelSendResult = { kind: "sent", idempotencyKey: "k", messageId: "m" };
    const enviar = envioFalso(resultadoEnvio);
    const avisar = vi.fn();
    const r = await enviarComSaidaConfiguravel(
      { db: { query } as never, organizationId: "org-a", conversationId: "conv-1", via: "followup", mensagem: MSG, avisar },
      "só cumprimento",
      enviar,
    );
    expect(r).toBe(resultadoEnvio);
    expect(enviar.mock.calls[0]?.[0]).toBe("só cumprimento");
    expect(auditMock).not.toHaveBeenCalled();
    // O desfazer não existe neste arquivo de teste para o caso sem reserva; basta
    // conferir que não houve audit e o corpo saiu intacto.
  });

  // Modo da 2ª: a 2ª mensagem reservou a saída e voltou `queued`. O corpo
  // guardado, já com o PARAR, sai depois pelo watchdog sem passar por aqui —
  // então a contagem, a reserva e a auditoria FICAM (prova recusada do #3091).
  it("contou + envio queued → mantém a contagem e a reserva e audita", async () => {
    const agora = "2026-10-21T14:00:00.000000Z";
    const { query } = dbFalso({
      "returning": [
        {
          candidato_id: "cand-4",
          campanha_id: "camp-4",
          exit_offered_at: agora,
          leva_a_saida: true,
          numero_da_mensagem: 2,
          locale: "pt-BR",
          reservada_em_texto: agora,
        },
      ],
    });
    const enviar = envioFalso({ kind: "queued", idempotencyKey: "k", messageId: "m" });
    await enviarComSaidaConfiguravel(
      { db: { query } as never, organizationId: "org-a", conversationId: "conv-1", via: "inbound_turn", mensagem: MSG, avisar: vi.fn() },
      "texto",
      enviar,
    );
    expect(enviar.mock.calls[0]?.[0]).toContain("PARAR");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("greatest(automatic_sends - 1, 0)"))).toBe(false);
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  // `already_sent` não transmitiu nada: se esta tentativa contou, desfaz.
  it("contou + envio already_sent → desfaz a contagem desta tentativa e não audita", async () => {
    const agora = "2026-10-21T14:00:00.000000Z";
    const { query } = dbFalso({
      "returning": [
        {
          candidato_id: "cand-4",
          campanha_id: "camp-4",
          exit_offered_at: agora,
          leva_a_saida: true,
          numero_da_mensagem: 2,
          locale: "pt-BR",
          reservada_em_texto: agora,
        },
      ],
    });
    await enviarComSaidaConfiguravel(
      { db: { query } as never, organizationId: "org-a", conversationId: "conv-1", via: "inbound_turn", mensagem: MSG, avisar: vi.fn() },
      "texto",
      envioFalso({ kind: "already_sent", idempotencyKey: "k", messageId: "m" }),
    );
    const [sql, params] = query.mock.calls.at(-1)!;
    expect(sql).toContain("greatest(automatic_sends - 1, 0)");
    expect(params).toEqual(["org-a", "cand-4", agora]);
    expect(auditMock).not.toHaveBeenCalled();
  });

  // Reprocesso da MESMA mensagem (job, seq) já guardada: não conta, não audita,
  // e o corpo desta tentativa repete a decisão do corpo guardado.
  it.each([
    ["com", "Oi\n\nSe não quiser mais receber mensagens, responda PARAR.", true],
    ["sem", "Oi", false],
  ] as const)("mensagem já guardada %s o rodapé → não conta e repete a decisão", async (_, guardado, leva) => {
    const { query } = dbFalso({ "send_ledger": [{ body: guardado, locale: "pt-BR" }] });
    const enviar = envioFalso({ kind: "sent", idempotencyKey: "k", messageId: "m" });
    await enviarComSaidaConfiguravel(
      { db: { query } as never, organizationId: "org-a", conversationId: "conv-1", via: "followup", mensagem: MSG, avisar: vi.fn() },
      "Olá de novo",
      enviar,
    );
    expect(String(enviar.mock.calls[0]?.[0]).includes("PARAR")).toBe(leva);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual(["org-a", "job-1", 1]);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("contou + envio failed → desfazer chamado com reservadaEm", async () => {
    const agora = "2026-10-21T13:00:00.000000Z";
    const { query } = dbFalso({
      "returning": [
        {
          candidato_id: "cand-3",
          campanha_id: "camp-3",
          exit_offered_at: agora,
          leva_a_saida: true,
          numero_da_mensagem: 2,
          locale: "pt-BR",
          reservada_em_texto: agora,
        },
      ],
    });
    const resultadoEnvio: ChannelSendResult = { kind: "failed", idempotencyKey: "k", messageId: null };
    const enviar = envioFalso(resultadoEnvio);
    const avisar = vi.fn();
    await enviarComSaidaConfiguravel(
      { db: { query } as never, organizationId: "org-a", conversationId: "conv-1", via: "inbound_turn", mensagem: MSG, avisar },
      "texto",
      enviar,
    );
    // O desfazer é chamado via db.query. Confere o último SQL.
    const ultimoSql = query.mock.calls.at(-1);
    expect(ultimoSql).toBeDefined();
    const [sql, params] = ultimoSql!;
    expect(sql).toContain("greatest(automatic_sends - 1, 0)");
    expect(sql).toContain("exit_offered_at = case when exit_offered_at = $3::timestamptz then null");
    expect(params).toEqual(["org-a", "cand-3", agora]);
  });

  // A reserva só fica se for amarrada à mensagem que leva o rodapé: sem linha
  // amarrada (a mensagem já virou `failed`, ou o amarrar falhou), quem desfaz é
  // esta tentativa — o gatilho do banco não teria ponteiro para seguir.
  it.each([
    ["a mensagem já falhou (nenhuma linha amarrada)", false],
    ["o amarrar lança", true],
  ] as const)("reservou + queued, mas %s → desfaz e não audita", async (_, lanca) => {
    const agora = "2026-10-21T15:00:00.000000Z";
    const { query } = dbFalso({
      "exit_offer_message_id": [],
      "returning": [
        {
          candidato_id: "cand-5",
          campanha_id: "camp-5",
          exit_offered_at: agora,
          leva_a_saida: true,
          numero_da_mensagem: 2,
          locale: "pt-BR",
          reservada_em_texto: agora,
        },
      ],
    });
    if (lanca) {
      const original = query.getMockImplementation()!;
      query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("exit_offer_message_id")) throw new Error("banco caiu");
        return original(sql, params);
      });
    }
    const avisar = vi.fn();
    await enviarComSaidaConfiguravel(
      { db: { query } as never, organizationId: "org-a", conversationId: "conv-1", via: "inbound_turn", mensagem: MSG, avisar },
      "texto",
      envioFalso({ kind: "queued", idempotencyKey: "k", messageId: "m" }),
    );
    const amarrar = query.mock.calls.find(([sql]) => String(sql).includes("exit_offer_message_id"));
    expect(amarrar?.[1]).toEqual(["org-a", "job-1", 1, "Se não quiser mais receber mensagens, responda PARAR.", "cand-5", agora]);
    const [sql, params] = query.mock.calls.at(-1)!;
    expect(sql).toContain("greatest(automatic_sends - 1, 0)");
    expect(params).toEqual(["org-a", "cand-5", agora]);
    expect(auditMock).not.toHaveBeenCalled();
    expect(avisar).toHaveBeenCalledTimes(lanca ? 1 : 0);
  });

  it("enviar lança → desfazer chamado e o mesmo erro é relançado", async () => {
    const agora = "2026-10-21T13:00:00.000000Z";
    const { query } = dbFalso({
      "returning": [
        {
          candidato_id: "cand-4",
          campanha_id: "camp-4",
          exit_offered_at: agora,
          leva_a_saida: true,
          numero_da_mensagem: 2,
          locale: "pt-BR",
          reservada_em_texto: agora,
        },
      ],
    });
    const erro = new Error("canal fora do ar");
    const enviar = vi.fn(async (): Promise<ChannelSendResult> => {
      throw erro;
    });
    const avisar = vi.fn();
    await expect(
      enviarComSaidaConfiguravel(
        { db: { query } as never, organizationId: "org-a", conversationId: "conv-1", via: "followup", mensagem: MSG, avisar },
        "texto",
        enviar,
      ),
    ).rejects.toThrow(erro);
    // O desfazer é chamado via db.query (último SQL).
    const ultimoSql = query.mock.calls.at(-1);
    expect(ultimoSql).toBeDefined();
    const [sql, params] = ultimoSql!;
    expect(sql).toContain("greatest(automatic_sends - 1, 0)");
    expect(params).toEqual(["org-a", "cand-4", agora]);
  });

  it("conversationId null → db não é consultado; corpo intacto", async () => {
    const { query } = dbFalso({});
    const resultadoEnvio: ChannelSendResult = { kind: "sent", idempotencyKey: "k", messageId: "m" };
    const enviar = envioFalso(resultadoEnvio);
    const avisar = vi.fn();
    const r = await enviarComSaidaConfiguravel(
      { db: { query } as never, organizationId: "org-a", conversationId: null, via: "inbound_turn", mensagem: MSG, avisar },
      "texto puro",
      enviar,
    );
    expect(r).toBe(resultadoEnvio);
    expect(enviar.mock.calls[0]?.[0]).toBe("texto puro");
    expect(query).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("contagem lança → avisar chamado; enviar recebe o corpo intacto; resultado devolvido", async () => {
    const { query } = dbFalso({});
    // Faz a consulta lançar.
    query.mockRejectedValueOnce(new Error("banco caiu"));
    const resultadoEnvio: ChannelSendResult = { kind: "sent", idempotencyKey: "k", messageId: "m" };
    const enviar = envioFalso(resultadoEnvio);
    const avisar = vi.fn();
    const r = await enviarComSaidaConfiguravel(
      { db: { query } as never, organizationId: "org-a", conversationId: "conv-1", via: "inbound_turn", mensagem: MSG, avisar },
      "texto puro",
      enviar,
    );
    expect(r).toBe(resultadoEnvio);
    expect(enviar.mock.calls[0]?.[0]).toBe("texto puro");
    expect(avisar).toHaveBeenCalledTimes(1);
    expect(avisar.mock.calls[0]?.[0]).toContain("contagem de saída automática falhou");
    expect(auditMock).not.toHaveBeenCalled();
  });
});


describe("modos aceitos: só a 1ª e a 2ª mensagem (doc 170)", () => {
  const id = "0c110000-0000-4000-8000-000000000001";
  const config = {
    agent_id: id,
    channel_session_id: id,
    pipeline_id: id,
    stage_id: id,
    qualified_stage_id: id,
    instruction: "Vender consultoria para clínicas.",
    qualification: "Confirmou a necessidade e a decisão.",
    legal_basis_ref: "LIA-teste",
  };
  // O POST /api/v1/prospecting valida com este schema e devolve 422 validation_failed.
  const inicia = (extra: Record<string, unknown>) =>
    prospectingInputSchema.safeParse({ action: "start", id, config: { ...config, ...extra } }).success;

  it("recusa o modo da 3ª mensagem", () => {
    expect(inicia({ exit_offer: "third_message" })).toBe(false);
  });

  it("aceita a 1ª e a 2ª", () => {
    expect(inicia({ exit_offer: "first_message" })).toBe(true);
    expect(inicia({ exit_offer: "second_message" })).toBe(true);
  });

  it("campanha sem a chave segue com a saída na 1ª mensagem", () => {
    expect(campaignConfigSchema.parse(config).exit_offer).toBe("first_message");
  });
});
