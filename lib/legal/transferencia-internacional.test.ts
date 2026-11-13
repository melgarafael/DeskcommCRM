/**
 * A CLÁUSULA 9 DO DOCUMENTO DO OPERADOR (#4520) — a prova de que ela deixa de
 * ser uma frase fixa.
 *
 * O defeito medido em `docs/saas/contrato-e-lgpd.md` e em `lib/legal/operador.ts`
 * era o mesmo: "as conversas vão para provedores fora do Brasil", escrita à mão
 * uma vez, igual para toda instalação. Uma instalação cujo único provedor é um
 * endpoint próprio no servidor do próprio operador lia a mesma frase de uma
 * instalação que manda tudo para os Estados Unidos.
 *
 * O que este arquivo prende:
 *   1. a lista sai do REGISTRO de provedores ativos (credencial ativa e validada
 *      + chave de plataforma do `.env`), não de uma constante paralela;
 *   2. cada provedor ativo entra com o país declarado no catálogo;
 *   3. provedor sem país declarado aparece com a frase própria — nunca sumido;
 *   4. sem nenhum ativo, a cláusula diz que não há transferência por IA;
 *   5. leitura que falhou NÃO vira "não há transferência" — é `null`, e a
 *      cláusula tem frase própria para isso.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { PROVEDORES, PROVEDORES_DE_DECISAO } from "@/lib/ai/pontos/provedores";
import {
  clausulaDeTransferenciaInternacional,
  CONSULTA_DOS_PAISES_EM,
  provedoresAtivosDaInstalacao,
} from "@/lib/legal/operador";

/**
 * O dublê mínimo de `ai_provider_credentials` para esta leitura: aplica os DOIS
 * filtros que a consulta usa (`is_active` e `validated_at is not null`), como o
 * PostgREST aplicaria. Um dublê que ignorasse os filtros mediria o dublê — e o
 * caso "credencial inativa não entra" passaria sem que a consulta filtrasse.
 */
function dbDeCredenciais(
  linhas: Array<{ provider: string; is_active?: boolean; validated_at?: string | null }>,
  erro: { message: string } | null = null,
): SupabaseClient {
  let soAtivas = false;
  const consulta = {
    select: () => consulta,
    eq: (coluna: string, valor: unknown) => {
      if (coluna === "is_active") soAtivas = valor === true;
      return consulta;
    },
    not: async (coluna: string, operador: string, valor: unknown) => {
      if (erro) return { data: null, error: erro };
      // A consulta tem de ser a que o produto precisa: sem os dois filtros, a
      // credencial desativada e a que ainda não foi validada entrariam no
      // contrato como se estivessem em uso.
      if (coluna !== "validated_at" || operador !== "is" || valor !== null) {
        throw new Error(`filtro inesperado: not(${coluna}, ${operador}, ${valor})`);
      }
      const ativas = linhas.filter(
        (linha) => (!soAtivas || linha.is_active === true) && (linha.validated_at ?? null) !== null,
      );
      return { data: ativas.map((linha) => ({ provider: linha.provider })), error: null };
    },
  };
  return { from: () => consulta } as unknown as SupabaseClient;
}

