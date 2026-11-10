// @vitest-environment node
/**
 * A ESCOLHA DO EDITOR CHEGA AO TURNO (#3586) — do `tool_ids` ao montador.
 *
 * ─── O que este arquivo prova, e por que ele existe separado do teste de tela
 *
 * O cartão do editor (`ServidorExternoNoAtendimento.test.tsx`) prova que marcar
 * grava `mcp_externo:*` no `tool_ids`. Isso, sozinho, não prova nada para o
 * cliente da #3586: o defeito dele era o agente SEM a ferramenta no turno. Aqui
 * se conta as ferramentas que o montador devolve — a MESMA função do turno
 * (`pickToolsFromMcp`) — com o `tool_ids` que o editor grava.
 *
 * A conta é a régua: o catálogo compilado do mesmo `tool_ids` sem as remotas, e
 * depois com elas. Marcar três tem de dar exatamente TRÊS ferramentas a mais;
 * marcar duas, duas; sem servidor registrado, nenhuma — porque a flag do
 * servidor e a escolha no `tool_ids` são duas condições, não uma.
 *
 * Roda com: pnpm vitest run tests/unit/mcp-externo-monta-pela-escolha.test.ts
 */
import { describe, expect, it, vi } from "vitest";

// A auditoria só atrapalharia o arranjo (o recuso é devolvido ao modelo).
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import type { FerramentaRemota } from "@/lib/mcp/servidor-externo/chamada";
import {
  desmarcarRemota,
  marcaDaRemota,
  marcarRemota,
  removerRemotasOrfas,
  remotasOrfas,
} from "@/lib/mcp/servidor-externo/escolha-do-editor";
import { escolhasRemotas, toolIdRemoto } from "@/lib/mcp/servidor-externo/ids";
import type { ServidorMcpExterno } from "@/lib/mcp/servidor-externo/registro";
import { definirFerramentasRemotas } from "@/lib/mcp/tools/externo";
import {
  ligarPacote,
  TETO_TOOLS_POR_AGENTE,
  vagasExigidasPeloPacote,
  vagasRestantes,
  type CapacidadeSelecionavel,
} from "@/lib/mcp/tools/selecao-por-pacote";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "bcc12320-f555-4fef-8d90-38a0ac5950e0";
const SERVIDOR: ServidorMcpExterno = { endpoint: "https://erp.loja/mcp", chave: "segredo" };

/** As três ferramentas do relato da #3586 — leitura de verdade no ERP dele. */
const FERRAMENTAS: FerramentaRemota[] = [
  { name: "buscar_carros", description: "Consulta o estoque ao vivo.", somenteLeitura: true },
  { name: "detalhes_carro", description: "Ficha de um carro.", somenteLeitura: true },
  { name: "resumo_estoque", somenteLeitura: true },
];

/** O `tool_ids` que o editor grava: catálogo + as três marcadas. */
const CATALOGO = ["crm_search_products", "crm_list_followups"];
const TRES_MARCADAS = FERRAMENTAS.map((f) => toolIdRemoto(f.name, "escrita"));

const auth = {
  organizationId: ORG,
  role: "ai_operator",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "d7ba0e68-0000-4000-8000-000000000001",
  scopes: ["mcp:read", "mcp:write"],
} as unknown as McpAuthResult;

function supabaseDeMentira() {
  const cadeia: Record<string, unknown> = {
    select: () => cadeia,
    eq: () => cadeia,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
  };
  return { from: () => cadeia } as never;
}

function contexto(supabase: unknown): McpContext {
  return {
    organizationId: ORG,
    role: auth.role,
    actor: auth.actor,
    apiTokenId: auth.apiTokenId,
    requestId: "3f7c1e50-0000-4000-8800-000000000358",
    supabase,
  } as unknown as McpContext;
}

