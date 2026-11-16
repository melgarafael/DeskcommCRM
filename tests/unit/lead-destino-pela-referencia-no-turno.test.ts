import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * O NEGÓCIO DO ITEM NASCE NO FUNIL DA RECEITA, SEM O AGENTE SABER O FUNIL (Spec 25, R5c).
 *
 * Medido no espelho: o agente mostrou o imóvel, o cliente disse "tenho interesse" e o
 * agente escreveu "registrei" sem chamar `crm_create_lead` — no turno seguinte ele não
 * tinha funil nem etapa. Agora basta a referência do item.
 *
 * Mesma montagem do turno (`pickToolsFromMcp`), com o handler substituído por um espião:
 * o que se mede é o que a ponte entrega a ele e se o ESCOPO DE FUNIL julga o funil
 * RESOLVIDO (e não o argumento ausente).
 *
 * O que cada caso guarda, e a linha que o deixa vermelho se for revertida:
 *  1. Só a referência: o handler recebe funil e etapa da receita
 *     → tirar o bloco `completarDestinoDoNegocio` do wrapper (`lib/ai/runtime/tools.ts`).
 *  2. O funil resolvido FORA do escopo do agente é recusado (a guarda vê o funil
 *     completado, antes de o handler rodar)
 *     → mover o bloco para DEPOIS do escopo de funil.
 *  3. Receita sem destino: recusa com a ordem de passar para a equipe; handler não roda
 *     → tirar o `return completo.resposta`.
 *  4. Funil e etapa informados pelo modelo não são trocados pela receita
 *     → tirar o `return { ok: true }` do início de `completarDestinoDoNegocio`.
 *  5. A recusa do destino chega ao gate `registro_sem_efeito` como `falhou`, e o veto
 *     ensina a dizer a verdade em vez de mandar chamar de novo a ferramenta recusada
 *     → tirar o `anotarEfeito("falhou")` do bloco.
 *  6. Item inventado (não existe no banco de origem): o handler não roda e o gate lê
 *     `falhou` — foi o "registrado com sucesso" da prova de 10/11/2026
 *     → tirar a conferência do item de `completarDestinoDoNegocio`.
 */

vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));
// A consulta do item no banco de origem tem o próprio teste (`item-da-referencia.test.ts`).
const conferirItem = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as const));
vi.mock("@/lib/external-db/receitas/item-da-referencia", () => ({ conferirItemDaReferencia: conferirItem }));

const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");
const { getToolByName } = await import("@/lib/mcp/tools");
const { criarEfeitoDasEscrituras } = await import("@/lib/ai/runtime/efeito-das-escritas");
const { MODULOS_OPCIONAIS } = await import("@/lib/instalacao/modulos");
const { CAPACIDADES_DA_ORGANIZACAO } = await import("@/lib/organizacao/capacidades");

const ORG = "11111111-1111-4111-8111-111111111111";
const DO_TURNO = "22222222-2222-4222-8222-222222222222";
const FUNIL = "77777777-7777-4777-8777-777777777777";
const ETAPA = "88888888-8888-4888-8888-888888888888";
const OUTRO_FUNIL = "99999999-9999-4999-8999-999999999999";
const OUTRA_ETAPA = "aaaaaaaa-9999-4999-8999-999999999999";
const REF = "wordpress-conteudo:53";

type Linha = Record<string, unknown>;

const instancia = (destino: Linha | null) => ({
  id: "44444444-4444-4444-8444-444444444444",
  receita: "wordpress-conteudo",
  rotulo: "Imóveis",
  descricao: "",
  fixos: {},
  ativa: true,
  destino_do_interesse: destino,
});

function tabelas(destino: Linha | null): Record<string, Linha[]> {
  return {
    external_db_connections: [{ organization_id: ORG, enabled: true, receitas: [instancia(destino)] }],
    crm_pipelines: [{ id: FUNIL, organization_id: ORG, name: "Interessados", is_archived: false }],
    crm_stages: [
      { id: ETAPA, organization_id: ORG, pipeline_id: FUNIL, name: "Sei o que oferecer", is_archived: false, is_won: false, is_lost: false },
    ],
  };
}

