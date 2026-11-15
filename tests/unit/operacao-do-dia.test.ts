/**
 * A OPERAÇÃO DO DIA — as regras puras (`lib/operacao/regras.ts`), o texto do
 * relatório (`lib/operacao/texto-do-relatorio.ts`) e a volta do conteúdo
 * congelado (`lib/operacao/conteudo.ts`).
 *
 * O dia é cortado no fuso da organização — e Beirute é o caso que mais pega:
 * offset POSITIVO e horário de verão que vira à meia-noite, então o dia da
 * virada tem 23 ou 25 horas e a meia-noite da entrada do verão não existe.
 */
import { describe, expect, it } from "vitest";

import { sobreporAnonimizados, idsDeContatoDoConteudo, lerConteudo } from "@/lib/operacao/conteudo";
import {
  decisaoDoCron,
  diaNoFuso,
  diaValido,
  duracaoCurta,
  esperaUmaPessoa,
  esperandoDesde,
  etapaEhDeProposta,
  juntarProdutos,
  lerConfiguracao,
  limitesDoDia,
  minutosDeEspera,
  produtosDasChamadas,
  resolverDia,
  secoesDaConversa,
  TAGS_PADRAO,
} from "@/lib/operacao/regras";
import { linkDaConversa, textoDoRelatorio } from "@/lib/operacao/texto-do-relatorio";
import type { LinhaDeConversa, OperacaoDoDia } from "@/lib/operacao/tipos";

const BEIRUTE = "Asia/Beirut";
const HORA = 3_600_000;

describe("o dia no fuso de Beirute", () => {
  it("dia comum de inverno: começa às 00:00 locais = 22:00Z da véspera, 24 h", () => {
    const { inicio, fim } = limitesDoDia("2026-01-15", BEIRUTE);
    expect(inicio.toISOString()).toBe("2026-01-14T22:00:00.000Z");
    expect(fim.getTime() - inicio.getTime()).toBe(24 * HORA);
  });

  it("dia comum de verão: UTC+3", () => {
    const { inicio } = limitesDoDia("2026-07-15", BEIRUTE);
    expect(inicio.toISOString()).toBe("2026-07-14T21:00:00.000Z");
  });

  it("entrada do verão (último domingo de março): a meia-noite não existe e o dia tem 23 h", () => {
    const { inicio, fim } = limitesDoDia("2026-03-29", BEIRUTE);
    // O relógio pula de 23:59 do dia 28 para 01:00 do dia 29: o dia começa no
    // primeiro instante que existiu, e NUNCA na véspera.
    expect(diaNoFuso(inicio, BEIRUTE)).toBe("2026-03-29");
    expect(diaNoFuso(new Date(inicio.getTime() - 1), BEIRUTE)).toBe("2026-03-28");
    expect(fim.getTime() - inicio.getTime()).toBe(23 * HORA);
  });

  it("saída do verão (último domingo de outubro): o sábado tem 25 h e os dias não se sobrepõem", () => {
    const sabado = limitesDoDia("2026-10-24", BEIRUTE);
    const domingo = limitesDoDia("2026-10-25", BEIRUTE);
    expect(sabado.fim.getTime()).toBe(domingo.inicio.getTime());
    expect(sabado.fim.getTime() - sabado.inicio.getTime() + (domingo.fim.getTime() - domingo.inicio.getTime())).toBe(
      49 * HORA,
    );
    expect(diaNoFuso(domingo.inicio, BEIRUTE)).toBe("2026-10-25");
    expect(diaNoFuso(new Date(domingo.inicio.getTime() - 1), BEIRUTE)).toBe("2026-10-24");
  });

  it("o fim de um dia é o início do seguinte, em qualquer dia do ano", () => {
    let d = "2026-01-01";
    for (let i = 0; i < 365; i += 1) {
      const a = limitesDoDia(d, BEIRUTE);
      const proximo = new Date(Date.UTC(2026, 0, 2 + i)).toISOString().slice(0, 10);
      expect(a.fim.getTime()).toBe(limitesDoDia(proximo, BEIRUTE).inicio.getTime());
      d = proximo;
    }
  });

  it("recusa dia que não existe e dia no futuro", () => {
    expect(diaValido("2026-02-30")).toBe(false);
    expect(diaValido("2026-2-3")).toBe(false);
    const agora = new Date("2026-11-15T20:00:00Z"); // 22:00 em Beirute
    expect(resolverDia(null, BEIRUTE, agora)).toEqual({ ok: true, dia: "2026-11-15" });
    expect(resolverDia("2026-11-16", BEIRUTE, agora)).toEqual({ ok: false, motivo: "dia_no_futuro" });
    expect(resolverDia("2026-13-01", BEIRUTE, agora)).toEqual({ ok: false, motivo: "dia_invalido" });
    expect(resolverDia("2026-11-01", BEIRUTE, agora)).toEqual({ ok: true, dia: "2026-11-01" });
  });

  it("o dia local já virou em Beirute enquanto em UTC ainda é ontem", () => {
    expect(diaNoFuso(new Date("2026-11-15T22:30:00Z"), BEIRUTE)).toBe("2026-11-16");
  });
});

