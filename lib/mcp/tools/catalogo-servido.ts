/**
 * A junção entre o que o servidor SABE EXECUTAR (os handlers) e o que o humano
 * PRECISA LER para decidir (a camada de apresentação do catálogo).
 *
 * As duas metades vivem separadas por um motivo: `lib/mcp/tools/index.ts`
 * importa zod, supabase e os handlers — nada disso pode entrar num Client
 * Component. A tela consome esta junção pela rota `/api/v1/mcp/tools`.
 *
 * Por que falhar alto em vez de servir o que der: uma capacidade sem rótulo
 * chega à tela como um `crm_archive_lead` em fonte monoespaçada dentro de um
 * card de pacote. O leigo não configura o que não entende, e o defeito é
 * invisível para quem escreveu a tool — ele vê o `name`, que sempre existe.
 * Divergência entre as metades é erro de programação, não estado do usuário:
 * lança na primeira leitura, em qualquer ambiente.
 */
import type { McpToolCatalogEntry } from "./catalogo";
import type { ToolBundle, ToolRisk } from "./pacotes";
import { IDS_DO_HARNESS, motivoDoHarness } from "./ferramentas-do-harness";

/** Só o que a junção precisa de um handler — mantém a função testável sem zod. */
export interface HandlerDeclarado {
  name: string;
  description: string;
  category: string;
  requiresRole: string;
  requiresScope: string;
}

/** snake_case no wire, conforme a convenção da API (`CLAUDE.md`). */
export interface CapacidadeServida {
  id: string;
  description: string;
  category: string;
  requires_role: string;
  requires_scope: string;
  rotulo: string;
  explicacao: string;
  o_que_toca: string;
  risco: ToolRisk;
  pacotes: ReadonlyArray<ToolBundle>;
  /**
   * `false` = a capacidade é do harness: a tela MOSTRA (o humano precisa saber
   * que aquilo existe e já acontece sozinho) e não deixa marcar.
   *
   * A tela marcava, o dono salvava, o engine descartava — e o único sinal era
   * um `log.warn` no log do worker. O campo existe para que o descarte nunca
   * mais seja invisível para quem configura.
   */
  marcavel: boolean;
  /** Por que não é marcável, em pt-BR para a tela. `null` quando é marcável. */
  motivo_nao_marcavel: string | null;
}

export function juntarCatalogoComHandlers(
  handlers: ReadonlyArray<HandlerDeclarado>,
  catalogo: ReadonlyArray<McpToolCatalogEntry>,
): CapacidadeServida[] {
  const porNome = new Map(catalogo.map((entrada) => [entrada.name, entrada]));

  return handlers.map((handler) => {
    const entrada = porNome.get(handler.name);
    if (!entrada) {
      throw new Error(
        `mcp/tools: handler "${handler.name}" nao tem entrada em lib/mcp/tools/catalogo/ — ` +
          `a tela mostraria a capacidade sem rotulo nem explicacao`,
      );
    }
    return {
      id: handler.name,
      description: handler.description,
      category: handler.category,
      requires_role: handler.requiresRole,
      requires_scope: handler.requiresScope,
      rotulo: entrada.rotulo,
      explicacao: entrada.explicacao,
      o_que_toca: entrada.oQueToca,
      risco: entrada.risco,
      pacotes: entrada.pacotes,
      marcavel: !IDS_DO_HARNESS.has(handler.name),
      motivo_nao_marcavel: motivoDoHarness(handler.name),
    };
  });
}
