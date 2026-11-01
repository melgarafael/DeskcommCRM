/**
 * O ATESTADO DE ANONIMIZAÇÃO — o que o PAPEL declara, e o que ele se recusa a declarar.
 *
 * ─── O que cada caso fecha ──────────────────────────────────────────────────
 *
 * O pedido de exclusão precisa de um documento que o titular guarde: quem fez,
 * quando, de onde e um código que amarre o conjunto. O que este arquivo mede é
 * o documento DE VERDADE — o componente é chamado e os textos são colhidos da
 * árvore (`textos`, a mesma técnica de `art-15-entregue-no-pdf`) —, e não um
 * resumo do que ele deveria dizer.
 *
 * ─── Os NEGATIVOS mudaram de lado no CR do PR #3321 ─────────────────────────
 *
 * O arquivo tinha casos afirmando que o papel imprimia o titular MASCARADO
 * ("Maria Souza", `m***@exemplo.com`, `(**) ****-1234`) e a citação de lei do
 * perfil do país. O CR pediu o INVERSO em dois itens: o papel não carrega
 * identidade do titular — nem mascarada, porque é cópia nova de dado
 * reidentificável sobrevivendo ao apagamento que ele atesta (item 1) —, e não
 * cita lei, porque a citação do perfil é a do direito de ACESSO (item 2). Os
 * casos foram reescritos como asserções de AUSÊNCIA, com o valor proibido
 * escrito por extenso em `PII_DO_TITULAR`: é isso que faz a volta do dado
 * reidentificável ficar vermelha aqui.
 *
 * Os negativos que continuam valendo: (3) NÃO pode inventar um responsável
 * quando a execução foi automática; (4) NÃO pode exibir o mesmo selo para HMAC
 * (prova origem) e SHA-256 (prova só integridade).
 */
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import {
  VERSAO_DO_ATESTADO,
  codigoCurto,
  codigoDeAutenticidade,
  evidenciaDoPedido,
  linhaCanonica,
  textoDaDeclaracao,
  type DadosDoAtestado,
} from "@/lib/lgpd/atestado-de-anonimizacao";
import { AtestadoDeAnonimizacaoPdf } from "@/lib/lgpd/atestado-renderer";

function textos(no: ReactNode): string[] {
  if (no === null || no === undefined || typeof no === "boolean") return [];
  if (typeof no === "string") return [no];
  if (typeof no === "number") return [String(no)];
  if (Array.isArray(no)) return no.flatMap(textos);
  const el = no as ReactElement<{ children?: ReactNode }>;
  if (el.props && "children" in el.props) return textos(el.props.children);
  return [];
}

/**
 * O que a anonimização APAGOU. A fixture antiga imprimia isto no papel (nome,
 * documento e contatos mascarados); aqui os valores existem só para permitir
 * afirmar que NÃO estão no documento — nem na linha canônica do código.
 */
const PII_DO_TITULAR = [
  "Maria Souza",
  "m***@exemplo.com",
  "maria@exemplo.com",
  "(**) ****-1234",
  "(**) ****-7777",
  "***.***.***-45",
  "529.982.247-25",
] as const;

function dados(over: Partial<DadosDoAtestado> = {}): DadosDoAtestado {
  return {
    request_id: "11111111-2222-3333-4444-555555555555",
    organization_id: "org-1",
    organization_name: "Loja Exemplo LTDA",
    organization_document: "12.345.678/0001-90",
    organization_email: "dpo@loja.exemplo",
    evidencia: {
      executor: { user_id: "u1", nome: "Ana Lima", email: "ana@loja.exemplo", papel: "administrador" },
      ip: "203.0.113.7",
      em: "2026-10-22T15:04:05.000Z",
      origem: "aprovacao_manual",
    },
    escopo: "contact",
    fuso: "America/Sao_Paulo",
    ...over,
  };
}

/** O papel montado, com espaços colapsados. */
function papel(
  d: DadosDoAtestado,
  codigo = "A1B2-C3D4-E5F6-7890",
  algoritmo: "hmac-sha256" | "sha256" = "hmac-sha256",
): string {
  return textos(AtestadoDeAnonimizacaoPdf({ dados: d, codigo, algoritmo })).join(" ").replace(/\s+/g, " ");
}