describe("a configuração e as seções por etiqueta", () => {
  it("padrões quando não há nada gravado — reclamação COM acento", () => {
    const c = lerConfiguracao({});
    expect(c.tags).toEqual(TAGS_PADRAO);
    expect(c.tags.reclamacao).toBe("reclamação");
    expect(c.relatorio).toEqual({ ligado: true, hora: 21 });
  });

  it("valor torto cai no padrão campo a campo, sem lançar", () => {
    const c = lerConfiguracao({
      operacao_do_dia: { tags: { projeto: "  Restaurante ", produto: 42 }, relatorio: { hora: 99, ligado: false } },
    });
    expect(c.tags.projeto).toBe("restaurante");
    expect(c.tags.produto).toBe("produto");
    expect(c.relatorio).toEqual({ ligado: false, hora: 21 });
    expect(lerConfiguracao(null).tags).toEqual(TAGS_PADRAO);
  });

  it("a etiqueta compara como o produto grava (trim + minúscula), e o acento importa", () => {
    const tags = lerConfiguracao({}).tags;
    expect(secoesDaConversa(["Reclamação "], tags)).toEqual(["reclamacoes"]);
    expect(secoesDaConversa(["urgente", "produto"], tags)).toEqual(["reclamacoes", "produtos"]);
    expect(secoesDaConversa(["projeto"], tags)).toEqual(["projetos"]);
    expect(secoesDaConversa(["reclamacao"], tags)).toEqual([]);
    expect(secoesDaConversa(null, tags)).toEqual([]);
  });

  it("etapa de proposta casa pedaço do nome, sem acento e sem caixa", () => {
    const pedacos = lerConfiguracao({}).etapas_de_proposta;
    expect(etapaEhDeProposta("Proposta enviada", pedacos)).toBe(true);
    expect(etapaEhDeProposta("Orçamento", pedacos)).toBe(true);
    expect(etapaEhDeProposta("Qualificação", pedacos)).toBe(false);
  });
});

