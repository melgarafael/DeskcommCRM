/**
 * O RESOLVEDOR ÚNICO DE `{{variável}}` — uma conta, quatro telas.
 *
 * ═══ O defeito que este arquivo fecha (#3687) ═══════════════════════════════
 *
 * Antes desta fatia cada tela tinha a SUA conta. A frase `"{{saudacao}},
 * {{primeiro_nome}}!"`, o mesmo contato e o mesmo instante saíam assim:
 *
 *   resposta rápida (Inbox)  → "{{saudacao}}, Ana!"   (token literal no cliente)
 *   automação                → ", Ana!"               (saudação virou vazio)
 *   follow-up, texto         → ", Ana!"               (idem)
 *   campanha                 → "Boa tarde, Ana!"
 *
 * O vocabulário continua sendo o `lib/variaveis/catalogo.ts` (uma lista) e o
 * que cada fonte sabe resolve-se por `disponivelEm` — a política de cada tela é
 * um PARÂMETRO (`quandoVazio`), não uma reimplementação. Nada aqui lê banco nem
 * decide o que a tela oferece.
 *
 * ═══ As quatro políticas (todas declaradas e testadas) ══════════════════════
 *
 *   `vazio`    devolve string vazia .............. automação (`renderTemplate`)
 *   `remover`  tira o token e o espaço vizinho .... follow-up de texto
 *   `literal`  deixa `{{x}}` no texto ............. resposta rápida (Inbox)
 *   `pular`    deixa `{{x}}` e marca a pessoa ..... campanha
 *
 * Variável DESCONHECIDA nunca vira string vazia silenciosa por acidente: ela é
 * contada em `desconhecidas` e a política decide o que aparece. Variável
 * conhecida sem valor é contada em `vazias` — exceto quando quem escreveu deu
 * uma reserva (`{{primeiro_nome|"aluno"}}`), que é a resposta explícita.
 *
 * ═══ O `{{saudacao}}` e o instante do envio ═════════════════════════════════
 *
 * Saudação é do RELÓGIO, não do cadastro: só resolve quando quem chama informa
 * `agora` (instante + fuso do canal). Sem instante — a prévia da campanha, o
 * editor de automação — o token fica LITERAL nas quatro telas, e não "vazio":
 * cravar uma saudação na prévia ensinaria o operador a esperar aquela. `agora`
 * também pode chegar pronto no contexto (`contexto.saudacao`), para quem já o
 * calculou ao montar o dado.
 *
 * ═══ O que NÃO muda (e por que cada um é preservado) ════════════════════════
 *
 * 1. O mapa POSICIONAL do modelo da Meta (`contact_name`, `contact_first_name`,
 *    `lead_custom`) continua valendo: ele não passa por aqui — quem o resolve é
 *    `lib/channels/meta/variaveis-do-fluxo.ts`, e a origem nova que este
 *    resolvedor atende (`{ kind: "variavel", chave }`) é ADITIVA.
 * 2. Cada fonte continua lendo o dado do seu jeito, porque é isso que está
 *    gravado: `{{lead.gancho}}` é COLUNA na automação e campo personalizado na
 *    campanha (`SENTIDOS_DIVERGENTES`, no catálogo). Unificar a leitura mudaria
 *    texto já gravado — o que esta fatia NÃO faz.
 * 3. Valor com `{{` no meio não reabre expressão: `String.replace` não rescan
 *    o que inseriu, e a campanha — que renderiza duas vezes — pede
 *    `blindarValores` para a segunda passada.
 *
 * ═══ O BLOCO CONDICIONAL `{{#campo}}...{{/campo}}` (#4339) ══════════════════
 *
 * A linha que só existe quando o campo existe. Sem isto, quem escreve a
 * mensagem tem duas saídas ruins: omitir o dado (e o cliente recebe "Apólice:"
 * sem nada) ou criar uma regra por combinação de campos preenchidos. O bloco
 * resolve os dois: o que está entre `{{#campo}}` e `{{/campo}}` sai quando o
 * campo TEM valor e sai VAZIO quando não tem.
 *
 * ─── A LINHA INTEIRA SOME, e é o que a issue pede ──────────────────────────
 *
 * Bloco que resolve vazio e é o conteúdo da linha leva a linha junto (e o `\n`
 * dela), então o cliente não recebe linha em branco nem rótulo órfão. O bloco
 * tem de envolver a LINHA inteira:
 *
 *   `{{#seguro_apolice}}🔢 Apólice: {{seguro_apolice}}{{/seguro_apolice}}`
 *
 * Bloco no meio de uma linha com texto em volta só perde o miolo — a linha fica,
 * e isso é declarado, não acidente.
 *
 * ─── Quem decide se o bloco fica é a POLÍTICA da tela ──────────────────────
 *
 * A condição é "a variável produziu texto?". Com valor, o bloco fica. Sem valor,
 * quem responde é a política que a tela já usa: `vazio` (automação) e `remover`
 * (follow-up) apagam o bloco; `literal` (Inbox) e `pular` (campanha) MANTÊM,
 * porque nessas telas a variável sem valor continua aparecendo como token — e
 * esconder a linha no rascunho esconderia do operador justamente o que ele
 * precisa ver. Saudação pendente (sem instante do envio) também mantém.
 *
 * Não há aninhamento: o fechamento é o primeiro `{{/nome}}` do MESMO nome, e o
 * miolo é resolvido pela passada normal, uma vez. Bloco sem fechamento é texto
 * solto, como todo token que o render não conhece.
 */
