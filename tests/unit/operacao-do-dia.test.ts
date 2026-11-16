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

import { CHAVES_PESSOAIS, congelar, hidratar, lerConteudo, type LeitorAoVivo } from "@/lib/operacao/conteudo";
import {
  corteDoDia,
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
  type RelatorioExistente,
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
  // 19:10Z = 21:10 em Beirute no inverno; 18:50Z = 20:50.
  const depois = new Date("2026-11-15T19:10:00Z");
  const antes = new Date("2026-11-15T18:50:00Z");
  type Linha = [string, RelatorioExistente];
  const cron = (dia: string, gerado_em = `${dia}T19:00:00Z`): Linha => [dia, { gerado_por: "cron", gerado_em }];
  const manual = (dia: string, gerado_em: string): Linha => [dia, { gerado_por: "usuario", gerado_em }];
  const ontemFeito = cron("2026-11-14");

  it("gera depois da hora local, para o dia LOCAL", () => {
    expect(decisaoDoCron({ agora: depois, fuso: BEIRUTE, config, existentes: new Map([ontemFeito]) })).toEqual({
      acoes: [{ dia: "2026-11-15", motivo: "hora_marcada" }],
    });
  });

  it("não gera antes da hora, nem desligado, nem se o dia já tem linha do cron", () => {
    expect(decisaoDoCron({ agora: antes, fuso: BEIRUTE, config, existentes: new Map([ontemFeito]) })).toEqual({
      acoes: [],
      motivo: "antes_da_hora",
    });
    expect(
      decisaoDoCron({ agora: depois, fuso: BEIRUTE, config: { ligado: false, hora: 21 }, existentes: new Map() }),
    ).toEqual({ acoes: [], motivo: "desligado" });
    expect(
      decisaoDoCron({ agora: depois, fuso: BEIRUTE, config, existentes: new Map([ontemFeito, cron("2026-11-15", "2026-11-15T19:05:00Z")]) }),
    ).toEqual({ acoes: [], motivo: "ja_existe" });
  });

  it("DIA PERDIDO: ontem sem linha é gerado já, mesmo antes da hora de hoje — o dia inteiro", () => {
    expect(decisaoDoCron({ agora: antes, fuso: BEIRUTE, config, existentes: new Map() })).toEqual({
      acoes: [{ dia: "2026-11-14", motivo: "dia_perdido" }],
    });
    // Depois da hora, os dois: o perdido e o de hoje.
    expect(decisaoDoCron({ agora: depois, fuso: BEIRUTE, config, existentes: new Map() })).toEqual({
      acoes: [
        { dia: "2026-11-14", motivo: "dia_perdido" },
        { dia: "2026-11-15", motivo: "hora_marcada" },
      ],
    });
  });

  it("organização criada depois do fim de ontem não ganha o relatório de um dia em que não operava", () => {
    // Fim de 14/11 em Beirute = 2026-11-14T22:00Z.
    expect(
      decisaoDoCron({ agora: antes, fuso: BEIRUTE, config, existentes: new Map(), criadaEm: "2026-11-15T08:00:00Z" }),
    ).toEqual({ acoes: [], motivo: "antes_da_hora" });
    expect(
      decisaoDoCron({ agora: antes, fuso: BEIRUTE, config, existentes: new Map(), criadaEm: "2026-11-14T08:00:00Z" }).acoes,
    ).toEqual([{ dia: "2026-11-14", motivo: "dia_perdido" }]);
  });

  it("'Gerar agora' ANTES da hora não cancela o automático: o cron regera uma vez, condicionado", () => {
    const cedo = manual("2026-11-15", "2026-11-15T10:00:00Z"); // 12:00 em Beirute
    expect(decisaoDoCron({ agora: depois, fuso: BEIRUTE, config, existentes: new Map([ontemFeito, cedo]) })).toEqual({
      acoes: [
        { dia: "2026-11-15", motivo: "refazer_apos_manual", substituirManualAntesDe: "2026-11-15T19:00:00.000Z" },
      ],
    });
    // Antes da hora, o manual fica como está.
    expect(decisaoDoCron({ agora: antes, fuso: BEIRUTE, config, existentes: new Map([ontemFeito, cedo]) }).acoes).toEqual([]);
  });

  it("sem laço: depois de regerada (cron) ou se o manual foi DEPOIS da hora, nada a fazer", () => {
    const regerado = cron("2026-11-15", "2026-11-15T19:10:00Z");
    expect(decisaoDoCron({ agora: depois, fuso: BEIRUTE, config, existentes: new Map([ontemFeito, regerado]) }).acoes).toEqual([]);
    const tarde = manual("2026-11-15", "2026-11-15T19:05:00Z"); // 21:05 em Beirute, depois da hora
    expect(decisaoDoCron({ agora: depois, fuso: BEIRUTE, config, existentes: new Map([ontemFeito, tarde]) }).acoes).toEqual([]);
  });

  it("depois da meia-noite local, o dia novo ainda está antes da hora (e o de ontem já existe)", () => {
    // 22:30Z = 00:30 do dia 16 em Beirute.
    expect(
      decisaoDoCron({
        agora: new Date("2026-11-15T22:30:00Z"),
        fuso: BEIRUTE,
        config,
        existentes: new Map([cron("2026-11-15")]),
      }),
    ).toEqual({ acoes: [], motivo: "antes_da_hora" });
  });
});

