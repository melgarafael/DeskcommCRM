/**
 * UMA FRASE, QUATRO TELAS.
 *
 * ═══ O que este teste prova (e por que ele falhava antes) ═══════════════════
 *
 * `"{{saudacao}}, {{primeiro_nome}}!"` é a frase da issue #3687: a mesma que a
 * campanha sempre soube escrever e que, na automação e no follow-up, saía
 * `", Ana!"` — porque `{{saudacao}}` era chave desconhecida e virava string
 * vazia. No Inbox o token ia LITERAL para o cliente. Quatro telas, quatro
 * saídas para a mesma frase, o mesmo contato e o mesmo instante.
 *
 * Cada asserção chama a FUNÇÃO DE ENTRADA DA TELA (não o resolvedor por
 * dentro): `interpolateTemplate` é o que a resposta rápida usa; `renderTemplate`
 * é o que a automação usa; `renderizarTextoDeFollowup` é o caminho do follow-up
 * de texto; `renderizar` é o da campanha. Se uma tela deixar de usar o
 * resolvedor único, este teste continua verde enquanto a saída for a mesma —
 * e é por isso que `tests/unit/variaveis-fonte-unica.test.ts` confere a ligação
 * no fonte, arquivo por arquivo.
 *
 * O contato e o negócio são os MESMOS nas quatro: o que muda entre as telas é
 * de onde o dado vem (linha do banco, snapshot da audiência), nunca o que a
 * frase significa.
 */
import { describe, expect, it } from "vitest";

import { renderizarTextoDeFollowup } from "@/lib/automation/texto-do-followup";
import { renderTemplate } from "@/lib/automation/template";
import { renderizar } from "@/lib/campanhas/renderizador";
import { interpolateTemplate } from "@/lib/inbox/template-vars";
import { valorDaFonte } from "@/lib/channels/meta/variaveis-do-fluxo";
import { resolverVariaveis } from "@/lib/variaveis/resolvedor";

const CONTATO = {
  id: "c1",
  name: "Ana Souza",
  display_name: null,
  phone_number: "+5511999998888",
  email: "ana@exemplo.com",
  custom_fields: { link_previa: "https://loja.exemplo/previa/ana" },
};

const NEGOCIO = {
  id: "l1",
  title: "Plano Pro",
  custom_fields: { servico: "Site institucional", destino: ["paris-franca"] },
};

/** O que o fluxo do modelo aprovado tem para preencher (mapa posicional). */
const DADOS_DO_FLUXO = {
  nomeDoContato: "Ana Souza",
  camposDoNegocio: { servico: "Site institucional" },
};

/** 12h em São Paulo: o corte da saudação é o do português falado. */
const MEIO_DIA = new Date("2026-11-05T15:00:00.000Z");
const FUSO = "America/Sao_Paulo";
const AGORA = { instante: MEIO_DIA, fuso: FUSO };

/** A frase da issue, resolvida pela porta de entrada de cada tela. */
function nasQuatroTelas(frase: string): Record<string, string> {
  return {
    inbox: interpolateTemplate(frase, { name: "Ana Souza", displayName: null }, AGORA),
    automacao: renderTemplate(frase, { contact: CONTATO, lead: NEGOCIO }, undefined, AGORA),
    followup: renderizarTextoDeFollowup(frase, { contact: CONTATO, lead: NEGOCIO }, AGORA),
    campanha: renderizar(frase, { nome: "Ana Souza" }, { agora: MEIO_DIA, fuso: FUSO }).texto,
  };
}