function montar(opts: { toolIds: string[]; comServidor: boolean }) {
  const supabase = supabaseDeMentira();
  return pickToolsFromMcp({
    supabase: supabase,
    ctx: contexto(supabase),
    auth,
    toolIds: opts.toolIds,
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    ...(opts.comServidor
      ? { servidorMcpExterno: { servidor: SERVIDOR, ferramentas: FERRAMENTAS } }
      : {}),
  });
}

const nomes = (tools: Record<string, unknown>) => Object.keys(tools).sort();

describe("o turno monta as ferramentas que o editor marcou (#3586)", () => {
  it("três marcadas = exatamente TRÊS ferramentas a mais que o catálogo", () => {
    const semRemotas = montar({ toolIds: CATALOGO, comServidor: true });
    const comRemotas = montar({ toolIds: [...CATALOGO, ...TRES_MARCADAS], comServidor: true });

    expect(Object.keys(comRemotas).length).toBe(Object.keys(semRemotas).length + 3);
    for (const ferramenta of FERRAMENTAS) {
      expect(Object.keys(comRemotas)).toContain(ferramenta.name);
    }
    // As do catálogo continuam montadas: remota SOMA, nunca substitui.
    for (const id of CATALOGO) expect(Object.keys(comRemotas)).toContain(id);
  });

  it("desmarcar UMA derruba uma só: duas escolhas = duas ferramentas a mais", () => {
    const semRemotas = montar({ toolIds: CATALOGO, comServidor: true });
    const duas = desmarcarRemota([...CATALOGO, ...TRES_MARCADAS], "detalhes_carro");
    const comDuas = montar({ toolIds: duas, comServidor: true });

    expect(Object.keys(comDuas).length).toBe(Object.keys(semRemotas).length + 2);
    expect(Object.keys(comDuas)).toContain("buscar_carros");
    expect(Object.keys(comDuas)).toContain("resumo_estoque");
    expect(Object.keys(comDuas)).not.toContain("detalhes_carro");
  });

  it("sem servidor registrado, o mesmo tool_ids não monta remota nenhuma", () => {
    // É o "agente sem servidor não muda": a ESCOLHA sozinha não basta.
    const semServidor = montar({ toolIds: [...CATALOGO, ...TRES_MARCADAS], comServidor: false });
    const catalogoSo = montar({ toolIds: CATALOGO, comServidor: false });

    expect(nomes(semServidor)).toEqual(nomes(catalogoSo));
  });

  it("a marca do ADMINISTRADOR decide a categoria; a do servidor só permite a leitura", () => {
    const escolhas = escolhasRemotas([toolIdRemoto("buscar_carros", "leitura")]);
    const [leitura] = definirFerramentasRemotas(SERVIDOR, FERRAMENTAS, new Set(), escolhas);
    expect(leitura?.category).toBe("read");

    // Marcada leitura num servidor que NÃO declarou leitura: continua escrita.
    const mentirosas: FerramentaRemota[] = [{ name: "buscar_carros" }];
    const [semDeclaracao] = definirFerramentasRemotas(
      SERVIDOR,
      mentirosas,
      new Set(),
      escolhas,
    );
    expect(semDeclaracao?.category).toBe("write");

    // Declarada leitura mas marcada escrita pelo administrador: escrita.
    const [escrita] = definirFerramentasRemotas(
      SERVIDOR,
      FERRAMENTAS,
      new Set(),
      escolhasRemotas([toolIdRemoto("buscar_carros", "escrita")]),
    );
    expect(escrita?.category).toBe("write");
  });
});

