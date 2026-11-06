/**
 * O CATÁLOGO ÚNICO DE `{{variável}}` — uma lista, sem resolvedor, sem tela.
 *
 * ═══ O DEFEITO QUE ESTE ARQUIVO ATA ════════════════════════════════════════
 *
 * Cada lugar que aceita `{{...}}` tem a sua própria lista, e a mesma frase
 * significa coisas diferentes conforme onde foi escrita. "Bom dia,
 * `{{primeiro_nome}}`" sai certa na campanha e sai ", Ana" na automação, porque
 * lá `{{saudacao}}` é chave desconhecida e vira STRING VAZIA. A tela de
 * automação oferece três botões (`{{nome}}`, `{{telefone}}`, `{{lead.title}}`)
 * enquanto o motor resolve `{{contact.*}}`, `{{email}}` e o atalho de campo do
 * negócio. Ninguém tem como saber o que vale onde sem ler cinco arquivos.
 *
 * ═══ O QUE ESTE MÓDULO É (e o que ele NÃO é) ═══════════════════════════════
 *
 * É DADO: nome, descrição em português, exemplo e — o campo que resolve a
 * dúvida — em QUAIS fontes a variável existe hoje (`disponivelEm`). Nada aqui
 * interpola, nada aqui lê banco, nada aqui decide o que a tela oferece. Quem
 * consome escolhe; a fatia do resolvedor e a do seletor vêm depois.
 *
 * `disponivelEm` responde "esta fonte tem REGRA para este nome hoje" — e só
 * isso. Não promete texto preenchido: com o dado ausente o Inbox deixa o token
 * literal, a automação devolve vazio e a campanha marca `faltando` para quem
 * chama tirar a pessoa da lista. Preservar as três diferenças é o ponto;
 * "melhorar" uma sem pedir mudaria o que chega ao cliente.
 *
 * ═══ AS FONTES CONFERIDAS (todas, não uma amostra) ═════════════════════════
 *
 *   - Resposta rápida (Inbox)   · `lib/inbox/template-vars.ts`
 *   - Campanha                  · `lib/campanhas/renderizador.ts`
 *   - Automação e follow-up     · `lib/automation/template.ts` (o follow-up de
 *     texto reaproveita o mesmo `renderTemplate`, em
 *     `lib/automation/texto-do-followup.ts`)
 *   - Modelo da Meta no fluxo   · `lib/channels/meta/variaveis-do-fluxo.ts`
 *     (dialeto posicional `{{1}}` — a tradução origem→token está no teste)
 *   - Seletor da automação      · `app/app/webhooks/_components/ActionConfigForm.tsx`
 *
 * `lib/propostas/documento/variaveis.ts` e os campos criados pela organização
 * NÃO têm lista fechada: estão em `VOCABULARIOS_ABERTOS`, com o motivo, porque
 * catálogo que finge cobrir vocabulário aberto é pior que catálogo declarado.
 * `lib/templates/midias.ts` foi medido e não interpola `{{...}}`: é o payload de
 * mídia da resposta rápida, não uma fonte de variável.
 *
 * ═══ AS LACUNAS SÃO DADO, NÃO COMENTÁRIO ══════════════════════════════════
 *
 * `LACUNAS_CONHECIDAS` lista TODO par (variável, fonte) em que a fonte não tem
 * regra, com o efeito que o operador vê. O teste de paridade compara a lista
 * com o que o catálogo implica por IGUALDADE: lacuna a mais é catálogo que
 * mente sobre a fonte; lacuna a menos é divergência que fica sem explicação.
 */

/** As fontes de `{{variável}}` conferidas contra este catálogo. */
export const RESOLVEDORES = ["inbox", "campanha", "automacao", "fluxo"] as const;

export type Resolvedor = (typeof RESOLVEDORES)[number];

