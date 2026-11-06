/**
 * #3310 — A PASSAGEM PARA HUMANO NÃO DIZ O QUE NÃO ACONTECEU.
 *
 * Numa organização com mais de um agente no mesmo número, a pausa do automático
 * e a escalação do próprio agente passavam pela MESMA porta do opt-out, e o
 * código único (`contato_bloqueado`) ia parar na tela de quem atende e na
 * abertura enviada ao lead:
 *
 *   - `force_human` (a conversa foi PASSADA para a equipe) era anunciado como
 *     "o contato pediu para não receber mensagens" — quem atende tratava um
 *     cliente vivo como descadastrado, e o caminho de volta ("Devolver ao
 *     automático") ficava invisível;
 *   - a escalação decidida pelo PRÓPRIO agente (falta de informação, regra do
 *     prompt) chegava como `requested_human`, e tanto o título do cartão quanto
 *     a abertura ao cliente diziam "o cliente pediu para falar com uma pessoa".
 *
 * ─── OS QUATRO CAMINHOS QUE ESTE ARQUIVO PRENDE ────────────────────────────
 *
 * 1. `force_human = true`, `is_blocked = false` ⇒ veto `atendimento_com_humano`,
 *    copy de handoff ("o atendimento automático está pausado… Devolver ao
 *    automático") — e NUNCA a frase de opt-out.
 * 2. `is_blocked = true` ⇒ `contato_bloqueado`, copy BIT A BIT a de hoje.
 * 3. pedido de humano de fato (`requested_human`) ⇒ `pediu_humano`.
 * 4. escalação do agente (texto livre/`low_confidence`) ⇒ `outro`, no título e
 *    na abertura.
 *
 * Os casos 1 e 2 rodam a CADEIA REAL (`runBeforeSend` com o client/pool falsos
 * que o #2426 usa): a asserção é sobre o `code` que o gate de verdade devolve,
 * não sobre o texto do arquivo. A decisão (vetar ou não) NÃO muda em nenhum
 * deles — o envio continua não acontecendo, e é por isso que o `send` é espiado.
 *
 * ─── SABOTAGEM (o caso que devolve o código único fica VERMELHO) ───────────
 * - Devolver `code: 'contato_bloqueado'` no ramo do handoff
 *   (`lib/agent-engine/guardrails/before-send.ts`, `stopGate`): o caso 1 cai.
 * - Tirar o `stop_por_handoff` da leitura (voltar a `boolean`): o caso 1 cai.
 * - Voltar o default de `reason`/`motivo_codigo` para `requested_human`
 *   (`lib/mcp/tools/handoff.ts` e `lib/agent-engine/agent/human-handoff.ts`):
 *   os casos 3/4 caem.
 * - Trocar o fallback de `motivoCodigoDoTexto` para `requested_human`
 *   (`lib/escalacao/passagem.ts`): os casos 3/4 caem.
 */
import fs from "node:fs";
import path from "node:path";

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { motivoDoBloqueioDaEntrega } from "@/lib/agent-engine/agent/meet-delivery";
import { runBeforeSend, type RunBeforeSendArgs } from "@/lib/agent-engine/guardrails/before-send";
import { motivoDoAviso, textoDoAviso } from "@/lib/escalacao/aviso-ao-lead";
import { motivoCodigoDoTexto } from "@/lib/escalacao/passagem";
import { retentionCopy, type RetentionContext } from "@/lib/inbox/retention-copy";

const RAIZ = process.cwd();
const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ORG = "00000000-0000-4000-8000-000000000001";
const LEAD = "00000000-0000-4000-8000-000000000002";

const CTX_DA_COPY: RetentionContext = {
  window_start_hour: 8,
  window_end_hour: 18,
  allow_sunday: false,
  timezone: "America/Sao_Paulo",
};

/**
 * Cliente falso que responde às travas do contato com o que o caso quer provar —
 * `{ stopped, stop_por_handoff }`, exatamente como `readStopFlags` lê do banco —
 * e vazio para todo o resto (todos os loaders têm default para vazio: é o
 * caminho feliz que o #2506 já usa).
 */
