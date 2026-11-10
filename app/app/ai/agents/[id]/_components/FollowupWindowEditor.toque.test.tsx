/**
 * OS DIAS DO FOLLOW-UP SÃO ALVO DE DEDO (#3923).
 *
 * ─── O que a issue mediu ────────────────────────────────────────────────────
 *
 * No celular, os botões de dia do `FollowupWindowEditor` — "Dom", "Seg", … —
 * tinham **26px** de altura: `text-xs` (12px de texto + 16px de entrelinha) com
 * `py-1` (8px) e 2px de borda. O piso de toque da casa é **44px** (ADR-0006),
 * e o número não foi escolhido a esmo: abaixo disso o dedo acerta o dia vizinho
 * e o follow-up passa a sair em sábado.
 *
 * ─── Por que um teste de CLASSE, e o que ele NÃO prova ──────────────────────
 *
 * A altura real depende do CSS compilado; medir aquilo aqui exigiria browser. O
 * que este arquivo prende é a REGRA: o chip carrega o piso de 44px no celular
 * (`min-h-11`) e o devolve só no desktop (`lg:min-h-0`), onde quem aciona é o
 * mouse. A régua complementar — que `min-h-11` é mesmo 44px e que os primitivos
 * obedecem — mora em `tests/unit/toque-nos-primitivos.test.tsx` e no e2e de
 * toque; aqui a pergunta é só "este controle ficou de fora?".
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FollowupWindowEditor } from "./FollowupWindowEditor";

const JANELA = { start: "09:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] };

function renderEditor(onChange = vi.fn()) {
  render(<FollowupWindowEditor value={JANELA} onChange={onChange} />);
  return onChange;
}

/** Os sete chips de dia, na ordem em que aparecem. */
function dias(): HTMLElement[] {
  return ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map((rotulo) =>
    screen.getByRole("button", { name: rotulo }),
  );
}

describe("#3923 — alvo de toque dos dias", () => {
  it("⭐ cada dia tem 44px de piso no celular e volta ao chip compacto no desktop", () => {
    renderEditor();

    for (const dia of dias()) {
      const classes = dia.className.split(/\s+/);
      expect(classes, dia.textContent ?? "").toContain("min-h-11");
      expect(classes, dia.textContent ?? "").toContain("lg:min-h-0");
    }
  });

  it("o dia ativo continua marcado por escrito para quem lê a tela", () => {
    renderEditor();

    // `aria-pressed` é o que o leitor de tela anuncia; estilo sozinho não conta.
    expect(screen.getByRole("button", { name: "Seg" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Dom" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("CONTROLE: o toque no dia continua alternando — o alvo novo não mudou o comportamento", async () => {
    const onChange = renderEditor();

    await userEvent.click(screen.getByRole("button", { name: "Dom" }));

    expect(onChange).toHaveBeenCalledWith({ ...JANELA, weekdays: [0, 1, 2, 3, 4, 5] });
  });
});