/** O arquivo de cada resolvedor — para o erro do teste nomear onde a variável nasceu. */
export const ARQUIVOS_DOS_RESOLVEDORES: Readonly<Record<Resolvedor, string>> = {
  inbox: "lib/inbox/template-vars.ts",
  campanha: "lib/campanhas/renderizador.ts",
  automacao: "lib/automation/template.ts",
  fluxo: "lib/channels/meta/variaveis-do-fluxo.ts",
};

/** De onde o valor sai — a coluna que o operador não vê, mas decide o resultado. */
export interface OrigemDoDado {
  /** Onde o dado mora hoje: `tabela.coluna`, jsonb do cadastro, ou o relógio. */
  fonte: string;
  /** A regra de leitura que cada resolvedor aplica — inclusive o fallback. */
  regra: string;
}

/** Uma entrada do catálogo. Curinga (`lead.*`) termina em `.*` e cobre um mapa. */
export interface VariavelDoCatalogo {
  /** A chave literal, sem `{{` e sem `}}`. */
  nome: string;
  descricao: string;
  /** Como o token fica DEPOIS de resolvido — o que o operador deve esperar ver. */
  exemplo: string;
  origem: OrigemDoDado;
  /** As fontes que hoje têm regra para este nome. */
  disponivelEm: readonly Resolvedor[];
}

/** A chave que o catálogo usa para um caminho: raiz + `.*`. */
export const SUFIXO_DE_CURINGA = ".*";

/**
 * As raízes de caminho do produto, cada uma no dialeto da fonte que a usa:
 * `lead` e `contato` (campanha, automação e fluxo), `contact` (só automação —
 * é o nome da linha de `contacts` no contexto de `renderTemplate`).
 */
export const RAIZES_DE_CAMPO = ["lead", "contato", "contact"] as const;

export type RaizDeCampo = (typeof RAIZES_DE_CAMPO)[number];

/**
 * O catálogo. A ORDEM é a de leitura na tela: primeiro o que toda mensagem usa,
 * depois os aliases que só a automação tem, e por último os caminhos — que não
 * são uma variável, são um mapa.
 */
