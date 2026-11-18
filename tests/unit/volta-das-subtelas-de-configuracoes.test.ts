import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

import { RAIZ_DO_REPO, arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * TODA SUBTELA DE CONFIGURAÇÕES TEM O CAMINHO DE VOLTA PARA O ÍNDICE.
 *
 * ─── O defeito que esta cerca existe para não repetir ──────────────────────
 *
 * `/app/settings` é um hub: entra-se nele pelo menu, e dele para Tags, Marca,
 * Notificações, Funis, Agenda… Quem caía numa subtela só saía reabrindo
 * Configurações pelo menu — nenhuma delas tinha `href="/app/settings"`. O
 * conserto é uma linha por tela, e é justamente por ser uma linha que a
 * próxima subtela esquece dela: o problema não é a tela de hoje, é a de
 * amanhã.
 *
 * Por isso a régua percorre os ARQUIVOS, não uma lista escrita à mão: tela
 * nova sob `app/app/settings/` entra na conta no dia em que é criada, e a
 * falha nomeia o arquivo que faltou.
 *
 * ─── O que ela NÃO prova ───────────────────────────────────────────────────
 *
 * Não prova que o link aparece na tela renderizada (isso é `jsdom` e um
 * `render()` por página, que nenhuma delas faz hoje) e não prova o espanhol:
 * quem cobra a tradução é `i18n-espanhol-cobre-a-tela`. O que se prova aqui é
 * que a tela USA o cabeçalho comum, que o alvo dele é o índice, e que o rótulo
 * sai do dicionário em vez de string solta no JSX.
 */

const COMPONENTE = path.join(RAIZ_DO_REPO, "components", "settings", "CabecalhoDaSubTela.tsx");
/** O índice — a tela que recebe as subtelas. Ela não se aponta para si. */
const INDICE = "app/app/settings/page.tsx";

/**
 * Rotas que NÃO são tela: continuam existindo só para não quebrar link salvo,
 * e o corpo delas é um `redirect()`. Não há cabeçalho onde caiba cabeçalho.
 *
 * Esta lista SÓ ENCOLHE. Entrada nova aqui significa "esta tela deixou de ser
 * tela", e isso é a mesma decisão que apagar o arquivo — com motivo escrito.
 * O teste abaixo cobra que cada uma continue sendo redirecionamento de fato:
 * allowlist que aceita qualquer coisa seria a cerca desligada.
 */
const REDIRECIONAMENTOS: Record<string, string> = {
  "app/app/settings/canal-oficial/page.tsx": "conectar canal vive em Conexões",
  "app/app/settings/templates/page.tsx": "template é sub-aba do canal oficial",
  "app/app/settings/tenant/whatsapp/page.tsx": "gestão de conexões vive em Conexões",
};

/** Todos os `page.tsx` sob as Configurações, em caminho relativo à raiz. */
function paginas(): string[] {
  return arquivosDeCodigo(["app/app/settings"])
    .filter((arquivo) => path.basename(arquivo) === "page.tsx")
    .map(caminhoRelativo)
    .sort();
}

describe("volta das subtelas de Configurações", () => {
  it("a varredura acha as subtelas (controle positivo)", () => {
    const encontradas = paginas();
    // Zero arquivo é indistinguível de "está tudo em ordem": o controle
    // positivo é o que separa cerca quebrada de cerca verde.
    expect(encontradas.length).toBeGreaterThanOrEqual(20);
    expect(encontradas).toContain(INDICE);
    expect(encontradas).toContain("app/app/settings/tags/page.tsx");
    expect(fs.existsSync(path.join(RAIZ_DO_REPO, "components", "settings", "CabecalhoDaSubTela.tsx"))).toBe(
      true,
    );
  });

  it("nenhuma subtela ficou sem o cabeçalho de volta", () => {
    const semCabecalho = paginas().filter((arquivo) => {
      if (arquivo === INDICE) return false;
      if (arquivo in REDIRECIONAMENTOS) return false;
      const fonte = fs.readFileSync(path.join(RAIZ_DO_REPO, arquivo), "utf8");
      // Import sem uso não basta: o nome tem de aparecer no JSX também.
      return !/import\s*\{[^}]*CabecalhoDaSubTela[^}]*\}/.test(fonte) || !/<CabecalhoDaSubTela[\s>]/.test(fonte);
    });
    expect(
      semCabecalho,
      `Subtela de Configurações sem caminho de volta ao índice. Use <CabecalhoDaSubTela/> ` +
        `(components/settings/CabecalhoDaSubTela.tsx) no topo da tela:\n  ${semCabecalho.join("\n  ")}`,
    ).toEqual([]);
  });

  it("o índice não ganhou o cabeçalho — ele não se aponta para si", () => {
    const fonte = fs.readFileSync(path.join(RAIZ_DO_REPO, INDICE), "utf8");
    expect(fonte).not.toMatch(/<CabecalhoDaSubTela[\s>]/);
  });

  it("os redirecionamentos continuam sendo redirecionamento", () => {
    for (const [arquivo, motivo] of Object.entries(REDIRECIONAMENTOS)) {
      expect(fs.existsSync(path.join(RAIZ_DO_REPO, arquivo)), `${arquivo} sumiu (${motivo})`).toBe(true);
      const fonte = fs.readFileSync(path.join(RAIZ_DO_REPO, arquivo), "utf8");
      expect(fonte, `${arquivo} deixou de redirecionar (${motivo})`).toMatch(/\bredirect\(/);
      // Tela de verdade renderiza JSX; redirecionamento puro não tem o que mostrar.
      expect(fonte, `${arquivo} virou tela: então ela precisa do cabeçalho`).not.toMatch(/<CabecalhoDaSubTela/);
    }
  });

  it("o cabeçalho aponta para o índice e o rótulo sai do dicionário", () => {
    const fonte = fs.readFileSync(COMPONENTE, "utf8");
    expect(fonte).toContain('href="/app/settings"');
    expect(fonte).toContain('traduzir("Voltar para Configurações", idioma)');
    // Texto solto no JSX continuaria em português para quem lê em espanhol.
    expect(fonte).not.toMatch(/>\s*Voltar para Configurações\s*</);
  });

  it("o rótulo tem espanhol no dicionário", () => {
    expect(DICIONARIO["Voltar para Configurações"]?.es).toBeTruthy();
  });
});