describe("a mesma frase, o mesmo contato, as quatro telas", () => {
  it("`{{saudacao}}, {{primeiro_nome}}!` sai igual nas quatro", () => {
    const saidas = nasQuatroTelas("{{saudacao}}, {{primeiro_nome}}!");
    expect(saidas).toEqual({
      inbox: "Boa tarde, Ana!",
      automacao: "Boa tarde, Ana!",
      followup: "Boa tarde, Ana!",
      campanha: "Boa tarde, Ana!",
    });
  });

  it("`{{nome}}` sai igual nas quatro", () => {
    const saidas = nasQuatroTelas("Olá, {{nome}}.");
    expect(new Set(Object.values(saidas)).size).toBe(1);
    expect(saidas.inbox).toBe("Olá, Ana Souza.");
  });

  it("sem instante do envio, `{{saudacao}}` fica LITERAL nas quatro (não vira vazio)", () => {
    const frase = "{{saudacao}}, {{primeiro_nome}}!";
    const saidas = {
      inbox: interpolateTemplate(frase, { name: "Ana Souza" }),
      automacao: renderTemplate(frase, { contact: CONTATO, lead: NEGOCIO }),
      followup: renderizarTextoDeFollowup(frase, { contact: CONTATO, lead: NEGOCIO }),
      campanha: renderizar(frase, { nome: "Ana Souza" }).texto,
    };
    expect(new Set(Object.values(saidas)).size).toBe(1);
    expect(saidas.campanha).toBe("{{saudacao}}, Ana!");
  });

  it("a reserva `{{primeiro_nome|\"aluno\"}}` vale igual nas quatro", () => {
    const semNome = "Oi {{primeiro_nome|\"aluno\"}}!";
    expect({
      inbox: interpolateTemplate(semNome, { name: null }),
      automacao: renderTemplate(semNome, { contact: { name: null } }),
      followup: renderizarTextoDeFollowup(semNome, { contact: { name: null } }),
      campanha: renderizar(semNome, { nome: null }).texto,
    }).toEqual({
      inbox: "Oi aluno!",
      automacao: "Oi aluno!",
      followup: "Oi aluno!",
      campanha: "Oi aluno!",
    });
  });

  it("texto sem variável sai IDÊNTICO nas quatro (byte a byte)", () => {
    const cru = "  Oi! Tudo bem?\nLinha dois, sem chave nenhuma. { } %  ";
    for (const saida of Object.values(nasQuatroTelas(cru))) expect(saida).toBe(cru);
  });
});

describe("o resolvedor único: o que cada fonte faz com o que não tem valor", () => {
  it("`quandoVazio: vazio` devolve string vazia (automação)", () => {
    const r = resolverVariaveis("Olá, {{nome}}!", {}, { fonte: "automacao", quandoVazio: "vazio" });
    expect(r).toEqual({ texto: "Olá, !", vazias: ["nome"], desconhecidas: [], pular: false });
  });

  it("`quandoVazio: literal` mantém o token (Inbox)", () => {
    const r = resolverVariaveis("Olá, {{nome}}!", {}, { fonte: "inbox", quandoVazio: "literal" });
    expect(r.texto).toBe("Olá, {{nome}}!");
    expect(r.vazias).toEqual(["nome"]);
  });

  it("`quandoVazio: remover` tira a marcação e o espaço vizinho (follow-up)", () => {
    const r = resolverVariaveis("Oi {{primeiro_nome}}!", {}, { fonte: "automacao", quandoVazio: "remover" });
    expect(r.texto).toBe("Oi!");
  });

  it("`quandoVazio: pular` mantém o token e marca a pessoa (campanha)", () => {
    const r = resolverVariaveis("Olá, {{nome}}!", {}, { fonte: "campanha", quandoVazio: "pular" });
    expect(r).toEqual({ texto: "Olá, {{nome}}!", vazias: ["nome"], desconhecidas: [], pular: true });
  });
});

/**
 * OS SEIS LADOS OPOSTOS (#3687).
 *
 * Unificar o resolvedor é fácil quando só se olha o caminho feliz. O que quebra
 * produção é o resto: token que ninguém conhece, contato sem o dado, automação
 * antiga gravada com o mapa posicional, valor que contém `{{`, a outra
 * organização, e o texto que não tem variável nenhuma. Cada um tem aqui a saída
 * DECLARADA — não a que saiu.
 */