describe("o papel declara o que o pedido precisa provar", () => {
  it("identifica o controlador, o requerente PELO PROTOCOLO, o ato datado e o código", () => {
    const p = papel(dados());

    expect(p).toContain("Atestado de Anonimização de Dados Pessoais");
    // O CONTROLADOR responde pelos dados — e o CNPJ dele sai inteiro (dado
    // público de empresa; é ele que diz de quem é o documento).
    expect(p).toContain("Loja Exemplo LTDA");
    expect(p).toContain("12.345.678/0001-90");
    expect(p).toContain("dpo@loja.exemplo");
    // O requerente: o protocolo é a identificação — e o papel diz que é assim
    // de propósito, em vez de deixar a ausência de nome parecer falha de
    // impressão.
    expect(p).toContain("11111111-2222-3333-4444-555555555555");
    expect(p).toMatch(/Protocolo #11111111/);
    expect(p).toContain("identificado apenas pelo protocolo do pedido");
    // O ato: quando, quem, de onde.
    expect(p).toContain("22/10/2026, 12:04:05 (America/Sao_Paulo)");
    expect(p).toContain("Ana Lima");
    expect(p).toContain("203.0.113.7");
    expect(p).toContain("aprovação no painel");
    // E o que amarra tudo.
    expect(p).toContain("A1B2-C3D4-E5F6-7890");
    expect(p).toContain(VERSAO_DO_ATESTADO);
  });

  it("a data e a hora saem no fuso da ORGANIZAÇÃO — no campo e na declaração", () => {
    // 15:04:05 em UTC é 16:04:05 em Lisboa (WEST, UTC+1, até 25/10/2026). O ISO
    // em UTC ao lado de "(Europe/Lisbon)" faria o titular ler uma hora que não
    // é a dele.
    const d = dados({ fuso: "Europe/Lisbon" });
    const p = papel(d);
    const declaracao = textoDaDeclaracao(d);

    expect(p).toContain("22/10/2026, 16:04:05 (Europe/Lisbon)");
    expect(declaracao).toContain("em 22/10/2026, 16:04:05 (Europe/Lisbon)");
    for (const impresso of [p, declaracao]) {
      expect(impresso, "o papel voltou a imprimir o ISO em UTC").not.toContain("2026-10-22T15:04:05");
      expect(impresso).not.toMatch(/\d{2}:\d{2}:\d{2}(\.\d+)?Z/);
    }
    // A linha canônica segue com o ISO: é o que um auditor reproduz.
    expect(linhaCanonica(d)).toContain("2026-10-22T15:04:05.000Z");
  });

  it("fuso inválido no cadastro cai para UTC — e diz UTC, não o nome do fuso", () => {
    const p = papel(dados({ fuso: "Marte/Olympus" }));
    expect(p).toContain("22/10/2026, 15:04:05 (UTC)");
    expect(p).not.toContain("Marte/Olympus");
  });

  it("NÃO imprime nome, documento nem contato do titular — nem mascarados (item 1 do CR)", () => {
    const p = papel(dados());

    for (const proibido of PII_DO_TITULAR) {
      expect(p, `o papel voltou a imprimir ${JSON.stringify(proibido)}`).not.toContain(proibido);
    }
    // A forma MASCARADA também é cópia do dado apagado: nenhum bloco de CPF nem
    // telefone mascarado pode aparecer, mesmo que o valor exato mude.
    expect(p, "o papel imprime CPF mascarado").not.toMatch(/\*{3}\.\*{3}\.\*{3}-\d{2}/);
    expect(p, "o papel imprime telefone mascarado").not.toMatch(/\*{4}-\d{4}/);
    expect(p, "o papel imprime e-mail mascarado").not.toMatch(/\*{3}@/);
  });

  it("NÃO cita lei nenhuma — nem a do direito de acesso (item 2 do CR)", () => {
    const d = dados();
    const p = papel(d);
    const declaracao = textoDaDeclaracao(d);

    // Nem a lei, nem o artigo: a citação do perfil (`LGPD Art. 18, II` no
    // Brasil, `RGPD art. 15.º` em Portugal) é a do direito de ACESSO e não
    // descreve este pedido.
    for (const texto of [p, declaracao]) {
      expect(texto).not.toMatch(/LGPD|RGPD|GDPR/);
      expect(texto).not.toMatch(/art\.|artigo|Art\./i);
      expect(texto).not.toMatch(/Lei n/i);
    }
    // E a frase de ausência NÃO substitui a citação: ela diria "país sem citação
    // revisada", que é FALSO para Portugal (o perfil de lá tem citação).
    expect(p).not.toContain("não declarada (país sem citação revisada)");
    expect(p).not.toContain("Base legal");
  });

  it("a declaração é de FATO — nenhum artigo, e o vínculo é o protocolo", () => {
    const t = textoDaDeclaracao(dados());
    expect(t).toContain("11111111-2222-3333-4444-555555555555");
    expect(t).toContain("ANONIMIZADOS");
    expect(t).toContain("203.0.113.7");
    expect(t).toContain("não reproduz nome, documento nem contato do titular");
    expect(t).not.toContain("Maria Souza");
    expect(t).not.toMatch(/art\.|artigo|LGPD|RGPD|Lei n/i);
  });

  it("execução automática: o papel NÃO inventa responsável", () => {
    const automatica = evidenciaDoPedido(undefined, "2026-10-22T15:04:05.000Z");
    expect(automatica.origem).toBe("automatica");
    expect(automatica.executor).toBeNull();

    const p = papel(dados({ evidencia: automatica }));
    expect(p).toContain("execução automática do sistema");
    expect(p).toContain("sem ato humano (execução automática)");
    expect(p).not.toContain("Ana Lima");
  });

  it("instalação sem chave exibe INTEGRIDADE, não autenticidade", () => {
    const p = papel(dados(), "A1B2-C3D4-E5F6-7890", "sha256");
    expect(p).toContain("Código de integridade (SHA-256");
    expect(p).toContain("não prova a origem");
    expect(p).not.toContain("Código de autenticidade");
  });

  it("escopo de loja inteira muda a frase do papel — e do escopo do titular", () => {
    expect(papel(dados({ escopo: "tenant" }))).toContain("base completa da organização");
    expect(papel(dados())).toContain("dados do titular");
  });
});

describe("o código de autenticidade amarra o documento à instalação", () => {
  it("é determinístico e muda se UM campo mudar", () => {
    const a = codigoDeAutenticidade(dados(), "chave-de-assinatura-longa");
    const b = codigoDeAutenticidade(dados(), "chave-de-assinatura-longa");
    const alterado = codigoDeAutenticidade(
      dados({ organization_name: "Loja Exemplo LTDA ME" }),
      "chave-de-assinatura-longa",
    );

    expect(a.codigo).toBe(b.codigo);
    expect(a.algoritmo).toBe("hmac-sha256");
    expect(a.codigo).toMatch(/^[0-9a-f]{64}$/);
    expect(alterado.codigo).not.toBe(a.codigo);
  });

  it("instalação sem chave degrada para SHA-256 — e diz que degradou", () => {
    for (const chave of [null, "", "curta"]) {
      const r = codigoDeAutenticidade(dados(), chave);
      expect(r.algoritmo).toBe("sha256");
      expect(r.codigo).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("a linha canônica NÃO carrega identidade do titular (item 1 do CR)", () => {
    const linha = linhaCanonica(dados());

    for (const proibido of PII_DO_TITULAR) {
      expect(linha, `a linha canônica voltou a assinar ${JSON.stringify(proibido)}`).not.toContain(proibido);
    }
    // O que ela assina é o que o papel declara: protocolo, controlador, escopo e
    // o ato de execução.
    expect(linha).toContain("11111111-2222-3333-4444-555555555555");
    expect(linha).toContain("Loja Exemplo LTDA");
    expect(linha).toContain("Ana Lima");
    expect(linha.split("|")).toHaveLength(12);
  });

  it("a linha canônica marca o ausente com `-`: ausente e vazio não geram o mesmo código", () => {
    const completo = linhaCanonica(dados());
    const semEmail = linhaCanonica(
      dados({
        evidencia: {
          ...dados().evidencia,
          executor: { user_id: null, nome: "Ana Lima", email: null, papel: "administrador" },
        },
      }),
    );
    const emailVazio = linhaCanonica(
      dados({
        evidencia: {
          ...dados().evidencia,
          executor: { user_id: null, nome: "Ana Lima", email: "", papel: "administrador" },
        },
      }),
    );

    expect(completo.split("|")[0]).toBe(VERSAO_DO_ATESTADO);
    expect(semEmail.split("|")).toContain("-");
    expect(emailVazio).not.toBe(semEmail);
  });

  it("o código citável é o recorte de 16 hex em quatro blocos", () => {
    expect(codigoCurto("a1b2c3d4e5f6789012345678abcdef01")).toBe("A1B2-C3D4-E5F6-7890");
  });
});

describe("a evidência vem do que o pedido guardou — nada é adivinhado", () => {
  it("evidência do ato humano: quem, de onde, quando", () => {
    const e = evidenciaDoPedido(
      {
        origem: "aprovacao_manual",
        executor: { user_id: "u9", nome: "Ana Lima", email: "ana@loja", papel: "owner" },
        ip: "198.51.100.9",
        user_agent: "Firefox",
        em: "2026-10-22T12:00:00.000Z",
      },
      "2026-10-22T13:00:00.000Z",
    );

    // O `user_agent` que um pedido antigo guardou NÃO é copiado: nada o imprime
    // nem o consome, e dado de quem opera sem leitor não atravessa.
    expect(e).toEqual({
      executor: { user_id: "u9", nome: "Ana Lima", email: "ana@loja", papel: "owner" },
      ip: "198.51.100.9",
      em: "2026-10-22T12:00:00.000Z",
      origem: "aprovacao_manual",
    });
  });

  it("JSONB adulterado não vira linha do documento", () => {
    for (const adulterada of [
      { origem: "aprovacao_manual", executor: { nome: "" } },
      { origem: "aprovacao_manual", executor: { nome: 42 } },
      { origem: "aprovacao_manual" },
      "texto solto",
      7,
      null,
    ]) {
      const e = evidenciaDoPedido(adulterada, "2026-10-22T13:00:00.000Z");
      expect(e.origem, `aceitou evidência inválida: ${JSON.stringify(adulterada)}`).toBe("automatica");
      expect(e.em).toBe("2026-10-22T13:00:00.000Z");
    }
  });
});
