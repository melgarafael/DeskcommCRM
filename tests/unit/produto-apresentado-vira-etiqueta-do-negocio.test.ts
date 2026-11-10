/**
 * O produto que o assistente APRESENTOU (send_message com `produto_codigo`) vira
 * etiqueta do negócio — é por ela que o fluxo de acompanhamento escolhe o
 * modelo aprovado do produto certo.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * A condição `tag` do grafo de acompanhamento lê `crm_leads.tags`. Quem punha a
 * etiqueta era o modelo, com a ferramenta de etiquetas — quando lembrava. Não é
 * confiável nem medível. O envio com `produto_codigo` é determinístico: o código
 * resolveu um produto ativo do catálogo e o canal devolveu "enviada".
 *
 * ─── O que se prova aqui ─────────────────────────────────────────────────────
 *
 * 1. A REGRA (`etiquetarNegocioComProdutoApresentado`), contra um banco de
 *    mentira que aplica as guardas do `update`: etiqueta o único negócio aberto,
 *    em minúsculas; não duplica; não adivinha com 0 ou 2 abertos; respeita o
 *    teto; deixa evento e linha do tempo; falha do rastro não desfaz a etiqueta.
 * 2. O PORTÃO depois do envio (`etiquetarProdutoAposEnvio`), por comportamento:
 *    só `sent`/`already_sent`, nunca em prévia, e nunca lança.
 * 3. A FIAÇÃO dentro do `execute` do `send_message` — closure sem injeção
 *    barata, lida do fonte como em `send-message-manda-foto-do-produto.test.ts`:
 *    o portão é chamado DEPOIS do envio e ANTES de devolver ao modelo.
 *
 * O que NÃO se prova aqui: o SQL contra um Postgres real (`array_append`,
 * `emit_event` chamado pelo pool) — isso é do `test:db`, que não rodou.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { etiquetarProdutoAposEnvio } from "@/lib/agent-engine/agent/etiqueta-apos-envio";
import type { ChannelSendResult } from "@/lib/agent-engine/channel-adapter";
import {
  etiquetaDoCodigo,
  etiquetarNegocioComProdutoApresentado,
} from "@/lib/leads/etiqueta-do-produto-apresentado";

const ORG = "org-1";
const CONTATO = "contato-1";
const CODIGO = "TENIS-CORRIDA-01";

interface Negocio {
  id: string;
  organization_id: string;
  contact_id: string;
  pipeline_id: string;
  status: "open" | "won" | "lost";
  last_activity_at: string | null;
  created_at: string;
  tags: string[] | null;
}

const negocio = (over: Partial<Negocio> = {}): Negocio => ({
  id: "negocio-1",
  organization_id: ORG,
  contact_id: CONTATO,
  pipeline_id: "funil-1",
  status: "open",
  last_activity_at: "2026-09-29T12:00:00Z",
  created_at: "2026-09-28T12:00:00Z",
  tags: [],
  ...over,
});

/**
 * Banco de mentira com a ÚNICA tabela que importa (`crm_leads`), e o `update`
 * aplicando as mesmas três guardas do SQL real — aberto, sem a etiqueta, abaixo
 * do teto. Sem elas, "não duplica" passaria por não haver o que duplicar.
 */
function banco(negocios: Negocio[], opts: { eventoFalha?: boolean; corridaNoUpdate?: boolean } = {}) {
  const eventos: Array<{ tipo: string; entidade: string; payload: Record<string, unknown> }> = [];
  const atividades: Array<{ lead_id: string; type: string; reason: string; payload: Record<string, unknown> }> = [];
  const consultas: Array<{ sql: string; params: unknown[] }> = [];

  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (sql.includes("from crm_leads l")) {
        const [org, contato] = params as [string, string];
        return { rows: negocios.filter((n) => n.organization_id === org && n.contact_id === contato) };
      }
      if (sql.includes("update crm_leads")) {
        if (opts.corridaNoUpdate) return { rows: [] };
        const [org, id, etiqueta, teto] = params as [string, string, string, number];
        const n = negocios.find((x) => x.organization_id === org && x.id === id);
        const tags = n?.tags ?? [];
        if (!n || n.status !== "open" || tags.includes(etiqueta) || tags.length >= teto) return { rows: [] };
        n.tags = [...tags, etiqueta];
        return { rows: [{ tags: n.tags }] };
      }
      if (sql.includes("public.emit_event")) {
        if (opts.eventoFalha) throw new Error("emit_event indisponível");
        const [tipo, entidade, , payload] = params as [string, string, string, string];
        eventos.push({ tipo, entidade, payload: JSON.parse(payload) });
        return { rows: [{ emit_event: "evt-1" }] };
      }
      if (sql.includes("from crm_pipelines")) return { rows: [] };
      if (sql.includes("insert into crm_lead_activities")) {
        const p = params as unknown[];
        atividades.push({
          lead_id: p[1] as string,
          type: p[3] as string,
          reason: p[9] as string,
          payload: JSON.parse(p[11] as string),
        });
        return { rows: [] };
      }
      if (sql.includes("insert into event_log")) return { rows: [] };
      throw new Error(`consulta não prevista: ${sql.slice(0, 60)}`);
    },
  };
  return { pool, eventos, atividades, consultas, negocios };
}