describe("clausulaDeTransferenciaInternacional — o texto vem dos provedores ativos", () => {
  it("dois provedores ativos: cita os DOIS países, com a data, e não cita os inativos", () => {
    const texto = clausulaDeTransferenciaInternacional(["anthropic", "google"]);

    expect(texto).toContain("Anthropic (Estados Unidos)");
    expect(texto).toContain("Google (Estados Unidos)");
    expect(texto).toContain("consultada em 13/11/2026");
    expect(texto).toContain("Resolução CD/ANPD nº 19/2024");
    // O que NÃO está ativo não pode aparecer: listar provedor sem credencial
    // assusta sem informar (regra 1 da issue).
    expect(texto).not.toContain("OpenAI");
    expect(texto).not.toContain("DeepSeek");
    expect(texto).not.toContain("Requesty");
  });

  it("nenhum provedor ativo: a cláusula diz que não há transferência por IA", () => {
    const texto = clausulaDeTransferenciaInternacional([]);

    expect(texto).toContain("Com a IA desligada");
    expect(texto).toContain("nenhum texto de conversa é enviado a provedor externo");
    expect(texto).not.toContain("processado por:");
  });

  it("provedor que não declara o país aparece — com a frase que manda consultar a política dele", () => {
    const texto = clausulaDeTransferenciaInternacional(["requesty"]);

    expect(texto).toContain("Requesty (não declara o país; consulte a política do provedor)");
  });

  it("endpoint próprio: aparece como 'no servidor do operador', não como país estrangeiro", () => {
    const texto = clausulaDeTransferenciaInternacional(["custom"]);

    expect(texto).toContain("Provedor personalizado (no servidor do operador)");
    expect(texto).not.toContain("Estados Unidos");
  });

  it("leitura que FALHOU (null) não vira 'não há transferência'", () => {
    const texto = clausulaDeTransferenciaInternacional(null);

    expect(texto).toContain("Não foi possível confirmar agora");
    expect(texto).not.toContain("Com a IA desligada");
  });

  it("a ordem é a do catálogo, e id repetido não duplica a linha", () => {
    // `google` vem antes de `deepseek` no catálogo; a ordem de chegada é a
    // inversa de propósito — dois documentos da mesma instalação têm de sair
    // iguais.
    const texto = clausulaDeTransferenciaInternacional(["deepseek", "google", "deepseek"]);

    expect(texto.indexOf("Google (Estados Unidos)")).toBeLessThan(
      texto.indexOf("DeepSeek (China)"),
    );
    expect(texto.match(/DeepSeek \(China\)/g)).toHaveLength(1);
  });

  it.each([...PROVEDORES, ...PROVEDORES_DE_DECISAO])(
    "catraca: $id tem país declarado no catálogo",
    (provedor) => {
      // Sem isto, um provedor novo entraria no produto e sumiria da cláusula em
      // silêncio — o defeito original, agora com outra causa.
      expect(provedor.pais).toBeTruthy();
    },
  );

  it("a data declarada é ISO e é a que sai no texto", () => {
    expect(CONSULTA_DOS_PAISES_EM).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(clausulaDeTransferenciaInternacional(["anthropic"])).toContain(
      CONSULTA_DOS_PAISES_EM.split("-").reverse().join("/"),
    );
  });
});

describe("provedoresAtivosDaInstalacao — o registro que a cláusula lê", () => {
  it("credencial ativa e validada + chave do .env, na ordem do catálogo", async () => {
    const db = dbDeCredenciais([
      { provider: "deepseek", is_active: true, validated_at: "2026-11-01T10:00:00Z" },
      { provider: "anthropic", is_active: true, validated_at: "2026-11-02T10:00:00Z" },
    ]);

    const ativos = await provedoresAtivosDaInstalacao(db, { OPENAI_API_KEY: "sk-teste" });

    expect(ativos).toEqual(["anthropic", "openai", "deepseek"]);
    // E o texto composto a partir DESSE registro cita os três países.
    const texto = clausulaDeTransferenciaInternacional(ativos);
    expect(texto).toContain("Anthropic (Estados Unidos)");
    expect(texto).toContain("OpenAI (Estados Unidos)");
    expect(texto).toContain("DeepSeek (China)");
  });

  it("credencial desativada ou ainda não validada NÃO entra na lista", async () => {
    const db = dbDeCredenciais([
      { provider: "google", is_active: false, validated_at: "2026-11-01T10:00:00Z" },
      { provider: "openrouter", is_active: true, validated_at: null },
    ]);

    expect(await provedoresAtivosDaInstalacao(db, {})).toEqual([]);
  });

  it("chave vazia no .env é ausente — o contrato do template de instalação", async () => {
    const db = dbDeCredenciais([]);

    expect(
      await provedoresAtivosDaInstalacao(db, { ANTHROPIC_API_KEY: "   ", OPENAI_API_KEY: "" }),
    ).toEqual([]);
  });

  it("leitura do banco falhou: devolve null, não lista vazia", async () => {
    const db = dbDeCredenciais([], { message: "canceling statement due to statement timeout" });

    expect(await provedoresAtivosDaInstalacao(db, {})).toBeNull();
  });
});