describe("os lados opostos: o que acontece quando não dá certo", () => {
  it("(a) variável DESCONHECIDA: cada tela declara a sua saída, e nenhuma quebra o envio", () => {
    const frase = "Oi, {{variavel_que_nao_existe}}!";
    const inbox = interpolateTemplate(frase, { name: "Ana Souza" }, AGORA);
    const automacao = renderTemplate(frase, { contact: CONTATO, lead: NEGOCIO }, undefined, AGORA);
    const followup = renderizarTextoDeFollowup(frase, { contact: CONTATO, lead: NEGOCIO }, AGORA);
    const campanha = renderizar(frase, { nome: "Ana Souza" }, { agora: MEIO_DIA, fuso: FUSO });

    // Inbox: literal — o operador vê o token antes de enviar, e o cliente também.
    expect(inbox).toBe("Oi, {{variavel_que_nao_existe}}!");
    // Automação: vazio (a política de sempre), e a frase continua enviável.
    expect(automacao).toBe("Oi, !");
    // Follow-up: some com a marcação e o ESPAÇO antes dela — a pontuação fica,
    // que é exatamente o que a automação já gravada faz hoje. Mudar isso agora
    // mudaria o texto de quem já tem follow-up rodando.
    expect(followup).toBe("Oi,!");
    // Campanha: literal + entra em `desconhecidas` (a prévia avisa), sem `faltando`.
    expect(campanha.texto).toBe("Oi, {{variavel_que_nao_existe}}!");
    expect(campanha.desconhecidas).toEqual(["variavel_que_nao_existe"]);
    expect(campanha.faltando).toEqual([]);
  });

  it("(b) contato SEM o dado: vazio declarado, nunca a palavra `undefined`", () => {
    const semEmpresa = { contact: { name: "Ana Souza" }, lead: { custom_fields: {} } };
    const frase = "Na {{lead.empresa}}.";
    const saidas = [
      renderTemplate(frase, semEmpresa),
      renderizarTextoDeFollowup(frase, semEmpresa),
      renderizar(frase, { nome: "Ana Souza" }, { agora: MEIO_DIA, fuso: FUSO }).texto,
      interpolateTemplate(frase, { name: "Ana Souza" }),
    ];
    for (const saida of saidas) {
      expect(saida).not.toContain("undefined");
      expect(saida).not.toContain("null");
    }
    // Automação: a política é vazio; nada de `undefined`.
    expect(saidas[0]).toBe("Na .");
  });

  it("(c) automação JÁ GRAVADA com o mapa posicional continua resolvendo igual", () => {
    // O `FonteDeVariavel` do fluxo é o mapa posicional antigo: `contact_name`,
    // `contact_first_name`, `lead_custom`. Uma automação gravada com ele NÃO
    // pode mudar de saída por causa do catálogo novo.
    expect(valorDaFonte({ kind: "contact_name" }, DADOS_DO_FLUXO)).toBe("Ana Souza");
    expect(valorDaFonte({ kind: "contact_first_name" }, DADOS_DO_FLUXO)).toBe("Ana");
    expect(valorDaFonte({ kind: "lead_custom", key: "servico" }, DADOS_DO_FLUXO)).toBe(
      "Site institucional",
    );
    // E o antigo continua sem conhecer o que o novo conhece: `saudacao` no
    // fluxo é "sem valor" (o passo é recusado com motivo), não saudação errada.
    expect(valorDaFonte({ kind: "variavel", chave: "saudacao" }, DADOS_DO_FLUXO)).toBeNull();
  });

  it("(d) valor com `{{` no meio NÃO entra em laço: resolve uma vez e para", () => {
    // Um contato cujo nome tem a marcação (importação, brincadeira, teste).
    const nomeComChaves = "Ana {{primeiro_nome}} Souza";
    const contato = { contact: { name: nomeComChaves }, lead: {} };
    expect(renderTemplate("Oi, {{nome}}!", contato)).toBe("Oi, Ana {{primeiro_nome}} Souza!");
    expect(renderizarTextoDeFollowup("Oi, {{nome}}!", contato)).toBe(
      "Oi, Ana {{primeiro_nome}} Souza!",
    );
    expect(renderizar("Oi, {{nome}}!", { nome: nomeComChaves }, { agora: MEIO_DIA, fuso: FUSO }).texto).toBe(
      "Oi, Ana {{primeiro_nome}} Souza!",
    );
    expect(interpolateTemplate("Oi, {{nome}}!", { name: nomeComChaves })).toBe(
      "Oi, Ana {{primeiro_nome}} Souza!",
    );
  });

  it("(e) outra organização fica intacta: o resolvedor não guarda estado entre chamadas", () => {
    const orgA = { contact: { name: "Ana Souza" } };
    const orgB = { contact: { name: "Bruno Lima" } };
    expect(renderTemplate("{{nome}}", orgA)).toBe("Ana Souza");
    expect(renderTemplate("{{nome}}", orgB)).toBe("Bruno Lima");
    // De volta à primeira: nada do contexto anterior ficou grudado.
    expect(renderTemplate("{{nome}}", orgA)).toBe("Ana Souza");
    expect(interpolateTemplate("{{nome}}", { name: "Carla Dias" })).toBe("Carla Dias");
    expect(renderizar("{{nome}}", { nome: "Davi" }, { agora: MEIO_DIA, fuso: FUSO }).texto).toBe(
      "Davi",
    );
  });
});
