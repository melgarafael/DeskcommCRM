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
import {
  citavelNoArgumento,
  descreverProblema,
  problemasMedidos,
  trocarMarcadores,
  type TradutorDeTexto,
} from "@/lib/prospecting/site-classify";
import type { OfertaDaCampanha } from "./schema";
import type { PreviaSalva } from "./previa";
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

/** Sem tradutor = português: é o que o agente recebe. A tela passa o `t()` do idioma. */
const SEM_TRADUCAO: TradutorDeTexto = (texto) => texto;

/** A sobrescrita é texto da organização e não passa pelo `t`; o mapa base passa. */
export function vocabularioDoNicho(
  nicho: string,
  sobrescrita?: Record<string, string> | null,
  t: TradutorDeTexto = SEM_TRADUCAO,
): string {
  const chave = normalizarNicho(nicho);
  if (sobrescrita) {
    for (const [termo, vocabulario] of Object.entries(sobrescrita)) {
      if (chave.includes(normalizarNicho(termo))) return vocabulario;
    }
  }
  for (const prefixo of Object.keys(VOCABULARIO_POR_NICHO)) {
    if (chave.includes(prefixo)) return t(VOCABULARIO_POR_NICHO[prefixo] as string);
  }
  return chave ? trocarMarcadores(t("clientes de {nicho}"), { nicho: nicho.trim() }) : t("clientes novos");
}

function ganchoDeReputacao(nota: number | null, avaliacoes: number | null, t: TradutorDeTexto): string {
  const n = nota ?? 0;
  const total = avaliacoes ?? 0;
  if (n >= 4.8 && total >= 50)
    return trocarMarcadores(
      t("Nota {nota} com {total} avaliações: reputação de sobra e negócio estabelecido — colhe resultado rápido."),
      { nota: n, total },
    );
  if (n >= 4.5 && total >= 10)
    return trocarMarcadores(
      t("Nota {nota} com {total} avaliações: a reputação já existe, só não trabalha fora do Maps."),
      { nota: n, total },
    );
  if (n > 0) return trocarMarcadores(t("Nota {nota} no Google — use como abertura, nunca como crítica."), { nota: n });
  return t("Sem avaliações visíveis — posicione presença digital como começo, não conserto.");
}

function juntarProblemas(problemas: string[], t: TradutorDeTexto): string | null {
  const texto = problemas
    .filter((p) => !p.startsWith("falta-"))
    .map((p) => descreverProblema(p, t))
    .slice(0, 3)
    .join("; ");
  return texto || null;
}

/**
 * Melhor ângulo = auditoria × primeira oferta aplicável ao caso.
 * `ofertas[0]` (primária) decide empates; default `["site"]` = comportamento atual.
 */