function clienteComTravas(travas: { stopped: boolean; stop_por_handoff: boolean; contato_interno?: boolean }): pg.PoolClient {
  return {
    query: vi.fn(async (sql: string) => {
      const s = String(sql).toLowerCase().trim();
      if (s.includes("stop_por_handoff")) return { rows: [travas], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  } as unknown as pg.PoolClient;
}

function poolDoTeste(cliente: pg.PoolClient): pg.Pool {
  return {
    connect: vi.fn(async () => cliente),
    query: vi.fn(async (sql: string) => {
      const s = String(sql).toLowerCase().trim();
      if (s.includes("insert into before_send_traces")) return { rows: [{ id: "trace-1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as pg.Pool;
}

/** Turno com a CADEIA REAL (`gates` ausente = `BEFORE_SEND_GATES`). */
function turno(travas: { stopped: boolean; stop_por_handoff: boolean; contato_interno?: boolean }, extras: Partial<RunBeforeSendArgs> = {}) {
  const cliente = clienteComTravas(travas);
  const pool = poolDoTeste(cliente);
  const send = vi.fn(async () => ({ kind: "sent" as const, idempotencyKey: "k", messageId: "m" }));
  const args: RunBeforeSendArgs = {
    pool,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tenantId: ORG,
    leadId: LEAD,
    jobId: "00000000-0000-4000-8000-000000000003",
    channelSessionId: "00000000-0000-4000-8000-000000000004",
    body: "Oi! Segue o que você pediu.",
    optedOutThisTurn: false,
    crmDailyLimit: null,
    now: new Date("2026-10-22T12:00:00.000Z"),
    rng: () => 0,
    sleep: async () => {},
    send,
    ...extras,
  };
  return { args, send, cliente };
}

describe("#3310 · 1+2 — o gate separa a passagem para a equipe do opt-out real", () => {
  it("force_human sozinho veta como `atendimento_com_humano`, e o envio não acontece", async () => {
    const { args, send } = turno({ stopped: true, stop_por_handoff: true });

    const r = await runBeforeSend(args);

    expect(r.status).toBe("vetoed");
    expect(r.status === "vetoed" && r.code).toBe("atendimento_com_humano");
    // A DECISÃO é a de sempre: o veto não deixa o envio passar.
    expect(send).not.toHaveBeenCalled();
  });

  it("a copy do `atendimento_com_humano` é a de handoff, nunca a de opt-out", async () => {
    const copy = retentionCopy("atendimento_com_humano", CTX_DA_COPY);

    expect(copy.kind).toBe("handoff");
    expect(copy.title).toBe("Resposta pausada: a conversa está com a equipe");
    expect(copy.description).toContain("O atendimento automático está pausado");
    expect(copy.description).toContain("Devolver ao automático");
    // O que NÃO pode estar lá: a acusação de opt-out que a issue mediu.
    expect(copy.description).not.toMatch(/pediu para não receber/i);
    expect(copy.description).not.toMatch(/opt-out/i);
  });

  it("is_blocked veta como `contato_bloqueado` e a copy é bit a bit a de hoje", async () => {
    const { args, send } = turno({ stopped: true, stop_por_handoff: false });

    const r = await runBeforeSend(args);

    expect(r.status).toBe("vetoed");
    expect(r.status === "vetoed" && r.code).toBe("contato_bloqueado");
    expect(send).not.toHaveBeenCalled();
    // Bit a bit: nenhuma vírgula mudou para quem pediu para sair.
    expect(retentionCopy("contato_bloqueado", CTX_DA_COPY)).toEqual({
      kind: "compliance",
      title: "Resposta bloqueada por conformidade",
      description: "O contato pediu para não receber mensagens (opt-out). Nada será enviado a ele.",
    });
  });

  it("opt-out E handoff juntos: vence o opt-out (a trava que Devolver ao automático não desfaz)", async () => {
    // O SQL do gate já reduz os dois a `stopPorHandoff: false`; o banco devolve o
    // que o caso monta. Aqui a linha diz as duas coisas e a leitura é a do banco.
    const { args } = turno({ stopped: true, stop_por_handoff: false });

    const r = await runBeforeSend(args);

    expect(r.status === "vetoed" && r.code).toBe("contato_bloqueado");
  });

  it("etiqueta interna (#2353) E handoff juntos: vence `contato_interno` (Devolver ao automático não a desfaz)", async () => {
    const { args, send } = turno({ stopped: true, stop_por_handoff: true, contato_interno: true });

    const r = await runBeforeSend(args);

    expect(r.status === "vetoed" && r.code).toBe("contato_interno");
    expect(send).not.toHaveBeenCalled();
  });

  it("`optedOutThisTurn` (opt-out já lido no turno) segue `contato_bloqueado`", async () => {
    const { args } = turno({ stopped: true, stop_por_handoff: true }, { optedOutThisTurn: true });

    const r = await runBeforeSend(args);

    expect(r.status === "vetoed" && r.code).toBe("contato_bloqueado");
  });

  it("a leitura do banco separa as travas: `force_human` sozinho marca o handoff", () => {
    const src = semComentarios(fonte("lib", "agent-engine", "guardrails", "before-send.ts"));
    // O predicado do STOP continua o da main — com a etiqueta interna do #2353
    // (a decisão não mudou)…
    expect(src).toMatch(/is_blocked or force_human or is_personal or ai_opt_out or i\.contato_interno\) as stopped/);
    // …e a segunda coluna é o que distingue o handoff do opt-out.
    expect(src).toMatch(
      /force_human and not \(is_blocked or is_personal or ai_opt_out\)\) as stop_por_handoff/,
    );
  });
});

describe("#3310 · 3 — o pedido de humano só existe quando o cliente pediu", () => {
  it("`requested_human` continua virando `pediu_humano`", () => {
    expect(motivoDoAviso("requested_human")).toBe("pediu_humano");
  });

  it("a escalação do agente cai em `outro`, no título e na abertura", () => {
    expect(motivoDoAviso("low_confidence")).toBe("outro");
    expect(motivoDoAviso("critical_stage")).toBe("outro");

    // O texto que o lead recebe: o do `outro`, nunca o de quem pediu.
    const doOutro = textoDoAviso("outro", { total: 1, disponiveis: 1, nomes: [] } as never, LEAD);
    const doPedido = textoDoAviso("pediu_humano", { total: 1, disponiveis: 1, nomes: [] } as never, LEAD);
    expect(doOutro).not.toBe(doPedido);
    expect(doOutro).not.toMatch(/Sem problema\. Acabei de acionar uma pessoa do time/);
  });

  it("texto livre (razão que não é código) NÃO vira pedido do cliente", () => {
    expect(motivoCodigoDoTexto("não consegui achar a reserva do cliente")).toBe("low_confidence");
    expect(motivoCodigoDoTexto(null)).toBe("low_confidence");
    expect(motivoCodigoDoTexto("  ")).toBe("low_confidence");
    expect(motivoCodigoDoTexto("low_confidence")).toBe("low_confidence");
    // O código explícito continua passando.
    expect(motivoCodigoDoTexto("requested_human")).toBe("requested_human");
  });

  it("o default de `reason` do MCP e de `motivo_codigo` do tool nativo não mente", () => {
    const mcp = semComentarios(fonte("lib", "mcp", "tools", "handoff.ts"));
    expect(mcp).not.toMatch(/default\(["']requested_human["']\)/);
    expect(mcp).toMatch(/reason: z\.string\(\)[\s\S]{0,120}\.optional\(\)/);
    // O motivo do agente externo que o nosso vocabulário não aceita não vira pedido.
    const doAgente = mcp.match(/function motivoDoAgenteExterno[\s\S]*?\n\}/)?.[0] ?? "";
    expect(doAgente).toContain('"low_confidence"');
    expect(doAgente).not.toContain('"requested_human"');

    const nativo = semComentarios(fonte("lib", "agent-engine", "agent", "human-handoff.ts"));
    expect(nativo).not.toMatch(/motivo_codigo\s*\?\?\s*['"]requested_human['"]/);
    expect(nativo).toMatch(/motivo_codigo\s*\?\?\s*['"]low_confidence['"]/);
  });
});

describe("#3310 · entrega da agenda — o motivo do bloqueio é um que o banco aceita", () => {
  // `fn_meet_delivery_settle` recusa motivo fora de uma lista FECHADA
  // (`meet_reason_invalid`): o settle cai no `retry` e a entrega termina
  // `failed`, não `blocked`. Vale a ÚLTIMA definição do baseline.
  const listas = [
    ...fonte("supabase", "baseline.sql").matchAll(
      /if reason not in \(([^)]*)\) then raise exception 'meet_reason_invalid'/g,
    ),
  ];
  const aceitos = (listas.at(-1)?.[1] ?? "").split(",").map((v) => v.trim().replace(/^'|'$/g, ""));

  it("controle: a lista do banco foi lida", () => {
    expect(aceitos).toContain("opt_out");
  });

  it("a pausa por handoff vira `blocked:force_human`, nunca `opt_out`", () => {
    expect(motivoDoBloqueioDaEntrega("atendimento_com_humano")).toBe("force_human");
    expect(motivoDoBloqueioDaEntrega("contato_bloqueado")).toBe("opt_out");
  });

  it.each(["atendimento_com_humano", "contato_bloqueado", "lgpd_sem_base", "messaging_window_closed", "outro_veto"])(
    "o motivo de %s está na lista do banco",
    (code) => {
      expect(aceitos).toContain(motivoDoBloqueioDaEntrega(code));
    },
  );
});
