/**
 * O DIÁLOGO "PUBLICAR V?" FALA PORTUGUÊS, NÃO JARGÃO DE MANUAL.
 *
 * MEDIDO na tela (issue #1694, item 3): a caixa dizia
 * "A versão atual (nenhuma) será marcada como **superseded**", "**Provider:**
 * openai" e "Prompt: **+65 chars**" — inglês e id cru para o dono da clínica.
 *
 * Este teste guarda as três frases novas E as três que sumiram: o vermelho
 * abaixo é o jargão voltando à tela.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PublishConfirmDialog } from "@/app/app/ai/agents/[id]/_components/PublishConfirmDialog";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

function versao(campo: Partial<AgentVersionRow>): AgentVersionRow {
  return {
    id: "v7",
    version_number: 7,
    provider: "anthropic",
    model: "claude-sonnet-5",
    // 100 caracteres: o delta de 65 vem do rascunho de 165.
    system_prompt: "p".repeat(100),
    tool_ids: [],
    ...campo,
  } as AgentVersionRow;
}

function abrir(draft: AgentVersionRow, published: AgentVersionRow | null) {
  render(
    <PublishConfirmDialog
      open
      onOpenChange={() => {}}
      draft={draft}
      published={published}
      onConfirm={() => {}}
      isPending={false}
    />,
  );
  const dialogo = screen.getByRole("alertdialog");
  return dialogo.textContent ?? "";
}

describe("Publicar v? — o texto que o operador lê", () => {
  it("explica a troca de versão sem a palavra superseded", () => {
    const texto = abrir(versao({ version_number: 8 }), versao({}));

    expect(texto, "jargão de status voltou para a tela").not.toMatch(/superseded/i);
    expect(texto).toContain("A versão atual (v7) continua guardada no histórico, mas deixa de atender.");
  });

  it("sem versão publicada, diz que é a primeira e não fala de 'versão atual'", () => {
    const texto = abrir(versao({ version_number: 1 }), null);

    expect(texto).not.toMatch(/superseded/i);
    expect(texto, "a v1 não tem versão atual para 'deixar de atender'").not.toContain("(nenhuma)");
    expect(texto).not.toContain("deixa de atender");
    expect(texto).toContain("É a primeira publicação deste agente.");
  });

  it("mostra a EMPRESA pelo nome que o operador conhece, não o id cru", () => {
    const texto = abrir(
      versao({ version_number: 8, provider: "openai", model: "gpt-5-mini" }),
      versao({}),
    );

    expect(texto, "o rótulo em inglês voltou").not.toContain("Provider:");
    expect(texto).not.toMatch(/\bprovider\b/i);
    expect(texto).toContain("Empresa:");
    expect(texto).toContain("Anthropic (Claude) → OpenAI (GPT)");
  });

  it("o delta do prompt vira 'caracteres a mais', não '+65 chars'", () => {
    const texto = abrir(
      versao({ version_number: 8, system_prompt: "p".repeat(165) }),
      versao({}),
    );

    expect(texto, "'chars' voltou ao diálogo").not.toMatch(/chars/i);
    expect(texto).not.toContain("+65");
    expect(texto).toContain("65 caracteres a mais");
  });

  it("prompt encurtado conta para menos, sem sinal negativo solto", () => {
    const texto = abrir(versao({ version_number: 8 }), versao({ system_prompt: "p".repeat(165) }));

    expect(texto).toContain("65 caracteres a menos");
    expect(texto).not.toContain("-65");
  });
});
