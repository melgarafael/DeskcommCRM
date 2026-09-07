import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * O QUE VAI PARA O BANCO FICA NO VOCABULÁRIO CANÔNICO; A TELA TRADUZ NA LEITURA.
 *
 * ─── O defeito que este guarda mede ─────────────────────────────────────────
 *
 * `crm_lead_activities.reason` é a frase legível da linha do tempo, escrita
 * pelo SISTEMA (assumiu, liberou, transferiu, pausou a IA, encerrou o negócio).
 * Ela é gravada uma vez e lida para sempre, por quem quer que abra o negócio
 * depois.
 *
 * A varredura de espanhol do PR #600 passou seis desses sítios de ESCRITA por
 * `t()`, gravando o idioma de quem clicou. Numa organização bilíngue — que é o
 * caso que a própria feature cria — o histórico vira mistura: metade das linhas
 * em português, metade em espanhol, e nenhuma das duas metades traduz para quem
 * lê no outro idioma, porque a chave gravada em espanhol não existe no
 * dicionário (a chave É o texto em português).
 *
 * A intenção do #600 — quem usa espanhol lê espanhol — não some com isso: ela é
 * atendida na LEITURA, por `t(item.reason)`, que o MESMO PR acrescentou. É a
 * doutrina que ele escreveu no dicionário, no bloco "vocabulario de dominio
 * persistido"; o que faltava era aplicá-la nos seis sítios.
 *
 * ─── Por que um guarda de AST e não seis testes de comportamento ────────────
 *
 * Os seis são rotas com Supabase, RLS e RPC no meio: seis testes de
 * comportamento custariam seis dublês e ainda assim não alcançariam o SÉTIMO
 * sítio — a próxima atividade que alguém emitir. O que se quer proteger é a
 * classe, e a classe é estrutural: nenhum `reason`/`motivo` de atividade passa
 * por tradução na escrita.
 *
 * O par do «não faça X» está no fim do arquivo: a leitura TEM de traduzir. Sem
 * ele, "nunca traduza reason" seria satisfeito arrancando a tradução dos dois
 * lados — e o espanhol voltaria a ver português.
 */

const RAIZ = join(__dirname, "..", "..");

/** As duas portas por onde uma frase chega a `crm_lead_activities.reason`. */
const EMISSORES = new Set(["emitLeadActivity", "registrarTrocaDeComando"]);

/** O campo muda de nome entre as duas portas; o destino é a mesma coluna. */
const CAMPOS_PERSISTIDOS = new Set(["reason", "motivo"]);

function nomeDaChamada(no: ts.CallExpression): string {
  const alvo = no.expression;
  if (ts.isIdentifier(alvo)) return alvo.text;
  if (ts.isPropertyAccessExpression(alvo)) return alvo.name.text;
  return "";
}

/** `t(...)`, `traduzir(...)` ou o `_t(...)` dos módulos que recebem `t` opcional. */
function ehChamadaDeTraducao(no: ts.Node): boolean {
  return ts.isCallExpression(no) && ["t", "_t", "traduzir"].includes(nomeDaChamada(no));
}

function contemTraducao(no: ts.Node): boolean {
  if (ehChamadaDeTraducao(no)) return true;
  let achou = false;
  ts.forEachChild(no, (f) => {
    if (!achou && contemTraducao(f)) achou = true;
  });
  return achou;
}

interface Sitio {
  local: string;
  trecho: string;
}

/**
 * Devolve os sítios de escrita e quantas chamadas a emissor foram visitadas —
 * o segundo número existe para separar "nenhum defeito" de "sonda cega".
 */
