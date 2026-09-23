/**
 * O PAINEL DE ETIQUETAS EM ESPANHOL — medido na TELA, não no dicionário.
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 *
 * O PR #955 entregou o painel com seis chamadas `t()` recebendo template literal
 * com interpolação (`t(\`Renomear "${tag}" para:\`)`). `traduzir()` casa a string
 * EXATA, então a frase montada em runtime nunca casava chave nenhuma: o diálogo
 * inteiro e os dois toasts saíam em português para quem escolheu espanhol. E o
 * guarda de i18n (`tests/unit/i18n-espanhol-cobre-a-tela.test.ts`) é cego a isso
 * por construção — ele só registra `StringLiteral` e
 * `NoSubstitutionTemplateLiteral`; uma `TemplateExpression` não entra em ramo
 * nenhum. Foi por isso que o `verify` ficou verde.
 *
 * O conserto (commit 1aaced861) tirou o dado de dentro do `t()`. Sem este
 * arquivo, devolver UMA frase ao template literal passava com a suíte verde —
 * o mesmo ponto cego que deixou o defeito entrar. Aqui o painel é montado com
 * `idioma="es"` e o que se afirma é o TEXTO que o operador lê.
 *
 * Medido ao escrever: a recusa `mfa_required` saía em português mesmo depois do
 * conserto — a frase do mapa de erros nunca tinha entrada no dicionário.
 *
 *     npx vitest run tests/unit/tags-vocabulario-painel-em-espanhol.test.tsx
 */
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LinhaDeVocabulario } from "@/lib/schemas/tags";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { PainelDeTags } from "@/app/app/settings/tags/_painel";

const VIP: LinhaDeVocabulario = {
  tag: "vip",
  uso_em_contatos: 3,
  uso_em_leads: 2,
  uso_em_conversas: 1,
  em_regras: 2,
  cor: null,
  descricao: null,
  no_vocabulario: true,
};
const OBRA: LinhaDeVocabulario = { ...VIP, tag: "obra", em_regras: 0 };

/** O `<p>` da confirmação, pelo texto INTEIRO — frase partida não conta. */
const frase = (texto: string) =>
  screen.getByText((_, el) => el?.tagName === "P" && el.textContent === texto);

function montar() {
  // O painel passou a invalidar o cache das cores ao salvar uma cor (#1271):
  // `useQueryClient` exige o provider, e é ele que existe na tela de verdade.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PainelDeTags tags={[VIP, OBRA]} idioma="es" />
    </QueryClientProvider>,
  );
}

function responder(status: number, corpo: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(corpo), { status })),
  );
}

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("painel de etiquetas com idioma espanhol", () => {
  it("⭐ renomear, juntar e excluir: a confirmação sai inteira em espanhol", () => {
    montar();

    fireEvent.click(screen.getAllByRole("button", { name: "Renombrar" })[0]!);
    expect(frase("Renombrar vip a:")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Juntar" })[0]!);
    expect(frase("Juntar vip en otra etiqueta existente:")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" })[0]!);
    expect(frase("Eliminar vip de 3 contacto(s), 2 lead(s) y 1 conversación(es).")).toBeTruthy();
    expect(
      frase(
        "Atención: 2 regla(s) de agente siguen escribiendo esta etiqueta. Eliminarla aquí no borra la regla: el agente volverá a crear la etiqueta en la próxima atención.",
      ),
    ).toBeTruthy();
  });

  it("os toasts de resultado saem em espanhol, com os números de verdade", async () => {
    montar();

    responder(200, { data: { contatos: 2, leads: 1, conversas: 0, regras: 1 } });
    fireEvent.click(screen.getAllByRole("button", { name: "Renombrar" })[0]!);
    fireEvent.change(screen.getByLabelText("Nombre nuevo"), { target: { value: "VIP" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Etiqueta actualizada en 3 registro(s) y en 1 regla(s) de agente.",
      ),
    );

    responder(200, { data: { contatos: 1, leads: 0, conversas: 1 } });
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Etiqueta eliminada de 2 registro(s)."),
    );
  });

  it("cada recusa do servidor sai em espanhol — inclusive o código que o mapa não conhece", async () => {
    const esperado: Record<string, string> = {
      validation_failed: "Revisa la etiqueta, el nombre nuevo y el color.",
      forbidden: "Solo un gerente o administrador de la organización puede cambiar las etiquetas.",
      unauthenticated: "Tu sesión expiró. Entra de nuevo.",
      mfa_required: "Confirma el segundo factor para cambiar las etiquetas.",
      forbidden_tenant: "No estás en ninguna organización activa.",
      codigo_que_o_mapa_nao_tem: "No se pudo completar ahora. Inténtalo de nuevo.",
    };
    montar();

    for (const [codigo, frase] of Object.entries(esperado)) {
      toast.error.mockReset();
      responder(403, { error: { code: codigo } });
      fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" })[0]!);
      fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
      await waitFor(() => expect(toast.error, codigo).toHaveBeenCalledTimes(1));
      expect(toast.error.mock.calls[0]?.[0], codigo).toBe(frase);
    }
  });

  it("falha de rede também avisa em espanhol", async () => {
    montar();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Eliminar" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "No se pudo contactar al servidor. Recarga la página y comprueba antes de intentarlo de nuevo.",
      ),
    );
  });

  it("a cor sai em espanhol: o botão, o nome do tom e o aviso de gravado", async () => {
    // Os oito tons têm NOME justamente para quem não distingue matiz escolher —
    // e um nome que não é traduzido devolve a escolha ao português.
    montar();

    fireEvent.click(screen.getAllByRole("button", { name: "Color" })[0]!);
    expect(frase("Color vip en las listas y en los filtros:")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ámbar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sin color" })).toBeTruthy();

    responder(200, { data: { alterou: true } });
    fireEvent.click(screen.getByRole("button", { name: "Ámbar" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Color de la etiqueta actualizado."));
  });
});