import { valorComRotulo } from "@/lib/automation/campos-do-render";
import { COLUNAS_DE_CPF_DO_CONTATO, resolveField } from "@/lib/automation/conditions";
import { opcoesDoRender } from "@/lib/automation/opcoes-do-render";
import { horaNoFuso } from "@/lib/campanhas/relogio";
import { nomeDoContato, type ContatoNomeavel } from "@/lib/contacts/rotulo-do-contato";
import { formatarValorComModificadorDeData } from "@/lib/i18n/data-na-mensagem";
import { MODIFICADOR_DA_VARIAVEL } from "@/lib/texto/modificador-da-variavel";
import { RESERVA_DA_VARIAVEL } from "@/lib/texto/reserva-da-variavel";

import { variavelDoCatalogo, type Resolvedor } from "./catalogo";

/**
 * A marcação `{{caminho}}`, `{{caminho|"reserva"}}` ou `{{caminho|data}}`: grupo
 * 1 = caminho, grupo 2 = reserva, grupo 3 = modificador (cada um ausente quando
 * não há). A MESMA forma em todas as telas — era o primeiro lugar onde elas
 * divergiam (o Inbox não casava ponto nem número). A ordem dos grupos é
 * contrato: quem já lia 1 e 2 continua lendo os mesmos dois.
 */
export const MARCACAO_DE_VARIAVEL = new RegExp(
  String.raw`\{\{\s*([\w.]+)\s*${RESERVA_DA_VARIAVEL}${MODIFICADOR_DA_VARIAVEL}\}\}`,
  "g",
);

/**
 * Os caminhos marcados no texto, na ordem em que aparecem, sem resolver nada.
 *
 * Existe para quem precisa PERGUNTAR "esta frase usa `{{nome}}`?" sem trocar
 * valor nenhum (a trava de envio do Inbox, #2744). Antes cada tela montava o seu
 * `new RegExp` para isso — e a marcação só pode ser lida por um lugar.
 */
export function marcacoesNoTexto(texto: string): string[] {
  return [...texto.matchAll(MARCACAO_DE_VARIAVEL)].map((m) => (m[1] ?? "").toLowerCase());
}

/** O que fazer com a variável CONHECIDA que ficou sem valor. */
export type QuandoVazio = "vazio" | "literal" | "remover" | "pular";

/** O instante do envio, no fuso do canal — nunca o do servidor. */
export interface InstanteDoEnvio {
  instante: Date;
  fuso: string;
}

