/**
 * A PRIMEIRA MENSAGEM USA TUDO O QUE A BUSCA ACHOU (#4459).
 *
 * ## O defeito, medido no prompt de hoje
 *
 * Para uma empresa SEM site com nota 4,9, 37 avaliações, Instagram publicado e
 * celular, o prompt recebia só `Empresa`, `Segmento`, `Endereço`,
 * `Avaliação: 4.9` (nota nua), `Redes: <url>` (URL crua) e
 * `Auditoria: Sem site próprio`. O NÚMERO de avaliações e o tipo de telefone não
 * chegavam; e a instrução do ramo frio só autorizava citar `Auditoria`. Material
 * citável, no caso mais comum de negócio local: "não tem site". A mensagem saía
 * genérica — e mensagem fria parecida em sequência é o que leva a denúncia e a
 * banimento de número.
 *
 * ## Por que a asserção é sobre o TEXTO do prompt, e não sobre o que o modelo
 * escreve
 *
 * O que o modelo devolve varia com temperatura. O que este teste fixa é o
 * MATERIAL e a REGRA que chegam até ele: se o sinal não entra na ficha, ou se a
 * instrução proíbe citá-lo, nenhuma temperatura salva a mensagem.
 */
import { describe, expect, it } from "vitest";

import { blocoDeModo, formatarDados, type OrigemDaAbordagem } from "@/lib/agent-engine/agent/abordagem-de-formulario";
import {
  estrategiaDoCandidato,
  instrucaoDeAbordagemFria,
  montarDadosDeAbordagem,
} from "@/lib/prospecting/estrategia-site";
import type { Prospect } from "@/lib/prospecting/schema";
import { siteEfetivo } from "@/lib/prospecting/site-efetivo";
import { fichaDoGoogle, tipoDeTelefone } from "@/lib/prospecting/sinais-da-empresa";

const AGORA = "2026-11-12T12:00:00.000Z";

const BASE = {
  key: "k",
  maps_url: null,
  emails: [] as string[],
};

const SEM_SITE_COM_REPUTACAO: Prospect = {
  ...BASE,
  name: "Clínica Sorriso",
  phone: "+5511999998888",
  website: null,
  category: "Clínica odontológica",
  address: "Rua A, 10",
  rating: 4.9,
  reviews: 37,
  socials: ["https://instagram.com/clinicasorriso"],
  whatsapp: { existe: true, verificado_em: "2026-11-03T09:00:00.000Z" },
};

/** O caminho REAL do envio: veredito efetivo → estratégia → dados → prompt. */
function promptDe(p: Prospect) {
  const site = siteEfetivo(p, AGORA);
  const estrategia = site
    ? estrategiaDoCandidato(p, site, {
        ofertas: ["site"],
        nicho: p.category ?? "",
        status: "queued",
      })
    : null;
  const dados = montarDadosDeAbordagem(p, site, null);
  const instrucao = instrucaoDeAbordagemFria(
    "Escreva uma abordagem curta.",
    "segmento e dor",
    undefined,
    estrategia,
    false,
  );
  return {
    dados,
    ficha: formatarDados(dados),
    instrucao,
    prompt: blocoDeModo("prospeccao_fria", "abcd1234", instrucao),
  };
}

