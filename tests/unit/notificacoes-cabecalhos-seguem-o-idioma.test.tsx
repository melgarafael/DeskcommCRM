import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { NotificationPrefsClient } from "@/app/app/settings/notifications/_client";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

/**
 * OS CABEÇALHOS DA TABELA DE NOTIFICAÇÕES SEGUEM O IDIOMA DA TELA (issue #4755).
 *
 * ## O defeito
 *
 * A coluna "Categoria" já passava por `t(...)`, mas as três seguintes estavam
 * escritas direto no JSX: `<th ...>Email</th>`, `<th ...>In-app</th>` e
 * `<th ...>Push</th>`. Com a instalação em espanhol, a primeira virava
 * "Categoría" e as outras três continuavam em português — o dicionário já tinha
 * `Email → Correo` e `In-app → En la app`, só ninguém as chamava.
 *
 * ## Por que este arquivo é NOVO
 *
 * `notificacoes-tela-diz-o-que-falta.test.tsx` mocka `_client` inteiro
 * (`NotificationPrefsClient: () => <table />`) para medir outra coisa — o texto
 * sobre o que a instalação consegue entregar. Aquele mock esconde exatamente os
 * cabeçalhos que este teste precisa ver, então trocá-lo faria o teste antigo
 * medir o que não promete. Aqui o componente é montado de verdade.
 *
 * ## O controle positivo do instrumento
 *
 * A terceira asserção não é redundante com a primeira: ela cobra a AUSÊNCIA do
 * literal "Email" nos cabeçalhos em espanhol. É o defeito de hoje, e é o que
 * falha se alguém "consertar" só a coluna nova e esquecer uma das três. Sem
 * ela, um `expect(html).toContain("Correo")` poderia passar por acidente com
 * outra ocorrência da palavra na tela.
 *
 * O `Push` é o único que sai igual nos dois idiomas (`Push → Push` no
 * dicionário): ele prova que a coluna continua renderizada, não o idioma.
 */

type Locale = "pt-BR" | "es";

/** Texto exato das quatro colunas, por idioma, como a tabela deve sair. */
const CABECALHOS: Record<Locale, string[]> = {
  "pt-BR": ["Categoria", "Email", "In-app", "Push"],
  es: ["Categoría", "Correo", "En la app", "Push"],
};

function cabecalhosNaTela(locale: Locale): string[] {
  const { container } = render(
    createElement(IdiomaProvider, {
      locale,
      children: createElement(NotificationPrefsClient),
    }),
  );
  return Array.from(container.querySelectorAll("thead th")).map((th) =>
    (th.textContent ?? "").trim(),
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("cabeçalhos da tabela de Notificações — seguem o idioma da tela", () => {
  it("em espanhol, as colunas saem Correo e En la app", () => {
    const cabecalhos = cabecalhosNaTela("es");

    expect(cabecalhos).toContain("Correo");
    expect(cabecalhos).toContain("En la app");
    expect(cabecalhos).toEqual(CABECALHOS.es);
  });

  it("em português, a tabela continua igual (controle da correção)", () => {
    const cabecalhos = cabecalhosNaTela("pt-BR");

    expect(cabecalhos).toEqual(CABECALHOS["pt-BR"]);
  });

  it("em espanhol, NENHUM cabeçalho carrega o literal Email (o defeito de hoje)", () => {
    const cabecalhos = cabecalhosNaTela("es");

    expect(cabecalhos).not.toContain("Email");
    expect(cabecalhos).not.toContain("In-app");
  });
});
