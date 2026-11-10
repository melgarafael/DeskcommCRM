/**
 * O E-MAIL DO SISTEMA SEGUE O IDIOMA DA TELA (#4302).
 *
 * ─── O que estava errado ───────────────────────────────────────────────────
 *
 * Quem opera uma organização em espanhol lia a tela em espanhol e recebia
 * « Confirme seu e-mail », « {fulano} convidou você » e « Orçamento mensal de
 * IA » em português. Não era um texto esquecido: cada molde tinha a cópia fixa
 * dentro do próprio arquivo (`acesso-gotrue.ts`, `invite.ts`,
 * `ai-budget-alarm.tsx`), fora do dicionário da interface — e por isso nenhum
 * gate de i18n (que varre `app/` e `components/`) chegava perto.
 *
 * ─── Os quatro grupos de prova ─────────────────────────────────────────────
 *
 *   (a) tabela por locale nos TRÊS moldes: assunto e corpo no MESMO idioma,
 *       pt-BR byte a byte como era;
 *   (b) precedência — mora em `lib/email/idioma-do-email.test.ts`, ao lado do
 *       resolvedor que ela descreve;
 *   (c) locale desconhecido não quebra — idem;
 *   (d) nenhum molde guarda prosa em português fora de `t()`/`traduzir()`, e
 *       toda chave que ele usa tem espanhol no dicionário.
 *
 * (d) existe porque o guarda de tela (`tests/unit/i18n-espanhol-cobre-a-tela`)
 * só olha `app/` e `components/`: sem esta varredura, texto novo de e-mail
 * voltaria a nascer fora do dicionário sem ninguém notar.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";
import { idiomaDoEmail } from "@/lib/email/idioma-do-email";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import { MODELOS_DE_ACESSO, assuntoDoModelo, montarTemplateDeAcesso } from "./acesso-gotrue";
import { buildBudgetAlarmEmail } from "./ai-budget-alarm";
import { buildInviteEmail } from "./invite";

const MARCA: MarcaDeSaida = {
  nome: "Acme",
  logoUrl: null,
  accent: "#506d48",
  accentFg: "#ffffff",
  origens: { nome: "instalacao", cor: "instalacao" },
};

const CONVITE = {
  inviterName: "Ana",
  orgName: "Equipe Sintética",
  role: "agent" as const,
  acceptUrl: "https://crm.exemplo.test/team/accept-invite/tok",
  expiresAt: new Date("2026-11-01T12:00:00.000Z"),
  marca: MARCA,
};

const ALARME = {
  pct: 80,
  consumedCents: 800,
  limitCents: 1000,
  orgName: "Equipe Sintética",
  dashboardUrl: "https://crm.exemplo.test/app/ai",
};

/**
 * O caminho REAL do locale até o molde: o valor cru do destinatário passa pelo
 * resolvedor do sistema. É de propósito que o teste não chame o molde com
 * `"es"` literal — assim a sabotagem do resolvedor (devolver sempre `pt-BR`)
 * tem como reprovar este arquivo.
 */
function idiomaDe(tag: string): Idioma {
  return idiomaDoEmail({ destinatario: tag });
}

// ─── (a) tabela por locale, nos três moldes ────────────────────────────────

