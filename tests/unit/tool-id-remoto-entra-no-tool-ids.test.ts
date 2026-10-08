// @vitest-environment node
/**
 * O item 6 do desenho (#2147) — CADA AGENTE ESCOLHE AS PRÓPRIAS FERRAMENTAS —
 * no id e nos quatro pontos que o validam.
 *
 * Um id remoto tem de atravessar a MESMA régua de sempre em todos eles
 * (`tool_ids` do zod, publicação, os dois espelhos de `_actions.ts`), porque
 * aceitar num e recusar no outro faria a tela salvar e a publicação devolver
 * `tool_id_invalid` com o mesmo dado. E sem escolha não há ferramenta remota
 * (item 7): registrar o servidor não dá ferramenta a agente nenhum.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  usuario: null as Record<string, unknown> | null,
  org: { orgId: "0be7a70c-0000-4000-8000-000000000001", name: "Org Ativa" } as {
    orgId: string;
    name: string;
  } | null,
  montado: null as unknown,
}));

// Fronteiras: sessão e a descoberta (que faria rede). A RÉGUA de permissão e o
// montador de ids são os de produção.
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => estado.usuario),
  resolveActiveOrg: vi.fn(async () => estado.org),
  mfaEmDivida: vi.fn(async () => false),
  sessionAal: vi.fn(async () => "aal2"),
}));
vi.mock("@/lib/mcp/servidor-externo/carregar", () => ({
  carregarServidorMcpExterno: vi.fn(async () => estado.montado),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
// A regra de permissão consulta a tabela de donos da instalação; a fronteira é
// esta — a RÉGUA em si é a de produção.
vi.mock("@/lib/supabase/server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createClient: vi.fn(async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            maybeSingle: async () => ({
              data: { scope: "full", mfa_required: false },
              error: null,
            }),
          }),
        }),
      }),
    }),
  })),
}));

import { listarFerramentasMcpExternas } from "@/app/actions/settings/listarFerramentasMcpExternas";
import { versionCreateSchema } from "@/lib/ai/agents/validation";
import {
  PREFIXO_TOOL_ID_MCP_EXTERNO,
  ehToolIdRemoto,
  escolhasRemotas,
  lerToolIdRemoto,
  toolIdAceito,
  toolIdRemoto,
} from "@/lib/mcp/servidor-externo/ids";

const CATALOGO = new Set(["crm_search_products", "crm_list_followups"]);

describe("o id da ferramenta remota (item 6)", () => {
  it("o prefixo é estável — é por ele que o editor lista o que o agente pode marcar", () => {
    expect(PREFIXO_TOOL_ID_MCP_EXTERNO).toBe("mcp_externo:");
    expect(toolIdRemoto("erp_achar", "leitura")).toBe("mcp_externo:leitura:erp_achar");
    expect(toolIdRemoto("erp_achar", "escrita")).toBe("mcp_externo:escrita:erp_achar");
  });

  it("o id monta e o id desmonta, nos dois sentidos", () => {
    expect(lerToolIdRemoto("mcp_externo:leitura:erp_achar")).toEqual({
      nome: "erp_achar",
      leitura: true,
    });
    expect(lerToolIdRemoto("mcp_externo:escrita:erp_achar")).toEqual({
      nome: "erp_achar",
      leitura: false,
    });
  });

  it("id compilado NÃO é lido como remota (o `null` do prefixo ausente)", () => {
    expect(lerToolIdRemoto("crm_search_products")).toBeNull();
    expect(ehToolIdRemoto("crm_search_products")).toBe(false);
  });

  it("forma inválida não vale como escolha: marca desconhecida, nome fora do protocolo, sobra", () => {
    expect(lerToolIdRemoto("mcp_externo:admin:erp_achar")).toBeNull();
    expect(lerToolIdRemoto("mcp_externo:leitura:")).toBeNull();
    expect(lerToolIdRemoto("mcp_externo:leitura:tem espaço")).toBeNull();
    expect(lerToolIdRemoto("mcp_externo:leitura:erp:achar")).toBeNull();
  });

  it("a escolha é deduplicada por nome — duas marcas não viram duas tools", () => {
    const escolhas = escolhasRemotas([
      "crm_search_products",
      "mcp_externo:leitura:erp_achar",
      "mcp_externo:escrita:erp_achar",
    ]);
    expect(escolhas).toEqual([{ nome: "erp_achar", leitura: true }]);
  });

  it("sem escolha remotas não há escolha nenhuma — o padrão é VAZIO (item 7)", () => {
    expect(escolhasRemotas([])).toEqual([]);
    expect(escolhasRemotas(["crm_search_products"])).toEqual([]);
  });
});

/** O mínimo que o schema da versão exige: o resto tem default. */
const BASE = {
  system_prompt: "prompt de teste suficientemente longo",
  provider: "anthropic",
  model: "claude",
  credential_id: null,
  channel_session_id: null,
};