const ENTRADA = { organizationId: ORG, contactId: CONTATO, codigo: CODIGO, agentId: "agente-1", messageId: "msg-1" };

describe("a regra — o produto apresentado vira etiqueta do negócio", () => {
  it("único negócio aberto: ganha o código em minúsculas, com evento e linha do tempo", async () => {
    const b = banco([negocio({ tags: ["cliente-novo"] })]);
    const r = await etiquetarNegocioComProdutoApresentado(b.pool as never, ENTRADA);

    expect(r).toEqual({ etiquetou: true, leadId: "negocio-1", etiqueta: "tenis-corrida-01", falhasDoRastro: [] });
    expect(b.negocios[0]!.tags).toEqual(["cliente-novo", "tenis-corrida-01"]);
    // O mesmo evento do PATCH do negócio e da automação — é o que webhook e
    // automação escutam.
    expect(b.eventos).toEqual([
      {
        tipo: "lead.tag_added",
        entidade: "crm_lead",
        payload: { added_tags: ["tenis-corrida-01"], tags: ["cliente-novo", "tenis-corrida-01"] },
      },
    ]);
    expect(b.atividades).toHaveLength(1);
    expect(b.atividades[0]).toMatchObject({ lead_id: "negocio-1", type: "lead_edited" });
    expect(b.atividades[0]!.reason).toContain("tenis-corrida-01");
  });

  it("toda leitura e escrita vai filtrada pela organização", async () => {
    const b = banco([negocio()]);
    await etiquetarNegocioComProdutoApresentado(b.pool as never, ENTRADA);
    const leitura = b.consultas.find((c) => c.sql.includes("from crm_leads l"))!;
    expect(leitura.sql).toMatch(/l\.organization_id = \$1 and l\.contact_id = \$2/);
    expect(leitura.params).toEqual([ORG, CONTATO]);
    const escrita = b.consultas.find((c) => c.sql.includes("update crm_leads"))!;
    expect(escrita.sql).toMatch(/where organization_id = \$1 and id = \$2 and status = 'open'/);
    expect(escrita.params[0]).toBe(ORG);
  });

  it("não duplica: o negócio que já tem a etiqueta não é tocado nem gera evento", async () => {
    const b = banco([negocio({ tags: ["tenis-corrida-01"] })]);
    const r = await etiquetarNegocioComProdutoApresentado(b.pool as never, ENTRADA);
    expect(r).toMatchObject({ etiquetou: false, motivo: "ja_tinha" });
    expect(b.negocios[0]!.tags).toEqual(["tenis-corrida-01"]);
    expect(b.consultas.some((c) => c.sql.includes("update crm_leads"))).toBe(false);
    expect(b.eventos).toHaveLength(0);
  });

  it("não duplica em dois envios seguidos do mesmo produto", async () => {
    const b = banco([negocio()]);
    await etiquetarNegocioComProdutoApresentado(b.pool as never, ENTRADA);
    const segunda = await etiquetarNegocioComProdutoApresentado(b.pool as never, ENTRADA);
    expect(segunda).toMatchObject({ etiquetou: false, motivo: "ja_tinha" });
    expect(b.negocios[0]!.tags).toEqual(["tenis-corrida-01"]);
    expect(b.eventos).toHaveLength(1);
  });

  it("sem negócio aberto (só ganho): não etiqueta", async () => {
    const b = banco([negocio({ status: "won" })]);
    const r = await etiquetarNegocioComProdutoApresentado(b.pool as never, ENTRADA);
    expect(r).toMatchObject({ etiquetou: false, motivo: "sem_negocio_aberto" });
    expect(b.negocios[0]!.tags).toEqual([]);
  });

  it("dois negócios abertos: não adivinha qual", async () => {
    const b = banco([
      negocio({ id: "negocio-1" }),
      negocio({ id: "negocio-2", last_activity_at: "2026-09-29T13:00:00Z" }),
    ]);
    const r = await etiquetarNegocioComProdutoApresentado(b.pool as never, ENTRADA);
    expect(r).toMatchObject({ etiquetou: false, motivo: "mais_de_um_negocio_aberto" });
    expect(b.negocios.map((n) => n.tags)).toEqual([[], []]);
  });

  it("no teto de 20 etiquetas do editor: não passa dele", async () => {
    const vinte = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const b = banco([negocio({ tags: vinte })]);
    const r = await etiquetarNegocioComProdutoApresentado(b.pool as never, ENTRADA);
    expect(r).toMatchObject({ etiquetou: false, motivo: "teto_de_etiquetas" });
    expect(b.negocios[0]!.tags).toHaveLength(20);
  });

  it("o negócio mudou entre a leitura e a escrita: nada de evento sobre o que não foi gravado", async () => {
    const b = banco([negocio()], { corridaNoUpdate: true });
    const r = await etiquetarNegocioComProdutoApresentado(b.pool as never, ENTRADA);
    expect(r).toMatchObject({ etiquetou: false, motivo: "mudou_no_meio" });
    expect(b.eventos).toHaveLength(0);
    expect(b.atividades).toHaveLength(0);
  });

  it("o evento falha: a etiqueta fica, a linha do tempo sai, e a falha é devolvida para o log", async () => {
    const b = banco([negocio()], { eventoFalha: true });
    const r = await etiquetarNegocioComProdutoApresentado(b.pool as never, ENTRADA);
    expect(r.etiquetou).toBe(true);
    if (r.etiquetou) expect(r.falhasDoRastro[0]).toMatch(/^evento: emit_event indisponível/);
    expect(b.negocios[0]!.tags).toEqual(["tenis-corrida-01"]);
    expect(b.atividades).toHaveLength(1);
  });

  it("código que não cabe numa etiqueta (40) não vira etiqueta cortada", () => {
    expect(etiquetaDoCodigo("  TENIS-CORRIDA-01 ")).toBe("tenis-corrida-01");
    expect(etiquetaDoCodigo("X".repeat(41))).toBeNull();
    expect(etiquetaDoCodigo("   ")).toBeNull();
  });
});