describe("o corte do dia e o estado do momento", () => {
  const dia = { inicio: "2026-11-14T22:00:00.000Z", fim: "2026-11-15T22:00:00.000Z" };

  it("leitura dentro do dia: de 00:00 até a hora da leitura, com o estado do momento", () => {
    expect(corteDoDia({ ...dia, lido_em: "2026-11-15T19:00:00.000Z" })).toEqual({
      diaInteiro: false,
      ate: "2026-11-15T19:00:00.000Z",
      estadoDoMomento: true,
    });
  });

  it("leitura depois do dia (dia passado, dia perdido): dia inteiro, SEM o estado do momento", () => {
    expect(corteDoDia({ ...dia, lido_em: "2026-11-16T06:00:00.000Z" })).toEqual({
      diaInteiro: true,
      ate: dia.fim,
      estadoDoMomento: false,
    });
  });

  it("o texto declara o corte e omite o estado do momento num dia que já acabou", () => {
    const passado = conteudo({ lido_em: "2026-11-16T06:00:00.000Z" });
    const texto = textoDoRelatorio(passado, { idioma: "pt-BR", baseUrl: "https://x.test", geradoEm: new Date(passado.lido_em) });
    expect(texto).toContain("dia inteiro");
    expect(texto).toContain("Aguardando uma pessoa: Estado do momento — só no dia de hoje.");
    expect(texto).not.toContain("Aguardando uma pessoa (no momento da geração)");
    const hoje = conteudo({ lido_em: "2026-11-15T19:00:00.000Z" });
    const deHoje = textoDoRelatorio(hoje, { idioma: "pt-BR", baseUrl: "https://x.test", geradoEm: new Date(hoje.lido_em) });
    expect(deHoje).toContain("de 00:00 até 21:00");
    expect(deHoje).toContain("Aguardando uma pessoa (no momento da geração)");
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
    motivo_codigo: null,
    proxima_acao: null,
    responsavel_user_id: null,
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
});

/** Todas as chaves de um valor, em qualquer profundidade. */
function chavesProfundas(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) chavesProfundas(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      chavesProfundas(x, out);
    }
  }
  return out;
}