describe("os quatro pontos que validam `tool_ids` aceitam a remota", () => {
  it("o predicado único aceita catálogo E remota bem formada, e recusa o resto", () => {
    expect(toolIdAceito("crm_search_products", CATALOGO)).toBe(true);
    expect(toolIdAceito("mcp_externo:leitura:erp_achar", CATALOGO)).toBe(true);
    expect(toolIdAceito("mcp_externo:leitura:tem espaço", CATALOGO)).toBe(false);
    expect(toolIdAceito("id_que_nao_existe", CATALOGO)).toBe(false);
  });

  it("o zod da VERSÃO não recusa a escolha remota", () => {
    const versao = versionCreateSchema.safeParse({
      ...BASE,
      tool_ids: ["crm_search_products", "mcp_externo:leitura:erp_achar"],
    });
    expect(versao.success, JSON.stringify(versao.success ? [] : versao.error.issues)).toBe(true);
  });

  it("o zod da VERSÃO continua recusando id que não existe", () => {
    const versao = versionCreateSchema.safeParse({
      ...BASE,
      tool_ids: ["id_que_nao_existe"],
    });
    expect(versao.success).toBe(false);
    expect(versao.success ? [] : versao.error.issues.map((i) => i.message)).toContain(
      "tool_id_invalid",
    );
  });
});

// ─── A listagem que o editor do agente consiga fazer (item 6) ────────────────

describe("o editor do agente lista o que o servidor remoto oferece", () => {
  beforeEach(() => {
    estado.usuario = {
      id: "11111111-1111-4111-8111-111111111111",
      is_platform_admin: true,
      support: null,
      idioma: "pt",
    };
    estado.org = { orgId: "0be7a70c-0000-4000-8000-000000000001", name: "Org Ativa" };
    estado.montado = {
      servidor: { endpoint: "https://erp.loja:8443/mcp/v1/pedidos", chave: "segredo" },
      ferramentas: [
        { name: "erp_consultar", description: "Consulta pedidos", somenteLeitura: true },
        { name: "erp_cancelar" },
      ],
    };
  });

  it("sem sessão: nada a listar", async () => {
    estado.usuario = null;
    expect(await listarFerramentasMcpExternas()).toEqual({ ok: false, error: "unauthenticated" });
  });

  it("quem não é dono da instalação não recebe nem os nomes das tools", async () => {
    estado.usuario = { id: "u", is_platform_admin: false, support: null, idioma: "pt" };
    expect(await listarFerramentasMcpExternas()).toEqual({ ok: false, error: "forbidden_role" });
  });

  it("sem registro: `sem_servidor` — lista vazia não é lista cheia", async () => {
    estado.montado = null;
    expect(await listarFerramentasMcpExternas()).toEqual({ ok: false, error: "sem_servidor" });
  });

  it("devolve os dois ids da DECLARADA e só o de escrita na não declarada", async () => {
    const resultado = await listarFerramentasMcpExternas();
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    // Host SEM caminho, na mesma régua da trilha de auditoria (item 5).
    expect(resultado.host).toBe("erp.loja:8443");

    const [consultar, cancelar] = resultado.ferramentas;
    expect(consultar!.ids).toEqual([
      "mcp_externo:leitura:erp_consultar",
      "mcp_externo:escrita:erp_consultar",
    ]);
    expect(consultar!.declaradaLeitura).toBe(true);
    expect(cancelar!.ids).toEqual(["mcp_externo:escrita:erp_cancelar"]);
    expect(cancelar!.declaradaLeitura).toBe(false);

    // O que a listagem devolve é exatamente o que a validação do agente aceita.
    for (const opcao of resultado.ferramentas) {
      for (const id of opcao.ids) {
        expect(ehToolIdRemoto(id)).toBe(true);
        expect(toolIdAceito(id, CATALOGO)).toBe(true);
        expect(versionCreateSchema.safeParse({ ...BASE, tool_ids: [id] }).success).toBe(true);
      }
    }
  });

  it("só a ferramenta que o servidor DECLAROU oferece a marca `leitura`", async () => {
    const resultado = await listarFerramentasMcpExternas();
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    const ids = resultado.ferramentas.flatMap((f) => f.ids);
    // Ausência de `readOnlyHint` nunca vira opção de leitura — é o item 8
    // saindo pela porta do editor, junto da marca que o administrador escolhe.
    expect(ids.filter((id) => lerToolIdRemoto(id)?.leitura)).toEqual([
      "mcp_externo:leitura:erp_consultar",
    ]);
  });
});
