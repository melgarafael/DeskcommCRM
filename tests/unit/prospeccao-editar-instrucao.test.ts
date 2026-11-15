/**
 * EDITAR A INSTRUÇÃO E OS CRITÉRIOS DE UMA CAMPANHA JÁ INICIADA — issue #4570.
 *
 * O defeito: com a campanha pausada, a tela só oferecia "Editar ritmo" e
 * "Retomar fila". O texto que a IA lê ("O que a IA deve oferecer e como
 * iniciar"), os critérios de qualificação e as ofertas ficavam congelados no
 * `start`: para corrigir uma palavra era preciso criar outra campanha e perder
 * a lista já pesquisada.
 *
 * O que este arquivo prova, sem banco:
 *   - a ação nova entra no schema da rota com o mesmo formato fechado das irmãs
 *     e sem `.default()` nas ofertas (oferta omitida não volta para "site");
 *   - `editBriefing` só escreve com a campanha PAUSADA, só na organização da
 *     sessão, com o MESMO código de erro de `adjust_pace`/`adjust_tags` (409);
 *   - o `update` faz merge com `||` e troca só instrução, critérios e ofertas;
 *   - a auditoria recebe de que texto para que texto.
 *
 * O contexto montado a partir do texto novo (o que uma conversa NOVA lê) é
 * provado contra Postgres de verdade em
 * `tests/invariants/prospecting-editar-instrucao.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/app/api/v1/contacts/_handler", () => ({ createContactHandler: vi.fn() }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: vi.fn() }));
vi.mock("@/lib/atendimento/origem", () => ({
  beginServiceAtOrigin: vi.fn(),
  assertServiceBoundarySupabase: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  TAMANHO_MAXIMO_DO_BRIEFING,
  TAMANHO_MINIMO_DO_BRIEFING,
  prospectingInputSchema,
} from "@/lib/prospecting/schema";
import { previaDoAgente } from "@/lib/prospecting/previa";
import {
  CONGELA_BRIEFING_DOS_ABORDADOS_SQL,
  DESCARTA_PREVIAS_DA_FILA_SQL,
  EDICAO_DO_BRIEFING_SQL,
  MENSAGEM_DE_CAMPANHA_PAUSADA_PARA_EDITAR,
  editBriefing,
} from "@/lib/prospecting/store";

const ORG = "0c120000-0000-4000-8000-000000000001";
const CAMPANHA = "0c120000-1111-4000-8000-000000000001";

const NOVO = {
  instruction: "Ofereça uma auditoria gratuita do site e proponha conversar 15 minutos.",
  qualification: "Confirmou que recebe pedidos pelo WhatsApp e quer responder mais rápido.",
  ofertas: ["site", "automacao_crm"] as const,
};

type Linha = { status: string; config: Record<string, unknown> | null };

/** Banco falso: responde a linha da campanha e o `returning id` do update. */
function poolDeMentira(campanhaLinha: Linha | null, atualiza = true) {
  const consultas: { texto: string; params: unknown[] }[] = [];
  const cliente = {
    query: vi.fn(async (texto: string, params: unknown[] = []) => {
      consultas.push({ texto, params });
      if (texto.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (texto.startsWith("select status, config"))
        return { rows: campanhaLinha ? [campanhaLinha] : [] };
      if (texto === EDICAO_DO_BRIEFING_SQL) return { rows: atualiza ? [{ id: CAMPANHA }] : [] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => cliente } as never, consultas };
}
const escreveu = (consultas: { texto: string }[]) =>
  consultas.some((q) => q.texto === EDICAO_DO_BRIEFING_SQL);

describe("editBriefing: só campanha pausada, só desta organização", () => {
  it("campanha que não existe: 404, sem escrever", async () => {
    const { pool, consultas } = poolDeMentira(null);
    await expect(editBriefing(pool, ORG, CAMPANHA, { ...NOVO, ofertas: [...NOVO.ofertas] })).rejects.toMatchObject(
      { status: 404 },
    );
    expect(escreveu(consultas)).toBe(false);
  });

  it.each(["running", "draft", "completed"])(
    "campanha %s: 409 (a MESMA régua das irmãs), sem escrever",
    async (status) => {
      const { pool, consultas } = poolDeMentira({
        status,
        config: { instruction: "Texto antigo.", qualification: "Critério antigo." },
      });
      await expect(
        editBriefing(pool, ORG, CAMPANHA, { ...NOVO, ofertas: [...NOVO.ofertas] }),
      ).rejects.toMatchObject({
        status: 409,
        message: MENSAGEM_DE_CAMPANHA_PAUSADA_PARA_EDITAR,
      });
      expect(escreveu(consultas)).toBe(false);
    },
  );

  it("sem configuração (nunca iniciada): 409, sem escrever", async () => {
    const { pool, consultas } = poolDeMentira({ status: "paused", config: null });
    await expect(
      editBriefing(pool, ORG, CAMPANHA, { ...NOVO, ofertas: [...NOVO.ofertas] }),
    ).rejects.toMatchObject({ status: 409 });
    expect(escreveu(consultas)).toBe(false);
  });

  it("pausada: escreve com organização, id e os três campos, e devolve de que texto para que texto", async () => {
    const { pool, consultas } = poolDeMentira({
      status: "paused",
      config: {
        instruction: "Texto antigo, ainda em uso.",
        qualification: "Critério antigo.",
        ofertas: ["site"],
      },
    });
    const resultado = await editBriefing(pool, ORG, CAMPANHA, {
      ...NOVO,
      ofertas: [...NOVO.ofertas],
    });
    expect(resultado).toEqual({
      previous: {
        instruction: "Texto antigo, ainda em uso.",
        qualification: "Critério antigo.",
        ofertas: ["site"],
      },
      next: {
        instruction: NOVO.instruction,
        qualification: NOVO.qualification,
        ofertas: [...NOVO.ofertas],
      },
    });
    const escrita = consultas.find((q) => q.texto === EDICAO_DO_BRIEFING_SQL);
    expect(escrita?.params).toEqual([
      ORG,
      CAMPANHA,
      NOVO.instruction,
      NOVO.qualification,
      JSON.stringify(NOVO.ofertas),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    ]);
    // Doc 358 › 1A: na mesma transação, o texto ANTERIOR fica com quem já foi
    // abordado e a prévia da fila, escrita com ele, sai.
    const textos = consultas.map((q) => q.texto);
    const congela = consultas.find((q) => q.texto === CONGELA_BRIEFING_DOS_ABORDADOS_SQL);
    expect(congela?.params).toEqual([
      ORG,
      CAMPANHA,
      JSON.stringify({
        instruction: "Texto antigo, ainda em uso.",
        qualification: "Critério antigo.",
        ofertas: ["site"],
      }),
    ]);
    expect(textos.indexOf("begin")).toBeLessThan(textos.indexOf(EDICAO_DO_BRIEFING_SQL));
    expect(textos.indexOf(DESCARTA_PREVIAS_DA_FILA_SQL)).toBeLessThan(textos.indexOf("commit"));
  });

  it("campanha antiga sem ofertas gravadas: o `previous` sai null, não some", async () => {
    const { pool } = poolDeMentira({ status: "paused", config: { daily_limit: 10 } });
    const resultado = await editBriefing(pool, ORG, CAMPANHA, {
      ...NOVO,
      ofertas: [...NOVO.ofertas],
    });
    expect(resultado.previous).toEqual({
      instruction: null,
      qualification: null,
      ofertas: null,
    });
  });

  it("alguém retomou entre a leitura e a escrita: o `where` recusou e o resultado é 409", async () => {
    const { pool, consultas } = poolDeMentira({ status: "paused", config: {} }, false);
    await expect(
      editBriefing(pool, ORG, CAMPANHA, { ...NOVO, ofertas: [...NOVO.ofertas] }),
    ).rejects.toMatchObject({ status: 409 });
    // Nada congela nem descarta prévia por uma edição que não aconteceu.
    const textos = consultas.map((q) => q.texto);
    expect(textos).toContain("rollback");
    expect(textos).not.toContain(CONGELA_BRIEFING_DOS_ABORDADOS_SQL);
    expect(textos).not.toContain(DESCARTA_PREVIAS_DA_FILA_SQL);
  });
});

describe("o texto do update troca só o briefing e exige pausada", () => {
  const texto = EDICAO_DO_BRIEFING_SQL.replace(/\s+/g, " ");

  it("filtra pela organização e pelo id", () => {
    expect(texto).toContain("where organization_id = $1 and id = $2");
  });

  it("só altera campanha pausada com configuração", () => {
    expect(texto).toContain("status = 'paused' and config is not null");
  });

  it("faz merge com `||` nas TRÊS chaves e não substitui a configuração inteira", () => {
    expect(texto).toContain(
      "set config = config || jsonb_build_object('instruction', $3::text, 'qualification', $4::text, 'ofertas', $5::jsonb, 'briefing_editado_em', $6::text)",
    );
    expect(texto).not.toMatch(/set config\s*=\s*\$/);
  });

  it("não encosta em ritmo, etiquetas, conexão nem agente", () => {
    for (const chave of ["daily_limit", "interval_minutes", "contact_tags", "channel_session_id", "agent_id"]) {
      expect(texto).not.toContain(chave);
    }
  });
});

describe("a rota aceita edit_briefing com o formato fechado das irmãs", () => {
  const valido = { action: "edit_briefing", id: CAMPANHA, ...NOVO };

  it("aceita instrução, critérios e ofertas", () => {
    const parsed = prospectingInputSchema.parse(valido);
    expect(parsed).toMatchObject({
      action: "edit_briefing",
      instruction: NOVO.instruction,
      qualification: NOVO.qualification,
      ofertas: [...NOVO.ofertas],
    });
  });

  it("apara os espaços das pontas", () => {
    const parsed = prospectingInputSchema.parse({
      ...valido,
      instruction: `   ${NOVO.instruction}   `,
      qualification: `  ${NOVO.qualification}  `,
    });
    expect(parsed).toMatchObject({ instruction: NOVO.instruction, qualification: NOVO.qualification });
  });

  it.each(["instruction", "qualification", "ofertas"])(
    "exige %s: omitido é erro, não 'grava o padrão sem avisar'",
    (campo) => {
      const corpo: Record<string, unknown> = { ...valido };
      delete corpo[campo];
      expect(prospectingInputSchema.safeParse(corpo).success).toBe(false);
    },
  );

  it("recusa oferta vazia, oferta desconhecida e mais de três", () => {
    for (const ofertas of [[], ["panfletagem"], ["site", "automacao_crm", "automacao_n8n", "site"]]) {
      expect(
        prospectingInputSchema.safeParse({ ...valido, ofertas }).success,
        `ofertas=${JSON.stringify(ofertas)}`,
      ).toBe(false);
    }
  });

  it("recusa texto abaixo do piso e acima do teto da configuração", () => {
    expect(
      prospectingInputSchema.safeParse({ ...valido, instruction: "ok" }).success,
    ).toBe(false);
    expect(
      prospectingInputSchema.safeParse({
        ...valido,
        qualification: "x".repeat(TAMANHO_MAXIMO_DO_BRIEFING),
      }).success,
    ).toBe(true);
    expect(
      prospectingInputSchema.safeParse({
        ...valido,
        qualification: "x".repeat(TAMANHO_MAXIMO_DO_BRIEFING + 1),
      }).success,
    ).toBe(false);
    expect(TAMANHO_MINIMO_DO_BRIEFING).toBeGreaterThan(1);
  });

  it("recusa campo a mais — conexão, agente, funil, base legal e ritmo seguem fechados", () => {
    for (const campo of [
      "agent_id",
      "channel_session_id",
      "pipeline_id",
      "qualified_stage_id",
      "legal_basis_ref",
      "daily_limit",
      "organization_id",
    ]) {
      expect(
        prospectingInputSchema.safeParse({ ...valido, [campo]: "x" }).success,
        `o campo ${campo} não pode passar por edit_briefing`,
      ).toBe(false);
    }
  });
});

describe("doc 358 › 1A: o texto novo não alcança quem já foi abordado, nem o rascunho velho", () => {
  it("congela só quem já foi abordado, só nesta campanha, e não sobrescreve o primeiro congelado", () => {
    const texto = CONGELA_BRIEFING_DOS_ABORDADOS_SQL;
    expect(texto).toContain("where organization_id = $1 and campaign_id = $2");
    expect(texto).toContain("status in ('sending','sent')");
    expect(texto).toContain("not (data ? 'briefing')");
  });

  it("descarta a prévia só de quem ainda está na fila", () => {
    const texto = DESCARTA_PREVIAS_DA_FILA_SQL;
    expect(texto).toContain("where organization_id = $1 and campaign_id = $2");
    expect(texto).toContain("status in ('new','queued')");
    expect(texto).toContain("data - 'previa'");
  });

  const AGENTE = "0c120000-2222-4000-8000-000000000001";
  const site = {
    ver: 1, classe: "sem-site", problemas: [], checklist: { tem: [], falta: [] },
    final_url: null, http_status: null, tempo_ms: null, conteudo_resumo: null,
    pagespeed: null, verificado_em: "2026-11-01T00:00:00.000Z", provisorio: false, tentativas: 0,
  } as never;
  const previa = (carimbo?: string) => ({
    website: null,
    site,
    previa: {
      texto: "Olá! Rascunho escrito com o texto da campanha.",
      baseada_em: "sem-site@2026-11-01T00:00:00.000Z",
      gerada_em: "2026-11-01T00:00:00.000Z",
      agente_id: AGENTE,
      ...(carimbo ? { briefing_editado_em: carimbo } : {}),
    },
  });

  it("campanha nunca editada: a prévia sem carimbo continua valendo no envio", () => {
    expect(previaDoAgente(previa(), AGENTE, undefined)).not.toBeNull();
  });

  it("campanha editada: a prévia de antes da edição (sem carimbo ou com o velho) não sai", () => {
    const agora = "2026-11-15T12:00:00.000Z";
    expect(previaDoAgente(previa(), AGENTE, agora)).toBeNull();
    expect(previaDoAgente(previa("2026-11-10T12:00:00.000Z"), AGENTE, agora)).toBeNull();
    expect(previaDoAgente(previa(agora), AGENTE, agora)).not.toBeNull();
  });
});
