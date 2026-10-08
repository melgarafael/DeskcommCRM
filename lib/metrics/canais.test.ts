/**
 * A linha "Por canal" (issue #2390) — montagem pura + a RÉGUA da RPC.
 *
 * Duas metades, nenhuma delas abre banco:
 *
 *  - a montagem da linha (`montarLinhas`/`totalDeConversas`/`rotuloCanal`), que
 *    é o que a rota entrega e a tela pinta;
 *  - a régua da migration 0590, lida DO ARQUIVO: é ela que garante que a conta
 *    por canal é a MESMA da irmã `fn_attendant_metrics` (0037) — bot fora,
 *    `t1 <= t0` descartado e vazamento fora da média — e que o `group by` é por
 *    `channel_session_id`.
 *
 * A segunda metade é também a prova de sabotagem pedida na issue: trocar o
 * `group by c.channel_session_id` por `group by c.assigned_to_user_id` deixa
 * EXATAMENTE UM teste vermelho, e é o da contagem por canal.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { montarLinhas, rotuloCanal, totalDeConversas, type LinhaCanalBruta } from "./canais";

function linha(parcial: Partial<LinhaCanalBruta>): LinhaCanalBruta {
  return {
    channel_session_id: "11111111-1111-4111-8111-111111111111",
    channel_name: "11 99999-0001",
    channel: "whatsapp",
    is_archived: false,
    conversations_handled: 1,
    avg_first_response_seconds: null,
    sem_resposta: 0,
    ...parcial,
  };
}

/** A migration da issue, achada pelo NÚMERO (0590), não pelo nome do slug. */
function sqlDaMigration(): string {
  const dir = join(process.cwd(), "supabase", "migrations");
  const arquivos = readdirSync(dir).filter((a) => /^.*_0590_.*\.sql$/.test(a));
  expect(arquivos, "migration 0590 não encontrada em supabase/migrations").toHaveLength(1);
  const nome = arquivos[0];
  if (!nome) throw new Error("migration 0590 não encontrada em supabase/migrations");
  return readFileSync(join(dir, nome), "utf8");
}

describe("a linha por canal", () => {
  it("2 canais com 3 conversas somam 3 — nada de total engolido (critério 1)", () => {
    const linhas = montarLinhas([
      linha({
        channel_session_id: "aaaaaaaa-0000-4000-8000-000000000001",
        channel_name: "11 99999-0001",
        conversations_handled: 2,
        avg_first_response_seconds: 120,
        sem_resposta: 1,
      }),
      linha({
        channel_session_id: "bbbbbbbb-0000-4000-8000-000000000002",
        channel_name: "22 99999-0002",
        conversations_handled: 1,
        avg_first_response_seconds: 60,
        sem_resposta: 0,
      }),
    ]);

    expect(linhas).toHaveLength(2);
    expect(totalDeConversas(linhas)).toBe(3);
    // Cada linha guarda a SUA conta: o total é soma, nunca um número próprio.
    expect(linhas.map((l) => l.conversations_handled)).toEqual([2, 1]);
    expect(linhas.map((l) => l.sem_resposta)).toEqual([1, 0]);
  });

  it("média não medida chega como null e vira traço na tela — null ≠ 0 (critério 5)", () => {
    const [soVazamento] = montarLinhas([
      linha({ conversations_handled: 3, avg_first_response_seconds: null, sem_resposta: 3 }),
    ]);
    expect(soVazamento?.avg_first_response_seconds).toBeNull();
    expect(soVazamento?.avg_first_response_seconds).not.toBe(0);
    // O vazamento continua visível à parte, sem tocar na média (critério 3).
    expect(soVazamento?.sem_resposta).toBe(3);
  });

  it("canal arquivado aparece, marcado — a conversa existiu", () => {
    const linhas = montarLinhas([linha({ is_archived: true, conversations_handled: 4 })]);
    expect(linhas[0]?.is_archived).toBe(true);
  });

  it("ordena por volume e desempata pelo id; nome vazio vira ausente", () => {
    const linhas = montarLinhas([
      linha({ channel_session_id: "zzzz", channel_name: "  ", conversations_handled: 1 }),
      linha({ channel_session_id: "aaaa", conversations_handled: 5 }),
      linha({ channel_session_id: "mmmm", conversations_handled: 5 }),
    ]);
    expect(linhas.map((l) => l.channel_session_id)).toEqual(["aaaa", "mmmm", "zzzz"]);
    const semNome = linhas.find((l) => l.channel_session_id === "zzzz");
    expect(semNome?.channel_name).toBeNull();
    // Sem nome a linha NÃO some: o rótulo cai no prefixo do id.
    expect(semNome && rotuloCanal(semNome, (texto) => texto)).toBe("Canal zzzz");
  });

  it("sem linha nenhuma o quadro é vazio, não é zero fingindo medição", () => {
    expect(montarLinhas([])).toEqual([]);
    expect(montarLinhas(null)).toEqual([]);
    expect(totalDeConversas([])).toBe(0);
  });
});

describe("a RPC da migration 0590 — a régua da irmã (0037)", () => {
  const sql = sqlDaMigration();

  it("agrupa por channel_session_id e NUNCA por atendente (prova de sabotagem)", () => {
    expect(sql).toContain("group by c.channel_session_id");
    expect(sql).not.toContain("group by c.assigned_to_user_id");
  });

  it("a 1ª resposta é HUMANA: o bot fica de fora", () => {
    expect(sql).toContain("m.direction = 'outbound' and m.sent_by_user_id is not null");
  });

  it("conversa iniciada pelo atendente (t1 <= t0) é descartada, igual à original", () => {
    expect(sql).toContain("c.first_human_out > c.first_in");
  });

  it("o vazamento conta À PARTE e nunca entra no cálculo da média", () => {
    // O vazamento é um count próprio, ancorado em "nunca teve resposta humana"…
    expect(sql).toMatch(
      /count\(\*\) filter \([\s\S]{0,200}c\.first_human_out is null[\s\S]{0,60}\) as sem_resposta/,
    );
    // …e a média só nasce com par válido: sem par, `null` — não `0`.
    expect(sql).toMatch(
      /avg\(extract\(epoch from \(c\.first_human_out - c\.first_in\)\)\) filter \(\s*where c\.first_in is not null\s*and c\.first_human_out is not null/,
    );
  });

  it("a janela é semiaberta e cada medida corta na sua coluna", () => {
    expect(sql).toContain("c.assigned_at >= p_from and c.assigned_at < p_to");
    expect(sql).toContain("c.first_human_out >= p_from and c.first_human_out < p_to");
  });

  it("é SECURITY INVOKER: a RLS é o portão, não uma checagem paralela", () => {
    expect(sql).toContain("language sql stable");
    expect(sql).not.toMatch(/security\s+definer/i);
    expect(sql).toContain("c.organization_id = p_org");
  });
});
