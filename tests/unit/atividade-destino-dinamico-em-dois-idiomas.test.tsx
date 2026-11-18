import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityTab } from "@/app/app/webhooks/_components/ActivityTab";
import type { AutomationRuleRunRow } from "@/hooks/webhooks/useAutomationRules";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/**
 * O DESTINO DINÂMICO (#3804) NA ABA ATIVIDADE, EM PORTUGUÊS E EM ESPANHOL.
 *
 * A ação grava em `explicacao` a frase pronta, COM o nome de quem recebeu
 * ("Ficou com Ana, o responsável do negócio."). Essa string muda a cada negócio
 * e nunca casa com o dicionário: quem lia em espanhol via português, e o CI
 * ficava verde porque nenhum teste renderizava a aba em outro idioma. A tela
 * traduz o MOLDE escolhido por `detail.destino` e só depois cola o nome — o
 * mesmo caminho da vez do rodízio (#2041).
 *
 * O tradutor aqui é o de produção (`traduzir`), não uma identidade: é ele que
 * decide se a chave existe. Os detalhes abaixo têm a forma que
 * `lib/automation/actions/assign-owner.ts` grava, `explicacao` inclusive.
 *
 * Roda com: npx vitest run tests/unit/atividade-destino-dinamico-em-dois-idiomas.test.tsx
 */

const estado = vi.hoisted(() => ({ runs: [] as unknown[], idioma: "pt-BR" as string }));

vi.mock("@/hooks/webhooks/useAutomationRules", () => ({
  useAutomationRuns: () => ({
    data: { data: estado.runs },
    isLoading: false,
    refetch: vi.fn(),
    isRefetching: false,
  }),
  useResendAutomationRun: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/i18n/useT", () => ({
  useT: () => (texto: string) => traduzir(texto, estado.idioma as Idioma),
}));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({
  useLocaleDeData: () => undefined,
  useTagDeIdioma: () => "pt-BR",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

afterEach(cleanup);

function telaDaAba(idioma: Idioma, acao: AutomationRuleRunRow["actions_result"][number]): string {
  estado.idioma = idioma;
  estado.runs = [
    {
      id: "run-1",
      organization_id: "org-1",
      rule_id: "rule-1",
      event_id: null,
      status: acao.status === "success" ? "success" : "failed",
      actions_result: [acao],
      error: null,
      created_at: new Date().toISOString(),
      automation_rules: { name: "Pós-venda do vendedor" },
    } satisfies AutomationRuleRunRow,
  ];
  render(<ActivityTab />);
  return document.body.textContent ?? "";
}

function sucesso(destino: string, explicacao: string) {
  return {
    type: "assign_owner",
    status: "success" as const,
    detail: { user_id: "u-1", nome: "Andreia", destino, explicacao },
  };
}

const CASOS = [
  {
    destino: "responsavel_do_negocio",
    gravada: "Ficou com Andreia, o responsável do negócio.",
    es: "Quedó con Andreia, el responsable del negocio.",
  },
  {
    destino: "dono_da_carteira",
    gravada: "Ficou com Andreia, o dono da carteira do cliente.",
    es: "Quedó con Andreia, el dueño de la cartera del cliente.",
  },
  {
    destino: "fallback_fixo",
    gravada: "Nenhum destino do negócio serviu: ficou com Andreia, a pessoa fixa do fallback.",
    es: "Ningún destino del negocio sirvió: quedó con Andreia, la persona fija del respaldo.",
  },
] as const;

describe("aba Atividade: quem recebeu pelo destino dinâmico", () => {
  for (const caso of CASOS) {
    it(`${caso.destino}: em português, a frase de sempre`, () => {
      expect(telaDaAba("pt-BR", sucesso(caso.destino, caso.gravada))).toContain(caso.gravada);
    });

    it(`${caso.destino}: em espanhol, o molde traduzido com o nome colado depois`, () => {
      const tela = telaDaAba("es", sucesso(caso.destino, caso.gravada));
      expect(tela).toContain(caso.es);
      expect(tela).not.toContain(caso.gravada);
    });
  }

  it("ninguém pôde receber: a frase gravada pela ação também sai em espanhol", () => {
    const acao = {
      type: "assign_owner",
      status: "failed" as const,
      error: "sem_destino",
      detail: {
        destino: "sem_destino",
        explicacao:
          "Ninguém pôde receber este negócio: o responsável e a carteira do cliente não existem ou estão fora da equipe, e o fallback também não pôde atender. O negócio ficou sem responsável.",
      },
    };

    expect(telaDaAba("es", acao)).toContain(
      "Nadie pudo recibir este negocio: el responsable y la cartera del cliente no existen o están fuera del equipo, y el respaldo tampoco pudo atender.",
    );
  });
});