export function montarEstrategia(entrada: EntradaDaEstrategia, t: TradutorDeTexto = SEM_TRADUCAO): EstrategiaDoLead {
  const objecoesTraduzidas = (lista: ObjecaoComResposta[]): ObjecaoComResposta[] =>
    lista.map((o) => ({ objecao: t(o.objecao), resposta: t(o.resposta) }));
  const ofertas: OfertaDaCampanha[] =
    entrada.ofertas.length > 0 ? entrada.ofertas : ["site"];
  // Provisório primeiro: verificação inconclusiva não gera ângulo de conserto
  // (vender em cima de timeout seria queimar o lead com gancho falso).
  // `nao-medido` é o mesmo caso, já congelado: não olhamos o site (bloqueio
  // anti-robô, rede), então não há o que citar. Antes o timeout congelava
  // "fora do ar" e a primeira mensagem dizia que o site não abre (#3723).
  if (entrada.provisorio || entrada.classe === "nao-medido") {
    const medido = entrada.classe === "nao-medido" && !entrada.provisorio;
    return {
      cenario: t(medido ? "Site não medido" : "Verificação pendente"),
      angulo: t(
        medido
          ? "Não deu para abrir o site daqui (bloqueio ao nosso acesso automático ou rede instável), então NÃO há defeito medido para citar. Aborde pelo que é público e comprovado — nota, avaliações, presença — e não fale do site."
          : "A verificação do site foi inconclusiva (instabilidade de rede, não defeito comprovado). Sem gancho até a reverificação confirmar — abordar citando queda seria mentir com dados.",
      ),
      ganchos: [],
      objecoes: [],
      proximoPasso: t(
        medido
          ? "Aborde sem citar o site. Para ter diagnóstico, rode \"Reanalisar site\" de outra rede ou noutro dia."
          : "Aguardar a reverificação automática; se esgotar as tentativas, o veredito fica \"não medido\" e a abordagem segue sem citar o site.",
      ),
    };
  }
  const vocabulario = vocabularioDoNicho(entrada.nicho, entrada.sobrescritaVocabulario ?? null, t);
  const ganchos: string[] = [ganchoDeReputacao(entrada.nota, entrada.numAvaliacoes, t)];

  let cenario: string;
  let angulo: string;
  let objecoes: ObjecaoComResposta[] = OBJETOES_SITE_RUIM;

  const querAutomacao = ofertas.includes("automacao_crm") || ofertas.includes("automacao_n8n");
  const volumeAlto = (entrada.numAvaliacoes ?? 0) >= 50;

  if (entrada.classe === "site-ok") {
    if (querAutomacao && volumeAlto) {
      cenario = t("Site ok, demanda alta");
      angulo = trocarMarcadores(
        t("Site em ordem e movimento alto: a dor não é vitrine, é atendimento — mensagens sem resposta e {vocabulario} perdido no volume. O ângulo é automação (fila, resposta imediata, follow-up automático), não site."),
        { vocabulario },
      );
      objecoes = [
        {
          objecao: "Meu atendimento dá conta",
          resposta:
            "Que bom — e é justamente quem tem movimento que mais perde no detalhe: mensagem fora de hora, follow-up esquecido. Automação não troca ninguém, só garante que nada cai no chão.",
        },
      ];
      ganchos.push(
        t("Volume alto + site ok: pergunte quantas mensagens ficam sem resposta por dia — a conta se vende sozinha."),
      );
    } else {
      return {
        cenario: t("Site ok"),
        angulo: t(
          "Sem problema técnico à vista para vender conserto. Se abordar, o ângulo muda para melhoria de resultado (mais contatos, melhor posição) — caso contrário, priorize os mais quentes.",
        ),
        ganchos,
        objecoes: [],
        proximoPasso: t(
          "Prioridade baixa: compete com sem-site e site ruim na fila. Aborde só se a região ou o nicho for estratégico.",
        ),
      };
    }
  } else if (entrada.classe === "agregador" || entrada.classe === "sem-site") {
    cenario = t(entrada.classe === "agregador" ? "Só rede social" : "Sem site");
    angulo =
      trocarMarcadores(
        t("Negócio bem avaliado mas invisível para quem pesquisa no Google fora do Maps. Cada pesquisa sem resultado é {vocabulario} indo para o concorrente que aparece."),
        { vocabulario },
      ) +
      " " +
      t(
        entrada.temInstagram
          ? "O Instagram é ativo — posicione o site como o complemento que captura quem pesquisa, nunca como substituto da rede."
          : "Presença digital quase zero: hoje só chega quem indica. Um site abre o canal de quem pesquisa por conta própria.",
      );
    objecoes = OBJETOES_SEM_SITE;
  } else if (entrada.classe === "fora-do-ar") {
    const dominioMorto = entrada.problemas.includes("dns-morto");
    cenario = t("Site fora do ar");
    angulo = t(
      dominioMorto
        ? "O endereço do site NÃO EXISTE MAIS (domínio pode ter expirado) — quem clica no link do Google não chega a lugar nenhum. Abra como AVISO de cortesia e ofereça um endereço novo, rápido: a marca perde quem pesquisa todos os dias."
        : "O site NÃO ABRE — quem clica encontra erro. Abra como AVISO de cortesia (gera gratidão, não parece venda) e ofereça reconstruir rápido. Maior urgência, melhor resposta.",
    );
    ganchos.push(
      t("Diga que tentou acessar e está fora do ar — você está avisando, não vendendo. A oferta vem depois da reação."),
    );
  } else if (entrada.classe === "ssl-invalido" || entrada.problemas.includes("sem-https") || entrada.problemas.includes("http-sem-redirecionar")) {
    cenario = t("Site inseguro");
    angulo = t(
      "O navegador marca o site como “não seguro” — espanta cliente na hora e derruba a posição no Google. A reputação construída está sendo minada por um cadeado vermelho.",
    );
    ganchos.push(t("Mande um print do aviso do navegador — é visual, indiscutível, e ninguém quer isso na marca."));
  } else if (entrada.problemas.includes("nao-mobile")) {
    cenario = t("Site não-mobile");
    angulo = trocarMarcadores(
      t("O site quebra no celular — e quase toda pesquisa local é no celular. O site atende bem quem quase não existe (desktop) e falha onde está {vocabulario}."),
      { vocabulario },
    );
    ganchos.push(t("Sugira abrirem o próprio site no celular agora — a experiência ruim se vende sozinha."));
  } else if (entrada.problemas.includes("lento")) {
    cenario = t("Site lento");
    angulo = t(
      "Funciona, mas demora tanto que parte dos visitantes desiste antes de ver qualquer coisa. Não é trocar por vaidade — é parar de perder quem já clicou.",
    );
    ganchos.push(t("Sugira abrir no 4G sem Wi-Fi; com a nota do PageSpeed em mãos, fecha a questão."));
  } else if (entrada.problemas.some((p) => p.startsWith("construtor-"))) {
    cenario = t("Site de construtor");
    angulo = t(
      "Modelo pronto: funciona, mas igual a milhares de outros, sem a credibilidade que a reputação merece. Negócio com nota alta merece site próprio, com cara própria.",
    );
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
    ganchos.push(
      t("Cite que dá para notar o modelo pronto — e emende com a reputação: “um negócio com essa nota merece um site à altura”."),
    );
  } else {
    cenario = t("Site com problemas");
    angulo = t(
      "Site existe mas custa clientes. Aborde como diagnóstico: aponte o problema em linguagem leiga e ofereça a reformulação como solução direta.",
    );
    const detalhe = juntarProblemas(entrada.problemas, t);
    if (detalhe) ganchos.push(trocarMarcadores(t("Problemas detectados: {detalhe}."), { detalhe }));
  }

  // O checklist NÃO entra em gancho (#3723). `falta-tel`, `falta-fotos`,
  // `falta-titulo` são melhoria — e três delas eram mentira (site com `wa.me`,
  // título curto, página montada por JavaScript). Gancho é só o que a medição
  // provou e qualquer pessoa confirma abrindo o site, e disso já cuidam os
  // ramos acima: não abre, domínio morto, "não seguro", quebrado no celular.
  if (entrada.temInstagram && entrada.classe !== "agregador" && entrada.classe !== "sem-site") {
    ganchos.push(t("O Instagram pode estar mais atualizado que o site — use isso a favor do diagnóstico."));
  }

  // `status` é o de `prospecting_candidates` ('new','queued','sending','sent',
  // 'skipped','failed'): só 'sent' foi abordado. Vazio = quem chama não sabe (o
  // Inbox): sem passo, em vez de afirmar um contato que talvez não houve.
  // 'skipped' (a triagem descartou) e 'failed' também ficam sem passo: sugerir
  // envio convidaria a abordar quem foi barrado.
  const proximoPasso =
    entrada.followUpsEnviados > 0
      ? trocarMarcadores(
          t("Já foram {n} follow-up(s): gere a próxima copy trazendo um elemento NOVO (prazo, exemplo, diagnóstico) — repetir o argumento queima o lead."),
          { n: entrada.followUpsEnviados },
        )
      : entrada.status === "sent"
        ? t("Lead contatado sem resposta: follow-up leve de lembrete, com pedido de ação fechado.")
        : ["", "skipped", "failed"].includes(entrada.status)
          ? ""
          : t(
              "Gere a prévia da abordagem, revise com seu tom e envie pelo WhatsApp; ao responder, siga com a estratégia acima. Depois marque como contatado.",
            );

  return { cenario, angulo, ganchos, objecoes: objecoesTraduzidas(objecoes), proximoPasso };
}