describe("quem espera uma pessoa, e há quanto tempo", () => {
  const base = {
    status: "open",
    is_group: false,
    last_inbound_at: "2026-11-15T10:00:00Z",
    last_outbound_at: "2026-11-15T09:00:00Z",
    awaiting_since: "2026-11-15T09:30:00Z",
    bot_silenced_until: null,
    assigned_to_user_id: null,
  };
  const agora = new Date("2026-11-15T12:05:00Z");

  it("entregue à equipe e sem dono espera, mesmo com a última palavra nossa", () => {
    expect(esperaUmaPessoa({ ...base, comando_da_conversa: "aguardando", last_outbound_at: "2026-11-15T11:00:00Z" }, agora)).toBe(true);
  });

  it("com uma pessoa dona: espera só quando o cliente falou por último", () => {
    expect(esperaUmaPessoa({ ...base, comando_da_conversa: "humano" }, agora)).toBe(true);
    expect(esperaUmaPessoa({ ...base, comando_da_conversa: "humano", last_outbound_at: "2026-11-15T11:00:00Z" }, agora)).toBe(false);
  });

  it("a IA atendendo não espera uma pessoa; grupo e encerrada nunca entram", () => {
    expect(esperaUmaPessoa({ ...base, comando_da_conversa: "automatico" }, agora)).toBe(false);
    expect(esperaUmaPessoa({ ...base, comando_da_conversa: "aguardando", is_group: true }, agora)).toBe(false);
    expect(esperaUmaPessoa({ ...base, comando_da_conversa: "aguardando", status: "closed" }, agora)).toBe(false);
  });

  it("robô calado com o cliente falando por último espera", () => {
    expect(esperaUmaPessoa({ ...base, comando_da_conversa: "automatico", bot_silenced_until: "infinity" }, agora)).toBe(true);
  });

  it("a espera conta da mensagem sem resposta mais antiga, e nunca é negativa", () => {
    expect(esperandoDesde(base)).toBe("2026-11-15T09:30:00Z");
    // awaiting_since anterior à nossa última resposta não vale (o banco não o limpa).
    expect(esperandoDesde({ ...base, awaiting_since: "2026-11-15T08:00:00Z" })).toBe("2026-11-15T10:00:00Z");
    expect(minutosDeEspera("2026-11-15T09:30:00Z", agora)).toBe(155);
    expect(minutosDeEspera("2026-11-15T13:00:00Z", agora)).toBe(0);
    expect(minutosDeEspera(null, agora)).toBeNull();
    expect(duracaoCurta(155)).toBe("2 h 35 min");
    expect(duracaoCurta(45)).toBe("45 min");
    expect(duracaoCurta(60 * 50)).toBe("2 d 2 h");
  });
});

describe("o que a busca de produtos da IA deixou registrado", () => {
  const passos = [
    {
      step: 0,
      tool_calls: [
        { tool_name: "crm_search_products", args: { termo: "árvore grande" }, result: { produtos: [{ nome: "Ficus 2m" }, { nome: "Oliveira" }] } },
        { tool_name: "crm_get_contact", args: {}, result: {} },
      ],
    },
    { step: 1, tool_calls: [{ tool_name: "crm_search_products", args: { termo: "vaso" }, result: { produtos: [], motivo: "nao_encontrado" } }] },
  ];

  it("lê o termo e os nomes devolvidos, e ignora outras ferramentas", () => {
    expect(produtosDasChamadas(passos)).toEqual({ termos: ["árvore grande", "vaso"], encontrados: ["Ficus 2m", "Oliveira"] });
  });

  it("formato torto não lança", () => {
    expect(produtosDasChamadas(null)).toEqual({ termos: [], encontrados: [] });
    expect(produtosDasChamadas([{ tool_calls: "x" }, 3, { tool_calls: [null, { tool_name: "crm_search_products" }] }])).toEqual({
      termos: [],
      encontrados: [],
    });
  });

  it("juntar não repete (sem caixa)", () => {
    expect(juntarProdutos({ termos: ["Vaso"], encontrados: [] }, { termos: ["vaso", "árvore"], encontrados: ["X"] })).toEqual({
      termos: ["Vaso", "árvore"],
      encontrados: ["X"],
    });
  });
});

