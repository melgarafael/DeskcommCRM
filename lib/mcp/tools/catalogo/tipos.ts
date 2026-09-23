/**
 * Shape de uma entrada do catalogo de tools.
 *
 * Separado do agregador (`lib/mcp/tools/catalog.ts`) para que cada dominio
 * declare suas capacidades no proprio arquivo sem que times paralelos colidam
 * no mesmo hunk. Client-safe: zero import de zod, supabase ou next/headers.
 */
import type { ModuloOpcional } from "@/lib/instalacao/modulos";

import type { McpToolCategory } from "../../types";
import type { ToolBundle, ToolRisk } from "../pacotes";

export interface McpToolCatalogEntry {
  /** CONTRATO DE WIRE — imutavel depois de publicado. */
  name: string;
  /** Dirige requiresScope/requiresRole. Nao e rotulo de tela. */
  category: McpToolCategory;

  // ---- camada de apresentacao: o que o HUMANO le ----
  /** Verbo no infinitivo, pt-BR. Ex: "Mover oportunidade de etapa". */
  rotulo: string;
  /** O que acontece quando a IA usa isto, em portugues de gente (>= 40 chars). */
  explicacao: string;
  /** O recurso na linguagem do usuario. Ex: "Funil de vendas". */
  oQueToca: string;
  risco: ToolRisk;
  /** >= 1 pacote. Uma capacidade pode servir a mais de uma jornada. */
  pacotes: ReadonlyArray<ToolBundle>;
  /**
   * Capacidade operada por PESSOA, nunca pelo agente.
   *
   * Existe porque nem toda tool do catalogo deve estar ao alcance da IA. O
   * exemplo que originou o campo: retomar o atendimento automatico depois que
   * uma pessoa assumiu. `lib/agent-engine/agent/inbound-turn.ts` registra a
   * regra dura — "so o humano/CRM libera, o agente nunca reassume" — e um
   * agente que pudesse chamar essa tool se auto-liberaria do proprio handoff.
   *
   * Marcar aqui NAO e o que impede: quem impede e `requiresRole` acima do papel
   * do agente. A marca serve para (a) distinguir a restricao DELIBERADA do
   * acidente que o gate de alcancabilidade caca, e (b) dizer a tela que essa
   * capacidade e operada por gente — senao o dono liga achando que o agente vai
   * usar, e ela nunca dispara.
   */
  apenasHumano?: boolean;
  /**
   * Capacidade de um MODULO OPCIONAL da instalacao (`lib/instalacao/modulos.ts`).
   * Com o modulo desligado ela nao e oferecida a ninguem — nem ao agente, nem
   * ao cliente MCP externo, nem a tela que escolhe capacidades. Ver
   * `deModuloDesligado` em `./index.ts`.
   */
  modulo?: ModuloOpcional;
}

/**
 * Helper de declaracao. Existe para dar erro de tipo no arquivo do dominio —
 * sem ele, o objeto so seria checado no agregador e a mensagem apontaria para
 * o arquivo errado.
 */
export function declararTools(
  entradas: ReadonlyArray<McpToolCatalogEntry>,
): ReadonlyArray<McpToolCatalogEntry> {
  return entradas;
}