export const VARIAVEIS_DO_CATALOGO: readonly VariavelDoCatalogo[] = [
  {
    nome: "nome",
    descricao: "Nome do contato, como está no cadastro",
    exemplo: "Ana Souza",
    origem: {
      fonte: "contacts.name, com contacts.display_name como reserva",
      regra:
        "Vazio, só espaço ou identificador técnico (`Contato 5431@lid`) caem no `display_name`; " +
        "sem nenhum dos dois, a variável fica sem valor. Inbox, automação e fluxo leem as duas " +
        "colunas por `nomeDoContato`; a campanha recebe o nome já congelado no snapshot da " +
        "audiência. O fluxo recusa nome que não tem letra (telefone no lugar do nome) em vez de " +
        'saudar "Olá +5511…".',
    },
    disponivelEm: ["inbox", "campanha", "automacao", "fluxo"],
  },
  {
    nome: "primeiro_nome",
    descricao: "Só a primeira palavra do nome",
    exemplo: "Ana",
    origem: {
      fonte: "o mesmo `nome`, cortado no primeiro espaço",
      regra:
        "Primeira palavra de `nome`, nas quatro fontes. Sem nome não há primeira palavra: a " +
        "variável fica sem valor — nunca cai para o telefone, que é rótulo de tela e não nome " +
        "de gente.",
    },
    disponivelEm: ["inbox", "campanha", "automacao", "fluxo"],
  },
  {
    nome: "saudacao",
    descricao: "Bom dia / Boa tarde / Boa noite, na hora do envio",
    exemplo: "Boa tarde",
    origem: {
      fonte: "relógio do envio, no fuso do canal (nunca o do servidor)",
      regra:
        "Antes das 12h, `Bom dia`; antes das 18h, `Boa tarde`; depois, `Boa noite`. Só resolve " +
        "quando há instante do envio: na prévia da campanha o token continua literal, porque " +
        "cravar uma saudação ali ensinaria o operador a esperar aquela. Fora da campanha não " +
        "existe: no Inbox sai literal, na automação sai VAZIO (ver `LACUNAS_CONHECIDAS`).",
    },
    disponivelEm: ["campanha"],
  },
  {
    nome: "telefone",
    descricao: "Telefone do contato, como está no cadastro",
    exemplo: "+5511999998888",
    origem: {
      fonte: "contacts.phone_number (alias `{{telefone}}`)",
      regra:
        "Alias de `contact.phone_number` no `renderTemplate`; o mesmo valor que " +
        "`{{contact.phone_number}}` dá. Só a automação (e o follow-up, que a reaproveita) tem " +
        "esse atalho: no Inbox o token é literal e na campanha entra em `desconhecidas`.",
    },
    disponivelEm: ["automacao"],
  },
  {
    nome: "email",
    descricao: "E-mail do contato, como está no cadastro",
    exemplo: "ana@exemplo.com",
    origem: {
      fonte: "contacts.email (alias `{{email}}`)",
      regra:
        "Alias de `contact.email` no `renderTemplate`, com o mesmo alcance do telefone: só a " +
        "automação. No Inbox o token é literal e na campanha entra em `desconhecidas`.",
    },
    disponivelEm: ["automacao"],
  },
  {
    nome: "lead.*",
    descricao:
      "Caminho do NEGÓCIO: campo personalizado (campanha, fluxo) ou coluna do card (automação)",
    exemplo: "{{lead.gancho}} → “vi que vocês vendem bolo de casamento”",
    origem: {
      fonte: "crm_leads.custom_fields (jsonb) e as colunas de crm_leads",
      regra:
        "MESMO TOKEN, TRÊS LEITURAS: na campanha, `{{lead.gancho}}` e `{{lead.custom_fields.gancho}}` " +
        "são o mesmo campo personalizado; na automação, `{{lead.gancho}}` é a COLUNA `gancho` (que " +
        "não existe, e sai vazio) e o campo personalizado exige `{{lead.custom_fields.gancho}}`; no " +
        "fluxo, `lead_custom` lê o `custom_fields` do negócio mais recente. Leitura só de " +
        "propriedade própria (nada de protótipo), lista separada por vírgula — com o rótulo da " +
        "opção quando o funil declara (#3605) —, e objeto/vazio/ausente são FALTA na campanha. " +
        "A divergência de sentido está em `SENTIDOS_DIVERGENTES`.",
    },
    disponivelEm: ["campanha", "automacao", "fluxo"],
  },
  {
    nome: "contato.*",
    descricao: "Campo personalizado do CONTATO, escrito como `{{contato.<campo>}}`",
    exemplo: "{{contato.link_previa}} → “https://<a-loja-do-cliente>/previa/ana”",
    origem: {
      fonte: "contacts.custom_fields (jsonb) do contato",
      regra:
        "Dialeto da campanha: `{{contato.gancho}}` e `{{contato.custom_fields.gancho}}` são o " +
        "mesmo campo. Mesma leitura de `lead.*` sobre o mapa do contato: propriedade própria, " +
        "lista separada por vírgula, vazio e ausente são FALTA (a pessoa sai da lista). Na " +
        "automação essa raiz não existe — lá o campo do contato é `{{contact.custom_fields.x}}` " +
        "— e o token sai VAZIO; no Inbox, literal.",
    },
    disponivelEm: ["campanha"],
  },
  {
    nome: "contact.*",
    descricao:
      "Caminho do CONTATO na automação: `{{contact.<coluna>}}` ou `{{contact.custom_fields.<campo>}}`",
    exemplo: "{{contact.phone_number}} → “+5511999998888”",
    origem: {
      fonte: "colunas de contacts e contacts.custom_fields (jsonb)",
      regra:
        "Dialeto da automação (o contexto de `renderTemplate` tem a linha inteira do contato em " +
        "`contact`). Alias de CRM nunca é atendido por campo homônimo: `{{nome}}` continua sendo " +
        "o nome da pessoa, não um campo personalizado chamado `nome`. O campo do nome da agenda " +
        "do celular (apelido interno da equipe) é bloqueado de propósito e sai vazio (PR #2439), " +
        "sem virar texto na mensagem. Fora da " +
        "automação não existe: na campanha é literal, no Inbox é literal.",
    },
    disponivelEm: ["automacao"],
  },
];