/**
 * A estratégia do candidato a partir do veredito EFETIVO (`siteEfetivo`) e do
 * contexto da campanha. Fonte única: a TELA (prévia) e o ENVIO (worker) chamam
 * esta função — sem isso o ângulo que a pessoa revisa na prévia e o que o agente
 * recebe no envio divergem, e o par tela×envio se rompe em silêncio.
 */
export function estrategiaDoCandidato(
  data: {
    rating: number | null;
    reviews: number | null;
    socials?: string[] | null;
  },
  site: {
    classe: ClasseDeSite;
    problemas: string[];
    checklist: RaioXDoSite | null;
    provisorio: boolean;
  },
  contexto: {
    ofertas: OfertaDaCampanha[];
    nicho: string;
    sobrescritaVocabulario?: Record<string, string> | null;
    status: string;
    followUpsEnviados?: number;
  },
): EstrategiaDoLead {
  return montarEstrategia({
    classe: site.classe,
    problemas: site.problemas,
    checklist: site.checklist,
    nota: data.rating,
    numAvaliacoes: data.reviews,
    temInstagram: /instagram/i.test((data.socials ?? []).join(",")),
    ofertas: contexto.ofertas,
    nicho: contexto.nicho,
    sobrescritaVocabulario: contexto.sobrescritaVocabulario ?? null,
    provisorio: site.provisorio,
    status: contexto.status,
    followUpsEnviados: contexto.followUpsEnviados ?? 0,
  });
}

