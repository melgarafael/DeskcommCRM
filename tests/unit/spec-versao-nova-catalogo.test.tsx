/**
 * O ESTADO "VERSÃO NOVA DO CATÁLOGO" DO PAINEL DE SKILLS TEM PROVA PELA TELA.
 *
 * A issue #1975 nasceu do vazio: desde o #1927 o painel ganhou o estado
 * `versao_nova_catalogo` + `comparativo`, o #1960 e o #1972 mexeram nele, e
 * nenhum spec citava `versao_nova_catalogo` — `app/app/ai/skills` não tinha
 * teste de componente nenhum. O que a tela FAZ com aqueles campos era afirmado
 * só por quem escreveu o JSX.
 *
 * ## O que este arquivo cobre (o "mínimo aceitável" que a própria issue aceita)
 *
 * Renderizar `SkillsClient` com `initialState` trazendo `comparativo` e cobrar
 * o texto que chega ao olho:
 *
 * 1. O aviso de versão nova fica visível quando `versao_nova_catalogo` é true.
 * 2. O título literal "Se você adotar a versão do catálogo, muda:" aparece.
 * 3. As contagens do comparativo chegam à tela: palavras-chave que ENTRAM (+)
 *    e que SAEM (−), e o placar de linhas do procedimento (+12 −3).
 * 4. Sem versão nova, não há aviso nem título (o estado não vaza para toda skill).
 * 5. Versão nova SEM comparativo: o aviso continua, o título some — a tela não
 *    promete detalhe que o backend não mandou.
 * 6. Só o campo que mudou é listado — `mudou_em` não vira catálogo completo.
 *
 * ## Por que renderizar, e não varrer o AST
 *
 * A varredura estática pegaria a CHAMADA `{t("Se você adotar…")}` no JSX e
 * passaria mesmo se a chamada ficasse dentro de um `&&` morto, de um ramo que
 * só abre com `canManage` falso ou de um componente que nunca é montado. O que
 * importa é o texto no DOM com o `initialState` que o SSR manda no primeiro
 * paint (`app/app/ai/skills/page.tsx` monta exatamente este shape).
 *
 * ## Os dublês
 *
 * `useSkills` devolve o `initialState` como `data` (é o que `initialData` do
 * react-query faria), então a árvore inteira monta sem rede e sem QueryClient.
 * `t` é identidade — cobrar o texto traduzido aqui esconderia exatamente o que
 * se quer provar; o dicionário é assunto de outra guarda.
 *
 * Roda com: npx vitest run tests/unit/spec-versao-nova-catalogo.test.tsx
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/ai/useSkills", () => ({
  // initialState vira o dado pronto — mesmo efeito de `initialData` no react-query.
  useSkills: (estado: unknown) => ({ data: estado }),
  useInstallSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useUninstallSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useImportSkill: () => ({ mutate: vi.fn(), isPending: false }),
  // Exportes que `./_components/EditorDeSkill` importa do mesmo módulo.
  useSkill: () => ({ data: undefined, isLoading: false }),
  useSalvarSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useSkillVersions: () => ({ data: [], isLoading: false }),
  useRestaurarSkill: () => ({ mutate: vi.fn(), isPending: false }),
}));
/** Identidade: o texto que o teste lê é o português que a tela mostra. */
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { SkillsClient } from "@/app/app/ai/skills/_client";
import type { InstalledSkill, SkillsState } from "@/hooks/ai/useSkills";

/** Literal de `app/app/ai/skills/_client.tsx` — copiado do código, não de memória. */
const AVISO =
  "Há uma versão nova desta skill no catálogo. Se você editou esta cópia, suas alterações ficam só no Histórico de versões: ao adotar, a versão nova do catálogo passa a ser a ativa. Confira antes de adotar.";
const TITULO = "Se você adotar a versão do catálogo, muda:";

/** Skill instalada do catálogo com versão nova publicada e comparativo completo. */
function skillComVersaoNova(): InstalledSkill {
  return {
    name: "atendimento",
    description: "Atende o cliente pelo WhatsApp.",
    version_id: "v-copia-1",
    source: "catalog",
    versao_nova_catalogo: true,
    comparativo: {
      descricao_mudou: true,
      matcher_mudou: true,
      any_adicionadas: ["agendamento", "reatendimento"],
      any_removidas: ["legado"],
      corpo_mudou: true,
      linhas_adicionadas: 12,
      linhas_removidas: 3,
      mudou_em: ["descricao", "matcher", "corpo"],
      resumo: "descrição, palavras-chave e corpo mudaram",
    },
    updated_at: "2026-09-01T12:00:00.000Z",
  };
}

function painel(installed: InstalledSkill[]): SkillsState {
  return { installed, catalog: [] };
}

function pintar(installed: InstalledSkill[]) {
  return render(<SkillsClient initialState={painel(installed)} />);
}

describe("painel de Skills — versão nova do catálogo chega ao olho", () => {
  it("o aviso de versão nova fica visível na skill com versao_nova_catalogo", () => {
    pintar([skillComVersaoNova()]);

    expect(screen.getByText(AVISO)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adotar versão nova" })).toBeInTheDocument();
  });

  it(`o título literal «${TITULO}» aparece quando há comparativo`, () => {
    pintar([skillComVersaoNova()]);

    expect(screen.getByText(TITULO)).toBeInTheDocument();
  });

  it("as contagens do comparativo chegam à tela: palavras-chave e placar de linhas", () => {
    pintar([skillComVersaoNova()]);

    // O que ENTRA ao adotar (+) e o que SAEM (−) — o diff de duas vias.
    expect(screen.getByText("+agendamento, reatendimento")).toBeInTheDocument();
    expect(screen.getByText("−legado")).toBeInTheDocument();
    // Procedimento (corpo): +12 −3 — o placar de linhas, com o sinal de menos tipográfico.
    expect(screen.getByText(/Procedimento \(corpo\):\s*\+12\s*−\s*3/)).toBeInTheDocument();
    expect(screen.getByText("• Descrição")).toBeInTheDocument();
  });

  it("skill sem versão nova não recebe nem aviso nem título", () => {
    const atualizada = skillComVersaoNova();
    pintar([{ ...atualizada, versao_nova_catalogo: false, comparativo: null }]);

    expect(screen.queryByText(AVISO)).toBeNull();
    expect(screen.queryByText(TITULO)).toBeNull();
  });

  it("versão nova SEM comparativo: o aviso continua e o título some", () => {
    const semComparativo = skillComVersaoNova();
    pintar([{ ...semComparativo, comparativo: null }]);

    expect(screen.getByText(AVISO)).toBeInTheDocument();
    expect(screen.queryByText(TITULO)).toBeNull();
  });

  it("só o campo que mudou é listado — mudou_em não vira lista completa", () => {
    const soCorpo = skillComVersaoNova();
    soCorpo.comparativo = {
      ...soCorpo.comparativo!,
      mudou_em: ["corpo"],
      descricao_mudou: false,
      matcher_mudou: false,
    };
    pintar([soCorpo]);

    expect(screen.getByText(TITULO)).toBeInTheDocument();
    expect(screen.getByText(/Procedimento \(corpo\)/)).toBeInTheDocument();
    expect(screen.queryByText("• Descrição")).toBeNull();
  });
});
