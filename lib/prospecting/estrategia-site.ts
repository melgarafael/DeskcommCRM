/**
 * Estratégia de abordagem por lead: auditoria × ofertas × nicho.
 *
 * A auditoria (`ClasseDeSite` + problemas + checklist de `site-classify.ts`) é
 * fato e não muda; esta função é a LEITURA — qual ângulo vende para este lead,
 * nesta campanha, neste nicho. Função pura: mesma entrada, mesma estratégia,
 * sem rede e sem modelo. O que a IA escreve depois (a copy) cita a estratégia;
 * o que o humano lê antes (objeções) fica na tela, nunca no prompt.
 */
import type { ClasseDeSite, ItemDoRaioX, RaioXDoSite } from "@/lib/prospecting/site-classify";
import { descreverProblema } from "@/lib/prospecting/site-classify";
import type { OfertaDaCampanha } from "./schema";
export type { OfertaDaCampanha } from "./schema";

export interface ObjecaoComResposta {
  objecao: string;
  resposta: string;
}
export interface EstrategiaDoLead {
  cenario: string;
  angulo: string;
  ganchos: string[];
  objecoes: ObjecaoComResposta[];
  proximoPasso: string;
}

export interface EntradaDaEstrategia {
  classe: ClasseDeSite;
  /** Códigos do vocabulário fechado (ex: "nao-mobile", "construtor-Wix", "falta-whatsapp"). */
  problemas: string[];
  checklist: RaioXDoSite | null;
  nota: number | null;
  numAvaliacoes: number | null;
  temInstagram: boolean;
  ofertas: OfertaDaCampanha[];
  nicho: string;
  /** Sobrescrita de vocabulário da org (`settings.prospeccao.vocabulario`). */
  sobrescritaVocabulario?: Record<string, string> | null;
  /** Provisório = verificação inconclusiva: sem ângulo de conserto. */
  provisorio: boolean;
  status: string;
  followUpsEnviados: number;
}

const OBJETOES_SEM_SITE: ObjecaoComResposta[] = [
  {
    objecao: "Já tenho Instagram/WhatsApp, não preciso de site",
    resposta:
      "Instagram alcança quem já segue; o site captura quem pesquisa no Google sem conhecer. Um completa o outro — e o site dá o endereço profissional que passa confiança na hora de fechar.",
  },
  {
    objecao: "Site é caro / não é prioridade agora",
    resposta:
      "Compare com UM cliente que pesquisou, não achou e fechou com o concorrente. O site se paga com o primeiro cliente que trouxer — e dá para começar simples.",
  },
  {
    objecao: "Não tenho tempo para cuidar disso",
    resposta:
      "Você não cuida de nada — textos, fotos, publicação e manutenção por nossa conta. Só uma conversa curta para entender o negócio.",
  },
];

const OBJETOES_SITE_RUIM: ObjecaoComResposta[] = [
  {
    objecao: "Já tenho site",
    resposta:
      "A questão não é ter, é o site trabalhar a favor. Hoje ele afasta cliente em vez de trazer — e no celular o visitante desiste em segundos.",
  },
  {
    objecao: "Foi um conhecido que fez",
    resposta:
      "Sem desmerecer — tecnologia de site envelhece rápido, e o Google penaliza base antiga. Dá para aproveitar o conteúdo e modernizar a base.",
  },
  {
    objecao: "Vou ver com quem fez o site",
    resposta:
      "Perfeito — e se quiser uma segunda opinião sem compromisso, mando um diagnóstico gratuito do que está pegando para comparar propostas.",
  },
];

/** Vocabulário por nicho (base em código; override por org em settings). Nicho novo = linha nova. */
const VOCABULARIO_POR_NICHO: Readonly<Record<string, string>> = {
  clinica: "agenda de pacientes",
  estetica: "agenda de pacientes",
  restaurante: "reservas e pedidos",
  imobiliaria: "captação de clientes",
  advocacia: "captação de casos",
  oficina: "agendamento de serviços",
  salao: "agendamento de horários",
  academia: "matrículas e retenção",
};