describe("#4459 — a empresa SEM site leva os outros sinais para a 1ª mensagem", () => {
  it("o número de avaliações, o nome da rede e o tipo de telefone chegam ao prompt", () => {
    const { ficha, dados } = promptDe(SEM_SITE_COM_REPUTACAO);
    // O que o defeito escondia: a CONTAGEM, não só a nota.
    expect(dados["Ficha do Google"]).toBe("nota 4,9 com 37 avaliações");
    expect(ficha).toContain("nota 4,9 com 37 avaliações");
    // A rede pelo NOME — URL crua o modelo copia ou ignora.
    expect(dados["Redes"]).toBe("Instagram: https://instagram.com/clinicasorriso");
    expect(ficha).toContain("Instagram");
    // O tipo de telefone, com a conferência do canal datada.
    expect(dados["Telefone"]).toBe("celular — com WhatsApp (conferido em 03/11/2026)");
    expect(ficha).toContain("Telefone: celular");
    // Sem site continua sendo dito — como FATO medido, na linha da auditoria.
    expect(dados["Auditoria"]).toBe("Sem site próprio (verificado em 12/11/2026)");
  });

  it("a instrução autoriza UM desses fatos como motivo, e por nome", () => {
    const { prompt } = promptDe(SEM_SITE_COM_REPUTACAO);
    expect(prompt).toMatch(/Motivo do contato: escolha UM fato da ficha/);
    expect(prompt).toMatch(/`Ficha do Google` \(nota e número de avaliações\)/);
    expect(prompt).toMatch(/`Redes` publicadas/);
    expect(prompt).toMatch(/`Telefone`/);
    // "como quem notou", nunca como auditoria nem como lista.
    expect(prompt).toMatch(/como quem notou/);
    expect(prompt).toMatch(/nunca como auditoria nem como lista/);
    // E o limite continua explícito: o que não foi coletado não existe.
    expect(prompt).toMatch(/dado que não está na ficha não existe/);
  });

  it("sem rastro público: nada inventado, e a conversa abre pela rotina do negócio", () => {
    const semRastro: Prospect = {
      ...BASE,
      name: "Oficina do Zé",
      phone: "+551133334444",
      website: null,
      category: "Oficina mecânica",
      address: "Av. B, 20",
      rating: null,
      reviews: null,
      socials: [],
    };
    const { dados, ficha, prompt } = promptDe(semRastro);
    expect(dados).not.toHaveProperty("Ficha do Google");
    // Ausência NÃO vira afirmação: "sem avaliações" é sobre o mundo, e o dado
    // só diz que a busca não trouxe nada.
    expect(ficha).not.toMatch(/sem avaliaç/i);
    expect(ficha).not.toMatch(/0 avaliaç/i);
    expect(prompt).toMatch(/NÃO invente um achado/);
    expect(prompt).toMatch(/abra pela rotina do negócio/);
    expect(prompt).toMatch(/sem fingir que pesquisou/);
    // O telefone FIXO, esse sim, é fato — e é material de conversa.
    expect(dados["Telefone"]).toBe("fixo");
  });

  it("telefone fixo SEM WhatsApp é o ângulo mais forte: sai com a data da conferência", () => {
    const p: Prospect = {
      ...SEM_SITE_COM_REPUTACAO,
      phone: "+551133334444",
      whatsapp: { existe: false, verificado_em: "2026-11-01T08:00:00.000Z" },
    };
    expect(promptDe(p).dados["Telefone"]).toBe(
      "fixo — sem WhatsApp (conferido em 01/11/2026)",
    );
  });

  it("número de outro país não vira celular nem fixo — o comprimento não diz o tipo", () => {
    expect(tipoDeTelefone("+351912345678")).toBeNull();
    expect(tipoDeTelefone(null)).toBeNull();
    expect(tipoDeTelefone("+551133334444")).toBe("fixo");
    expect(tipoDeTelefone("+5511999998888")).toBe("celular");
  });

  it("nota e contagem são independentes: o que não veio não é escrito", () => {
    expect(fichaDoGoogle({ rating: 4.9, reviews: null })).toBe("nota 4,9");
    expect(fichaDoGoogle({ rating: null, reviews: 1 })).toBe("1 avaliação");
    expect(fichaDoGoogle({ rating: null, reviews: null })).toBeNull();
  });

  it("a permissão é do ramo FRIO: formulário e automação não ganham o motivo da ficha", () => {
    for (const origem of ["formulario", "automacao"] as OrigemDaAbordagem[]) {
      expect(blocoDeModo(origem, "abcd1234", "x")).not.toContain("Motivo do contato:");
    }
  });

  it("a proibição de inventar familiaridade não foi afrouxada pela permissão nova", () => {
    const { prompt } = promptDe(SEM_SITE_COM_REPUTACAO);
    expect(prompt).toMatch(/NÃO preencheu formulário nenhum/);
    expect(prompt).toMatch(/NÃO diga nem insinue que ela preencheu/);
    expect(prompt).toMatch(/NÃO invente histórico, interesse, indicação/);
    expect(prompt).toMatch(/dado pessoal/i);
  });
});
