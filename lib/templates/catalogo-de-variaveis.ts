/**
 * O CATÁLOGO ÚNICO DE `{{variável}}` — uma lista, cinco campos, nenhum resolvedor.
 *
 * ═══ O DEFEITO QUE ESTE ARQUIVO ATA ════════════════════════════════════════
 *
 * Hoje cada tela que aceita `{{...}}` tem a sua própria lista. "Olá
 * `{{primeiro_nome}}`" significa coisas diferentes conforme onde foi escrito, e
 * a tela que oferece os botões oferece o vocabulário DELA, não o do produto:
 *
 *   - Resposta rápida (Inbox)  · `lib/inbox/template-vars.ts`
 *   - Campanha                 · `lib/campanhas/renderizador.ts`
 *   - Webhook / follow-up      · `lib/automation/template.ts`
 *   - Follow-up modelo Meta    · `lib/channels/meta/variaveis-do-fluxo.ts`
 *   - Proposta                 · `lib/propostas/documento/variaveis.ts`
 *
 * Este módulo descreve o vocabulário que JÁ EXISTE — não inventa um novo. A
 * fatia desta entrega confere PARIDADE contra dois resolvedores, escolhidos por
 * cobrirem os dois extremos: o Inbox (o mais pobre: só nome e primeiro nome) e a
 * campanha (o mais rico: mais `saudacao` e os campos personalizados). Os outros
 * quatro estão listados em `RESOLVEDORES_NAO_COBERTOS`, com o arquivo de cada um,
 * porque catálogo que finge cobrir o que não leu é pior que catálogo parcial.
 *
 * ═══ O QUE `disponivelEm` QUER DIZER (e o que NÃO quer) ═════════════════════
 *
 * `disponivelEm` responde "quais resolvedores têm REGRA para este nome hoje" —
 * nada além disso. Não promete que o texto sai preenchido: com o dado ausente, o
 * Inbox deixa o token LITERAL (`{{primeiro_nome}}`) e a campanha deixa o literal
 * e marca a variável em `faltando`, para quem chama tirar a pessoa da lista.
 * Preservar essa diferença é o ponto; "melhorar" uma das duas sem pedir
 * mudaria o que chega ao cliente.
 *
 * ═══ SEM REACT, SEM ESTADO, SEM I/O ═════════════════════════════════════════
 *
 * Tipo puro de propósito: a mesma lista serve à tela (botões de inserção), ao
 * servidor (prévia) e ao teste de paridade. Quem importa daqui decide o que
 * fazer; este arquivo não resolve texto — o resolvedor único é a fatia seguinte.
 */

/** Os resolvedores contra os quais o catálogo foi conferido nesta fatia. */
export const RESOLVEDORES = ["inbox", "campanha"] as const;

export type Resolvedor = (typeof RESOLVEDORES)[number];

/** De onde o valor sai — a coluna que o operador não vê, mas decide o resultado. */
export interface OrigemDoDado {
  /** Onde o dado mora hoje: `tabela.coluna`, jsonb do cadastro, ou o relógio. */
  fonte: string;
  /** A regra de leitura que o resolvedor aplica — inclusive o fallback. */
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
  /** Os resolvedores que hoje têm regra para este nome. */
  disponivelEm: readonly Resolvedor[];
}

/** A chave que o catálogo usa para um campo personalizado: raiz + `.*`. */
export const SUFIXO_DE_CURINGA = ".*";

/** As duas raízes de campo personalizado — as mesmas da campanha e da automação. */
export const RAIZES_DE_CAMPO = ["lead", "contato"] as const;

export type RaizDeCampo = (typeof RAIZES_DE_CAMPO)[number];