export function normalizarNicho(nicho: string): string {
  return (nicho || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

export function vocabularioDoNicho(nicho: string, sobrescrita?: Record<string, string> | null): string {
  const chave = normalizarNicho(nicho);
  if (sobrescrita) {
    for (const [termo, vocabulario] of Object.entries(sobrescrita)) {
      if (chave.includes(normalizarNicho(termo))) return vocabulario;
    }
  }
  for (const [prefixo, vocabulario] of Object.entries(VOCABULARIO_POR_NICHO)) {
    if (chave.includes(prefixo)) return vocabulario;
  }
  return chave ? `clientes de ${nicho.trim()}` : "clientes novos";
}

function ganchoDeReputacao(nota: number | null, avaliacoes: number | null): string {
  const n = nota ?? 0;
  const total = avaliacoes ?? 0;
  if (n >= 4.8 && total >= 50)
    return `Nota ${n} com ${total} avaliações: reputação de sobra e negócio estabelecido — colhe resultado rápido.`;
  if (n >= 4.5 && total >= 10)
    return `Nota ${n} com ${total} avaliações: a reputação já existe, só não trabalha fora do Maps.`;
  if (n > 0) return `Nota ${n} no Google — use como abertura, nunca como crítica.`;
  return "Sem avaliações visíveis — posicione presença digital como começo, não conserto.";
}

function juntarProblemas(problemas: string[]): string | null {
  const texto = problemas
    .filter((p) => !p.startsWith("falta-"))
    .map(descreverProblema)
    .slice(0, 3)
    .join("; ");
  return texto || null;
}

/**
 * Melhor ângulo = auditoria × primeira oferta aplicável ao caso.
 * `ofertas[0]` (primária) decide empates; default `["site"]` = comportamento atual.
 */
export function montarEstrategia(entrada: EntradaDaEstrategia): EstrategiaDoLead {
  const ofertas: OfertaDaCampanha[] =
    entrada.ofertas.length > 0 ? entrada.ofertas : ["site"];
  // Provisório primeiro: verificação inconclusiva não gera ângulo de conserto
  // (vender em cima de timeout seria queimar o lead com gancho falso).
  if (entrada.provisorio) {
    return {
      cenario: "Verificação pendente",
      angulo:
        "A verificação do site foi inconclusiva (instabilidade de rede, não defeito comprovado). Sem gancho até a reverificação confirmar — abordar citando queda seria mentir com dados.",
      ganchos: [],
      objecoes: [],
      proximoPasso:
        "Aguardar a reverificação automática; se congelar como fora do ar, a estratégia de cortesia assume.",
    };
  }
  const vocabulario = vocabularioDoNicho(entrada.nicho, entrada.sobrescritaVocabulario ?? null);
  const ganchos: string[] = [ganchoDeReputacao(entrada.nota, entrada.numAvaliacoes)];
  const faltas: ItemDoRaioX[] = entrada.checklist?.falta ?? [];

  let cenario: string;
  let angulo: string;
  let objecoes: ObjecaoComResposta[] = OBJETOES_SITE_RUIM;

  const querAutomacao = ofertas.includes("automacao_crm") || ofertas.includes("automacao_n8n");
  const volumeAlto = (entrada.numAvaliacoes ?? 0) >= 50;

  if (entrada.classe === "site-ok") {
    if (querAutomacao && volumeAlto) {
      cenario = "Site ok, demanda alta";
      angulo =
        `Site em ordem e movimento alto: a dor não é vitrine, é atendimento — mensagens sem resposta e ${vocabulario} perdido no volume. O ângulo é automação (fila, resposta imediata, follow-up automático), não site.`;
      objecoes = [
        {
          objecao: "Meu atendimento dá conta",
          resposta:
            "Que bom — e é justamente quem tem movimento que mais perde no detalhe: mensagem fora de hora, follow-up esquecido. Automação não troca ninguém, só garante que nada cai no chão.",
        },
      ];
      ganchos.push(
        "Volume alto + site ok: pergunte quantas mensagens ficam sem resposta por dia — a conta se vende sozinha.",
      );
    } else {
      return {
        cenario: "Site ok",
        angulo:
          "Sem problema técnico à vista para vender conserto. Se abordar, o ângulo muda para melhoria de resultado (mais contatos, melhor posição) — caso contrário, priorize os mais quentes.",
        ganchos,
        objecoes: [],
        proximoPasso:
          "Prioridade baixa: compete com sem-site e site ruim na fila. Aborde só se a região ou o nicho for estratégico.",
      };
    }
  } else if (entrada.classe === "agregador" || entrada.classe === "sem-site") {
    cenario = entrada.classe === "agregador" ? "Só rede social" : "Sem site";
    angulo =
      `Negócio bem avaliado mas invisível para quem pesquisa no Google fora do Maps. Cada pesquisa sem resultado é ${vocabulario} indo para o concorrente que aparece. ` +
      (entrada.temInstagram
        ? "O Instagram é ativo — posicione o site como o complemento que captura quem pesquisa, nunca como substituto da rede."
        : "Presença digital quase zero: hoje só chega quem indica. Um site abre o canal de quem pesquisa por conta própria.");
    objecoes = OBJETOES_SEM_SITE;
  } else if (entrada.classe === "fora-do-ar") {
    cenario = "Site fora do ar";
    angulo =
      "O site NÃO ABRE — quem clica encontra erro. Abra como AVISO de cortesia (gera gratidão, não parece venda) e ofereça reconstruir rápido. Maior urgência, melhor resposta.";
    ganchos.push("Diga que tentou acessar e está fora do ar — você está avisando, não vendendo. A oferta vem depois da reação.");
  } else if (entrada.classe === "ssl-invalido" || entrada.problemas.includes("sem-https")) {
    cenario = "Site inseguro";
    angulo =
      "O navegador marca o site como “não seguro” — espanta cliente na hora e derruba a posição no Google. A reputação construída está sendo minada por um cadeado vermelho.";
    ganchos.push("Mande um print do aviso do navegador — é visual, indiscutível, e ninguém quer isso na marca.");
  } else if (entrada.problemas.includes("nao-mobile")) {
    cenario = "Site não-mobile";
    angulo =
      `O site quebra no celular — e quase toda pesquisa local é no celular. O site atende bem quem quase não existe (desktop) e falha onde está ${vocabulario}.`;
    ganchos.push("Sugira abrirem o próprio site no celular agora — a experiência ruim se vende sozinha.");
  } else if (entrada.problemas.includes("lento")) {
    cenario = "Site lento";
    angulo =
      "Funciona, mas demora tanto que parte dos visitantes desiste antes de ver qualquer coisa. Não é trocar por vaidade — é parar de perder quem já clicou.";
    ganchos.push("Sugira abrir no 4G sem Wi-Fi; com a nota do PageSpeed em mãos, fecha a questão.");
  } else if (entrada.problemas.some((p) => p.startsWith("construtor-"))) {
    cenario = "Site de construtor";
    angulo =
      "Modelo pronto: funciona, mas igual a milhares de outros, sem a credibilidade que a reputação merece. Negócio com nota alta merece site próprio, com cara própria.";
    objecoes = [
      {
        objecao: "O construtor me atende",
        resposta:
          "Atende como cartão improvisado: existe, mas não diferencia. Site próprio tem domínio profissional, carrega mais rápido e posiciona melhor — outro nível de impressão.",
      },
      {
        objecao: "Eu mesmo atualizo, é prático",
        resposta:
          "Continua igual — painel simples para editar o que quiser. A diferença está na base: design exclusivo e estrutura que o Google leva a sério.",
      },
    ];
    ganchos.push("Cite que dá para notar o modelo pronto — e emende com a reputação: “um negócio com essa nota merece um site à altura”.");
  } else {
    cenario = "Site com problemas";
    angulo =
      "Site existe mas custa clientes. Aborde como diagnóstico: aponte o problema em linguagem leiga e ofereça a reformulação como solução direta.";
    const detalhe = juntarProblemas(entrada.problemas);
    if (detalhe) ganchos.push(`Problemas detectados: ${detalhe}.`);
  }

  if (faltas.length > 0) {
    ganchos.push(
      `Faltas concretas no site: ${faltas.slice(0, 3).join(", ")} — cite uma como exemplo específico.`,
    );
  }
  if (entrada.temInstagram && entrada.classe !== "agregador" && entrada.classe !== "sem-site") {
    ganchos.push("O Instagram pode estar mais atualizado que o site — use isso a favor do diagnóstico.");
  }

  const proximoPasso =
    entrada.status === "novo"
      ? "Gere a prévia da abordagem, revise com seu tom e envie pelo WhatsApp; ao responder, siga com a estratégia acima. Depois marque como contatado."
      : entrada.followUpsEnviados > 0
        ? `Já foram ${entrada.followUpsEnviados} follow-up(s): gere a próxima copy trazendo um elemento NOVO (prazo, exemplo, diagnóstico) — repetir o argumento queima o lead.`
        : "Lead contatado sem resposta: follow-up leve de lembrete, com pedido de ação fechado.";

  return { cenario, angulo, ganchos, objecoes, proximoPasso };
}

/** Pesos do site por oferta primária. v1 travada por teste; retuning exige medição. */
const PESOS_DO_SITE: Record<OfertaDaCampanha, Record<string, number>> = {
  site: { "sem-site": 30, agregador: 30, "site-ruim": 22, "fora-do-ar": 25, "ssl-invalido": 25, "site-ok": 10 },
  automacao_crm: { "sem-site": 20, agregador: 20, "site-ruim": 14, "fora-do-ar": 16, "ssl-invalido": 16, "site-ok": 14 },
  automacao_n8n: { "sem-site": 20, agregador: 20, "site-ruim": 14, "fora-do-ar": 16, "ssl-invalido": 16, "site-ok": 14 },
};

const PESO_AVALIACOES: Record<OfertaDaCampanha, { teto: number; porAvaliacao: number }> = {
  site: { teto: 100, porAvaliacao: 0.3 },
  automacao_crm: { teto: 150, porAvaliacao: 0.4 },
  automacao_n8n: { teto: 150, porAvaliacao: 0.4 },
};

export interface Pontuacao {
  valor: number;
  /** Qual parcela dominou — score sem motivo não é exibido. */
  motivo: string;
}

/**
 * Score 0–100: nota (0–40) + volume de avaliações + situação do site.
 * Espelhado em SQL na query da fila (ordenação com paginação).
 */
export function pontuarCandidato(
  nota: number | null,
  numAvaliacoes: number | null,
  classe: ClasseDeSite,
  ofertaPrimaria: OfertaDaCampanha = "site",
  provisorio = false,
): Pontuacao {
  const pontosNota = Math.max(0, Math.min((nota ?? 0) - 4.0, 1.0)) * 40;
  const faixa = PESO_AVALIACOES[ofertaPrimaria] ?? PESO_AVALIACOES.site;
  const pontosAvaliacoes = Math.min(numAvaliacoes ?? 0, faixa.teto) * faixa.porAvaliacao;
  const pesosSite = PESOS_DO_SITE[ofertaPrimaria] ?? PESOS_DO_SITE.site;
  // Provisório não é classe de mérito: peso neutro até confirmar. Sem isso o
  // não-verificado herdaria o peso do "fora do ar" e furaria a fila.
  const pontosSite = provisorio ? 18 : (pesosSite[classe] ?? 0);
  const valor = Math.round(pontosNota + pontosAvaliacoes + pontosSite);
  const parcelas: Array<[number, string]> = [
    [pontosNota, "nota alta"],
    [pontosAvaliacoes, "volume de avaliações"],
    [pontosSite, classe === "site-ok" ? "site em ordem" : classe === "agregador" || classe === "sem-site" ? "sem site próprio" : "site com problemas"],
  ];
  parcelas.sort((a, b) => b[0] - a[0]);
  const motivoBase =
    parcelas[0]![0] > 0 ? `${parcelas[0]![1]}${parcelas[1]![0] > 0 ? ` + ${parcelas[1]![1]}` : ""}` : "sem sinais positivos";
  return { valor, motivo: provisorio ? `${motivoBase} · verificação pendente` : motivoBase };
}

/**
 * Rótulos PT-BR por classe — `Record` fechado (padrão `SCORE_BAND_LABELS`):
 * classe nova sem rótulo não compila. A tela aplica `t()` em cima.
 */
export const ROTULOS_DA_CLASSE = {
  agregador: "Só rede social",
  "sem-site": "Sem site próprio",
  "site-ok": "Site em ordem",
  "site-ruim": "Site com problemas",
  "ssl-invalido": "Site inseguro",
  "fora-do-ar": "Site fora do ar",
} as const satisfies Record<ClasseDeSite, string>;

export function rotuloDaClasse(classe: ClasseDeSite, t: (texto: string) => string = (texto) => texto): string {
  return t(ROTULOS_DA_CLASSE[classe]);
}

/** Rótulos PT-BR dos itens do raio-X para a tela (a UI aplica `t()`). */
export const ROTULOS_DO_CHECKLIST = {
  whatsapp: "WhatsApp",
  tel: "Telefone",
  mailto: "E-mail",
  social: "Redes sociais",
  mapa: "Endereço e mapa",
  fotos: "Fotos",
  titulo: "Título",
  description: "Descrição no Google",
  favicon: "Ícone da aba",
} as const satisfies Record<ItemDoRaioX, string>;

export function rotuloDoItem(item: ItemDoRaioX, t: (texto: string) => string = (texto) => texto): string {
  return t(ROTULOS_DO_CHECKLIST[item]);
}

export interface DadosDeAbordagem {
  dados: Record<string, string>;
}

/**
 * A instrução da abordagem fria: a do operador + a moldura que proíbe
 * inventar preenchimento. Fonte única — worker e prévia usam a mesma, ou o
 * par (tela × ferramenta) deixa de concordar.
 */
export function instrucaoDeAbordagemFria(
  instruction: string,
  qualification: string,
  voz?: string,
): string {
  const base =
    `${instruction}\nFaça uma primeira abordagem curta e transparente. ` +
    `Os dados vieram de pesquisa pública, não de um formulário preenchido pela pessoa. ` +
    `Não invente familiaridade, resultados ou interesse. Uma pergunta por vez. ` +
    `Critérios a confirmar durante a conversa: ${qualification}`;
  // Voz do vendedor (settings da org): some à moldura, nunca aos dados.
  // Vazia = byte a byte igual ao sem-voz (o par tela×ferramenta não sente).
  return voz ? `${base}\n${voz}` : base;
}

/**
 * Linha a linha para `gerarAbordagemDeFormulario`: os 6 campos que o envio já
 * usava (mesmos valores, mesma ordem) + `Auditoria` e `Detalhe` quando há
 * veredito. Fonte única — worker e prévia bebem daqui.
 */
export function montarDadosDeAbordagem(
  data: {
    name: string;
    category: string | null;
    address: string | null;
    website: string | null;
    rating: number | null;
    socials: string[];
  },
  site: {
    classe: ClasseDeSite;
    problemas: string[];
    conteudo_resumo: string | null;
    provisorio: boolean;
    verificado_em: string;
  } | null,
): Record<string, string> {
  const dados: Record<string, string> = {
    Empresa: data.name,
    Segmento: data.category ?? "",
    Endereço: data.address ?? "",
    Site: data.website ?? "",
    Avaliação: String(data.rating ?? ""),
    Redes: data.socials.join(", "),
  };
  // Só o DEFINITIVO é citável — e com a data, nunca "agora": o envio pode sair
  // dias depois da medição, e "agora" envelhece em mentira.
  if (site && !site.provisorio) {
    const problemas = site.problemas.map(descreverProblema).filter(Boolean);
    const dataMedicao = site.verificado_em.slice(0, 10).split("-").reverse().join("/");
    dados["Auditoria"] =
      `${ROTULOS_DA_CLASSE[site.classe]} (verificado em ${dataMedicao})` +
      (problemas.length > 0 ? ` — ${problemas.slice(0, 3).join("; ")}` : "");
    if (site.conteudo_resumo) dados["Detalhe"] = site.conteudo_resumo;
  }
  return dados;
}
