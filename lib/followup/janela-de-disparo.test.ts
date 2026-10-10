/**
 * #2658 — as DUAS réguas de horário do follow-up, no atalho inline.
 *
 * `decidirAdiamentoPorJanela` é a régua pura que `enviarTextoFixoPendente`
 * passou a consultar: a janela de DISPARO do canal (`channel_knobs`, a tela de
 * Proteção de envio) e a faixa PRÓPRIA do agente
 * (`ai_agent_versions.followup.send_window`). Aqui se mede a decisão; a
 * ligação no atalho (não envia, adia e registra o motivo) é medida em
 * `enviar-texto-fixo.test.ts`.
 *
 * As âncoras são FIXAS e o fuso da organização (America/Sao_Paulo) difere do
 * UTC, então nenhuma asserção de horário é identidade: 04:00Z é 01:00 local.
 */
import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { decidirAdiamentoPorJanela } from "./janela-de-disparo";

/** O que o stub devolve, por tabela (a linha crua daquele select). */
type Tabelas = Record<string, Record<string, unknown> | null | undefined>;

/** Stub de Supabase por tabela — a mesma técnica de `enviar-texto-fixo.test.ts`. */
function admin(tabelas: Tabelas, falhas: Record<string, string> = {}) {
  const make = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => {
        const causa = falhas[table];
        if (causa) return Promise.resolve({ data: null, error: { message: causa } });
        const linha = tabelas[table] ?? {};
        return Promise.resolve({ data: Object.keys(linha).length === 0 ? null : linha, error: null });
      },
    };
    return chain;
  };
  return { from: (t: string) => make(t) } as unknown as SupabaseClient;
}

/** Canal 8h–18h (a tela de Proteção de envio) com jitter zerado para o `until` ser exato. */
const KNOBS_8_A_18 = {
  throttle_ms: null,
  jitter_max_ms: 0,
  window_start_hour: 8,
  window_end_hour: 18,
  allow_sunday: true,
  timezone: null,
  warmup_daily_caps: null,
};