describe("(a) acesso: assunto e corpo no mesmo idioma", () => {
  it("espanhol — assunto, título, corpo, botão e rodapé, todos em espanhol", () => {
    const idioma = idiomaDe("es-MX");
    const html = montarTemplateDeAcesso("confirmation", MARCA, idioma);

    expect(assuntoDoModelo("confirmation", MARCA, idioma)).toBe("Confirma tu correo · Acme");
    expect(html).toContain('<html lang="es">');
    expect(html).toContain("Confirma tu correo");
    expect(html).toContain(
      "Tu cuenta en Acme está casi lista. Haz clic en el botón de abajo para confirmar tu correo y activar tu cuenta.",
    );
    expect(html).toContain("Confirmar correo");
    expect(html).toContain("Si no creaste esta cuenta, ignora este correo.");
    expect(html).toContain("O copia y pega este enlace en el navegador:");

    // O defeito do #4302 era este: o assunto mudava e o corpo ficava em PT (ou
    // o contrário). Nenhuma frase portuguesa pode sobrar neste e-mail.
    expect(html).not.toContain("Confirme seu e-mail");
    expect(html).not.toContain("Sua conta no Acme");
    expect(html).not.toContain("Se você não criou esta conta");
  });

  it("espanhol — redefinição de senha também inteira em espanhol", () => {
    const idioma = idiomaDe("es-AR");
    const html = montarTemplateDeAcesso("recovery", MARCA, idioma);

    expect(assuntoDoModelo("recovery", MARCA, idioma)).toBe("Restablecer tu contraseña · Acme");
    expect(html).toContain("Restablecer tu contraseña");
    expect(html).toContain(
      "Recibimos una solicitud para restablecer la contraseña de tu cuenta en Acme. Haz clic en el botón de abajo para elegir una nueva.",
    );
    expect(html).toContain("Definir nueva contraseña");
    expect(html).toContain(
      "Si no fuiste tú quien lo pidió, ignora este correo — tu contraseña sigue siendo la misma.",
    );

    expect(html).not.toContain("Redefinir sua senha");
    expect(html).not.toContain("Recebemos um pedido");
  });

  it("pt-BR não muda um byte: é o texto que já saía", () => {
    const idioma = idiomaDe("pt-BR");
    const confirmacao = montarTemplateDeAcesso("confirmation", MARCA, idioma);
    const recuperacao = montarTemplateDeAcesso("recovery", MARCA, idioma);

    expect(assuntoDoModelo("confirmation", MARCA, idioma)).toBe("Confirme seu e-mail · Acme");
    expect(assuntoDoModelo("recovery", MARCA, idioma)).toBe("Redefinir sua senha · Acme");
    expect(confirmacao).toContain('<html lang="pt-BR">');
    expect(confirmacao).toContain("Sua conta no Acme está quase pronta.");
    expect(confirmacao).toContain("Confirmar e-mail");
    expect(recuperacao).toContain("Recebemos um pedido para redefinir a senha da sua conta no Acme.");
    expect(recuperacao).toContain("Definir nova senha");
    // `sem idioma` continua sendo o português: nenhum chamador antigo quebrou.
    expect(montarTemplateDeAcesso("confirmation", MARCA)).toBe(confirmacao);
  });
});

describe("(a) convite de time: assunto e corpo no mesmo idioma", () => {
  it("espanhol — assunto, título, papel, botão e validade em espanhol", () => {
    const idioma = idiomaDe("es");
    const { subject, html, text } = buildInviteEmail({ ...CONVITE, idioma });

    expect(subject).toBe("Ana te invitó a Equipe Sintética en Acme");
    expect(html).toContain('<html lang="es">');
    expect(html).toContain("Te invitaron a Equipe Sintética");
    // O papel vem do rótulo traduzido, não do código (`agent`).
    expect(html).toContain("<strong>Asesor</strong>");
    expect(html).toContain("Ana te invitó como");
    expect(html).toContain("Aceptar invitación");
    expect(html).toContain("Este enlace caduca el");
    expect(html).toContain("Si no esperabas esta invitación, puedes ignorarla.");
    expect(html).toContain("O copia y pega este enlace en el navegador:");

    expect(text.split("\n")[0]).toBe("Te invitaron a Equipe Sintética como Asesor en Acme.");
    expect(text).toContain("Aceptar: https://crm.exemplo.test/team/accept-invite/tok");
    expect(text).toContain("Caduca el");

    expect(html).not.toContain("convidou você");
    expect(html).not.toContain("Aceitar convite");
    expect(subject).not.toContain("convidou");
  });

  it("pt-BR não muda um byte: é o texto que já saía", () => {
    const idioma = idiomaDe("pt-BR");
    const { subject, html, text } = buildInviteEmail({ ...CONVITE, idioma });

    expect(subject).toBe("Ana convidou você para a Equipe Sintética no Acme");
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain("Você foi convidado para a Equipe Sintética");
    expect(html).toContain("<strong>Atendente</strong>");
    expect(html).toContain("Aceitar convite");
    expect(text.split("\n")[0]).toBe(
      "Você foi convidado para a Equipe Sintética como Atendente no Acme.",
    );
    // Sem `idioma`, o convite continua idêntico ao de antes.
    expect(buildInviteEmail(CONVITE)).toEqual({ subject, html, text });
  });
});