// ─── 2. O portão depois do envio ────────────────────────────────────────────

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const ENVIADA: ChannelSendResult = { kind: "sent", idempotencyKey: "k", messageId: "msg-1" };
const PORTAO = {
  preview: false,
  produtoApresentado: CODIGO,
  outcome: ENVIADA,
  tenantId: ORG,
  contactId: CONTATO,
  agentId: "agente-1",
};

describe("o portão depois do envio", () => {
  it("mensagem ENVIADA com produto: etiqueta o negócio de verdade (regra real, banco de mentira)", async () => {
    const b = banco([negocio()]);
    const l = log();
    await etiquetarProdutoAposEnvio(b.pool as never, l, PORTAO);
    expect(b.negocios[0]!.tags).toEqual(["tenis-corrida-01"]);
    expect(l.info).toHaveBeenCalledWith(
      "negócio etiquetado com o produto apresentado",
      expect.objectContaining({ lead_id: "negocio-1", etiqueta: "tenis-corrida-01" }),
    );
  });

  it("a etiqueta leva a mensagem que apresentou o produto e o agente", async () => {
    const etiquetar = vi.fn(async () => ({ etiquetou: false as const, motivo: "ja_tinha" as const }));
    await etiquetarProdutoAposEnvio({} as never, log(), PORTAO, etiquetar);
    expect(etiquetar).toHaveBeenCalledWith(
      {},
      { organizationId: ORG, contactId: CONTATO, codigo: CODIGO, agentId: "agente-1", messageId: "msg-1" },
    );
  });

  it("replay de envio já aceito (`already_sent`) também etiqueta — não duplica, a regra garante", async () => {
    const etiquetar = vi.fn(async () => ({ etiquetou: false as const, motivo: "ja_tinha" as const }));
    await etiquetarProdutoAposEnvio({} as never, log(), {
      ...PORTAO,
      outcome: { kind: "already_sent", idempotencyKey: "k", messageId: null },
    }, etiquetar);
    expect(etiquetar).toHaveBeenCalledOnce();
  });

  it("em PRÉVIA não etiqueta", async () => {
    const etiquetar = vi.fn();
    await etiquetarProdutoAposEnvio({} as never, log(), { ...PORTAO, preview: true }, etiquetar as never);
    expect(etiquetar).not.toHaveBeenCalled();
  });

  it("sem produto no envio não etiqueta", async () => {
    const etiquetar = vi.fn();
    await etiquetarProdutoAposEnvio({} as never, log(), { ...PORTAO, produtoApresentado: null }, etiquetar as never);
    expect(etiquetar).not.toHaveBeenCalled();
  });

  it("o que não SAIU não etiqueta: fila, bloqueio, falha, canal fora", async () => {
    const naoSairam: ChannelSendResult[] = [
      { kind: "queued", idempotencyKey: "k", messageId: null },
      { kind: "blocked", idempotencyKey: "k" },
      { kind: "failed", idempotencyKey: "k", messageId: null },
      { kind: "unavailable", reason: "sessão caiu" },
    ];
    for (const outcome of naoSairam) {
      const etiquetar = vi.fn();
      await etiquetarProdutoAposEnvio({} as never, log(), { ...PORTAO, outcome }, etiquetar as never);
      expect(etiquetar, outcome.kind).not.toHaveBeenCalled();
    }
  });

  it("erro ao etiquetar NÃO lança — a mensagem já saiu e o modelo não pode ler 'falhou'", async () => {
    const l = log();
    const etiquetar = vi.fn(async () => {
      throw new Error("connection terminated");
    });
    await expect(
      etiquetarProdutoAposEnvio({} as never, l, PORTAO, etiquetar as never),
    ).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalledWith(
      "falha ao etiquetar o negócio com o produto apresentado (segue)",
      { error: "connection terminated" },
    );
  });
});

