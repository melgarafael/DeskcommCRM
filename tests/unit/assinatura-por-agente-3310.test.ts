/**
 * #3310 (parte 3, separada do #3318 para decisão do dono) — a assinatura da IA
 * com mais de um agente no mesmo número. Trabalho de @webtecnica.
 *
 * Decisão do dono (doc 191, opção B): o nome do agente só vale com o
 * interruptor `por_agente` LIGADO. Desligado — o padrão, e o estado de toda
 * organização que já existia —, a IA assina com o `nome_ia` de sempre.
 *
 * Sabotagem que este arquivo pega:
 * - `linhaDeAssinatura` ignorar `porAgente` (nome do agente sempre): o bloco
 *   "interruptor DESLIGADO" cai.
 * - `configAssinatura` ligar `por_agente` com qualquer valor truthy: o caso
 *   "só o true liga" cai.
 */
import { describe, expect, it, vi } from "vitest";

import { configAssinatura, linhaDeAssinatura, nomeDaAssinaturaDaIA } from "@/lib/messaging/assinatura";
import { nomeDoAgenteDeIA } from "@/lib/messaging/nome-do-agente-de-ia";

const ORG = "00000000-0000-4000-8000-000000000001";
const LEAD = "00000000-0000-4000-8000-000000000002";

describe("#3310 · assinatura — quem falou assina, não quem a organização configurou", () => {
  const config = configAssinatura({
    assinatura_mensagens: { humanos: true, ia: true, nome_ia: "Assistente Virtual", por_agente: true },
  });

  it("o nome do AGENTE que enviou ganha do `nome_ia` da organização", () => {
    expect(nomeDaAssinaturaDaIA(config, "Bia da Locação")).toBe("Bia da Locação");
    expect(linhaDeAssinatura(config, "ai", null, "Bia da Locação")).toBe("*Bia da Locação*\n");
  });

  it("sem agente (ou sem nome), a reserva é o `nome_ia` de sempre", () => {
    expect(nomeDaAssinaturaDaIA(config, null)).toBe("Assistente Virtual");
    expect(nomeDaAssinaturaDaIA(config, "   ")).toBe("Assistente Virtual");
    expect(linhaDeAssinatura(config, "ai", null, null)).toBe("*Assistente Virtual*\n");
    expect(linhaDeAssinatura(config, "ai", null)).toBe("*Assistente Virtual*\n");
  });

  it("nome de agente que desmonta a linha (`*`, quebra de linha) cai na reserva", () => {
    expect(nomeDaAssinaturaDaIA(config, "Bia *Locação*")).toBe("Assistente Virtual");
    expect(nomeDaAssinaturaDaIA(config, "Bia\nLocação")).toBe("Assistente Virtual");
  });

  it("um id que não é de agente nem chega ao banco (aviso do sistema assina com `nome_ia`)", async () => {
    const supabase = { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn() })) })) };
    await expect(
      nomeDoAgenteDeIA(supabase as never, ORG, "handoff-orchestrator"),
    ).resolves.toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("o nome do agente é lido da organização certa, e uma falha não derruba o envio", async () => {
    const cadeia = (resultado: { data: unknown; error: unknown }) => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => resultado }) }) }),
    });
    const ok = { from: vi.fn(() => cadeia({ data: { name: "Bia da Locação" }, error: null })) };
    await expect(nomeDoAgenteDeIA(ok as never, ORG, LEAD)).resolves.toBe("Bia da Locação");

    const falha = { from: vi.fn(() => cadeia({ data: null, error: { message: "boom" } })) };
    await expect(nomeDoAgenteDeIA(falha as never, ORG, LEAD)).resolves.toBeNull();
  });
});

describe("#3310 · o interruptor `por_agente` (doc 191, opção B)", () => {
  const base = { humanos: true, ia: true, nome_ia: "Assistente Virtual" };

  it("interruptor DESLIGADO (ausente ou false): a IA assina com o `nome_ia`, mesmo com agente", () => {
    for (const config of [
      configAssinatura({ assinatura_mensagens: base }),
      configAssinatura({ assinatura_mensagens: { ...base, por_agente: false } }),
    ]) {
      expect(config.porAgente).toBe(false);
      expect(linhaDeAssinatura(config, "ai", null, "Bia da Locação")).toBe("*Assistente Virtual*\n");
    }
  });

  it("interruptor LIGADO: a IA assina com o nome do agente que enviou", () => {
    const config = configAssinatura({ assinatura_mensagens: { ...base, por_agente: true } });
    expect(config.porAgente).toBe(true);
    expect(linhaDeAssinatura(config, "ai", null, "Bia da Locação")).toBe("*Bia da Locação*\n");
  });

  it("só o booleano `true` liga (a régua da casa)", () => {
    for (const lixo of ["true", 1, "sim", null]) {
      expect(configAssinatura({ assinatura_mensagens: { ...base, por_agente: lixo } }).porAgente).toBe(false);
    }
  });

  it("a assinatura da IA desligada não assina, com ou sem o interruptor", () => {
    const config = configAssinatura({ assinatura_mensagens: { ...base, ia: false, por_agente: true } });
    expect(linhaDeAssinatura(config, "ai", null, "Bia da Locação")).toBeNull();
  });
});