describe("(a) alerta de orçamento de IA: assunto e corpo no mesmo idioma", () => {
  it("espanhol — assunto, título, consumo, política e botão em espanhol", () => {
    const idioma = idiomaDe("es-419");
    const { subject, html, text } = buildBudgetAlarmEmail({ ...ALARME, idioma });

    expect(subject.startsWith("Alerta IA: el presupuesto alcanzó 80.00%")).toBe(true);
    expect(subject).not.toContain("orçamento");
    expect(html).toContain('<html lang="es">');
    expect(html).toContain("El presupuesto mensual de IA alcanzó 80.00%");
    expect(html).toContain("Organización:");
    expect(html).toContain("Consumo del mes:");
    expect(html).toContain(
      "Al llegar al 100%, el bot de IA se pausará o deshabilitará automáticamente según la política configurada. La atención humana sigue con normalidad.",
    );
    expect(html).toContain("Ver panel de uso");
    expect(html).toContain(
      "Este aviso se envía automáticamente una vez cada 24 h mientras el consumo siga por encima del límite configurado.",
    );

    expect(text).toContain("El presupuesto mensual de IA alcanzó 80.00%.");
    expect(text).toContain("Organización: Equipe Sintética");
    expect(text).toContain("Panel: https://crm.exemplo.test/app/ai");

    expect(html).not.toContain("Orçamento mensal de IA atingiu");
    expect(html).not.toContain("Ver dashboard de uso");
  });

  it("pt-BR não muda um byte: é o texto que já saía", () => {
    const idioma = idiomaDe("pt-BR");
    const { subject, html, text } = buildBudgetAlarmEmail({ ...ALARME, idioma });

    expect(subject.startsWith("Alerta IA: orçamento atingiu 80.00%")).toBe(true);
    expect(subject).not.toContain("presupuesto");
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain("Orçamento mensal de IA atingiu 80.00%");
    expect(html).toContain("Ver dashboard de uso");
    expect(text).toContain("Orçamento mensal de IA atingiu 80.00%.");
    expect(buildBudgetAlarmEmail(ALARME)).toEqual({ subject, html, text });
  });
});

// ─── (d) nenhuma prosa fixa fora do dicionário ─────────────────────────────

/** Letra que só aparece em português/espanhol escrito com acento. */
const ACENTO = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;

/**
 * Palavras que só existem na cópia em português. Servem para pegar a prosa que
 * NÃO tem acento (« no {marca}. », « Este link expira em »), que é justamente a
 * que passaria batido numa varredura só por acento.
 */
const PALAVRA_PT =
  /\b(você|seu|sua|não|para|que|este|esta|expira|convidou|convidado|senha|orçamento|confirme|clique|ignore|copie|cole|atingiu|consumo|mês|organização|dashboard|alerta|no)\b/i;

/** Um literal de texto que parece prosa escrita para quem lê. */
function ehProsa(texto: string): boolean {
  const limpo = texto.trim();
  // Marcação, CSS e URL não têm espaço; prosa tem.
  return limpo.length > 3 && /\s/.test(limpo) && (ACENTO.test(limpo) || PALAVRA_PT.test(limpo));
}