/**
 * O catálogo. A ORDEM é a de leitura na tela: primeiro o que toda mensagem usa,
 * depois o que só a campanha usa, e por último os mapas — que não são uma
 * variável, são um caminho.
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
        "sem nenhum dos dois, a variável fica sem valor. O Inbox lê as duas colunas por " +
        "`nomeDoContato`; a campanha recebe o nome já congelado no snapshot da audiência.",
    },
    disponivelEm: ["inbox", "campanha"],
  },
  {
    nome: "primeiro_nome",
    descricao: "Só a primeira palavra do nome",
    exemplo: "Ana",
    origem: {
      fonte: "o mesmo `nome`, cortado no primeiro espaço",
      regra:
        "Primeira palavra de `nome`. Sem nome não há primeira palavra: a variável fica sem " +
        "valor — nunca cai para o telefone, que é rótulo de tela e não nome de gente.",
    },
    disponivelEm: ["inbox", "campanha"],
  },
  {
    nome: "saudacao",
    descricao: "Bom dia / Boa tarde / Boa noite, na hora do envio",
    exemplo: "Boa tarde",
    origem: {
      fonte: "relógio do envio, no fuso do canal (nunca o do servidor)",
      regra:
        "Antes das 12h, `Bom dia`; antes das 18h, `Boa tarde`; depois, `Boa noite`. Só resolve " +
        "quando há instante do envio: na prévia o token continua literal, porque cravar uma " +
        "saudação ali ensinaria o operador a esperar aquela.",
    },
    disponivelEm: ["campanha"],
  },
  {
    nome: "lead.*",
    descricao: "Campo personalizado do NEGÓCIO, escrito como `{{lead.<campo>}}`",
    exemplo: "{{lead.gancho}} → “vi que vocês vendem bolo de casamento”",
    origem: {
      fonte: "crm_leads.custom_fields (jsonb) do negócio do contato",
      regra:
        "`{{lead.custom_fields.gancho}}` e `{{lead.gancho}}` são o mesmo campo. Lê só " +
        "propriedade própria do mapa (nada de protótipo), lista vira texto separado por " +
        "vírgula, e objeto/vazio/ausente são FALTA. Contato sem negócio não tem mapa: falta.",
    },
    disponivelEm: ["campanha"],
  },
  {
    nome: "contato.*",
    descricao: "Campo personalizado do CONTATO, escrito como `{{contato.<campo>}}`",
    exemplo: "{{contato.link_previa}} → “https://<a-loja-do-cliente>/previa/ana”",
    origem: {
      fonte: "contacts.custom_fields (jsonb) do contato",
      regra:
        "Mesma leitura de `lead.*`, sobre o mapa do contato: propriedade própria, lista " +
        "separada por vírgula, vazio e ausente são FALTA.",
    },
    disponivelEm: ["campanha"],
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
 * campo com ou sem `custom_fields`: é a mesma tolerância que os dois resolvedores
 * já têm, e a tela não pode ser mais exigente que o motor.
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

/** `{{ Primeiro_Nome }}` → `primeiro_nome`; `lead.custom_fields.gancho` → `lead.*`. */
export function normalizarToken(token: string): string {
  const semChaves = token.trim().replace(/^\{\{/, "").replace(/\}\}$/, "").trim().toLowerCase();
  // A reserva (`{{nome|"aluno"}}`) é sintaxe do motor, não parte do nome.
  const semReserva = semChaves.split("|")[0] ?? "";
  const caminho = semReserva
    .trim()
    .replace(/^lead\.custom_fields\./, "lead.")
    .replace(/^contato\.custom_fields\./, "contato.");
  const ponto = caminho.indexOf(".");
  if (ponto > 0) {
    const raiz = caminho.slice(0, ponto);
    if ((RAIZES_DE_CAMPO as readonly string[]).includes(raiz)) {
      return `${raiz}${SUFIXO_DE_CURINGA}`;
    }
  }
  return caminho;
}

/** Os nomes que UM resolvedor conhece hoje, na ordem do catálogo. */
export function variaveisDe(resolvedor: Resolvedor): string[] {
  return VARIAVEIS_DO_CATALOGO.filter((v) => v.disponivelEm.includes(resolvedor)).map(
    (v) => v.nome,
  );
}

