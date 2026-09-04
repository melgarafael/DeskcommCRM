/**
 * O CONTEXTO DO TURNO TRAZ OS COMPROMISSOS JÁ MARCADOS (issue #512).
 *
 * O agente marcava uma reunião e, minutos depois, não sabia que ela existia:
 * dizia que o horário estava ocupado por OUTRA pessoa quando o ocupante era a
 * reunião do próprio cliente, e negava o agendamento que ele mesmo fizera.
 *
 * Medido: `grep -ciE "appointment|agendamento|calendar" get-lead-context.ts` → 0.
 * CONTROLE POSITIVO na mesma sonda, arquivo irmão: `mcp/tools/agendamento.ts` → 45.
 */
import { describe, expect, it } from "vitest";

import {
  MAXIMO_DE_COMPROMISSOS_NO_BLOCO,
  compromissosDoContato,
  renderCompromissos,
} from "@/lib/agent-engine/agent/compromissos-do-contato";
import { ritualBlocks } from "@/lib/agent-engine/agent/inbound-turn";

const ORG = "org-1";
const CONTATO = "contato-1";
const AGORA = new Date("2026-09-03T12:00:00Z");

/** Captura o SQL e os parâmetros — é a consulta que este teste precisa medir. */
function db(rows: unknown[] = []) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  return {
    chamadas,
    q: {
      query: async (sql: string, params: unknown[]) => {
        chamadas.push({ sql, params });
        return { rows };
      },
    } as never,
  };
}

describe("a consulta dos compromissos", () => {
  it("⭐ filtra por contact_id — e NÃO por lead_id", async () => {
    // A armadilha da issue #509 mora aqui: no motor `leadId` É o contato, e uma
    // consulta que confiasse no nome da variável plantaria aquele defeito dentro
    // deste conserto.
    const { q, chamadas } = db();
    await compromissosDoContato(q, ORG, CONTATO, AGORA);

    expect(chamadas[0]!.sql).toContain("contact_id");
    expect(chamadas[0]!.sql).not.toMatch(/\blead_id\b/);
    expect(chamadas[0]!.params[0]).toBe(ORG);
    expect(chamadas[0]!.params[1]).toBe(CONTATO);
  });

  it("⭐ isola por organização — service role não tem RLS", async () => {
    const { q, chamadas } = db();
    await compromissosDoContato(q, ORG, CONTATO, AGORA);
    expect(chamadas[0]!.sql).toContain("organization_id = $1");
  });

  it("⭐ exclui cancelado e passado", async () => {
    // Compromisso cancelado no bloco faria o agente afirmar uma reunião que não
    // existe mais — troca "não vê o que marcou" por "promete o que foi
    // desmarcado", que é pior.
    const { q, chamadas } = db();
    await compromissosDoContato(q, ORG, CONTATO, AGORA);
    expect(chamadas[0]!.sql).toContain("status <> 'cancelled'");
    expect(chamadas[0]!.sql).toContain("ends_at >= $3");
  });

  it("pede uma linha a mais que o teto — é assim que se sabe que truncou", async () => {
    const { q, chamadas } = db();
    await compromissosDoContato(q, ORG, CONTATO, AGORA);
    expect(chamadas[0]!.params[3]).toBe(MAXIMO_DE_COMPROMISSOS_NO_BLOCO + 1);
  });
});

describe("o bloco em texto", () => {
  const linha = (i: number) => ({
    id: `ag-${i}`,
    title: `Consulta ${i}`,
    starts_at: `2026-09-0${i}T14:00:00Z`,
    ends_at: `2026-09-0${i}T15:00:00Z`,
    status: "confirmed",
  });

  it("⭐ traz horário e título do compromisso", () => {
    const t = renderCompromissos([linha(4)]);
    expect(t).toContain("2026-09-04T14:00:00Z");
    expect(t).toContain("Consulta 4");
  });

  it("sem compromisso, o bloco é VAZIO — não custa tokens para dizer 'nenhum'", () => {
    expect(renderCompromissos([])).toBe("");
  });

  it("⭐ quando trunca, DIZ que truncou", () => {
    // Truncar em silêncio faria o modelo afirmar que o cliente só tem estes —
    // a mesma classe de erro que a busca do catálogo cometia (#480).
    const muitos = Array.from({ length: MAXIMO_DE_COMPROMISSOS_NO_BLOCO + 1 }, (_, i) => linha(i + 1));
    const t = renderCompromissos(muitos);

    expect(/NÃO diga que esta é a lista completa/i.test(t)).toBe(true);
    expect(t.split("\n").filter((l) => l.includes("Consulta")).length).toBe(
      MAXIMO_DE_COMPROMISSOS_NO_BLOCO,
    );
  });
});

describe("o bloco chega ao prompt", () => {
  const contexto = { contact: { name: "Cliente", email: null } } as never;

  it("⭐ o ritual de abertura carrega os compromissos", () => {
    const t = ritualBlocks(null, null, contexto, "sem notas", false, "- 2026-09-04T14:00:00Z — Consulta (confirmed)").join(
      "\n",
    );
    expect(t).toContain("2026-09-04T14:00:00Z");
    expect(/compromissos/i.test(t)).toBe(true);
  });

  it("sem compromissos, nenhum cabeçalho aparece — o prompt não engorda à toa", () => {
    const t = ritualBlocks(null, null, contexto, "sem notas", false, "").join("\n");
    expect(/## Compromissos/i.test(t)).toBe(false);
  });

  it("controle positivo: os blocos de sempre continuam lá", () => {
    const t = ritualBlocks(null, null, contexto, "sem notas", false, "").join("\n");
    expect(t).toContain("## Contexto do lead");
    expect(t).toContain("## Estado do funil");
  });
});
