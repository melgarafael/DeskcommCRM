/**
 * O TEXTO DO AVISO — o que ele DIZ e, sobretudo, o que ele NUNCA diz.
 *
 * O aviso sai por WhatsApp para o número da equipe de suporte, que é um número
 * como outro qualquer: ele pode ser lido no metrô, encaminhado sem pensar,
 * recuperado de um aparelho perdido. Por isso a decisão do dono é "detalhes sem
 * dado sensível" — tipo, título, PRIMEIRO nome, o que a pessoa precisa, por que
 * a IA travou, e o link. Nunca telefone, nunca CPF, nunca trecho de mensagem.
 *
 * Os casos de AUSÊNCIA (`não leva telefone`, `não leva CPF`) valem tanto quanto
 * os de presença: o `title`/`summary`/`blocker` são escritos pelo MODELO a
 * partir do que o lead disse, e um lead que digitou o próprio CPF no meio da
 * frase o veria reaparecer aqui. `sanitizarTextoDoLead` é o que impede isso —
 * e ela é a mesma função que a onda seguinte aplica ao briefing da passagem.
 */
import { describe, expect, it } from "vitest";

import {
  TETOS_DO_TEXTO_DO_LEAD,
  sanitizarTextoDoLead,
} from "@/lib/escalacao/sanitizar-texto-do-lead";
import { montarAvisoDeCaso, primeiroNome } from "@/lib/escalacao/texto-do-aviso";

const BASE = {
  marca: "Acme CRM",
  idioma: "pt-BR" as const,
  kind: "financeiro",
  source: "agent" as const,
  title: "Desconto acima da política",
  summary: "15% de desconto no plano anual",
  blocker: "a política permite até 10%",
  nomeDoCliente: "Maria Aparecida de Souza",
  link: "https://crm.exemplo.com.br/app/ai/cases?caso=0b1f7a2e-0000-4000-8000-000000000000",
};

describe("sanitizarTextoDoLead", () => {
  it("remove URL http, www e domínio nu — o único link do aviso é o que o servidor montou", () => {
    expect(sanitizarTextoDoLead("veja em https://mal.example/pague agora", 200)).toBe(
      "veja em agora",
    );
    expect(sanitizarTextoDoLead("entre em www.mal.example e pague", 200)).toBe("entre em e pague");
    expect(sanitizarTextoDoLead("acesse mal.example.com hoje", 200)).toBe("acesse hoje");
  });

  it("remove os marcadores de formatação do WhatsApp — imitar uma linha do sistema é phishing", () => {
    expect(sanitizarTextoDoLead("*Abrir:* _agora_ ~já~ `cmd`", 200)).toBe("Abrir: agora já cmd");
  });

  it("remove controles, INCLUSIVE U+2028/U+2029, e colapsa quebras de linha", () => {
    // Os dois separadores Unicode entram por ESCAPE, nunca como caractere cru: eles
    // terminam linha em JS, e um arquivo com o caractere literal já quebrou script
    // neste projeto. Escrever `\u2028` é o que mantém o teste legível e o fonte são.
    expect(sanitizarTextoDoLead("linha\u2028dois\u2029tres\n\nquatro\u0007", 200)).toBe(
      "linha dois tres quatro",
    );
  });

  it("trunca com … e nunca estoura o teto", () => {
    const longo = "a".repeat(300);
    const cortado = sanitizarTextoDoLead(longo, TETOS_DO_TEXTO_DO_LEAD.title);
    expect(cortado).not.toBeNull();
    expect([...(cortado as string)].length).toBe(TETOS_DO_TEXTO_DO_LEAD.title);
    expect(cortado?.endsWith("…")).toBe(true);
  });

  it("texto que não sobrevive à limpeza vira null, nunca string vazia", () => {
    // Uma linha "Assunto: " vazia é pior que a ausência da linha: ela afirma que
    // há um assunto e que ele é nada.
    expect(sanitizarTextoDoLead("https://so-link.example", 200)).toBeNull();
    expect(sanitizarTextoDoLead("   ", 200)).toBeNull();
    expect(sanitizarTextoDoLead(null, 200)).toBeNull();
  });
});