/** O texto do literal, quando o nó é um literal de string ou pedaço de molde. */
function textoDoNo(no: ts.Node): string | null {
  if (ts.isStringLiteral(no)) return no.text;
  if (ts.isNoSubstitutionTemplateLiteral(no)) return no.text;
  // Pedaços de molde (`...${x}...`) também carregam prosa: foi assim que o
  // convite e o alarme escondiam o texto em português de uma varredura ingênua.
  if (ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) return no.text;
  return null;
}

/**
 * O literal está dentro de uma chamada a `t(...)`/`traduzir(...)`?
 *
 * Sobe por `escapeHtml(t(...))` e por `t(...).replace(...)`, que são as duas
 * formas usadas nos moldes, e para em qualquer outro nó.
 */
function dentroDeTraducao(no: ts.Node): boolean {
  let atual: ts.Node | undefined = no.parent;
  while (atual) {
    if (ts.isCallExpression(atual)) {
      const chamado = atual.expression;
      if (ts.isIdentifier(chamado) && (chamado.text === "t" || chamado.text === "traduzir")) return true;
      if (!ts.isPropertyAccessExpression(chamado)) return false;
      atual = atual.parent;
      continue;
    }
    if (ts.isPropertyAccessExpression(atual) || ts.isParenthesizedExpression(atual)) {
      atual = atual.parent;
      continue;
    }
    return false;
  }
  return false;
}

const MOLDES = ["acesso-gotrue.ts", "invite.ts", "ai-budget-alarm.tsx"] as const;

describe("(d) nenhum molde guarda texto fixo fora do dicionário", () => {
  it.each(MOLDES)("%s: toda prosa em português passa por t()/traduzir()", (arquivo) => {
    const fonte = readFileSync(join(__dirname, arquivo), "utf8");
    const ast = ts.createSourceFile(
      arquivo,
      fonte,
      ts.ScriptTarget.Latest,
      true,
      arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const soltos: string[] = [];
    const visitar = (no: ts.Node): void => {
      const texto = textoDoNo(no);
      if (texto !== null && ehProsa(texto) && !dentroDeTraducao(no)) soltos.push(texto);
      ts.forEachChild(no, visitar);
    };
    visitar(ast);

    expect(soltos, `prosa em português fora de t()/traduzir() em ${arquivo}`).toEqual([]);
  });

  it.each(MOLDES)("%s: toda chave usada tem espanhol no dicionário", (arquivo) => {
    const fonte = readFileSync(join(__dirname, arquivo), "utf8");
    const ast = ts.createSourceFile(
      arquivo,
      fonte,
      ts.ScriptTarget.Latest,
      true,
      arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const semEspanhol: string[] = [];
    const visitar = (no: ts.Node): void => {
      if (ts.isCallExpression(no) && ts.isIdentifier(no.expression)) {
        const nome = no.expression.text;
        if (nome === "t" || nome === "traduzir") {
          const [primeiro] = no.arguments;
          const texto = primeiro ? textoDoNo(primeiro) : null;
          if (texto !== null && texto.trim() !== "" && DICIONARIO[texto]?.es === undefined) {
            semEspanhol.push(texto);
          }
        }
      }
      ts.forEachChild(no, visitar);
    };
    visitar(ast);

    expect(semEspanhol, `chave sem espanhol usada em ${arquivo}`).toEqual([]);
  });

  it("os rótulos de papel que o convite usa têm espanhol (vêm de ROTULO_DO_PAPEL)", () => {
    for (const papel of ["Atendente", "Gerente", "Administrador", "Somente leitura"]) {
      expect(DICIONARIO[papel]?.es, `${papel} sem espanhol`).toBeTruthy();
    }
  });

  it("os três moldes cobrem os dois modelos de acesso do GoTrue", () => {
    expect([...MODELOS_DE_ACESSO].sort()).toEqual(["confirmation", "recovery"]);
  });
});