export interface OpcoesDaResolucao {
  /** De onde a frase sai: decide o vocabulário pelo `disponivelEm` do catálogo. */
  fonte: Resolvedor;
  /** Política para a variável conhecida sem valor. Padrão: `literal`. */
  quandoVazio?: QuandoVazio;
  /** Instante do envio — sem ele `{{saudacao}}` fica literal. */
  agora?: InstanteDoEnvio;
  /** Recebe cada VALOR já resolvido (quem renderiza HTML escapa). A reserva não passa aqui. */
  formatarValor?: (valor: string) => string;
  /**
   * Marca `{` de cada valor para a segunda passada não reler o dado como token
   * (campanha: o corpo é renderizado na preparação E no envio).
   */
  blindarValores?: boolean;
  /** Desfaz a blindagem no texto final (o envio da campanha). */
  desblindarValores?: boolean;
}

export interface ResultadoDaResolucao {
  texto: string;
  /** Variáveis conhecidas que ficaram sem valor (e sem reserva). */
  vazias: string[];
  /** Tokens que a fonte não resolve — ficam literais (ou vazios, pela política). */
  desconhecidas: string[];
  /** `true` quando a política é `pular` e há ao menos uma vazia: a pessoa sai da lista. */
  pular: boolean;
}

/** O valor que a fonte lê para um nome — `null` quando não há valor utilizável. */
interface Leitura {
  valor: string | null;
  /** A fonte tem regra para este nome (catálogo), mesmo sem valor. */
  conhecida: boolean;
  /** Sem valor AGORA, mas por falta de instante — a política não se aplica. */
  pendente?: boolean;
  /** Campo bloqueado de propósito: sai vazio SEMPRE, nem reserva o preenche. */
  bloqueada?: boolean;
}

/**
 * O contexto canônico. Cada adaptador preenche o que tem; o que não veio é
 * ausência declarada, nunca texto inventado.
 */
export interface ContextoDeVariaveis extends Record<string, unknown> {
  /** Nome de gente já resolvido (`nomeDoContato`). */
  nome?: string | null;
  /** Atalho de telefone/e-mail de quem não tem a linha do contato (campanha). */
  telefone?: string | null;
  email?: string | null;
  /** Saudação já calculada por quem montou o dado. */
  saudacao?: string | null;
  /** Linha de `contacts` (automação). */
  contact?: ContatoNomeavel | null;
  /** Linha de `crm_leads` (automação): colunas + `custom_fields`. */
  lead?: Record<string, unknown> | null;
  /** Campos personalizados do NEGÓCIO (campanha, fluxo). */
  camposDoNegocio?: Record<string, unknown> | null;
  /** Campos personalizados do CONTATO (campanha). */
  camposDoContato?: Record<string, unknown> | null;
}

/** Aliases do produto: o nome curto e a coluna que ele lê. */
const ALIASES: Readonly<Record<string, string>> = {
  nome: "contact.name",
  primeiro_nome: "contact.name",
  telefone: "contact.phone_number",
  email: "contact.email",
};

/**
 * Campos do contato que SÓ A EQUIPE vê e que nenhuma mensagem renderiza, nem
 * pedidos pelo caminho (`{{contact.address_book_name}}`) — decisão do
 * mantenedor no PR #2439. A guarda mora aqui porque todo texto passa por aqui.
 */
const SO_DA_EQUIPE: ReadonlySet<string> = new Set([
  "contact.address_book_name",
  // Colunas de CPF: mensagem nenhuma tem por que levá-las (main, #— CPF só no servidor).
  ...COLUNAS_DE_CPF_DO_CONTATO,
]);

/** Propriedades do protótipo nunca são campo: um jsonb malformado não abre caminho. */
const CHAVES_DE_PROTOTIPO: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Marca invisível (word joiner) depois de `{` — a segunda passada não a lê como token. */
export const CHAVE_BLINDADA = "{\u2060";

/**
 * ABERTURA de bloco condicional: `{{#campo}}` (#4339). Sem grupo de reserva e
 * sem modificador de propósito — o bloco PERGUNTA se o campo tem valor; quem
 * imprime o valor é a marcação de dentro, com os modificadores dela.
 */