describe("quando o cron gera o relatório", () => {
  const config = { ligado: true, hora: 21 };
  // 19:10Z = 21:10 em Beirute no inverno.
  const depois = new Date("2026-11-15T19:10:00Z");
  const antes = new Date("2026-11-15T18:50:00Z");

  it("gera depois da hora local, para o dia LOCAL", () => {
    expect(decisaoDoCron({ agora: depois, fuso: BEIRUTE, config, diasJaGerados: new Set() })).toEqual({
      gerar: true,
      dia: "2026-11-15",
    });
  });

  it("não gera antes da hora, nem desligado, nem se o dia já tem linha", () => {
    expect(decisaoDoCron({ agora: antes, fuso: BEIRUTE, config, diasJaGerados: new Set() })).toEqual({
      gerar: false,
      motivo: "antes_da_hora",
    });
    expect(decisaoDoCron({ agora: depois, fuso: BEIRUTE, config: { ligado: false, hora: 21 }, diasJaGerados: new Set() })).toEqual({
      gerar: false,
      motivo: "desligado",
    });
    expect(decisaoDoCron({ agora: depois, fuso: BEIRUTE, config, diasJaGerados: new Set(["2026-11-15"]) })).toEqual({
      gerar: false,
      motivo: "ja_existe",
    });
  });

  it("a linha de ontem não segura o relatório de hoje (repetir a rodada é idempotente pelo dia)", () => {
    expect(decisaoDoCron({ agora: depois, fuso: BEIRUTE, config, diasJaGerados: new Set(["2026-11-14"]) }).gerar).toBe(true);
  });

  it("depois da meia-noite local, o dia novo ainda está antes da hora", () => {
    // 22:30Z = 00:30 do dia 16 em Beirute.
    expect(decisaoDoCron({ agora: new Date("2026-11-15T22:30:00Z"), fuso: BEIRUTE, config, diasJaGerados: new Set() })).toEqual({
      gerar: false,
      motivo: "antes_da_hora",
    });
  });
});

function linha(parcial: Partial<LinhaDeConversa>): LinhaDeConversa {
  return {
    conversation_id: "c0000000-0000-4000-8000-000000000001",
    contato: { contact_id: "k1", nome: "Rana", telefone: "+96170000000", identidade: null },
    canal: "whatsapp",
    numero: "Loja",
    resumo: null,
    resumo_origem: null,
    status: "open",
    comando: "humano",
    motivo_da_passagem: null,
    proxima_acao: null,
    responsavel: null,
    responsavel_tipo: null,
    ultima_atividade_em: "2026-11-15T15:00:00Z",
    esperando_desde: null,
    tags: [],
    ...parcial,
  };
}

function conteudo(parcial: Partial<OperacaoDoDia> = {}): OperacaoDoDia {
  const zero = { whatsapp: 0, instagram: 0, outros: 0, total: 0 };
  return {
    versao: 1,
    dia: "2026-11-15",
    fuso: BEIRUTE,
    inicio: "2026-11-14T22:00:00.000Z",
    fim: "2026-11-15T22:00:00.000Z",
    lido_em: "2026-11-15T19:00:00.000Z",
    tags: lerConfiguracao({}).tags,
    contadores: { novas: { ...zero, whatsapp: 2, instagram: 1, total: 3 }, com_entrada: zero },
    aguardando: [],
    projetos: [],
    reclamacoes: [],
    produtos: [],
    funil: { ganhos: [], perdidos: [], em_proposta: [], mudaram_de_etapa: null },
    falhas: { mensagens: [], execucoes_da_ia: [], canais: [], avisos: [] },
    truncado: [],
    ...parcial,
  };
}