// ─── 3. A fiação dentro do `send_message` ───────────────────────────────────

const FONTE = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
const corpoDoSend = (() => {
  const i = FONTE.indexOf("send_message: tool({");
  const j = FONTE.indexOf("update_lead_state: tool({", i);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return FONTE.slice(i, j);
})();

describe("a fiação no send_message", () => {
  it("o portão roda DEPOIS do envio pela cadeia e ANTES de devolver o resultado ao modelo", () => {
    const envio = corpoDoSend.indexOf("const outcome = chain.outcome;");
    const portao = corpoDoSend.indexOf("await etiquetarProdutoAposEnvio(pool, runLog, {");
    const devolve = corpoDoSend.indexOf("switch (outcome.kind) {");
    expect(envio).toBeGreaterThan(-1);
    expect(portao).toBeGreaterThan(envio);
    expect(devolve).toBeGreaterThan(portao);
  });

  it("o portão recebe a prévia, o produto resolvido e o desfecho do canal", () => {
    const chamada = corpoDoSend.slice(corpoDoSend.indexOf("await etiquetarProdutoAposEnvio("));
    const args = chamada.slice(0, chamada.indexOf("});"));
    expect(args).toContain("preview: Boolean(preview)");
    expect(args).toContain("produtoApresentado,");
    expect(args).toContain("outcome,");
    expect(args).toContain("contactId: leadId");
  });

  it("o produto só conta como apresentado depois que o código resolveu um produto do catálogo", () => {
    const prepara = corpoDoSend.indexOf("prepararFotosDoProduto(");
    const recusa = corpoDoSend.indexOf("if (!preparadas.ok)");
    const marca = corpoDoSend.indexOf("produtoApresentado = produto_codigo.trim();");
    expect(prepara).toBeGreaterThan(-1);
    expect(recusa).toBeGreaterThan(prepara);
    expect(marca).toBeGreaterThan(recusa);
  });
});
