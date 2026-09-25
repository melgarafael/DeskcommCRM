/**
 * `resourceId` DO AUDIT É UUID — E CHAVE NATURAL NÃO CABE LÁ.
 *
 * ## O defeito, medido numa corrida real da suíte e2e (2026-08-08)
 *
 * Os logs do servidor sob teste traziam, três vezes em 14 minutos:
 *
 *     [audit] insert error invalid input syntax for type uuid: "stage_classifier"
 *       { action: 'ai.purpose_binding_updated' }
 *
 * `api_audit_log.resource_id` é `uuid`. O `purpose` (`stage_classifier`,
 * `intent_router`…) é chave natural em `text`. O INSERT do audit estourava, e —
 * porque falha de audit **não bloqueia a mutação, por doutrina** — a configuração
 * era gravada, a tela dizia "salvo", e a trilha de auditoria simplesmente não
 * tinha a linha.
 *
 * Procurando a CLASSE em vez da instância, esta varredura achou uma segunda
 * ocorrência que ninguém tinha visto: `ai.skill_uninstalled` mandava o NOME da
 * skill (`skill_pointers` é chaveada por `(organization_id, name)` e não tem uuid).
 * Um DELETE perdendo a própria auditoria.
 *
 * ## Por que este gate, e não "olhar o Sentry"
 *
 * `lib/audit/index.ts` já reporta a falha ao Sentry — e o docstring dele registra
 * que ESTA MESMA classe já tinha acontecido antes, com as ferramentas MCP. Ou
 * seja: o alarme funciona e a classe reincide. Alarme avisa depois do fato, num
 * canal que ninguém abre em desenvolvimento; o que faltava era algo que reprovasse
 * ANTES do merge. A propriedade é enumerável a partir do repositório, e é aí que a
 * régua deste repo diz que o teste ganha do hábito.
 *
 * ## A regra, e por que ela é allowlist
 *
 * Todo `resourceId:` resolve para algo cujo nome termina em `id`/`Id`/`_id`, ou é
 * `null`. Um denylist de nomes ruins (`purpose`, `name`, `slug`…) envelheceria a
 * cada campo novo; esta forma falha FECHADO — expressão que não se parece com id
 * precisa entrar em `EXCECOES` com o motivo escrito.
 *
 * A régua é textual e isso é deliberado: o valor real só existe em runtime, e um
 * gate que exigisse execução não cobriria as 149 chamadas.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

/**
 * Expressões que não terminam em `id` e ainda assim são legítimas.
 *
 * Cada entrada diz POR QUÊ. Sem a razão escrita, a allowlist vira o lugar onde a
 * dívida volta pela porta de serviço.
 */
const EXCECOES: Record<string, string> = {
  "pid": "parâmetro de rota /proposals/[pid] — é o uuid da proposta, o nome curto vem do path",
  "vid": "parâmetro de rota /versions/[vid] — uuid da versão",
  "String(lead.id)": "uuid do lead, convertido porque a origem é jsonb do webhook",
  "string | null | undefined":
    "falso positivo do parser: é uma ANOTAÇÃO DE TIPO num componente, não uma chamada de audit",
  "string;":
    "falso positivo do parser: é a ANOTAÇÃO DE TIPO de `resourceId` na interface " +
    "`DepsDeGrupos.audit` (lib/grupos/servico.ts:77), não uma chamada. As DUAS chamadas " +
    "reais — `ligarGrupo` e `desligarGrupo`, esta última inclusive quando o desligamento " +
    "do filtro falha depois da escrita — passam `resourceId: row.id`, o uuid da linha de " +
    "`channel_session_groups`, que já satisfaz a régua (`row.id` termina em `id`).",
};

function arquivosDeCodigo(base: string): string[] {
  const achados: string[] = [];
  const anda = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!/node_modules|\.next|\.git/.test(p)) anda(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) {
        achados.push(p);
      }
    }
  };
  anda(path.join(RAIZ, base));
  return achados;
}

/**
 * A expressão resolve para um id (ou para `null`)?
 *
 * NORMALIZA antes de julgar, e isso é o conserto de um falso positivo real: a
 * forma idiomática `(x as { id?: string }).id ?? null` — que é EXATAMENTE o
 * conserto certo deste defeito, e chegou pela main em 2026-08-09 — não terminava
 * em `id` e era acusada. Gate que reprova a correção correta faz as pessoas
 * encherem a allowlist até ela virar a regra.
 *
 * As duas caudas removidas são semanticamente neutras para a pergunta que se faz
 * aqui: `?? null` só acrescenta o caso vazio (que já é permitido) e `as <T>` é
 * anotação, não valor.
 */
function pareceId(expr: string): boolean {
  const v = expr
    .trim()
    .replace(/\s*\?\?\s*null$/, "")
    .replace(/\s+as\s+[\w<>[\]|\s{}?:;]+$/, "")
    .trim();
  if (v === "null") return true;
  return /(Id|_id|\bid)$/.test(v);
}

const chamadas: Array<{ arquivo: string; valor: string }> = [];
for (const base of ["lib", "app"]) {
  for (const arquivo of arquivosDeCodigo(base)) {
    const fonte = readFileSync(arquivo, "utf8");
    for (const m of fonte.matchAll(/resourceId:\s*([^,\n]+)/g)) {
      chamadas.push({ arquivo: path.relative(RAIZ, arquivo), valor: m[1]!.trim() });
    }
  }
}

describe("resourceId do audit é sempre um uuid (ou null)", () => {
  it("a varredura está viva — controle positivo", () => {
    // Um regex que parou de casar devolveria zero chamadas e o teste abaixo
    // passaria sem medir nada. 149 medidas em 2026-08-08.
    expect(chamadas.length, "nenhuma chamada de audit encontrada — o padrão mudou?").toBeGreaterThan(100);
  });

  it("nenhuma chave natural vai para a coluna uuid", () => {
    const fora = chamadas
      .filter((c) => !pareceId(c.valor))
      .filter((c) => EXCECOES[c.valor] === undefined)
      .map((c) => `${c.arquivo} -> resourceId: ${c.valor}`);

    expect(
      fora,
      "`api_audit_log.resource_id` é uuid. Um valor que não é id faz o INSERT do " +
        "audit estourar, e como audit é fire-and-forget a mutação segue e a trilha " +
        "perde a linha — sem sintoma em tela nenhuma. Use o uuid da linha, `null` " +
        "(com o identificador natural no metadata), ou declare a exceção em " +
        "EXCECOES com o motivo.\n",
    ).toEqual([]);
  });

  it("toda exceção declarada tem motivo escrito e ainda é usada", () => {
    for (const [expr, motivo] of Object.entries(EXCECOES)) {
      expect(motivo.trim().length, `a exceção \`${expr}\` não diz por quê`).toBeGreaterThan(20);
      // Exceção que ninguém usa mais é ruído que ensina a confiar na allowlist
      // sem conferir — e um dia cobre um defeito novo por acidente.
      expect(
        chamadas.some((c) => c.valor === expr),
        `a exceção \`${expr}\` não corresponde a nenhuma chamada — remova-a`,
      ).toBe(true);
      // E que ela ainda seja NECESSÁRIA. Sem isto, uma régua que melhorou deixa
      // exceções para trás, e a allowlist cresce sozinha até virar a regra —
      // aconteceu aqui: normalizar `?? null` e `as <T>` tornou três delas inúteis.
      expect(
        pareceId(expr),
        `a exceção \`${expr}\` não é mais necessária — a régua já a aceita. Remova-a.`,
      ).toBe(false);
    }
  });
});