export const ABERTURA_DE_BLOCO = /\{\{#\s*([\w.]+)\s*\}\}/;

/**
 * O que fica no texto quando um bloco é apagado. Existe porque a linha inteira
 * (`\n` inclusive) some junto, e para saber se o bloco era o conteúdo da linha
 * é preciso uma marca que sobreviva à passada das marcações — o texto entre ele
 * e as bordas da linha ainda não foi resolvido nesse ponto. Caractere de
 * controle NUL: não é digitável no editor de mensagem, então não colide com
 * nada que o operador escreva.
 */
const BLOCO_REMOVIDO = "\u0000";

/** "Bom dia" / "Boa tarde" / "Boa noite" — no fuso do canal, nunca no do servidor. */
export function saudacaoDaHora(agora: Date, fuso: string): string {
  const hora = horaNoFuso(agora, fuso);
  if (hora < 12) return "Bom dia";
  if (hora < 18) return "Boa tarde";
  return "Boa noite";
}

/**
 * A RESOLUÇÃO: troca cada marcação pelo valor que a fonte conhece, aplicando a
 * política pedida e devolvendo o que faltou. Função pura.
 */
export function resolverVariaveis(
  texto: string,
  contexto: ContextoDeVariaveis,
  opcoes: OpcoesDaResolucao,
): ResultadoDaResolucao {
  const quandoVazio = opcoes.quandoVazio ?? "literal";
  const vazias = new Set<string>();
  const desconhecidas = new Set<string>();
  let saida = "";
  let cursor = 0;
  let removeu = false;

  // Os blocos são decididos ANTES das marcações: um bloco apagado não deve nem
  // contar as variáveis do miolo (a linha não existe), e um bloco mantido
  // devolve o miolo para a passada normal resolver uma vez só (#4339).
  const corpo = resolverBlocos(texto, contexto, opcoes);

  for (const marca of corpo.matchAll(MARCACAO_DE_VARIAVEL)) {
    const inicio = marca.index ?? cursor;
    saida += corpo.slice(cursor, inicio);
    cursor = inicio + marca[0].length;

    const bruto = marca[1] ?? "";
    const reserva = marca[2];
    const modificador = marca[3];
    const leitura = ler(bruto, contexto, opcoes);

    if (leitura.pendente) {
      // Sem instante do envio: o token fica como o operador escreveu, nas
      // quatro telas. Não é "falta" — a política não opina sobre ele.
      saida += marca[0];
      continue;
    }

    if (leitura.valor !== null) {
      saida += prepararValor(comModificador(leitura.valor, modificador, contexto), opcoes);
      continue;
    }

    // Sem valor. A reserva de quem escreveu é a resposta EXPLÍCITA — vale nas
    // variáveis que a fonte conhece e, na automação/follow-up (que sempre
    // aceitaram reserva em token desconhecido), também nas demais. No Inbox e
    // na campanha a desconhecida não ganha reserva: continua literal.
    //
    // Campo bloqueado (o que a equipe vê e o cliente não, PR #2439) não é
    // variável vazia: ele não vaza NEM quando alguém escreve reserva.
    const reservaVale =
      !leitura.bloqueada &&
      (leitura.conhecida || quandoVazio === "vazio" || quandoVazio === "remover");
    if (reserva !== undefined && reservaVale) {
      saida += reserva;
      continue;
    }

    const chave = bruto.toLowerCase();
    if (!leitura.conhecida) desconhecidas.add(bruto);
    else vazias.add(chave);

    switch (quandoVazio) {
      case "vazio":
        // automação: string vazia, como sempre foi
        break;
      case "remover":
        // follow-up: some a marcação e o espaço que ficaria órfão à esquerda
        saida = saida.replace(/\s+$/, "");
        removeu = true;
        break;
      case "literal":
      case "pular":
        saida += marca[0];
        break;
    }
  }

  saida += corpo.slice(cursor);
  // Sem valor no INÍCIO da frase ("{{nome}} chegou"), o espaço do segundo
  // pedaço também não pode sobrar — " chegou" não é frase.
  if (removeu) saida = saida.replace(/^\s+/, "");
  if (saida.includes(BLOCO_REMOVIDO)) saida = textoSemLinhaDoBlocoRemovido(saida);
  if (opcoes.desblindarValores) saida = saida.replaceAll(CHAVE_BLINDADA, "{");

  return {
    texto: saida,
    vazias: [...vazias],
    desconhecidas: [...desconhecidas],
    pular: quandoVazio === "pular" && vazias.size > 0,
  };
}

function prepararValor(valor: string, opcoes: OpcoesDaResolucao): string {
  const formatado = opcoes.formatarValor ? opcoes.formatarValor(valor) : valor;
  return opcoes.blindarValores ? formatado.replaceAll("{", CHAVE_BLINDADA) : formatado;
}

/**
 * Troca cada bloco `{{#campo}}...{{/campo}}` pelo MIOLO (campo com valor) ou pela
 * marca de bloco apagado (#4339). O miolo resolvido sai daqui CRU: quem resolve
 * as marcações dele é a passada normal, uma vez, com as contagens de sempre.
 */
function resolverBlocos(
  texto: string,
  contexto: ContextoDeVariaveis,
  opcoes: OpcoesDaResolucao,
): string {
  let saida = texto;
  // Um laço por bloco: o primeiro que aparece é o mais externo, e o miolo dele
  // (que pode trazer outros blocos) volta para a próxima volta.
  for (let voltas = 0; voltas < 50; voltas += 1) {
    const abre = ABERTURA_DE_BLOCO.exec(saida);
    if (!abre || abre.index === undefined) return saida;
    const nome = abre[1] ?? "";
    if (nome === "") return saida;
    const depoisDaAbertura = abre.index + abre[0].length;
    const fecha = new RegExp(String.raw`\{\{\/\s*${nome}\s*\}\}`).exec(
      saida.slice(depoisDaAbertura),
    );
    // Sem fechamento, `{{#campo}}` é texto solto — o destino de todo token que
    // o render não conhece. Não se apaga conteúdo de quem errou a sintaxe.
    if (!fecha || fecha.index === undefined) return saida;
    const miolo = saida.slice(depoisDaAbertura, depoisDaAbertura + fecha.index);
    const depoisDoFechamento = depoisDaAbertura + fecha.index + fecha[0].length;
    saida =
      saida.slice(0, abre.index) +
      (blocoFica(nome, contexto, opcoes) ? miolo : BLOCO_REMOVIDO) +
      saida.slice(depoisDoFechamento);
  }
  return saida;
}

/**
 * O bloco fica? "A variável produziu texto?" — e, sem valor, quem responde é a
 * política da tela: `vazio`/`remover` apagam o bloco; `literal`/`pular` mantêm,
 * porque nelas a variável sem valor continua visível como token e esconder a
 * linha esconderia do operador o que ele precisa ver.
 */
function blocoFica(
  nome: string,
  contexto: ContextoDeVariaveis,
  opcoes: OpcoesDaResolucao,
): boolean {
  const leitura = ler(nome, contexto, opcoes);
  if (leitura.pendente || leitura.valor !== null) return true;
  const politica = opcoes.quandoVazio ?? "literal";
  return politica === "literal" || politica === "pular";
}

/**
 * Apaga as LINHAS que ficaram só com a marca de bloco removido — é isto que faz
 * a linha do rótulo sumir em vez de virar buraco na mensagem (#4339). Bloco no
 * meio de uma linha com texto em volta só perde a marca: a linha fica, como o
 * cabeçalho do resolvedor declara.
 */
function textoSemLinhaDoBlocoRemovido(texto: string): string {
  const linhas = texto.split(/\r?\n/);
  const mantidas: string[] = [];
  for (const linha of linhas) {
    if (linha.includes(BLOCO_REMOVIDO) && linha.replaceAll(BLOCO_REMOVIDO, "").trim() === "") {
      continue;
    }
    mantidas.push(linha.replaceAll(BLOCO_REMOVIDO, ""));
  }
  return mantidas.join("\n");
}

/**
 * O valor com o MODIFICADOR da marcação aplicado — `{{campo|data}}` e
 * `{{campo|data:dd/mm/aaaa}}` (#4339) — ou intacto quando não há modificador.
 *
 * O idioma e o fuso vêm do contexto (`__render`), porque quem os conhece é quem
 * monta o dado; sem eles vale o padrão do produto. Modificador que o produto não
 * conhece nunca chega aqui: a marcação não casa, e o token sai cru como antes.
 * A transformação é ANTES de `formatarValor`, para que quem escapa HTML escape o
 * texto final e não uma data que seria reformatada depois.
 */
function comModificador(
  valor: string,
  modificador: string | undefined,
  contexto: ContextoDeVariaveis,
): string {
  if (modificador === undefined) return valor;
  return formatarValorComModificadorDeData(valor, modificador, opcoesDoRender(contexto));
}

/**
 * O valor de UM nome para UMA fonte.
 *
 * A leitura de caminho é a de sempre, por fonte — `SENTIDOS_DIVERGENTES` no
 * catálogo explica por que `{{lead.gancho}}` não pode significar a mesma coisa
 * nas duas: na automação é coluna do card, na campanha é campo personalizado.
 */
function ler(bruto: string, contexto: ContextoDeVariaveis, opcoes: OpcoesDaResolucao): Leitura {
  const nome = bruto.toLowerCase();
  const entrada = variavelDoCatalogo(nome);
  const conhecida = entrada?.disponivelEm.includes(opcoes.fonte) ?? false;

  if (!conhecida) {
    if (opcoes.fonte !== "automacao") return { valor: null, conhecida: false };
    // A automação resolve QUALQUER chave que quem montou o contexto pôs nele —
    // é assim que `{{resumo}}` (do e-mail, `send-email.ts`) e
    // `{{appointment.starts_at}}` funcionam sem catálogo. Depois, o atalho de
    // campo personalizado do negócio (`{{servico}}`), que é vocabulário ABERTO:
    // a chave nasce no funil, em runtime.
    const doContexto = textoDeValor(resolveField(contexto, nome));
    if (doContexto !== null) return { valor: doContexto, conhecida: false };
    return { valor: atalhoDeCampoDoNegocio(contexto, nome), conhecida: false };
  }

  switch (nome) {
    case "nome":
      return { valor: nomeCompleto(contexto), conhecida };
    case "primeiro_nome": {
      const primeiro = primeiroNome(nomeCompleto(contexto));
      return { valor: primeiro, conhecida };
    }
    case "saudacao": {
      if (opcoes.agora) {
        return { valor: saudacaoDaHora(opcoes.agora.instante, opcoes.agora.fuso), conhecida };
      }
      const pronto = textoNaoVazio(contexto.saudacao);
      return pronto !== null ? { valor: pronto, conhecida } : { valor: null, conhecida, pendente: true };
    }
    case "telefone":
      return {
        valor:
          textoNaoVazio(resolveField(contexto, "contact.phone_number")) ??
          textoNaoVazio(contexto.telefone),
        conhecida,
      };
    case "email":
      return {
        valor:
          textoNaoVazio(resolveField(contexto, "contact.email")) ?? textoNaoVazio(contexto.email),
        conhecida,
      };
    default:
      return lerCaminho(nome, contexto, opcoes.fonte, conhecida);
  }
}

/** `lead.*`, `contato.*` e `contact.*` — cada raiz no dialeto da fonte. */
function lerCaminho(
  nome: string,
  contexto: ContextoDeVariaveis,
  fonte: Resolvedor,
  conhecida: boolean,
): Leitura {
  if (SO_DA_EQUIPE.has(nome)) return { valor: null, conhecida, bloqueada: true };

  const raiz = nome.slice(0, nome.indexOf("."));
  if (raiz === "lead") {
    if (fonte === "automacao") {
      const valor = resolveField(contexto, nome);
      // Campo de LISTA guarda o CÓDIGO da opção (`paris-franca`) e o cliente lê
      // o rótulo (#3605) — só quando o funil declarou as opções.
      const chave = chaveDoCampoPersonalizado(nome);
      const legivel = chave === null ? valor : valorComRotulo(contexto, chave, valor);
      return { valor: textoDeValor(legivel), conhecida };
    }
    return { valor: lerMapa(contexto.camposDoNegocio ?? contexto.lead, nome), conhecida };
  }
  if (raiz === "contato") {
    return { valor: lerMapa(contexto.camposDoContato, nome), conhecida };
  }
  // contact.*
  const valor = resolveField(contexto, nome);
  const chave = chaveDoCampoPersonalizado(nome);
  const legivel = chave === null ? valor : valorComRotulo(contexto, chave, valor);
  return { valor: textoDeValor(legivel), conhecida };
}

/** `lead.custom_fields.x` e `lead.x` são o MESMO campo em quem lê mapa. */
function nomeDoCampoNoMapa(caminho: string): string {
  const depois = caminho.slice(caminho.indexOf(".") + 1);
  return /^custom_fields\./i.test(depois) ? depois.slice("custom_fields.".length) : depois;
}

/**
 * O campo personalizado de um mapa jsonb — propriedade PRÓPRIA, nunca
 * protótipo. Lista sai separada por vírgula (como a pessoa leria); objeto,
 * ausente e vazio são FALTA, não texto pela metade.
 */
function lerMapa(
  mapa: Record<string, unknown> | null | undefined,
  caminho: string,
): string | null {
  if (!mapa || typeof mapa !== "object") return null;
  const campo = nomeDoCampoNoMapa(caminho);
  if (campo === "" || CHAVES_DE_PROTOTIPO.has(campo)) return null;
  const chave = Object.hasOwn(mapa, campo)
    ? campo
    : Object.hasOwn(mapa, campo.toLowerCase())
      ? campo.toLowerCase()
      : null;
  if (chave === null) return null;
  const texto = textoDeCampo(mapa[chave]);
  return texto.trim() === "" ? null : texto;
}

function textoDeCampo(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  if (Array.isArray(valor)) {
    return valor
      .filter((v) => v !== null && v !== undefined && typeof v !== "object")
      .map((v) => String(v))
      .join(", ");
  }
  if (typeof valor === "object") return "";
  return String(valor);
}

/** Automação: `String(valor ?? "")`, como o `renderTemplate` sempre fez. */
function textoDeValor(valor: unknown): string | null {
  if (valor === undefined || valor === null) return null;
  const texto = String(valor);
  return texto.trim() === "" ? null : texto;
}

function nomeCompleto(contexto: ContextoDeVariaveis): string | null {
  return nomeDoContato(contexto.contact) ?? textoNaoVazio(contexto.nome);
}

function primeiroNome(nome: string | null): string | null {
  if (nome === null) return null;
  const primeiro = nome.trim().split(/\s+/)[0] ?? "";
  return primeiro === "" ? null : primeiro;
}

function textoNaoVazio(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  return texto === "" ? null : texto;
}

/**
 * `{{servico}}` como atalho de `{{lead.custom_fields.servico}}`, só na
 * automação e só para nome SIMPLES: alias e caminho direto ganham primeiro, e
 * alias de CRM nunca é atendido por campo homônimo (o nome da pessoa não vira
 * o rótulo de um pacote).
 */
function atalhoDeCampoDoNegocio(
  contexto: ContextoDeVariaveis,
  nome: string,
): string | null {
  if (nome.includes(".") || ALIASES[nome] !== undefined) return null;
  const campos = (contexto.lead as { custom_fields?: unknown } | null | undefined)?.custom_fields;
  if (!campos || typeof campos !== "object" || Array.isArray(campos)) return null;
  if (!Object.hasOwn(campos, nome)) return null;
  const valor = (campos as Record<string, unknown>)[nome];
  return textoDeValor(valorComRotulo(contexto, nome, valor));
}

/**
 * A chave do campo personalizado que um caminho pede — `null` quando o caminho
 * não fala de campo personalizado. Três formas contam: atalho, `lead.custom_fields.x`
 * e `contact.custom_fields.x`; alias de CRM nunca conta.
 */
export function chaveDoCampoPersonalizado(caminho: string): string | null {
  if (!caminho.includes(".")) return ALIASES[caminho] === undefined ? caminho : null;
  const [raiz, meio, chave] = caminho.split(".");
  if (!chave || meio !== "custom_fields") return null;
  return raiz === "lead" || raiz === "contact" ? chave : null;
}