function varrer(fontes: { rel: string; texto: string }[]): {
  comTraducao: Sitio[];
  emissoresVistos: number;
} {
  const comTraducao: Sitio[] = [];
  let emissoresVistos = 0;

  for (const { rel, texto } of fontes) {
    const fonte = ts.createSourceFile(rel, texto, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visita = (no: ts.Node): void => {
      if (ts.isCallExpression(no) && EMISSORES.has(nomeDaChamada(no))) {
        emissoresVistos += 1;
        for (const arg of no.arguments) {
          if (!ts.isObjectLiteralExpression(arg)) continue;
          for (const prop of arg.properties) {
            if (!ts.isPropertyAssignment(prop) || !prop.name) continue;
            const campo = ts.isIdentifier(prop.name)
              ? prop.name.text
              : ts.isStringLiteral(prop.name)
                ? prop.name.text
                : "";
            if (!CAMPOS_PERSISTIDOS.has(campo)) continue;
            if (contemTraducao(prop.initializer)) {
              const linha = fonte.getLineAndCharacterOfPosition(prop.getStart()).line + 1;
              comTraducao.push({
                local: `${rel}:${linha}`,
                trecho: prop.getText(fonte).replace(/\s+/g, " ").slice(0, 120),
              });
            }
          }
        }
      }
      ts.forEachChild(no, visita);
    };
    visita(fonte);
  }
  return { comTraducao, emissoresVistos };
}

function fontesDoProduto(): { rel: string; texto: string }[] {
  // `git ls-files` em vez de andar no disco: arquivo não rastreado ainda não
  // existe para o CI, e um `.next`/`node_modules` esquecido não entra na conta.
  const saida = execFileSync("git", ["ls-files", "app", "lib", "workers"], {
    cwd: RAIZ,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return saida
    .split("\n")
    .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p))
    .map((rel) => ({ rel, texto: readFileSync(join(RAIZ, rel.split("/").join(sep)), "utf8") }));
}

describe("o reason da linha do tempo é gravado no vocabulário canônico", () => {
  const { comTraducao, emissoresVistos } = varrer(fontesDoProduto());

  it("nenhuma escrita de atividade passa reason/motivo por t()", () => {
    expect(
      comTraducao.map((s) => `${s.local} → ${s.trecho}`),
      `${comTraducao.length} atividade(s) gravam o idioma de quem clicou em ` +
        "crm_lead_activities.reason — numa organização bilíngue o histórico vira " +
        "mistura, e a frase em espanhol não bate com nenhuma chave na leitura",
    ).toEqual([]);
  });

  it("a varredura alcança os emissores de verdade (não é sonda cega)", () => {
    // Ausência só vale se a sonda cobre a categoria: se um rename fizer
    // `emitLeadActivity` deixar de ser reconhecido, o teste de cima ficaria
    // verde por não ter olhado nada.
    expect(
      emissoresVistos,
      "a varredura não encontrou chamadas a emitLeadActivity/registrarTrocaDeComando",
    ).toBeGreaterThan(20);
  });

  it("a varredura enxerga o defeito quando ele existe (controle positivo)", () => {
    const comDefeito = `
      await emitLeadActivity(db, { leadId: "x", reason: t("Ganho"), payload: {} });
      await registrarTrocaDeComando({ tipo: "conversation_claimed", motivo: traduzir("Assumiu", idioma) });
      await emitLeadActivity(db, { leadId: "y", reason: \`Perdido — \${motivo}\` });
    `;
    const achado = varrer([{ rel: "sintetico.ts", texto: comDefeito }]);
    expect(achado.emissoresVistos).toBe(3);
    // Os dois primeiros são o defeito; o terceiro é a forma CERTA e não pode
    // ser acusada — senão o guarda proibiria gravar a frase canônica.
    expect(achado.comTraducao.map((s) => s.local)).toEqual(["sintetico.ts:2", "sintetico.ts:3"]);
  });
});

describe("a intenção do #600 sobrevive: quem lê em espanhol vê espanhol", () => {
  const TELAS = [
    "components/kanban/LeadTimeline.tsx",
    "components/inbox/CRMSidePanel.tsx",
    "components/contacts/TimelineView.tsx",
  ] as const;

  it.each(TELAS)("%s traduz o reason na LEITURA", (rel) => {
    const texto = readFileSync(join(RAIZ, rel.split("/").join(sep)), "utf8");
    const fonte = ts.createSourceFile(rel, texto, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    let traduzReason = false;
    const visita = (no: ts.Node): void => {
      if (ehChamadaDeTraducao(no) && ts.isCallExpression(no)) {
        const arg = no.arguments[0];
        if (arg && /reason/i.test(arg.getText(fonte))) traduzReason = true;
      }
      ts.forEachChild(no, visita);
    };
    visita(fonte);

    expect(
      traduzReason,
      `${rel} deixou de traduzir o reason na leitura — como a escrita é canônica ` +
        "em português, quem escolheu espanhol passa a ver a linha do tempo em português",
    ).toBe(true);
  });
});