describe("a regra de marcar/desmarcar do editor (função pura)", () => {
  const base = ["crm_search_products", toolIdRemoto("buscar_carros", "leitura")];

  it("marcar preserva o catálogo e o que já estava marcado", () => {
    expect(marcarRemota(base, "detalhes_carro", "escrita")).toEqual([
      ...base,
      "mcp_externo:escrita:detalhes_carro",
    ]);
  });

  it("marcar de novo no mesmo nome TROCA a marca, sem duplicar", () => {
    const depois = marcarRemota(base, "buscar_carros", "escrita");
    expect(depois).toEqual(["crm_search_products", "mcp_externo:escrita:buscar_carros"]);
    expect(escolhasRemotas(depois)).toHaveLength(1);
  });

  it("desmarcar tira só aquele nome", () => {
    const comTres = marcarRemota(marcarRemota(base, "detalhes_carro", "escrita"), "resumo_estoque", "escrita");
    const depois = desmarcarRemota(comTres, "detalhes_carro");
    expect(escolhasRemotas(depois).map((e) => e.nome)).toEqual(["buscar_carros", "resumo_estoque"]);
  });

  it("a marca lida do tool_ids é a que a caixa mostra", () => {
    expect(marcaDaRemota(base, "buscar_carros")).toBe("leitura");
    expect(marcaDaRemota(base, "detalhes_carro")).toBeNull();
    expect(marcaDaRemota(base, "crm_search_products")).toBeNull();
  });

  it("órfã é só o que o servidor NÃO anuncia; remover deixa o resto intacto", () => {
    const anunciadas = FERRAMENTAS.map((f) => f.name);
    const ids = [
      "crm_search_products",
      toolIdRemoto("buscar_carros", "leitura"),
      toolIdRemoto("carro_que_saiu_do_estoque", "leitura"),
    ];

    expect(remotasOrfas(ids, anunciadas).map((o) => o.nome)).toEqual([
      "carro_que_saiu_do_estoque",
    ]);
    expect(removerRemotasOrfas(ids, anunciadas)).toEqual([
      "crm_search_products",
      "mcp_externo:leitura:buscar_carros",
    ]);
  });

  it("id malformado não é escolha e não é tocado por desmarcar", () => {
    const ids = ["mcp_externo:admin:estranho", "crm_search_products"];
    expect(desmarcarRemota(ids, "estranho")).toEqual(ids);
    expect(remotasOrfas(ids, [])).toEqual([]);
  });
});

describe("o seletor de capacidades não apaga a escolha remota (#3586)", () => {
  const catalogo: CapacidadeSelecionavel[] = [
    { name: "crm_search_products", risco: "seguro", pacotes: ["atender"] },
    { name: "crm_send_whatsapp_message", risco: "critico", pacotes: ["atender"] },
  ];

  it("ligar um pacote preserva o id do servidor externo", () => {
    // O `ligarPacote` devolvia só nomes do catálogo: um clique num pacote
    // apagava a escolha do ERP em silêncio, e o agente ficava sem a ferramenta
    // de novo — o defeito da issue por outro caminho.
    const remota = toolIdRemoto("buscar_carros", "leitura");
    const depois = ligarPacote(["crm_search_products", remota], catalogo, "atender");
    expect(depois).toContain(remota);
    expect(depois).toContain("crm_search_products");
  });

  it("a remota conta no teto nas duas direções: vagas restantes e vaga exigida pelo pacote", () => {
    // 26 nativas fora do pacote + 1 remota = teto cheio. O pacote `atender`
    // traz 1 automática e 1 crítica (reservada): 27 + 2 = 29. Se a remota
    // sumisse da conta (ligarPacote a descartando, ou o seletor a filtrando),
    // daria 28 — e o seletor deixaria ligar uma capacidade além do zod.
    const nativas: CapacidadeSelecionavel[] = Array.from({ length: 26 }, (_, i) => ({
      name: `nativa_${i}`,
      risco: "seguro",
      pacotes: ["organizar"],
    }));
    const cat = [...nativas, ...catalogo];
    const sel = [...nativas.map((c) => c.name), toolIdRemoto("buscar_carros", "leitura")];

    expect(sel).toHaveLength(TETO_TOOLS_POR_AGENTE);
    expect(vagasRestantes(sel)).toBe(0);
    expect(vagasExigidasPeloPacote(sel, cat, "atender")).toBe(TETO_TOOLS_POR_AGENTE + 2);
  });
});
