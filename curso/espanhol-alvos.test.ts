// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { traduzir } from "../lib/i18n/dicionario";
import catalogoJson from "./espanhol-alvos.json";
import { traducaoDaDemonstracao } from "./espanhol-demonstracao";

const catalogo: Readonly<Record<string, string>> = catalogoJson;
const t = (texto: string) => traduzir(texto, "es");
const padrao = (texto: string) => new RegExp(catalogo[texto] ?? texto);

/** Os identificadores e os dados dos personagens não são rótulos do produto. */
function alvosDasLicoes() {
  const textos = new Set<string>();
  const regex = new Set<string>();
  function visitar(valor: unknown, alvo = false) {
    if (Array.isArray(valor)) {
      valor.forEach((item) => visitar(item));
      return;
    }
    if (!valor || typeof valor !== "object") return;
    const objeto = valor as Record<string, unknown>;
    if (alvo) {
      for (const chave of ["nome", "rotulo", "placeholder", "texto"]) {
        const texto = objeto[chave];
        if (typeof texto !== "string") continue;
        textos.add(texto);
        if (objeto.regex === true) regex.add(texto);
      }
      if (typeof objeto.css === "string") {
        for (const trecho of objeto.css.matchAll(/(?:has-text|text-is)\((["'])(.*?)\1\)|aria-label(?:[~|^$*])?=(["'])(.*?)\3/g)) {
          textos.add(trecho[2] ?? trecho[4]!);
        }
      }
    }
    for (const [chave, item] of Object.entries(objeto)) {
      visitar(item, chave === "alvo" || chave === "clicar" || (alvo && chave === "dentro"));
    }
  }
  for (const arquivo of readdirSync("curso/licoes").filter((nome) => nome.endsWith(".json"))) {
    visitar(JSON.parse(readFileSync(path.join("curso/licoes", arquivo), "utf8")));
  }
  return { textos, regex };
}

describe("alvos em espanhol das fotografias do curso", () => {
  it("acompanha os nomes de etapas traduzidos pela semente", () => {
    const primeiro = traducaoDaDemonstracao("Primeiro contato");
    const consulta = traducaoDaDemonstracao("Consulta agendada");
    expect(primeiro).toBe("Primer contacto");
    expect(consulta).toBe("Consulta programada");
    expect(catalogo["Nome da etapa «Primeiro contato»"]).toBe(`${t("Nome da etapa")} «${primeiro}»`);
    expect(catalogo["Nome da etapa «Consulta agendada»"]).toBe(`${t("Nome da etapa")} «${consulta}»`);
    expect(catalogo["3h em Primeiro contato"]).toBe(`3h ${t("em")} ${primeiro}`);
    expect(catalogo["em Consulta agendada"]).toBe(`${t("em")} ${consulta}`);
    expect(catalogo["Selecionar todos em Primeiro contato"]).toBe(`${t("Selecionar todos em")} ${primeiro}`);
  });
  it("mantém um JSON sem duplicatas e somente exceções usadas nas lições", () => {
    const fonte = readFileSync("curso/espanhol-alvos.json", "utf8");
    const chaves = [...fonte.matchAll(/^  ("(?:[^"\\]|\\.)*"):/gm)]
      .map((linha) => JSON.parse(linha[1]!) as string);
    expect(new Set(chaves).size).toBe(chaves.length);
    expect(chaves.length).toBe(Object.keys(catalogo).length);
    const { textos, regex } = alvosDasLicoes();
    for (const [original, espanhol] of Object.entries(catalogo)) {
      expect(textos.has(original), `alvo sem consumidor: ${original}`).toBe(true);
      expect(espanhol.trim(), original).not.toBe("");
      expect(espanhol, original).not.toBe(original);
      expect(traduzir(original, "es"), `tradução exata dispensa exceção: ${original}`).toBe(original);
      if (regex.has(original)) {
        expect(() => new RegExp(espanhol), original).not.toThrow();
        expect(espanhol.startsWith("^"), original).toBe(original.startsWith("^"));
        expect(espanhol.endsWith("$"), original).toBe(original.endsWith("$"));
      }
    }
  });

  it.each([
    ["^Fila", "Fila"],
    ["^Automático", "Automático"],
    ["^Minhas", "Minhas"],
    ["^Aguardando", "Aguardando"],
    ["^Arquivadas", "Arquivadas"],
    ["^Fechadas", "Fechadas"],
  ])("encontra a aba %s com o contador real do produto", (original, chave) => {
    expect(padrao(original).test(`${t(chave)} 12`)).toBe(true);
    expect(padrao(original).test(`Outra aba ${t(chave)} 12`)).toBe(false);
    if (t(chave) !== chave) expect(padrao(original).test(`${chave} 12`)).toBe(false);
  });

  it.each([
    ["^\\d+ contatos$", "7", "contatos", ""],
    ["^\\d+ solicitaç(ões|ão)\\+?$", "1", "solicitação", ""],
    ["^\\d+ solicitaç(ões|ão)\\+?$", "7", "solicitações", "+"],
    ["^\\d+ usuários?\\+?$", "1", "usuário", ""],
    ["^\\d+ usuários?\\+?$", "7", "usuários", "+"],
  ])("preserva quantidade, plural e limite de página de %s", (original, numero, unidade, mais) => {
    const texto = `${numero} ${t(unidade)}${mais}`;
    expect(padrao(original).test(texto)).toBe(true);
    expect(padrao(original).test(`antes ${texto}`)).toBe(false);
    expect(padrao(original).test(`${texto} depois`)).toBe(false);
  });

  it("preserva os parênteses escapados dos botões de canais", () => {
    for (const verbo of ["Pausar", "Retomar"]) {
      const regex = padrao(`${verbo} todas \\(\\d+\\)`);
      expect(regex.test(`${t(`${verbo} todas`)} (4)`)).toBe(true);
      expect(regex.test(`${t(`${verbo} todas`)} 4`)).toBe(false);
    }
  });

  it.each([
    ["^Propostas Configure", "Propostas", "Configure a validade padrão e condições para propostas comerciais."],
    ["^Propostas Rascunhe", "Propostas", "Rascunhe, revise e envie propostas comerciais — do orçamento ao aceite."],
    ["^Automações O freio", "Automações", "O freio único do passo em que a IA escolhe entre as opções de uma regra, para a empresa inteira."],
    ["^Tags O vocabulário", "Tags", "O vocabulário de etiquetas da empresa: onde cada uma é usada e como renomear, juntar ou excluir."],
    ["^Conversões Devolver ao anúncio", "Conversões", "Devolver ao anúncio as vendas que ele trouxe, e marcar a origem de quem chega pelo site."],
  ])("encontra %s montado com título e descrição separados", (original, titulo, descricao) => {
    expect(padrao(original).test(`${t(titulo)} ${t(descricao)}`)).toBe(true);
  });

  it.each([
    ["^Nas conversas, o assistente consulta este banco sem limitar", "Nas conversas, o assistente consulta este banco sem limitar ao cliente que está falando. Escolha, em Editar, a coluna que identifica o cliente."],
    ["^Conecte um banco de dados de outro sistema", "Conecte um banco de dados de outro sistema — o seu segundo CRM, um ERP, uma planilha num banco PostgreSQL ou MySQL — e o agente passa a consultá-lo em tempo real. A conexão é sempre somente leitura: nada que o agente faz altera o banco de origem."],
    ["^A senha é cifrada antes de gravar", "A senha é cifrada antes de gravar e nunca é mostrada de volta. A conexão é somente leitura e só aceita TLS por padrão."],
    ["Este modelo quase não pede nada ao cliente", "Este modelo quase não pede nada ao cliente: a IA não saberá o que perguntar. Troque por {{campo}} o que muda de um projeto para outro."],
    ["O plano escolhido e seus limites passam a valer na próxima renovação", "O plano escolhido e seus limites passam a valer na próxima renovação. A fatura atual mantém o valor e o vencimento."],
  ])("encontra o prefixo %s na frase completa traduzida pelo CRM", (original, frase) => {
    expect(padrao(original).test(t(frase))).toBe(true);
  });

  it("preserva as partes variáveis de horário, funil e gravidade", () => {
    expect(padrao("^Recebido em .* · Vence em").test(`${t("Recebido em")} 27/10/2026 · ${t("Vence em")} 03/11/2026`)).toBe(true);
    expect(padrao("^Funil\\s+·").test(`${t("Funil")} \t · 9`)).toBe(true);
    expect(padrao("^Funil do atendente").test(`${t("Funil")} ${t("do atendente")} · 9`)).toBe(true);
    expect(padrao("^há ").test(t("há {tempo}").replace("{tempo}", "3 horas"))).toBe(true);
    expect(padrao("^FisioMove Reabilitação.*Atenção.*LGPD").test(`FisioMove Reabilitação ${t("Atenção")} LGPD`)).toBe(true);
    expect(padrao("^NutriVida Consultório.*IA Budget").test(`NutriVida Consultório ${t("IA Budget")}`)).toBe(true);
    expect(padrao("^Rede Sorriso Pleno.*Atenção.*Overflow").test(`Rede Sorriso Pleno ${t("Atenção")} ${t("Overflow")}`)).toBe(true);
    expect(padrao("^Tag: convenio").test(`${t("Tag")}: convenio`)).toBe(true);
  });

  it.each([
    ["Limpar filtros ×", `${t("Limpar filtros")} ×`],
    ["1 usuário", `1 ${t("usuário")}`],
    ["2 tabelas liberadas", `2 ${t("tabelas liberadas")}`],
    ["39 acontecimentos", `39 ${t("acontecimentos")}`],
    ["Imagens 1", `${t("Imagens")} 1`],
    ["Posição 1 na fila", `${t("Posição")} 1 ${t("na fila")}`],
    ["parado há 30h", `${t("parado há")} 30h`],
    ["status: Aguardando resposta", `${t("status")}: ${t("Aguardando resposta")}`],
    ["status: Rascunho", `${t("status")}: ${t("Rascunho")}`],
    ["Gerente ou administrador · Padrão: desligado", `${t("Gerente ou administrador")} · ${t("Padrão: desligado")}`],
  ])("acompanha o literal composto %s", (original, esperado) => {
    expect(catalogo[original]).toBe(esperado);
  });

  it.each([
    ["A carência vai de 0 a 30 dias", "A carência vai de 0 a 30 dias: durante o prazo ninguém é bloqueado, e depois dele a tela trava até o cadastro. O prazo começa na mudança da regra ou na entrada da pessoa na empresa, o que for mais tarde."],
    ["Os números vêm da plataforma no momento em que você clica em Atualizar", "O desempenho das campanhas que estão trazendo gente para cá. Os números vêm da plataforma no momento em que você clica em Atualizar — nada fica guardado aqui."],
    ["Novos canais começam em modo de teste", "Novos canais começam em modo de teste, sem respostas automáticas até você autorizar números ou liberar o público."],
    ["Sua cor é um tom neutro", "Sua cor é um tom neutro (cinza, preto ou branco), e uma cor assim não destaca nada na tela. Os botões seguem com a cor padrão do sistema, e a sua fica reservada ao logo."],
  ])("encontra o trecho literal %s dentro da frase completa", (original, frase) => {
    expect(t(frase)).not.toBe(frase);
    expect(t(frase)).toContain(catalogo[original]);
  });

  it("traduz os rótulos compostos e preserva nomes e slugs dos dados", () => {
    expect(catalogo["Papel de Ana Ribeiro"]).toBe(`${t("Papel de")} Ana Ribeiro`);
    expect(catalogo["Editar os dados de Odonto Sorriso Leve"])
      .toBe(t("Editar os dados de {nome}").replace("{nome}", "Odonto Sorriso Leve"));
    expect(catalogo["Remover tag pos-cirurgia"]).toBe(`${t("Remover tag")} pos-cirurgia`);
    expect(catalogo["Suspender Odonto Sorriso Leve"])
      .toBe(t("Suspender {nome}").replace("{nome}", "Odonto Sorriso Leve"));
    for (const tecnico of ["funil-pacientes", "#7c41e9a2", "role:manager", "convenio", "whatsapp.session_disconnected", "^#[0-9a-f]{8}$", "^marcos\\.teixeira@clinicabemviver"]) {
      expect(Object.hasOwn(catalogo, tecnico), tecnico).toBe(false);
    }
  });
});