/** Dublê que APLICA `eq` e devolve as linhas; qualquer outro método encadeia. */
function bancoFalso(dados: Record<string, Linha[]>) {
  const from = (tabela: string) => {
    let linhas = [...(dados[tabela] ?? [])];
    const alvo: Record<string, unknown> = {
      eq: (coluna: string, valor: unknown) => {
        linhas = linhas.filter((l) => l[coluna] === valor);
        return cadeia;
      },
      maybeSingle: () => Promise.resolve({ data: linhas[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve({ data: linhas, error: null }).then(ok, falha),
    };
    const cadeia: unknown = new Proxy(alvo, { get: (t, p: string) => (p in t ? t[p] : () => cadeia) });
    return cadeia;
  };
  return { from };
}

async function executar(args: Linha, dados: Record<string, Linha[]>, escopo: string[] = [FUNIL]) {
  const def = getToolByName("crm_create_lead")!;
  const handler = vi.spyOn(def, "handler").mockResolvedValue({ chegou_ao_handler: true } as never);
  const supabase = bancoFalso(dados);
  const ator = { type: "ai_agent", id: "ag-1", role: "ai_operator" };
  const efeitos = criarEfeitoDasEscrituras();
  const ferramentas = pickToolsFromMcp({
    toolIds: ["crm_create_lead"],
    auth: { organizationId: ORG, role: "ai_operator", scopes: ["mcp:read", "mcp:write"], actor: ator, apiTokenId: "tok-1" },
    ctx: { organizationId: ORG, role: "ai_operator", actor: ator, apiTokenId: "tok-1", requestId: "req-1", supabase },
    supabase,
    pipelineIds: escopo,
    modulosLigados: MODULOS_OPCIONAIS,
    capacidadesLigadas: CAPACIDADES_DA_ORGANIZACAO,
    handoffToolEnabled: true,
    proposalAiDraftEnabled: true,
    handoffSignal: { triggered: false },
    contatoDoTurno: DO_TURNO,
    efeitos,
  } as never);
  const r = await ferramentas.crm_create_lead!.execute!(args, { toolCallId: "c1", messages: [] } as never);
  const chamadas = handler.mock.calls.map((c) => c[0] as Linha);
  handler.mockRestore();
  return { r: r as Linha, chamadas, desfecho: efeitos.desfechoDe("crm_create_lead") };
}

afterEach(() => vi.restoreAllMocks());

const SO_A_REFERENCIA = { contact_id: DO_TURNO, title: "Apartamento no Campolim", referencia_externa: REF };

describe("crm_create_lead com a referência do item e sem funil", () => {
  it("o handler recebe o funil e a etapa da receita", async () => {
    const { r, chamadas } = await executar(SO_A_REFERENCIA, tabelas({ pipeline_id: FUNIL, stage_id: ETAPA }));

    expect(r).toEqual({ chegou_ao_handler: true });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({ pipeline_id: FUNIL, stage_id: ETAPA, referencia_externa: REF });
  });

  it("funil da receita FORA do escopo do agente: recusado, o handler não roda", async () => {
    const { r, chamadas } = await executar(SO_A_REFERENCIA, tabelas({ pipeline_id: FUNIL, stage_id: ETAPA }), [OUTRO_FUNIL]);

    expect(chamadas).toHaveLength(0);
    expect(r).toMatchObject({ permitido: false });
  });

  it("receita sem destino: passa para a equipe e o handler não roda", async () => {
    const { r, chamadas } = await executar(SO_A_REFERENCIA, tabelas(null));

    expect(chamadas).toHaveLength(0);
    expect(r).toMatchObject({ erro: "sem_destino" });
    expect(String((r as { mensagem: string }).mensagem)).toContain("crm_request_human_handoff");
  });

  it("funil e etapa que o modelo informou não são trocados pelos da receita", async () => {
    const { chamadas } = await executar(
      { ...SO_A_REFERENCIA, pipeline_id: OUTRO_FUNIL, stage_id: OUTRA_ETAPA },
      tabelas({ pipeline_id: FUNIL, stage_id: ETAPA }),
      [OUTRO_FUNIL],
    );

    expect(chamadas[0]).toMatchObject({ pipeline_id: OUTRO_FUNIL, stage_id: OUTRA_ETAPA });
  });

  it("negócio aberto pela referência conta como efeito produzido", async () => {
    const { desfecho } = await executar(SO_A_REFERENCIA, tabelas({ pipeline_id: FUNIL, stage_id: ETAPA }));

    expect(desfecho).toBe("produziu_efeito");
  });

  it("receita sem destino: o gate lê que a escrita falhou, não que ninguém tentou", async () => {
    const { desfecho } = await executar(SO_A_REFERENCIA, tabelas(null));

    expect(desfecho).toBe("falhou");
  });

  it("item inventado: o negócio não nasce e o gate lê que a escrita falhou", async () => {
    conferirItem.mockResolvedValueOnce({ ok: false, motivo: "item_inexistente", mensagem: "não existe" } as never);

    const { r, chamadas, desfecho } = await executar(SO_A_REFERENCIA, tabelas({ pipeline_id: FUNIL, stage_id: ETAPA }));

    expect(chamadas).toHaveLength(0);
    expect(r).toMatchObject({ erro: "item_inexistente" });
    expect(desfecho).toBe("falhou");
  });
});