/**
 * As variáveis que só existem em UM dos resolvedores — a divergência, sem
 * escolher lado. É o que a fatia 2 vai ter de decidir tela por tela.
 */
export function exclusivasDe(resolvedor: Resolvedor): string[] {
  return VARIAVEIS_DO_CATALOGO.filter(
    (v) => v.disponivelEm.includes(resolvedor) && v.disponivelEm.length < RESOLVEDORES.length,
  ).map((v) => v.nome);
}

/** Uma linha da tabela de divergência: onde existe, onde não, e o que acontece lá. */
export interface Divergencia {
  variavel: string;
  existeEm: Resolvedor;
  faltaEm: Resolvedor;
  /** O efeito no resolvedor que não conhece o nome — mantém o token literal. */
  efeito: string;
}

/**
 * A divergência escrita por extenso, para a tabela do PR e para a tela que um
 * dia avisar "esta variável não funciona no Inbox". Mantida à mão de propósito:
 * é texto para humano, e o teste confere que ela não envelheceu em relação ao
 * catálogo.
 */
export const DIVERGENCIAS: readonly Divergencia[] = [
  {
    variavel: "saudacao",
    existeEm: "campanha",
    faltaEm: "inbox",
    efeito:
      "No Inbox o token fica LITERAL no texto ({{saudacao}} sai na mensagem); reserva não cobre, " +
      "porque a chave é desconhecida lá.",
  },
  {
    variavel: "lead.*",
    existeEm: "campanha",
    faltaEm: "inbox",
    efeito:
      "No Inbox o token fica LITERAL ({{lead.gancho}} sai na mensagem) — o Inbox não lê " +
      "custom_fields de negócio nem de contato.",
  },
  {
    variavel: "contato.*",
    existeEm: "campanha",
    faltaEm: "inbox",
    efeito:
      "No Inbox o token fica LITERAL ({{contato.link_previa}} sai na mensagem); campo " +
      "personalizado do contato não existe lá.",
  },
];

/** Um resolvedor que este catálogo AINDA NÃO cobre — declarado, não escondido. */
export interface ResolvedorNaoCoberto {
  arquivo: string;
  /** O que ele aceita hoje, em uma frase. */
  dialeto: string;
  /** Por que ficou de fora desta fatia. */
  motivo: string;
}

/**
 * O que este catálogo NÃO cobre. Existe para o PR poder dizer, com o caminho do
 * arquivo na mão, o que falta — e para o teste reprovar se alguém apagar a
 * declaração sem cobrir o resolvedor.
 */
export const RESOLVEDORES_NAO_COBERTOS: readonly ResolvedorNaoCoberto[] = [
  {
    arquivo: "lib/automation/template.ts",
    dialeto: "`renderTemplate` — o mais completo; inclui os campos do funil e variáveis próprias.",
    motivo: "Fatia seguinte: paridade contra ele muda o superset do catálogo, não a forma dele.",
  },
  {
    arquivo: "lib/automation/texto-do-followup.ts",
    dialeto: "Reaproveita `renderTemplate` — herda o vocabulário da automação, sem lista própria.",
    motivo: "Coberto de tabela quando `renderTemplate` entrar; hoje não é conferido caso a caso.",
  },
  {
    arquivo: "lib/channels/meta/variaveis-do-fluxo.ts",
    dialeto: "Outro dialeto: `{{1}}`, `{{2}}` — posição, não nome. Continua funcionando como está.",
    motivo:
      "Dialeto de modelo aprovado pela Meta; não é o mesmo vocabulário e não entra no catálogo.",
  },
  {
    arquivo: "lib/propostas/documento/variaveis.ts",
    dialeto: "Vocabulário próprio do documento de proposta.",
    motivo: "Fatia seguinte: precisa ser lido antes de afirmar paridade.",
  },
];
