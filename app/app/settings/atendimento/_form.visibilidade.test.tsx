import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { AtendimentoForm, type AtendimentoConfig } from "./_form";

/**
 * O TEXTO DOS MODOS DE VISIBILIDADE DIZ O QUE O MODO **NÃO** ESCONDE (#4381).
 *
 * ## O atrito medido
 *
 * Com `visibility_mode = 'own'` ("Só os seus"), o atendente deixa de ver a
 * conversa e o negócio do colega — mas a lista de Contatos continua inteira,
 * porque `tenant_isolation_contacts_read` recorta por ORGANIZAÇÃO e não olha o
 * modo. O texto da tela dizia "vê apenas o que foi direcionado a ele", sem
 * dizer que Contatos, empresas e pessoas seguem visíveis; quem lê conclui que
 * a permissão falhou.
 *
 * ## O que este arquivo prende
 *
 *   1. os três textos, nos dois idiomas que a interface serve (pt-BR e es);
 *   2. a CONTRADIÇÃO: o texto afirma que Contatos continuam visíveis, e a
 *      policy de leitura de `contacts` não pode passar a olhar
 *      `visibility_mode` sem que este teste peça a revisão do texto;
 *   3. o controle positivo: os TÍTULOS e o valor salvo de cada opção não mudam.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetcher = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
});

const inicial: AtendimentoConfig = {
  mode: "manual",
  max_retries: 5,
  backoff_seconds: 60,
  visibility_mode: "all",
  handoff_return_after_minutes: null,
  conversation_stays_with_attendant: false,
  manual_reply_silence_minutes: null,
};

function renderizar(locale: "pt-BR" | "es") {
  return render(
    createElement(IdiomaProvider, {
      locale,
      children: createElement(AtendimentoForm, { initial: inicial }),
    }),
  );
}

/** O texto que a opção mostra na tela: título + corpo. */
function textoDaOpcao(valor: string): string {
  return screen.getByTestId(`opcao-visibilidade-${valor}`).textContent ?? "";
}

const MODOS_RESTRITIVOS = ["own_and_unassigned", "own"] as const;

describe("#4381 — o texto dos modos diz o que fica de fora E o que continua visível", () => {
  it("em português, as três opções avisam que Contatos, empresas e pessoas continuam visíveis", () => {
    renderizar("pt-BR");

    expect(textoDaOpcao("all")).toContain("Contatos, empresas e pessoas continuam visíveis");
    for (const modo of MODOS_RESTRITIVOS) {
      expect(
        textoDaOpcao(modo),
        `${modo}: o texto tem de dizer que o cadastro de base NÃO é recortado pelo modo`,
      ).toContain("Contatos, empresas e pessoas continuam visíveis");
    }
  });

  it("em português, o que cada modo esconde fica limitado a conversas e negócios", () => {
    renderizar("pt-BR");

    // O modo estrito continua dizendo o que some (conversa e negócio) e o
    // preço de combiná-lo com distribuição manual.
    const estrito = textoDaOpcao("own");
    expect(estrito).toContain("conversas e os negócios direcionados a ele");
    expect(estrito).toContain("nem a fila");
    expect(estrito).toContain("rodízio");

    // E nenhum modo promete esconder o cadastro: é a mentira que a #4381 mediu.
    for (const modo of ["all", ...MODOS_RESTRITIVOS] as const) {
      expect(
        textoDaOpcao(modo),
        `${modo}: não pode prometer ocultação de contatos que a policy não faz`,
      ).not.toMatch(/contatos?[^.]{0,40}(não vê|não enxerga|esconde|oculta)/i);
    }
  });

  it("em espanhol, as três opções saem traduzidas e dizem a mesma coisa", () => {
    renderizar("es");

    for (const modo of ["all", ...MODOS_RESTRITIVOS] as const) {
      const texto = textoDaOpcao(modo);
      expect(texto, `${modo} caiu no português por falta de tradução`).toContain(
        "Los contactos, las empresas y las personas siguen visibles",
      );
      expect(texto).not.toContain("continuam visíveis");
    }
  });

  it("a promessa do texto casa com a policy: a leitura de contacts é por empresa, não por modo", () => {
    const pasta = join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
    const comAPolicy = readdirSync(pasta)
      .filter((arquivo) => arquivo.endsWith(".sql"))
      .sort()
      .filter((arquivo) =>
        readFileSync(join(pasta, arquivo), "utf8").includes(
          "create policy tenant_isolation_contacts_read",
        ),
      );
    expect(comAPolicy.length, "nenhuma migration declara a leitura de contacts").toBeGreaterThan(0);

    const ultima = comAPolicy[comAPolicy.length - 1]!;
    const corpo = readFileSync(join(pasta, ultima), "utf8");
    const trecho = corpo.slice(corpo.indexOf("create policy tenant_isolation_contacts_read"));
    const policy = trecho.slice(0, trecho.indexOf(";", trecho.indexOf("for select")) + 1);

    // Medido: a policy recorta por organização. Se um dia ela passar a olhar o
    // modo, o texto acima vira mentira — e este teste reprova pedindo revisão
    // dos DOIS lados (policy e cópia), que é a decisão de produto da saída 2.
    expect(
      policy.includes("visibility_mode"),
      `${ultima}: contacts_select passou a olhar visibility_mode — revise o texto dos modos (#4381)`,
    ).toBe(false);
    expect(policy).toContain("fn_user_org_ids");
  });

  it("controle positivo: os títulos das opções não mudaram", () => {
    renderizar("pt-BR");
    expect(screen.getByText("Todos veem tudo")).toBeInTheDocument();
    expect(screen.getByText("Os seus, mais os que ainda não têm dono")).toBeInTheDocument();
    expect(screen.getByText("Só os seus")).toBeInTheDocument();
  });

  it("controle positivo: escolher cada opção continua salvando o mesmo valor", async () => {
    renderizar("pt-BR");

    for (const modo of ["own_and_unassigned", "own"] as const) {
      fetcher.mockClear();
      // A transição do `startTransition` anterior pode ainda estar de pé quando
      // a volta seguinte começa — e aí a tela inteira está `disabled` e o botão
      // lê "Salvando…". Medido em `verify-parte (6)` do CI e reproduzido aqui
      // com um `fetch` de 40 ms: `:150` não achava o botão "Salvar". Esperar o
      // nome voltar é SINCRONIZAR, não afrouxar: o valor salvo de cada modo
      // continua sendo a asserção que importa.
      await screen.findByRole("button", { name: "Salvar" });
      fireEvent.click(screen.getByTestId(`opcao-visibilidade-${modo}`));
      fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      const corpo = JSON.parse(fetcher.mock.calls[0]![1].body as string) as Record<
        string,
        unknown
      >;
      expect(corpo.visibility_mode, `${modo} não foi salvo`).toBe(modo);
    }
  });
});
