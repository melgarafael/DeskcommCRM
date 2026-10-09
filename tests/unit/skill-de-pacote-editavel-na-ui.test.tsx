/**
 * A SKILL DE PACOTE SE EDITA EM TEXTO — E OS ARQUIFOS DELA FICAM NO LUGAR.
 *
 * A #2047 nasceu de uma trava que parecia prudente e virou muro: o editor de
 * skills travava o botão Salvar (`disabled={… || veioDePacote}`) para toda
 * skill importada por .zip com `references/` ou `assets/`, e a API rejeitava o
 * PUT com 409. O preço era desproporcional ao risco que a trava existia para
 * evitar: qualquer ajuste de descrição, palavra-chave ou corpo exigia
 * reconstruir o pacote inteiro e subir o .zip de novo.
 *
 * ─── Os defeitos que este arquivo existe para pegar ───────────────────────
 *
 * 1. **O texto volta a ficar bloqueado.** O `disabled` do Salvar é a linha que
 *    derrubou a issue: para skill de pacote ele tem de ficar LIVRE (o save
 *    textual é o produto deste PR). Se alguém reintroduzir `|| veioDePacote`
 *    ali — ou uma condição equivalente —, o caso "salva" aqui reprova.
 * 2. **Some a explicação do bloqueio ESTRUTURAL.** O que continua travado é a
 *    edição de arquivos, e a tela precisa dizer isso com a saída real (novo
 *    .zip) — sem a frase, o operador que não consegue achar o botão de arquivo
 *    conclui que a tela está quebrada. O teste cobra a frase e a LISTA de
 *    arquivos do pacote, que é o que prova, na tela, o que será herdado.
 * 3. **O aviso vira mentira.** A frase antiga mandava "edite o pacote e envie
 *    o .zip de novo" para MUDAR O TEXTO — que é justamente o que passou a
 *    funcionar aqui. Se ela voltar, o teste da frase erra.
 *
 * O outro lado da herança (o PUT gravar o manifesto novo e copiar os objetos
 * para o prefixo da versão nova) mora em
 * `app/api/v1/ai/skills/[name]/route.test.ts`, que é onde o handler é
 * isolarável sem React.
 *
 * Roda com: npx vitest run tests/unit/skill-de-pacote-editavel-na-ui.test.tsx
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { salvar } = vi.hoisted(() => ({
  salvar: { mutate: vi.fn(), isPending: false },
}));

vi.mock("@/hooks/ai/useSkills", () => ({
  useSkill: vi.fn(),
  useSalvarSkill: vi.fn(() => salvar),
  useSkillVersions: vi.fn(() => ({ data: [], isLoading: false })),
  useRestaurarSkill: vi.fn(() => ({ isPending: false })),
}));
// Identidade: `t` devolve a chave, então o texto que o teste lê é o português
// que a tela mostra — e traduzir aqui esconderia exatamente o que se cobra.
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { EditorDeSkill } from "@/app/app/ai/skills/_components/EditorDeSkill";
import { useSkill } from "@/hooks/ai/useSkills";

const MANIFESTO = [
  { path: "references/tabela.md", size: 12, sha256: "a", kind: "reference" },
  { path: "assets/capa.png", size: 3, sha256: "b", kind: "asset" },
];

/** Skill instalada com pacote .zip — o caso da #2047. */
function skillDePacote() {
  return {
    data: {
      name: "catalogo",
      description: "Como apresentar o catálogo.",
      body: "# Catálogo\n- mostre as motos",
      matcher: { any_keywords: ["moto"] },
      version_id: "v1",
      updated_at: "2026-09-19T00:00:00Z",
      tem_arquivos_do_pacote: true,
      arquivos_do_pacote: MANIFESTO.map((m) => m.path),
    },
    isLoading: false,
    isError: false,
    isSuccess: true,
  };
}

/** Skill body-only (sem .zip) — o caso que já era editável. */
function skillSemPacote() {
  return {
    data: {
      name: "manual",
      description: "Venda consultiva.",
      body: "Escute antes de vender.",
      matcher: { any_keywords: ["venda"] },
      version_id: "v9",
      tem_arquivos_do_pacote: false,
      arquivos_do_pacote: [],
    },
    isLoading: false,
    isError: false,
    isSuccess: true,
  };
}

function abrir(skill: unknown) {
  vi.mocked(useSkill).mockReturnValue(skill as never);
  return render(<EditorDeSkill nome="catalogo" aberto aoMudarAberto={() => undefined} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("skill de pacote — o texto é editável (o defeito da #2047)", () => {
  it("o Salvar não vem desabilitado e grava a descrição nova", () => {
    abrir(skillDePacote());

    const botao = screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement;
    // VERMELHO pré-fix: `disabled={… || veioDePacote}` travava este botão.
    expect(botao.disabled).toBe(false);

    // O Radix monta o Dialog em portal (document.body), então o seletor é no
    // documento, não no container do render.
    const descricao = document.querySelector("#skill-desc") as HTMLInputElement;
    expect(descricao).not.toBeNull();
    fireEvent.change(descricao, { target: { value: "Catálogo 2027." } });
    fireEvent.click(botao);

    expect(salvar.mutate).toHaveBeenCalledTimes(1);
    expect(salvar.mutate).toHaveBeenCalledWith(
      {
        name: "catalogo",
        body: {
          description: "Catálogo 2027.",
          body: "# Catálogo\n- mostre as motos",
          matcher: { any_keywords: ["moto"] },
        },
      },
      expect.anything(),
    );
  });

  it("as três caixas de texto continuam digitáveis", () => {
    abrir(skillDePacote());
    for (const id of ["#skill-desc", "#skill-kw", "#skill-body"]) {
      const campo = document.querySelector(id) as HTMLInputElement | HTMLTextAreaElement;
      expect(campo, `${id} sumiu ou veio travado`).not.toBeNull();
      expect(campo.disabled).toBe(false);
      fireEvent.change(campo, { target: { value: "novo valor" } });
      expect(campo.value).toBe("novo valor");
    }
  });
});

describe("skill de pacote — a edição estrutural continua bloqueada, e a tela diz por quê", () => {
  it("mostra os arquivos do pacote como somente leitura", () => {
    abrir(skillDePacote());
    expect(screen.getByText("references/tabela.md")).toBeInTheDocument();
    expect(screen.getByText("assets/capa.png")).toBeInTheDocument();
    expect(screen.getByText(/somente leitura/i)).toBeInTheDocument();
  });

  it("explica que trocar arquivo é por novo .zip, e não por esta tela", () => {
    abrir(skillDePacote());
    expect(screen.getByText(/envie o \.zip/i)).toBeInTheDocument();
    // A frase antiga mandava reenviar o .zip para mudar o TEXTO — que é o
    // contrário do que o produto passou a fazer.
    expect(screen.queryByText(/Para mudar o texto, edite o pacote/)).toBeNull();
  });

  it("a explicação não aparece em skill sem pacote", () => {
    abrir(skillSemPacote());
    expect(screen.queryByText(/envie o \.zip/i)).toBeNull();
    expect(screen.queryByText("references/tabela.md")).toBeNull();
  });
});

describe("a trava que continua de verdade — o teto de linhas", () => {
  it("corpo acima de 200 linhas desabilita o Salvar", () => {
    const pacote = skillDePacote();
    pacote.data.body = Array.from({ length: 201 }, (_, i) => `linha ${i}`).join("\n");
    abrir(pacote);
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
    expect(salvar.mutate).not.toHaveBeenCalled();
  });
});
