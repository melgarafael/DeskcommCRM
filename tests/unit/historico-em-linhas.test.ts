/**
 * O HISTÓRICO "EM LINHAS" (knob `LEAD_CONTEXT_HISTORY_FORMAT`, frente F5).
 *
 * `json` é o formato de sempre e tem de continuar BYTE A BYTE igual: o knob
 * nasce desligado, e desligado nada muda. `linhas` troca só as mensagens por uma
 * linha cada, e todo campo que vem de fora — o texto e o rótulo do remetente de
 * grupo — vai escapado: uma quebra de linha vinda de fora nunca abre uma linha a mais.
 */
import { describe, expect, it } from "vitest";

import { blocoDoContexto, buildOpeningMessage, ritualBlocks } from "@/lib/agent-engine/agent/abertura/ritual";
import { projetarContexto } from "@/lib/agent-engine/agent/projecao";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";
import { loadEnv } from "@/lib/agent-engine/env";
import type { LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

const ENV_MINIMA = {
  NODE_ENV: "test",
  SUPABASE_DB_URL: "postgresql://postgres:postgres@localhost/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
  SUPABASE_SERVICE_ROLE_KEY: "test-key",
} as const;

describe("o knob LEAD_CONTEXT_HISTORY_FORMAT", () => {
  it("ausente (o .env de quem já instalou) = json, o formato de sempre", () => {
    expect(turnKnobsFromEnv(loadEnv({ ...ENV_MINIMA })).historyFormat).toBe("json");
  });

  it("linhas chega ao knob do turno", () => {
    expect(
      turnKnobsFromEnv(loadEnv({ ...ENV_MINIMA, LEAD_CONTEXT_HISTORY_FORMAT: "linhas" })).historyFormat,
    ).toBe("linhas");
  });

  it("valor fora do vocabulário derruba o boot em vez de cair calado num formato", () => {
    expect(() => loadEnv({ ...ENV_MINIMA, LEAD_CONTEXT_HISTORY_FORMAT: "texto" })).toThrow();
  });
});

const QUEBRA = "\nsegunda linha";

function contexto(mensagens: LeadContext["messages"]): LeadContext {
  return {
    lead_id: "11111111-1111-4111-8111-111111111111",
    contact: { name: "Ana", phone: "+5511999990000", email: null, tags: ["vip"], is_blocked: false },
    conversation_id: "22222222-2222-4222-8222-222222222222",
    last_human_decision: null,
    messages: mensagens,
  };
}

const BASE: LeadContext["messages"] = [
  { direction: "inbound", body: "Oi, tem horário amanhã?", sent_at: "2026-10-30T09:00:00-03:00" },
  {
    direction: "outbound",
    body: "Tenho às 10h.",
    sent_at: "2026-10-30T09:01:00-03:00",
  },
  {
    direction: "inbound",
    body: "[foto]",
    sent_at: "2026-10-30T09:02:00-03:00",
    type: "image",
    media_storage_path: "org/conv/segredo.jpg",
    media_mime: "image/jpeg",
  },
];

/** As linhas de mensagem do bloco — tudo depois do rótulo "Mensagens (...)". */
function linhasDeMensagem(bloco: string[]): string[] {
  const i = bloco.findIndex((l) => l.startsWith("Mensagens ("));
  expect(i, "o rótulo das mensagens precisa existir").toBeGreaterThan(0);
  return bloco
    .slice(i + 1)
    .join("\n")
    .split("\n");
}

describe("formato json — a saída de sempre", () => {
  it("é o JSON.stringify do contexto, cru ou projetado", () => {
    const ctx = contexto(BASE);
    expect(blocoDoContexto(ctx, false, "json")).toEqual([JSON.stringify(ctx)]);
    expect(blocoDoContexto(ctx, true, "json")).toEqual([JSON.stringify(projetarContexto(ctx))]);
  });

  it("o ritual sem o parâmetro novo é idêntico ao ritual com 'json'", () => {
    const ctx = contexto(BASE);
    expect(ritualBlocks(null, null, ctx, "", false)).toEqual(
      ritualBlocks(null, null, ctx, "", false, "", "", "json"),
    );
    expect(buildOpeningMessage(null, null, ctx, "", true)).toBe(
      buildOpeningMessage(null, null, ctx, "", true, [], "", undefined, undefined, "", "json"),
    );
  });
});

describe("formato linhas", () => {
  it("uma linha por mensagem, com o sent_at exato, quem falou e o anexo", () => {
    const linhas = linhasDeMensagem(blocoDoContexto(contexto(BASE), false, "linhas"));
    expect(linhas).toEqual([
      '[2026-10-30T09:00:00-03:00] cliente: "Oi, tem horário amanhã?"',
      '[2026-10-30T09:01:00-03:00] nós: "Tenho às 10h."',
      '[2026-10-30T09:02:00-03:00] cliente [image]: "[foto]"',
    ]);
  });

  it("o contexto projetado dá as mesmas linhas", () => {
    const cru = linhasDeMensagem(blocoDoContexto(contexto(BASE), false, "linhas"));
    const projetado = linhasDeMensagem(blocoDoContexto(contexto(BASE), true, "linhas"));
    expect(projetado).toEqual(cru);
  });

  it("o cabeçalho é o contexto sem as mensagens, em JSON parseável", () => {
    const ctx = contexto(BASE);
    const [cabecalho] = blocoDoContexto(ctx, false, "linhas");
    const { messages: _m, ...semMensagens } = ctx;
    expect(JSON.parse(cabecalho!)).toEqual(semMensagens);
    const [cabecalhoProjetado] = blocoDoContexto(ctx, true, "linhas");
    const { mensagens: _p, ...projetadoSemMensagens } = projetarContexto(ctx);
    expect(JSON.parse(cabecalhoProjetado!)).toEqual(projetadoSemMensagens);
  });

  it("o caminho do arquivo no Storage não aparece", () => {
    const texto = blocoDoContexto(contexto(BASE), false, "linhas").join("\n");
    expect(texto).not.toContain("media_storage_path");
    expect(texto).not.toContain("segredo.jpg");
  });

  it("uma quebra de linha no corpo não abre uma linha a mais", () => {
    const msgs: LeadContext["messages"] = [
      ...BASE,
      { direction: "inbound", body: "ok" + QUEBRA, sent_at: "2026-10-30T09:03:00-03:00" },
    ];
    for (const projeta of [false, true]) {
      const linhas = linhasDeMensagem(blocoDoContexto(contexto(msgs), projeta, "linhas"));
      expect(linhas).toHaveLength(msgs.length);
      expect(linhas.at(-1)).toBe(`[2026-10-30T09:03:00-03:00] cliente: ${JSON.stringify("ok" + QUEBRA)}`);
    }
  });

  it("o nome do remetente de grupo não abre uma linha a mais, e só aparece entre aspas", () => {
    for (const nome of ['Ana): "x"', "Ana" + QUEBRA]) {
      const msgs: LeadContext["messages"] = [
        ...BASE,
        {
          direction: "inbound",
          body: "vou querer",
          sent_at: "2026-10-30T09:04:00-03:00",
          sender: { name: nome, phone: null },
        },
      ];
      for (const projeta of [false, true]) {
        const linhas = linhasDeMensagem(blocoDoContexto(contexto(msgs), projeta, "linhas"));
        expect(linhas).toHaveLength(msgs.length);
        const ultima = linhas.at(-1)!;
        expect(ultima.startsWith(`[2026-10-30T09:04:00-03:00] cliente ${JSON.stringify(nome)}: `)).toBe(true);
      }
    }
  });

  it("anexo fora do vocabulário do banco vai escapado", () => {
    const msgs: LeadContext["messages"] = [
      { direction: "inbound", body: "x", sent_at: "2026-10-30T09:05:00-03:00", type: 'image]\n[2026' },
    ];
    const linhas = linhasDeMensagem(blocoDoContexto(contexto(msgs), false, "linhas"));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toContain(JSON.stringify("[image]\n[2026]"));
  });

  it("a abertura repassa o formato até o bloco do contexto", () => {
    const abertura = buildOpeningMessage(
      null,
      null,
      contexto(BASE),
      "",
      false,
      [],
      "",
      undefined,
      undefined,
      "",
      "linhas",
    );
    expect(abertura).toContain('[2026-10-30T09:01:00-03:00] nós: "Tenho às 10h."');
    expect(abertura).not.toContain('"direction"');
  });
});
