/**
 * A capacidade marcada como operada por PESSOA não chega ao turno do agente.
 *
 * Achado com IA real (W1): `crm_create_stage` aparecia no painel de uso como
 * "1 tentativa, 1 falha". A capacidade estava corretamente marcada
 * `apenasHumano: true` no catálogo, mas a ponte montava a tool assim mesmo — o
 * dono ligava na tela, o modelo GASTAVA uma chamada, e só então o servidor
 * recusava por papel.
 *
 * Duas coisas erradas nisso: o modelo aprendia o limite ERRANDO (em vez de
 * simplesmente não ter a ferramenta), e o painel registrava falha onde não havia
 * defeito nenhum — poluindo justamente o número que o dono usa para decidir o
 * que desligar.
 *
 * A marca era declaração sem efeito: existia no catálogo e não era aplicada no
 * runtime. Este teste guarda o efeito, não a marca.
 */
import { describe, expect, it } from "vitest";

import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import { allTools } from "@/lib/mcp/tools";
import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "11111111-1111-4111-8111-111111111111";

function contexto() {
  const ctx = {
    organizationId: ORG,
    role: "ai_operator",
    actor: { type: "ai_agent", id: "agente-1", role: "ai_operator" },
    apiTokenId: "tok-1",
    requestId: "run-1",
    supabase: {} as never,
  } as unknown as McpContext;
  const auth = {
    organizationId: ORG,
    role: "ai_operator",
    actor: ctx.actor,
    apiTokenId: "tok-1",
    scopes: ["mcp:read", "mcp:write", "actor:ai_agent", "role:ai_operator"],
  } as unknown as McpAuthResult;
  return { ctx, auth };
}

describe("a ponte do turno respeita `apenasHumano`", () => {
  const apenasHumano = TOOL_CATALOG.filter((t) => t.apenasHumano).map((t) => t.name);
  // Capacidade de MÓDULO opcional (ADR-0002) some do turno quando o módulo não
  // está instalado — `contexto()` abaixo não passa `modulosLigados`, então
  // `deModuloDesligado` trata todo `modulo:` como desligado, de propósito
  // (mesma regra de `deModuloDesligado`/`pickToolsFromMcp`). Contar isso à
  // parte, e não estufar o "-3" fixo, é o que mantém este teste medindo o
  // filtro cego que ele foi escrito para pegar, e não a soma dos dois efeitos.
  const semModulo = TOOL_CATALOG.filter((t) => t.modulo).length;

  it("existe ao menos uma capacidade marcada (guarda de vacuidade)", () => {
    // Sem isto, remover a marca de todas faria o teste abaixo passar por
    // ausência de dado — verde por não haver o que verificar.
    expect(apenasHumano.length).toBeGreaterThan(0);
  });

  it("nenhuma capacidade de pessoa é montada no turno do agente", () => {
    const { ctx, auth } = contexto();
    const montadas = pickToolsFromMcp({
      supabase: ctx.supabase,
      ctx,
      auth,
      // Pede TODAS: simula o dono tendo ligado tudo o que a tela oferece.
      toolIds: allTools.map((t) => t.name),
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
    });

    const vazaram = apenasHumano.filter((n) => n in montadas);
    expect(vazaram, `capacidades de pessoa montadas no turno: ${vazaram.join(", ")}`).toEqual([]);
  });

  it("as demais capacidades continuam chegando (não virou filtro cego)", () => {
    const { ctx, auth } = contexto();
    const montadas = pickToolsFromMcp({
      supabase: ctx.supabase,
      ctx,
      auth,
      toolIds: allTools.map((t) => t.name),
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
    });
    // Controle positivo: se o filtro derrubasse tudo, o teste acima passaria
    // vacuamente e o agente ficaria sem ferramenta nenhuma.
    expect(Object.keys(montadas).length).toBeGreaterThan(
      allTools.length - apenasHumano.length - semModulo - 3,
    );
    expect(montadas).toHaveProperty("crm_search_contacts");
  });
});
