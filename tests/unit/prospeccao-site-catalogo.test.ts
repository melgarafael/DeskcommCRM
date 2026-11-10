/**
 * A análise do site no catálogo: existe, é só leitura, e não entra sozinha.
 *
 * O ponto que este arquivo guarda é o de não-ligar-sozinho. Agente já publicado
 * tem `tool_ids` gravado por versão, e só a pessoa, marcando na tela, acrescenta
 * a ferramenta. Por isso a prova aqui é de QUEM ENTRA NO PACOTE DE PARTIDA: o
 * agente que nasce no onboarding não a recebe, e a jornada `atender` (que o
 * teste da recusa da spec mede exata) continua do mesmo tamanho.
 */
import { describe, expect, it } from "vitest";

import { allTools } from "@/lib/mcp/tools";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalogo";
import { FERRAMENTAS_DO_HARNESS } from "@/lib/mcp/tools/ferramentas-do-harness";
import { ligarPacote } from "@/lib/mcp/tools/selecao-por-pacote";
import { capacidadesPadraoDoOnboarding, catalogoComHandler, PACOTE_PADRAO_DO_ONBOARDING } from "@/lib/ai/agents/capacidades-padrao";

const NOME = "crm_get_prospecting_site_audit";

describe("crm_get_prospecting_site_audit — catálogo", () => {
  it("existe no catálogo e no agregador de handlers", () => {
    expect(TOOL_CATALOG.some((t) => t.name === NOME)).toBe(true);
    expect(allTools.some((t) => t.name === NOME)).toBe(true);
  });

  it("é só leitura: risco seguro e categoria read", () => {
    const entrada = TOOL_CATALOG.find((t) => t.name === NOME);
    expect(entrada?.risco).toBe("seguro");
    expect(entrada?.category).toBe("read");
  });

  it("não é capacidade do harness (o motor a monta, não é descartada)", () => {
    expect(FERRAMENTAS_DO_HARNESS.some((f) => f.id === NOME)).toBe(false);
  });

  it("o agente que nasce no onboarding NÃO a recebe", () => {
    expect(capacidadesPadraoDoOnboarding()).not.toContain(NOME);
  });

  it("ligar a jornada de partida não a traz (ela não está no pacote padrão)", () => {
    const ligadas = ligarPacote([], catalogoComHandler(), PACOTE_PADRAO_DO_ONBOARDING);
    expect(ligadas).not.toContain(NOME);
  });

  it("não entra na jornada 'atender', cuja conta de vagas é medida exata pela spec da tela", () => {
    const ligadasAtender = ligarPacote([], catalogoComHandler(), "atender");
    expect(ligadasAtender).not.toContain(NOME);
  });
});