/** Um curinga cobre um mapa inteiro (`lead.*`); o resto é chave fechada. */
export function eCuringa(nome: string): boolean {
  return nome.endsWith(SUFIXO_DE_CURINGA);
}

/** `lead.*` → `lead`; chave fechada → `null`. */
export function raizDoCuringa(nome: string): RaizDeCampo | null {
  if (!eCuringa(nome)) return null;
  const raiz = nome.slice(0, -SUFIXO_DE_CURINGA.length).toLowerCase();
  return (RAIZES_DE_CAMPO as readonly string[]).includes(raiz) ? (raiz as RaizDeCampo) : null;
}

/** Os nomes do catálogo, na ordem em que a tela os mostra. */
export function nomesDoCatalogo(): string[] {
  return VARIAVEIS_DO_CATALOGO.map((v) => v.nome);
}

/**
 * A entrada de um nome — `null` para chave desconhecida.
 *
 * Aceita o token como o operador escreveu (`{{ Primeiro_Nome }}`) e o caminho de
 * campo com ou sem `custom_fields`: é a mesma tolerância dos resolvedores, e a
 * tela não pode ser mais exigente que o motor.
 */
export function variavelDoCatalogo(token: string): VariavelDoCatalogo | null {
  const caminho = normalizarToken(token);
  if (caminho === "") return null;
  const exata = VARIAVEIS_DO_CATALOGO.find((v) => v.nome.toLowerCase() === caminho);
  if (exata) return exata;
  const raiz = raizDoCuringa(caminho);
  if (!raiz) return null;
  return VARIAVEIS_DO_CATALOGO.find((v) => v.nome === `${raiz}${SUFIXO_DE_CURINGA}`) ?? null;
}

/** `{{ Primeiro_Nome }}` → `primeiro_nome`; `contact.custom_fields.x` → `contact.*`. */
export function normalizarToken(token: string): string {
  const semChaves = token.trim().replace(/^\{\{/, "").replace(/\}\}$/, "").trim().toLowerCase();
  // A reserva (`{{nome|"aluno"}}`) é sintaxe do motor, não parte do nome.
  const semReserva = semChaves.split("|")[0] ?? "";
  const caminho = semReserva
    .trim()
    .replace(/^lead\.custom_fields\./, "lead.")
    .replace(/^contato\.custom_fields\./, "contato.")
    .replace(/^contact\.custom_fields\./, "contact.");
  const ponto = caminho.indexOf(".");
  if (ponto > 0) {
    const raiz = caminho.slice(0, ponto);
    if ((RAIZES_DE_CAMPO as readonly string[]).includes(raiz)) {
      return `${raiz}${SUFIXO_DE_CURINGA}`;
    }
  }
  return caminho;
}

/** As variáveis que UMA fonte conhece hoje, na ordem do catálogo. */
export function variaveisDe(resolvedor: Resolvedor): string[] {
  return VARIAVEIS_DO_CATALOGO.filter((v) => v.disponivelEm.includes(resolvedor)).map(
    (v) => v.nome,
  );
}

/**
 * As variáveis que uma fonte conhece e ALGUMA outra não — a divergência, sem
 * escolher lado. É o que a fatia seguinte vai decidir tela por tela.
 */
