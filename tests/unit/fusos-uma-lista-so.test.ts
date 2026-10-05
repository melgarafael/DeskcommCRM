/**
 * Toda tela que pergunta o fuso oferece a MESMA lista.
 *
 * Eram quatro listas: o onboarding (12 fusos), Configurações › Empresa e
 * Configurações › Perfil (8 cada, escritas à mão) e `FUSOS_OFERECIDOS` (jornada
 * do atendente e janela anti-ban). Quem escolhia Madri, Cuiabá, Rio Branco,
 * Nova York ou Los Angeles no primeiro acesso abria Configurações e encontrava
 * o fuso fora das opções — e `fusoOferecidoOuPadrao` mostrava São Paulo. Roma
 * (a pedido de quem opera da Itália) não existia em nenhuma.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FUSOS_DO_ONBOARDING, FUSOS_OFERECIDOS, fusoOferecidoOuPadrao, fusoValido } from "@/lib/tempo/fusos";

const oferecidos = new Set(FUSOS_OFERECIDOS.map((f) => f.codigo));

describe("fusos: uma lista só", () => {
  it("todo fuso do onboarding aparece nas telas de configuração", () => {
    const fora = FUSOS_DO_ONBOARDING.map((f) => f.id).filter((id) => !oferecidos.has(id));
    expect(fora).toEqual([]);
  });

  it("quem escolhe Roma no onboarding continua vendo Roma depois", () => {
    expect(FUSOS_DO_ONBOARDING.map((f) => f.id)).toContain("Europe/Rome");
    expect(fusoOferecidoOuPadrao("Europe/Rome")).toBe("Europe/Rome");
    expect(fusoOferecidoOuPadrao("Europe/Madrid")).toBe("Europe/Madrid");
  });

  it("toda opção é um fuso que o Intl aceita", () => {
    const invalidos = [...oferecidos, ...FUSOS_DO_ONBOARDING.map((f) => f.id)].filter((tz) => !fusoValido(tz));
    expect(invalidos).toEqual([]);
  });

  it.each(["app/app/settings/tenant/_form.tsx", "app/app/settings/profile/_form.tsx", "app/onboarding/welcome/_form.tsx"])(
    "%s não escreve lista de fuso à mão",
    (arquivo) => {
      const fonte = readFileSync(join(process.cwd(), arquivo), "utf8");
      // Um identificador IANA literal na tela é o sinal de uma lista paralela.
      expect(fonte).not.toMatch(/["'](?:America|Europe|Africa)\/[A-Za-z_]+["']/);
    },
  );
});