const FAIXA_SEG_A_SEX = { send_window: { start: "08:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] } };

const ORG = "org-1";
const CONVERSA = "conv-1";
const CONTATO = "contact-1";
const INSCRICAO = "enr-1";

function entradas(overrides: Partial<Tabelas> = {}): Tabelas {
  return {
    conversations: { channel_session_id: "sess-1" },
    channel_knobs: KNOBS_8_A_18,
    organizations: { timezone: "America/Sao_Paulo" },
    followup_enrollments: { agent_id: "ag-1" },
    ai_agents: { published_version_id: "v1" },
    ai_agent_versions: { followup: FAIXA_SEG_A_SEX },
    ...overrides,
  };
}

function decidir(tabelas: Tabelas, agoraISO: string, falhas: Record<string, string> = {}) {
  return decidirAdiamentoPorJanela(admin(tabelas, falhas), {
    organizationId: ORG,
    contactId: CONTATO,
    conversationId: CONVERSA,
    enrollmentId: INSCRICAO,
    agora: new Date(agoraISO),
  });
}

describe("decidirAdiamentoPorJanela", () => {
  it("madrugada (01h local, canal 8h–18h) → adia para a abertura do canal, motivo do canal", async () => {
    // 2026-10-08 é quinta; 04:00Z = 01:00 de Brasília. Abertura de hoje: 08:00
    // local = 11:00Z.
    const adiamento = await decidir(entradas(), "2026-10-08T04:00:00Z");
    expect(adiamento).toEqual({
      until: new Date("2026-10-08T11:00:00Z"),
      reason: "outside_window",
    });
  });

  it("canal fechado e faixa também → adia direto para quando as DUAS abrem", async () => {
    // Sábado 22:00 local: o canal reabre domingo 08:00, mas a faixa só segunda
    // 08:00. Devolver domingo faria o job reentrar e ser adiado de novo.
    const adiamento = await decidir(entradas(), "2026-10-11T01:00:00Z");
    expect(adiamento).toEqual({
      until: new Date("2026-10-12T11:00:00Z"),
      reason: "followup_send_window",
    });
  });

  it("sexta 19h → UM adiamento só, até segunda 8h; na reentrada, envia (não adia de novo)", async () => {
    // Regressão do adiamento duplo: o canal abre sábado 08:00 e a faixa só
    // segunda. Com as réguas avaliadas uma de cada vez, o job ia a sábado e lá
    // era adiado DE NOVO com a mesma chave de `action_deferred` — o 23505 é
    // engolido, a prova de vida não avança e o dead-man mata a inscrição.
    const adiamento = await decidir(entradas(), "2026-10-09T22:00:00Z");
    expect(adiamento).toEqual({
      until: new Date("2026-10-12T11:00:00Z"),
      reason: "followup_send_window",
    });
    expect(await decidir(entradas(), adiamento!.until.toISOString())).toBeNull();
  });

  it("canal aberto mas SÁBADO (faixa seg–sex) → adia para segunda, motivo da faixa", async () => {
    // 2026-10-10 é sábado; 13:00Z = 10:00 local — dentro das 8h–18h do canal,
    // fora da faixa. Próxima abertura da faixa: segunda 08:00 local.
    const adiamento = await decidir(entradas(), "2026-10-10T13:00:00Z");
    expect(adiamento).toEqual({
      until: new Date("2026-10-12T11:00:00Z"),
      reason: "followup_send_window",
    });
  });

  it("DENTRO das duas réguas → null (pode enviar agora)", async () => {
    // Quinta 10:00 local.
    expect(await decidir(entradas(), "2026-10-08T13:00:00Z")).toBeNull();
  });

  it("a faixa é lida no fuso da ORGANIZAÇÃO, não no do knob do canal", async () => {
    // Org em São Paulo (21:00Z = 18:00 local, já FORA da faixa 8h–18h), canal
    // com knob de fuso em Nova York (17:00 de lá, ainda DENTRO das 8h–18h de
    // lá). Se a faixa herdasse o fuso do canal, este caso mandaria enviar às
    // 18h de Brasília — que é exatamente o defeito da issue. A faixa reabre
    // 08:00 de Brasília de sexta (11:00Z), mas aí são 07:00 em Nova York e o
    // canal ainda está fechado: as duas só concordam às 08:00 de lá (12:00Z).
    const tabelas = entradas({
      channel_knobs: { ...KNOBS_8_A_18, timezone: "America/New_York" },
    });
    const adiamento = await decidir(tabelas, "2026-10-08T21:00:00Z");
    expect(adiamento).toEqual({
      until: new Date("2026-10-09T12:00:00Z"),
      reason: "outside_window",
    });
  });

  it("conversa SEM canal → só a faixa decide", async () => {
    const adiamento = await decidir(entradas({ conversations: { channel_session_id: null } }), "2026-10-10T13:00:00Z");
    expect(adiamento?.reason).toBe("followup_send_window");
  });

  it("sem linha em `channel_knobs` → o padrão do pacing (7h–22h) ainda vale", async () => {
    const semKnobs = entradas({ channel_knobs: null, ai_agent_versions: { followup: null } });
    // 10:00 local: dentro do padrão 7h–22h, e sem faixa → pode enviar.
    expect(await decidir(semKnobs, "2026-10-08T13:00:00Z")).toBeNull();
    // 01:00 local: fora do padrão → adia para as 7h de hoje (10:00Z). Quem
    // nunca abriu a tela de Proteção de envio continua protegido. Sem linha em
    // `channel_knobs` valem os defaults do pacing, inclusive o jitter anti-ban
    // de até 800 ms — por isso a faixa, e não o instante exato.
    const adiamento = await decidir(semKnobs, "2026-10-08T04:00:00Z");
    expect(adiamento?.reason).toBe("outside_window");
    expect(adiamento!.until.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-10-08T10:00:00Z"));
    expect(adiamento!.until.getTime()).toBeLessThan(Date.parse("2026-10-08T10:00:02Z"));
  });

  it("dado legado: enrollment SEM agente → só o canal decide", async () => {
    const adiamento = await decidir(entradas({ followup_enrollments: { agent_id: null } }), "2026-10-10T13:00:00Z");
    expect(adiamento).toBeNull(); // sábado 10h: canal aberto, sem faixa para consultar
  });

  it("dado legado: agente SEM versão publicada → só o canal decide", async () => {
    const adiamento = await decidir(entradas({ ai_agents: { published_version_id: null } }), "2026-10-10T13:00:00Z");
    expect(adiamento).toBeNull();
  });

  it("faixa com shape inválido → ignorada, sem virar mordaça", async () => {
    // `start`/`end` tortos: `lerJanelaDeAtendimento` devolve null (falha aberta)
    // e o envio segue com a única régua que existe.
    const adiamento = await decidir(
      entradas({ ai_agent_versions: { followup: { send_window: { start: "25:00", end: "09:00", weekdays: [1] } } } }),
      "2026-10-08T04:00:00Z",
    );
    expect(adiamento?.reason).toBe("outside_window"); // o canal ainda segura
  });

  it("erro de leitura na faixa SOBE (fail-closed) — o job tenta de novo, não envia às cegas", async () => {
    await expect(
      decidir(entradas(), "2026-10-08T13:00:00Z", { ai_agent_versions: "db down" }),
    ).rejects.toThrow("db down");
  });
});