/** Pesos do site por oferta primária. v1 travada por teste; retuning exige medição. */
const PESOS_DO_SITE: Record<OfertaDaCampanha, Record<string, number>> = {
  site: { "sem-site": 30, agregador: 30, "site-ruim": 22, "fora-do-ar": 25, "ssl-invalido": 25, "site-ok": 10, "nao-medido": 18 },
  automacao_crm: { "sem-site": 20, agregador: 20, "site-ruim": 14, "fora-do-ar": 16, "ssl-invalido": 16, "site-ok": 14, "nao-medido": 18 },
  automacao_n8n: { "sem-site": 20, agregador: 20, "site-ruim": 14, "fora-do-ar": 16, "ssl-invalido": 16, "site-ok": 14, "nao-medido": 18 },
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
  t: TradutorDeTexto = SEM_TRADUCAO,
): Pontuacao {
  const pontosNota = Math.max(0, Math.min((nota ?? 0) - 4.0, 1.0)) * 40;
  const faixa = PESO_AVALIACOES[ofertaPrimaria] ?? PESO_AVALIACOES.site;
  const pontosAvaliacoes = Math.min(numAvaliacoes ?? 0, faixa.teto) * faixa.porAvaliacao;
  const pesosSite = PESOS_DO_SITE[ofertaPrimaria] ?? PESOS_DO_SITE.site;
  // Provisório e `nao-medido` não são classe de mérito: peso neutro. Sem isso o
  // não-verificado herdaria o peso do "fora do ar" e furaria a fila.
  const pontosSite = provisorio ? 18 : (pesosSite[classe] ?? 0);
  const valor = Math.round(pontosNota + pontosAvaliacoes + pontosSite);
  const parcelas: Array<[number, string]> = [
    [pontosNota, t("nota alta")],
    [pontosAvaliacoes, t("volume de avaliações")],
    [
      pontosSite,
      t(
        classe === "site-ok"
          ? "site em ordem"
          : classe === "agregador" || classe === "sem-site"
            ? "sem site próprio"
            : classe === "nao-medido"
              ? "site não medido"
              : "site com problemas",
      ),
    ],
  ];
  parcelas.sort((a, b) => b[0] - a[0]);
  const motivoBase =
    parcelas[0]![0] > 0 ? `${parcelas[0]![1]}${parcelas[1]![0] > 0 ? ` + ${parcelas[1]![1]}` : ""}` : t("sem sinais positivos");
  return { valor, motivo: provisorio ? `${motivoBase} · ${t("verificação pendente")}` : motivoBase };
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
  "nao-medido": "Site não medido",
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

const MAX_BLOCO_ESTRATEGIA = 900;

/**
 * O bloco de ESTRATÉGIA para a instrução do agente (lado `system`).
 *
 * Só texto fixo e números que o PRÓPRIO sistema produziu — cenário, ângulo,
 * ganchos (as objeções ficam na tela). NUNCA conteúdo publicado por terceiros (nome do negócio,
 * endereço, resumo do HTML): a instrução sobe para o `system`, longe da cerca
 * de nonce, e o texto do site de outra pessoa virando instrução de sistema é a
 * porta de injeção pela lateral. O que é de terceiro fica nos DADOS (`user`).
 */
export function blocoDeEstrategiaParaAgente(estrategia: EstrategiaDoLead): string {
  const partes: string[] = [
    "Estratégia de abordagem definida para este lead (siga o ângulo):",
    `Cenário: ${estrategia.cenario}`,
    `Ângulo: ${estrategia.angulo}`,
  ];
  if (estrategia.ganchos.length > 0) {
    partes.push("Ganchos:", ...estrategia.ganchos.map((g) => `- ${g}`));
  }
  // Sem as objeções: servem à conversa, não à primeira mensagem. Teto de 900
  // para a instrução não crescer sem limite.
  const texto = partes.join("\n");
  return texto.length > MAX_BLOCO_ESTRATEGIA ? texto.slice(0, MAX_BLOCO_ESTRATEGIA) : texto;
}

/**
 * A instrução da abordagem fria: a do operador + a moldura que proíbe
 * inventar preenchimento. Fonte única — worker e prévia usam a mesma, ou o
 * par (tela × ferramenta) deixa de concordar.
 *
 * `estrategia` (B1) soma o bloco de ângulo ao FIM. Ausente/nula, a saída é byte
 * a byte a de antes — é o que permite o par medir sem ruído quando não há
 * estratégia.
 *
 * `soCumprimenta` é o modo "saída na 2ª mensagem" da campanha (`exit_offer`
 * diferente de `first_message`): a primeira mensagem só cumprimenta e confirma
 * a empresa. A frase entra logo depois dos critérios, no mesmo lugar em que o
 * worker a punha antes de a prévia e o envio dividirem esta função.
 * Nesse modo nem a estratégia nem a auditoria entram (a estratégia é ângulo de
 * venda): é a definição do modo na spec do #3091, mantida pelo doc 170 = B. Os
 * chamadores tiram a auditoria dos dados com o mesmo booleano.
 */
export function instrucaoDeAbordagemFria(
  instruction: string,
  qualification: string,
  voz?: string,
  estrategia?: EstrategiaDoLead | null,
  soCumprimenta = false,
): string {
  const base =
    `${instruction}\nFaça uma primeira abordagem curta e transparente. ` +
    `Os dados vieram de pesquisa pública, não de um formulário preenchido pela pessoa. ` +
    `Não invente familiaridade, resultados ou interesse. Uma pergunta por vez. ` +
    `Critérios a confirmar durante a conversa: ${qualification}` +
    (soCumprimenta
      ? "\nEsta primeira mensagem NÃO apresenta serviço, preço nem proposta: só cumprimenta e confirma se falou com a empresa certa."
      : "");
  // Voz do vendedor (settings da org): some à moldura, nunca aos dados.
  // Vazia = byte a byte igual ao sem-voz (o par tela×ferramenta não sente).
  const comVoz = voz ? `${base}\n${voz}` : base;
  if (!estrategia || soCumprimenta) return comVoz;
  return `${comVoz}\n${blocoDeEstrategiaParaAgente(estrategia)}`;
}

/**
 * Linha a linha para `gerarAbordagemDeFormulario`: os 6 campos que o envio já
 * usava (mesmos valores, mesma ordem) + `Auditoria` e `Detalhe` quando há
 * veredito + `Rascunho de abordagem` quando a tela guardou uma prévia válida.
 * Fonte única — worker e prévia bebem daqui.
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
  previa?: PreviaSalva | null,
): Record<string, string> {
  const dados: Record<string, string> = {
    Empresa: data.name,
    Segmento: data.category ?? "",
    Endereço: data.address ?? "",
    Site: data.website ?? "",
    Avaliação: String(data.rating ?? ""),
    Redes: data.socials.join(", "),
  };
  // Só o DEFINITIVO E MEDIDO é citável (`citavelNoArgumento`) — e com a data,
  // nunca "agora": o envio pode sair dias depois da medição, e "agora"
  // envelhece em mentira. `falta-*` fica de fora mesmo em veredito antigo: item
  // de checklist é melhoria e já tem morada própria na ficha da tela (#3723).
  if (site && citavelNoArgumento(site)) {
    const problemas = problemasMedidos(site.problemas).map((p) => descreverProblema(p)).filter(Boolean);
    const dataMedicao = site.verificado_em.slice(0, 10).split("-").reverse().join("/");
    dados["Auditoria"] =
      `${ROTULOS_DA_CLASSE[site.classe]} (verificado em ${dataMedicao})` +
      (problemas.length > 0 ? ` — ${problemas.slice(0, 3).join("; ")}` : "");
    if (site.conteudo_resumo) dados["Detalhe"] = site.conteudo_resumo;
  }
  // A PRÉVIA guardada (pelo botão ou pelo preparo automático — nem sempre lida por
  // alguém). Vai como DADO — dentro da cerca de nonce, nunca como instrução — e com teto próprio
  // em `formatarDados` (1200, não os 500 dos outros campos).
  if (previa?.texto) dados["Rascunho de abordagem"] = previa.texto;
  return dados;
}
