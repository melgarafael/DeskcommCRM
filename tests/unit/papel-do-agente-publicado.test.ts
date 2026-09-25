/**
 * GATE DO PAPEL `ai_operator` — autonomia de máquina não vira papel de gente.
 *
 * O agente publicado ganhou um papel próprio entre `agent` e `manager`, para
 * alcançar as capacidades que um atendente humano não tem (mexer na régua de
 * retorno) sem que isso dê o mesmo poder a uma PESSOA com papel de atendente.
 *
 * A propriedade que torna o desenho seguro é uma só: **`ai_operator` vive no
 * escopo do token efêmero e NUNCA em `user_organizations`.** Se alguém puder
 * atribuí-lo a uma pessoa — por convite, por seletor de time, ou afrouxando o
 * CHECK do banco —, o papel deixa de ser autonomia de agente e vira escalada de
 * privilégio silenciosa: um atendente passaria a configurar a operação sem que
 * ninguém tivesse decidido isso.
 *
 * Estes testes existem porque essa propriedade não se defende sozinha. Ela
 * depende de três arquivos concordarem, e nenhum deles reclama se divergir.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PAPEIS_HUMANOS, ROLE_RANK, ROTULO_DO_PAPEL, type Role } from "@/lib/auth/types";

const RAIZ = join(__dirname, "..", "..");
const baseline = readFileSync(join(RAIZ, "supabase/baseline.sql"), "utf8");

describe("papel do agente publicado", () => {
  it("senta ENTRE atendente e gerente, nessa ordem", () => {
    // A faixa é o ponto inteiro do papel: acima do atendente para alcançar o
    // que ele não alcança, abaixo do gerente para não virar gerente.
    expect(ROLE_RANK.agent).toBeLessThan(ROLE_RANK.ai_operator);
    expect(ROLE_RANK.ai_operator).toBeLessThan(ROLE_RANK.manager);
  });

  it("NENHUMA pessoa pode recebê-lo — não está na lista de papéis humanos", () => {
    expect(PAPEIS_HUMANOS).not.toContain("ai_operator");
  });

  it("o banco também não o aceita para pessoa (CHECK de user_organizations)", () => {
    // A defesa de verdade é esta: mesmo que o TypeScript afrouxe, a linha não
    // entra. Lê o CHECK real do baseline — não uma cópia da regra.
    const m = baseline.match(/user_organizations_role_check[^\n]*/);
    expect(m, "CHECK de user_organizations não encontrado no baseline").not.toBeNull();
    expect(m![0]).not.toContain("ai_operator");
    // Controle positivo: se o regex parar de casar a linha certa, o teste acima
    // passaria vacuamente. Este confirma que estamos lendo o CHECK dos papéis.
    for (const humano of PAPEIS_HUMANOS) {
      expect(m![0]).toContain(humano);
    }
  });

  it("a função de papel do banco NÃO o conhece, e está certo assim", () => {
    // `fn_role_at_least` consulta `fn_user_role_in_org`, que lê
    // `user_organizations`. O agente não é usuário. Se `ai_operator` aparecer
    // ali, alguém tentou dar papel de máquina a gente pela porta do banco.
    // A ÚLTIMA definição é a que vale no banco: o arquivo é dump + apêndice,
    // aplicados em ordem (CLAUDE.md, item 10). O `match` parava na PRIMEIRA
    // ocorrência do nome — e o dump grafa `"public"."fn_role_at_least"`, com
    // aspas e maiúsculas, então a varredura é por regex e a leitura da última.
    const definicoes = [
      ...baseline.matchAll(
        /create or replace function\s+"?public"?\.\s*"?fn_role_at_least"?\s*\([\s\S]*?\$\$;/gi,
      ),
    ];
    const fn = definicoes.at(-1);
    expect(fn, "fn_role_at_least não encontrada").not.toBeUndefined();
    expect(fn![0]).not.toContain("ai_operator");
  });

  it("tem rótulo em português para todo papel, inclusive o do agente", () => {
    for (const papel of Object.keys(ROLE_RANK) as Role[]) {
      expect(ROTULO_DO_PAPEL[papel]?.trim()).not.toBe("");
      expect(ROTULO_DO_PAPEL[papel]).not.toContain("_");
    }
  });

  it("o token efêmero do agente nasce com este papel (controle positivo)", () => {
    // Lê o FONTE do mint. Sem isto, trocar o papel gravado no token faria todo
    // o resto deste arquivo passar descrevendo um mundo que não existe mais.
    const mint = readFileSync(join(RAIZ, "lib/ai/runtime/mcp_token.ts"), "utf8");
    expect(mint).toContain('"role:ai_operator"');
    expect(mint).not.toContain('"role:agent"');
  });
});
