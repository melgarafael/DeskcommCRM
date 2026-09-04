/**
 * O wizard não pode culpar a pessoa por uma tela que nunca lhe ofereceu.
 *
 * A ORDEM, os RÓTULOS e o RESUMO final vêm da mesma fonte — eram três listas
 * independentes que discordavam entre si.
 */
import { describe, expect, it } from "vitest";

import { passosVisiveis, proximoPasso, resumoDoOnboarding } from "@/lib/onboarding/passos";
import type { OnboardingState } from "@/lib/schemas/onboarding";

const VAZIO: OnboardingState = {};

describe("passos visíveis", () => {
  it("a ordem é a esperada", () => {
    expect(passosVisiveis().map((p) => p.segmento)).toEqual([
      "welcome",
      "connect-whatsapp",
      "setup-ai",
      // O quadro de clientes vem DEPOIS de treinar: a sugestão sai da chave que
      // a pessoa acabou de confirmar funcionando, e é o mesmo modelo que vai
      // atender. Pedi-lo antes obrigaria a montá-lo no escuro.
      "funil",
      // Ver o funcionário atender vem DEPOIS de treiná-lo e ANTES de chamar o
      // time: é a prova de que ele funciona, e ela precisa acontecer enquanto a
      // pessoa ainda está no wizard.
      "testar",
      "invite-team",
    ]);
  });
});

describe("próximo passo", () => {
  it("começa no primeiro", () => {
    expect(proximoPasso(VAZIO)?.segmento).toBe("welcome");
  });

  it("avança para o próximo passo pendente", () => {
    const s: OnboardingState = {
      welcome: { accepted_at: "x", timezone: "America/Sao_Paulo", display_name: "N" },
      whatsapp: { status: "WORKING" },
    };
    expect(proximoPasso(s)?.segmento).toBe("setup-ai");
  });

  it("passo PULADO conta como resolvido — senão o wizard entra em laço", () => {
    const s: OnboardingState = {
      welcome: { accepted_at: "x", timezone: "America/Sao_Paulo", display_name: "N" },
      whatsapp: { status: "skipped", skipped: true },
    };
    expect(proximoPasso(s)?.segmento).toBe("setup-ai");
  });

  it("tudo resolvido = não falta nenhum", () => {
    const s: OnboardingState = {
      welcome: { accepted_at: "x", timezone: "America/Sao_Paulo", display_name: "N" },
      whatsapp: { status: "WORKING" },
      ai: { agent_id: "a", prompt_template: "p" },
      funil: { pipeline_id: "f", origem: "ia", etapas: 6 },
      teste: { respondeu: true },
      team: { invites_sent: 0, skipped: true },
    };
    expect(proximoPasso(s)).toBeNull();
  });
});

describe("resumo final", () => {
  it("distingue feito de pulado — pular é escolha, não falha", () => {
    const s: OnboardingState = {
      welcome: { accepted_at: "x", timezone: "America/Sao_Paulo", display_name: "N" },
      whatsapp: { status: "skipped", skipped: true },
    };
    const resumo = resumoDoOnboarding(s);
    const porSegmento = new Map(resumo.map((i) => [i.segmento, i]));
    expect(porSegmento.get("welcome")).toMatchObject({ feito: true, pulado: false });
    expect(porSegmento.get("connect-whatsapp")).toMatchObject({ feito: false, pulado: true });
    // O que nem chegou a ser oferecido não é "pulado": é pendente.
    expect(porSegmento.get("setup-ai")).toMatchObject({ feito: false, pulado: false });
  });

  it("os rótulos nomeiam PEÇAS do funcionário, não telas do sistema", () => {
    // A moldura do redesenho. Um passo chamado "IA" não diz o que vai
    // acontecer ali; "Treinar" diz.
    const rotulos = resumoDoOnboarding(VAZIO).map((i) => i.rotulo);
    expect(rotulos).toContain("O telefone dele");
    expect(rotulos).toContain("Treinar");
    expect(rotulos).not.toContain("IA");
  });
});