export function exclusivasDe(resolvedor: Resolvedor): string[] {
  return VARIAVEIS_DO_CATALOGO.filter(
    (v) => v.disponivelEm.includes(resolvedor) && v.disponivelEm.length < RESOLVEDORES.length,
  ).map((v) => v.nome);
}

/** Uma linha da tabela de lacunas: onde a variável NÃO existe e o que acontece lá. */
export interface Lacuna {
  variavel: string;
  /** A fonte que NÃO tem regra para este nome. */
  fonte: Resolvedor;
  /** O que o operador vê nessa fonte — medido no motor, não suposto. */
  efeito: string;
}

/**
 * TODA lacuna do produto, uma por par (variável, fonte). Mantida à mão de
 * propósito: o efeito é texto para humano. O teste confere que ela é EXATAMENTE
 * o complemento de `disponivelEm` — crescer o catálogo sem atualizar aqui
 * reprova, e apagar uma linha aqui sem cobrir a fonte também.
 */
export const LACUNAS_CONHECIDAS: readonly Lacuna[] = [
  {
    variavel: "saudacao",
    fonte: "inbox",
    efeito:
      'O token sai LITERAL e vai para o cliente: "{{saudacao}}, Ana" chega assim. A reserva ' +
      "não cobre, porque a chave é desconhecida no Inbox.",
  },
  {
    variavel: "saudacao",
    fonte: "automacao",
    efeito:
      'Sai STRING VAZIA, sem aviso: "Bom dia, {{primeiro_nome}}! {{saudacao}}" vira "Bom dia, ' +
      'Ana! ". O operador só descobre na mensagem que já foi.',
  },
  {
    variavel: "saudacao",
    fonte: "fluxo",
    efeito:
      "Não há origem para escolher: o passo do modelo aprovado só oferece nome, primeiro nome e " +
      "campo do negócio.",
  },
  {
    variavel: "telefone",
    fonte: "inbox",
    efeito: "Literal `{{telefone}}` na mensagem do cliente — o Inbox não conhece telefone.",
  },
  {
    variavel: "telefone",
    fonte: "campanha",
    efeito:
      "Fica LITERAL e entra em `desconhecidas` na prévia: o operador vê `{{telefone}}` na " +
      "mensagem antes de apertar, mas o token não é resolvido.",
  },
  {
    variavel: "telefone",
    fonte: "fluxo",
    efeito: "Sem origem equivalente: o slot do modelo aprovado não aceita telefone.",
  },
  {
    variavel: "email",
    fonte: "inbox",
    efeito: "Literal `{{email}}` na mensagem do cliente — o Inbox não conhece e-mail.",
  },
  {
    variavel: "email",
    fonte: "campanha",
    efeito:
      "Fica LITERAL e entra em `desconhecidas` na prévia, como o telefone: a campanha só " +
      "resolve o que o snapshot da audiência carrega.",
  },
  {
    variavel: "email",
    fonte: "fluxo",
    efeito: "Sem origem equivalente: o slot do modelo aprovado não aceita e-mail.",
  },
  {
    variavel: "lead.*",
    fonte: "inbox",
    efeito:
      "Literal `{{lead.gancho}}` na mensagem — o Inbox não lê campo personalizado do negócio.",
  },
  {
    variavel: "contato.*",
    fonte: "inbox",
    efeito:
      "Literal `{{contato.gancho}}` na mensagem — o Inbox não lê campo personalizado do contato.",
  },
  {
    variavel: "contato.*",
    fonte: "automacao",
    efeito:
      "Sai VAZIO: o contexto da automação tem `contact` e `lead`, não `contato`. Quem copia a " +
      "sintaxe da campanha para uma automação perde o valor em silêncio.",
  },
  {
    variavel: "contato.*",
    fonte: "fluxo",
    efeito:
      "Campo do CONTATO não é origem: o fluxo só lê campo do NEGÓCIO. Escolhê-lo pularia o " +
      "passo — a limitação está registrada no #2791.",
  },
  {
    variavel: "contact.*",
    fonte: "inbox",
    efeito: "Literal `{{contact.phone_number}}` na mensagem — o Inbox não lê a linha do contato.",
  },
  {
    variavel: "contact.*",
    fonte: "campanha",
    efeito:
      "Literal + `desconhecidas`: a campanha só aceita a raiz `contato`, então quem escreve a " +
      "sintaxe da automação vê o token cru na prévia.",
  },
  {
    variavel: "contact.*",
    fonte: "fluxo",
    efeito:
      "Campo do CONTATO não é origem no fluxo: `lead_custom` lê só o negócio (#2791), e não há " +
      "origem para `{{contact.*}}`.",
  },
];