describe("primeiroNome", () => {
  it("devolve só o primeiro token", () => {
    expect(primeiroNome("Maria Aparecida de Souza")).toBe("Maria");
  });

  it("preserva o rótulo de contato anonimizado sem reidentificar ninguém", () => {
    // `Cliente Anonimizado #0b1f7a2e` tem espaço: cortar no primeiro token
    // devolveria "Cliente", que é pior — some a informação de que a pessoa
    // pediu para ser esquecida.
    expect(primeiroNome("Cliente Anonimizado #0b1f7a2e")).toBe("Cliente Anonimizado #0b1f7a2e");
  });

  it("sem nome devolve null", () => {
    expect(primeiroNome(null)).toBeNull();
    expect(primeiroNome("   ")).toBeNull();
  });
});

describe("montarAvisoDeCaso", () => {
  it("leva tipo, assunto, primeiro nome, o que precisa, por que travou e o link", () => {
    const texto = montarAvisoDeCaso(BASE);
    expect(texto).toContain("Acme CRM");
    expect(texto).toContain("Tipo: Pagamento");
    expect(texto).toContain("Assunto: Desconto acima da política");
    expect(texto).toContain("Cliente: Maria");
    expect(texto).toContain("O que o cliente precisa: 15% de desconto no plano anual");
    expect(texto).toContain("Por que a IA travou: a política permite até 10%");
    expect(texto).toContain(BASE.link);
  });

  it("termina com a linha que impede a equipe de responder no lugar errado", () => {
    // B3 da revisão: o número do suporte não fala com o cliente. Sem esta linha,
    // a primeira resposta da equipe vai para o vazio e ninguém descobre.
    expect(montarAvisoDeCaso(BASE).trimEnd()).toMatch(
      /Responder aqui não chega ao cliente — abra o link para responder\.$/,
    );
  });

  it("NÃO leva telefone, CPF nem trecho de mensagem do cliente", () => {
    const texto = montarAvisoDeCaso({
      ...BASE,
      title: "Cliente 529.982.247-25 no +55 31 99896-6398 quer desconto",
      summary: "ele disse: 'meu cpf é 529.982.247-25, me liga no 31998966398'",
      blocker: "a política permite até 10%",
    });
    expect(texto).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
    expect(texto).not.toMatch(/\+?55\s?\d{2}\s?9?\d{4}[-\s]?\d{4}/);
    expect(texto).not.toContain("998966398");
  });

  it("a URL escrita pelo lead some; o link do servidor fica", () => {
    const texto = montarAvisoDeCaso({ ...BASE, title: "veja https://mal.example/paga" });
    expect(texto).not.toContain("mal.example");
    expect(texto).toContain(BASE.link);
  });

  it("linha sem conteúdo não aparece — o aviso não afirma que há assunto quando não há", () => {
    const texto = montarAvisoDeCaso({ ...BASE, blocker: null, nomeDoCliente: null });
    expect(texto).not.toContain("Por que a IA travou");
    expect(texto).not.toContain("Cliente:");
    expect(texto).toContain("Tipo: Pagamento");
  });

  it("tipo desconhecido cai no genérico em vez de vazar o identificador cru", () => {
    expect(montarAvisoDeCaso({ ...BASE, kind: "kind_que_esta_imagem_nao_conhece" })).toContain(
      "Tipo: Outro",
    );
  });

  it("caso de fail-safe troca o assunto e ETIQUETA o resumo como citação", () => {
    const texto = montarAvisoDeCaso({
      ...BASE,
      source: "guardrail_autofallback",
      title: "Promessa não cumprida",
      summary: "eu te mando o boleto em 5 minutos",
    });
    expect(texto).toContain("Assunto: A IA prometeu algo e travou");
    expect(texto).not.toContain("Promessa não cumprida");
    expect(texto).toContain("(resumo escrito pela IA a partir da conversa)");
  });

  it("espanhol: as frases fixas são traduzidas", () => {
    const texto = montarAvisoDeCaso({ ...BASE, idioma: "es" });
    expect(texto).toContain("nuevo caso esperando por ti");
    expect(texto).toContain("Cliente: Maria");
    expect(texto).toContain("Por qué se atoró la IA");
    expect(texto).not.toContain("Por que a IA travou");
  });

  it("a marca vem de fora — o texto não conhece nome de produto nenhum", () => {
    // O resolvedor de marca (`marcaDaSaida`) é async e lê o banco; este módulo é
    // puro de propósito, e `tests/unit/branding.test.ts` varre /deskcomm/i aqui.
    expect(montarAvisoDeCaso({ ...BASE, marca: "Zap do João" })).toContain("Zap do João");
  });
});