describe("LGPD: o relatório guardado não tem dado pessoal, e a leitura resolve ao vivo", () => {
  const completo = () =>
    conteudo({
      aguardando: [
        linha({
          resumo: "Quer 40 vasos para o restaurante da Rua X",
          resumo_origem: "passagem",
          responsavel_user_id: "u1",
          responsavel: "Maya",
          responsavel_tipo: "pessoa",
          proxima_acao: { titulo: "Ligar para a Rana", vence_em: "2026-11-17T09:00:00Z" },
          motivo_codigo: "pedido_de_humano",
        }),
      ],
      produtos: [linha({ produtos: { termos: ["árvore"], encontrados: ["Ficus 2m"] } })],
      funil: {
        ganhos: [],
        perdidos: [
          {
            lead_id: "L1",
            titulo: "Rana — projeto",
            contato: { contact_id: "k1", nome: "Rana", telefone: "+96170000000", identidade: "@rana" },
            conversation_id: "c0000000-0000-4000-8000-000000000001",
            etapa: "Proposta",
            status: "lost",
            valor_cents: null,
            moeda: null,
            motivo_da_perda: "Rana achou caro",
            responsavel_user_id: "u1",
            responsavel: "Maya",
            quando: "2026-11-15T12:00:00Z",
          },
        ],
        em_proposta: [],
        mudaram_de_etapa: 2,
      },
      falhas: {
        mensagens: [
          {
            message_id: "m1",
            conversation_id: "c0000000-0000-4000-8000-000000000001",
            contato: { contact_id: "k1", nome: "Rana", telefone: "+96170000000", identidade: null },
            status: "failed",
            codigo: "waha_400",
            erro: "chat 96170000000@c.us not found",
            quando: "2026-11-15T12:00:00Z",
          },
        ],
        execucoes_da_ia: [],
        canais: [],
        avisos: [{ id: "a1", kind: "message_send_stuck", titulo: "Mensagem para Rana presa", severidade: "warn", quando: "2026-11-15T12:00:00Z" }],
      },
    });

  it("o jsonb guardado não tem chave de nome, telefone, @, prévia, resumo, título, motivo escrito nem erro", () => {
    const guardado = JSON.parse(JSON.stringify(congelar(completo())));
    const chaves = chavesProfundas(guardado);
    for (const proibida of [...CHAVES_PESSOAIS, "last_message_preview", "body", "phone_number", "display_name", "name"]) {
      expect(chaves.has(proibida), `chave pessoal no jsonb: ${proibida}`).toBe(false);
    }
    const texto = JSON.stringify(guardado);
    for (const pessoal of ["Rana", "+96170000000", "@rana", "restaurante", "Maya", "achou caro", "96170000000", "árvore"]) {
      expect(texto.includes(pessoal), `dado pessoal no jsonb: ${pessoal}`).toBe(false);
    }
    // Os fatos ficam: ids, termos e produtos, código, situação, instantes.
    expect(guardado.aguardando[0].contato).toEqual({ contact_id: "k1" });
    expect(guardado.aguardando[0].responsavel_user_id).toBe("u1");
    expect(guardado.aguardando[0].motivo_codigo).toBe("pedido_de_humano");
    expect(guardado.aguardando[0].proxima_acao).toEqual({ vence_em: "2026-11-17T09:00:00Z" });
    // O NOME do produto (catálogo) fica; o TERMO que o cliente escreveu, não.
    expect(guardado.produtos[0].produtos).toEqual({ encontrados: ["Ficus 2m"] });
    expect(guardado.falhas.mensagens[0].codigo).toBe("waha_400");
    expect(lerConteudo(guardado)).not.toBeNull();
  });

  function leitor(contatos: Record<string, { nome: string | null; telefone: string | null; identidade: string | null }>): LeitorAoVivo {
    return {
      contatos: async (ids) => new Map(ids.filter((id) => contatos[id]).map((id) => [id, contatos[id]!])),
      conversas: async (ids) => new Map(ids.map((id) => [id, { previa: null, responsavel: "Maya" }])),
      passagens: async () => new Map(),
      tarefas: async (ids) => new Map(ids.map((id) => [id, "Ligar de volta"])),
      negocios: async (ids) => new Map(ids.map((id) => [id, { titulo: "Projeto restaurante", motivo_da_perda: null }])),
      nomes: async (ids) => new Map(ids.map((id) => [id, "Maya"])),
    };
  }

  it("a tela do relatório resolve o pessoal AO VIVO: depois da anonimização, mostra o contato anonimizado", async () => {
    const guardado = lerConteudo(JSON.parse(JSON.stringify(congelar(completo()))))!;

    const antes = await hidratar(guardado, leitor({ k1: { nome: "Rana", telefone: "+96170000000", identidade: null } }));
    expect(antes.aguardando[0]!.contato.nome).toBe("Rana");
    expect(antes.aguardando[0]!.proxima_acao).toEqual({ titulo: "Ligar de volta", vence_em: "2026-11-17T09:00:00Z" });
    expect(antes.funil.perdidos[0]!.responsavel).toBe("Maya");

    // A cascata da LGPD reescreveu a linha de `contacts`: o mesmo relatório, lido de novo.
    const depois = await hidratar(guardado, leitor({ k1: { nome: "Cliente Anonimizado #3", telefone: null, identidade: null } }));
    for (const l of [depois.aguardando[0]!, depois.produtos[0]!]) {
      expect(l.contato).toEqual({ contact_id: "k1", nome: "Cliente Anonimizado #3", telefone: null, identidade: null });
    }
    expect(depois.falhas.mensagens[0]!.contato.nome).toBe("Cliente Anonimizado #3");
    const texto = textoDoRelatorio(depois, { idioma: "pt-BR", baseUrl: "https://x.test", geradoEm: new Date(guardado.lido_em) });
    expect(texto).toContain("Cliente Anonimizado #3");
    expect(texto).not.toContain("Rana");
    expect(texto).not.toContain("+96170000000");
  });

  it("contato que a leitura não alcança (apagado ou fora do escopo) diz não registrado", async () => {
    const guardado = congelar(completo());
    const lido = await hidratar(guardado, leitor({}));
    expect(lido.aguardando[0]!.contato).toEqual({ contact_id: "k1", nome: null, telefone: null, identidade: null });
  });

  it("FALHA de leitura do banco não se passa por contato apagado: a tela diz que não deu para ler", async () => {
    const guardado = lerConteudo(JSON.parse(JSON.stringify(congelar(completo()))))!;
    const quebrado: LeitorAoVivo = {
      ...leitor({ k1: { nome: "Rana", telefone: null, identidade: null } }),
      contatos: async () => {
        throw new Error("connection reset");
      },
    };
    const lido = await hidratar(guardado, quebrado);
    expect(lido.leitura_falhou).toEqual(["contatos"]);
    // Campo AUSENTE (não null): é o que separa "não li" de "não há".
    expect(lido.aguardando[0]!.contato).toEqual({ contact_id: "k1" });
    expect(lido.aguardando[0]!.contato.nome).toBeUndefined();
    const texto = textoDoRelatorio(lido, { idioma: "pt-BR", baseUrl: "https://x.test", geradoEm: new Date(guardado.lido_em) });
    expect(texto).toContain("não foi possível ler agora");
    expect(texto).toContain("Não foi possível ler agora os nomes e resumos deste relatório.");
    // O que leu bem continua: a tarefa veio do leitor que respondeu.
    expect(lido.aguardando[0]!.proxima_acao?.titulo).toBe("Ligar de volta");
    // E o leitor sadio não marca falha nenhuma.
    expect((await hidratar(guardado, leitor({}))).leitura_falhou).toBeUndefined();
  });
});

describe("o leitor ao vivo do banco não engole erro", () => {
  /** Um client de mentira cuja consulta, encadeada como for, termina em erro. */
  function dbComErro(): never {
    const resposta = Promise.resolve({ data: null, error: { message: "timeout" } });
    const cadeia: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"]) cadeia[m] = () => cadeia;
    cadeia.then = resposta.then.bind(resposta);
    return { from: () => cadeia } as never;
  }

  it("erro do banco LANÇA (não vira mapa vazio, que se leria como contato apagado)", async () => {
    const { leitorDoBanco } = await import("@/lib/operacao/hidratar-do-banco");
    const l = leitorDoBanco(dbComErro(), "org");
    await expect(l.contatos(["k1"])).rejects.toThrow("timeout");
    await expect(l.conversas(["c1"])).rejects.toThrow("timeout");
    await expect(l.passagens(["c1"])).rejects.toThrow("timeout");
    await expect(l.tarefas(["k1"])).rejects.toThrow("timeout");
    await expect(l.negocios(["L1"])).rejects.toThrow("timeout");
  });
});