/** Um token que existe em mais de uma fonte com SIGNIFICADOS diferentes. */
export interface SentidoDivergente {
  variavel: string;
  /** O que o token quer dizer em cada fonte que o conhece. */
  sentidoPorFonte: Partial<Record<Resolvedor, string>>;
}

/**
 * As armadilhas de significado — o caso em que a variável EXISTE nas duas pontas
 * e devolve dados diferentes. É pior que a lacuna: a lacuna se vê (literal ou
 * vazio), o sentido trocado passa por acerto.
 */
export const SENTIDOS_DIVERGENTES: readonly SentidoDivergente[] = [
  {
    variavel: "lead.*",
    sentidoPorFonte: {
      campanha: "campo personalizado do negócio (`crm_leads.custom_fields`)",
      automacao:
        "COLUNA do card (`crm_leads.<coluna>`, ex. `{{lead.title}}`); campo personalizado só " +
        "com `{{lead.custom_fields.<campo>}}` ou o atalho `{{<campo>}}`",
      fluxo: "campo personalizado do negócio mais recente (`lead_custom`)",
    },
  },
];

/** Uma fonte cujo vocabulário NÃO é uma lista fechada — declarada, não escondida. */
export interface VocabularioAberto {
  arquivo: string;
  /** O que ele aceita hoje, em uma frase. */
  dialeto: string;
  /** Por que não cabe no catálogo como lista fechada. */
  motivo: string;
}

/**
 * O que este catálogo NÃO enumera, e por quê. São três naturezas diferentes: a
 * proposta tem vocabulário próprio; os campos personalizados são criados pela
 * organização em runtime; e o seletor da automação é TELA — o teste confere
 * cada botão dele contra o motor, mas ele não é fonte de verdade.
 */
export const VOCABULARIOS_ABERTOS: readonly VocabularioAberto[] = [
  {
    arquivo: "lib/propostas/documento/variaveis.ts",
    dialeto: "Qualquer caminho `{{a.b}}` sobre os dados do documento de proposta.",
    motivo:
      "O vocabulário é o modelo da proposta, que a organização escreve. Nenhuma outra tela " +
      'resolve esses nomes: `{{cliente.nome}}` vira "[a definir]" fora da proposta.',
  },
  {
    arquivo: "lib/leads/campos-do-funil.ts",
    dialeto:
      "Campos criados pela organização: atalho `{{<campo>}}` (automação), `{{lead.<campo>}}` e " +
      "`{{contato.<campo>}}` (campanha), `{{contact.custom_fields.<campo>}}` (automação).",
    motivo:
      "As chaves nascem no funil em runtime, com rótulo e opções de lista. O catálogo guarda a " +
      "FORMA (`lead.*`, `contato.*`, `contact.*`); a lista sai de `camposDoFunil` na hora.",
  },
  {
    arquivo: "app/app/webhooks/_components/ActionConfigForm.tsx",
    dialeto:
      "Três botões fixos (`{{nome}}`, `{{telefone}}`, `{{lead.title}}`) mais os campos do funil.",
    motivo:
      "É seletor de tela, não resolvedor: o teste de paridade confere que todo botão fixo é uma " +
      "variável catalogada e que o motor resolve o token que ele insere.",
  },
];