describe("o texto do relatório", () => {
  const projeto = linha({
    contato: { contact_id: "k2", nome: "Karim", telefone: null, identidade: "@karim.studio" },
    canal: "instagram",
    numero: null,
    resumo: "Projeto de restaurante, 40 vasos",
    resumo_origem: "passagem",
    responsavel: "Maya",
    responsavel_tipo: "pessoa",
    proxima_acao: { titulo: "Enviar orçamento", vence_em: "2026-11-17T09:00:00Z" },
    esperando_desde: "2026-11-15T17:00:00Z",
  });
  const produto = linha({ produtos: { termos: ["árvore"], encontrados: ["Ficus 2m"] } });

  it("leva link absoluto de cada conversa e responde as duas perguntas do dono", () => {
    const texto = textoDoRelatorio(conteudo({ projetos: [projeto], produtos: [produto] }), {
      idioma: "pt-BR",
      baseUrl: "https://crm.exemplo.test/",
      geradoEm: new Date("2026-11-15T19:00:00Z"),
    });
    expect(texto).toContain("https://crm.exemplo.test/app/inbox?id=c0000000-0000-4000-8000-000000000001");
    expect(texto).not.toContain("test//app");
    // "Quem pediu uma árvore hoje?"
    expect(texto).toContain("Ficus 2m");
    expect(texto).toContain('"árvore"');
    // "Que cliente tem um projeto de restaurante para acompanhar?"
    expect(texto).toContain("Karim · @karim.studio");
    expect(texto).toContain("Projeto de restaurante, 40 vasos");
    expect(texto).toContain("Enviar orçamento");
    expect(texto).toContain("responsável: Maya");
    expect(texto).toContain("esperando há 2 h");
    expect(texto).toContain("Gerado às 21:00");
    expect(texto).toContain("3 (WhatsApp 2 · Instagram 1");
  });

  it("o que não foi registrado aparece como não registrado, nunca some", () => {
    const texto = textoDoRelatorio(conteudo({ aguardando: [linha({})] }), {
      idioma: "pt-BR",
      baseUrl: "https://crm.exemplo.test",
      geradoEm: new Date("2026-11-15T19:00:00Z"),
    });
    expect(texto).toContain("responsável: não registrado");
    expect(texto).toContain("próxima ação: não registrado");
    expect(texto).toContain("Resumo: não registrado");
    expect(texto).toContain("Negócios que mudaram de etapa no dia: não registrado");
  });

  it("sai no idioma da organização", () => {
    const texto = textoDoRelatorio(conteudo(), { idioma: "es", baseUrl: "https://x.test", geradoEm: new Date() });
    expect(texto).toContain("Operación del día");
    expect(texto).toContain("Esperando a una persona");
  });

  it("o link escapa o id", () => {
    expect(linkDaConversa("https://x.test/", "a b")).toBe("https://x.test/app/inbox?id=a%20b");
  });
});

describe("os filtros que vão para o PostgREST", () => {
  it("etiquetas entram no literal de array COM aspas (espaço, vírgula e aspas não quebram o filtro)", async () => {
    const { literalDeArray } = await import("@/lib/operacao/operacao-do-dia");
    expect(literalDeArray(["reclamação", "projeto grande", 'a,"b"'])).toBe('{"reclamação","projeto grande","a,\\"b\\""}');
  });

  it("a busca de produtos filtra o jsonb com JSON (cs.[...]), não com literal de array", async () => {
    const { FILTRO_DA_BUSCA_DE_PRODUTOS } = await import("@/lib/operacao/operacao-do-dia");
    expect(JSON.stringify(FILTRO_DA_BUSCA_DE_PRODUTOS)).toBe('[{"tool_calls":[{"tool_name":"crm_search_products"}]}]');
  });
});

describe("o conteúdo congelado, na volta", () => {
  it("só desenha a versão que conhece", () => {
    expect(lerConteudo(conteudo())).not.toBeNull();
    expect(lerConteudo({ ...conteudo(), versao: 2 })).toBeNull();
    expect(lerConteudo("x")).toBeNull();
  });

  it("contato anonimizado depois da geração aparece anonimizado, sem telefone nem @", () => {
    const c = conteudo({ produtos: [linha({})], projetos: [linha({ contato: { contact_id: "k9", nome: "Outro", telefone: "1", identidade: null } })] });
    expect(idsDeContatoDoConteudo(c).sort()).toEqual(["k1", "k9"]);
    const sobreposto = sobreporAnonimizados(c, [{ id: "k1", nome: "Cliente Anonimizado #7" }]);
    expect(sobreposto.produtos[0]!.contato).toEqual({ contact_id: "k1", nome: "Cliente Anonimizado #7", telefone: null, identidade: null });
    expect(sobreposto.projetos[0]!.contato.nome).toBe("Outro");
    // O original não é mexido.
    expect(c.produtos[0]!.contato.nome).toBe("Rana");
  });
});
