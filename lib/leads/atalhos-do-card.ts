/**
 * OS ATALHOS DO CARD (issue #3487) — botões que levam o atendente a OUTRO
 * sistema com o dado do cliente já preenchido: `tel:` para o softphone do PABX,
 * `https://…?cliente={{erp_id}}` para o app de pedidos.
 *
 * ─── Por que a régua mora AQUI, e não na tela ───────────────────────────────
 *
 * O modelo de link é digitado por uma PESSOA e renderizado para OUTRAS. O valor
 * vira `<a href>`, e `javascript:`/`data:` num href é execução de código a um
 * clique de distância. A defesa tem de existir nos dois extremos:
 *
 *   1. na GRAVAÇÃO — `pipelineConfigPatchSchema` recusa o atalho e a linha do
 *      funil nunca é tocada (`app/actions/settings/updatePipelineConfig.ts`);
 *   2. na RENDERIZAÇÃO — `atalhosParaExibir` revalida o que veio do banco.
 *
 * A segunda não é redundância decorativa: o `settings` é jsonb, escrito também
 * por script, seed, service role e importação de backup. Um valor gravado por
 * fora do formulário passaria pela primeira porta sem nunca tocá-la. É a mesma
 * doutrina de `lib/leads/links-de-contato.ts`, que já a aplica ao link do
 * contato — e é de propósito que as duas réguas digam a MESMA coisa.
 *
 * ─── Por que só `tel:`, `http:` e `https:` ─────────────────────────────────
 *
 * `tel:` é o caso que a issue pede (softphone do PABX disca por ele) e não
 * navega; `http:`/`https:` abrem em aba nova. `mailto:`/`sms:` ficaram de fora
 * desta fatia: nenhum dos dois casos reais da issue os usa, e cada esquema a
 * mais é superfície a mais para revisar. Quem precisar deles acrescenta AQUI —
 * a lista é uma só, lida pela gravação e pela renderização.
 */

/** Os esquemas aceitos, em minúsculas e COM os dois-pontos. */
export const ESQUEMAS_DE_ATALHO = ["tel:", "https:", "http:"] as const;
export type EsquemaDeAtalho = (typeof ESQUEMAS_DE_ATALHO)[number];

/**
 * Os ícones que o cadastro oferece — lista FIXA do design system, na mesma
 * ideia de `TIPOS_DE_LINK`: o operador escolhe de uma lista, não digita nome de
 * ícone. O mapa ícone→componente mora na tela (`components/kanban/AtalhosDoCard`),
 * porque importar React aqui tornaria este módulo intestável em `node`.
 */
export const ICONES_DE_ATALHO = [
  "telefone",
  "carrinho",
  "link",
  "boleto",
  "documento",
  "mapa",
  "email",
  "site",
] as const;
export type IconeDeAtalho = (typeof ICONES_DE_ATALHO)[number];

/**
 * Seis é o teto do que cabe numa faixa ao lado do negócio sem virar menu. Acima
 * disso o "atalho" deixa de ser atalho: quem tem vinte links precisa de uma
 * tela de links, não de uma fileira de botões no card.
 */
export const MAX_ATALHOS = 6;

export const TAMANHO_MAXIMO_DO_ROTULO = 40;
/** Folgado de propósito: URL de pedido com parâmetros passa de 300 sem esforço. */
export const TAMANHO_MAXIMO_DO_MODELO = 2000;

/**
 * Abaixo disto não é telefone, é fragmento: `tel:+1` abriria o softphone para
 * discar um dígito. O piso é 8 (o menor número nacional que o produto atende);
 * DDD + número no Brasil dá 10 ou 11.
 */
const MINIMO_DE_DIGITOS_NO_TELEFONE = 8;

/** Um atalho COMO ESTÁ no `settings` do funil (sem validação aplicada). */
export interface AtalhoDoCard {
  rotulo: string;
  icone: IconeDeAtalho;
  url: string;
}

/** Um atalho já validado e com o href montado — o que a tela desenha. */
export interface AtalhoExibivel {
  rotulo: string;
  icone: IconeDeAtalho;
  href: string;
  /** `true` para `http(s):` — abre em aba nova, com `noopener noreferrer`. */
  externo: boolean;
}

/**
 * Os dados do negócio e do contato que os marcadores resolvem.
 *
 * Tudo opcional: `undefined`, `null` e string vazia dizem a mesma coisa aqui —
 * "não tem" —, e é essa resposta que faz o botão NÃO aparecer.
 */
export interface DadosDoAtalho {
  telefone?: string | null;
  nome?: string | null;
  email?: string | null;
  documento?: string | null;
  lead?: { id?: string | null; campos?: Record<string, unknown> | null } | null;
  contato?: { id?: string | null; campos?: Record<string, unknown> | null } | null;
}

/**
 * Chaves de campo personalizado que respondem por `{{documento}}`, na ordem.
 *
 * O contato guarda CPF só como hash (`cpf_hash`), então o documento em claro —
 * quando existe — está em `custom_fields`. Ler as três grafias que as
 * organizações realmente usam evita a saída covarde de exigir que renomeiem o
 * campo para o botão funcionar.
 */
const CHAVES_DE_DOCUMENTO = ["documento", "cpf", "cnpj"] as const;

/** Controle (C0 e DEL): o que um navegador pode engolir dentro de um esquema. */
const CONTROLE = /[\u0000-\u001f\u007f]/;

function texto(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : "";
}

/**
 * O esquema declarado no começo do texto, em minúsculas, ou `null`.
 *
 * Não usa `new URL` de propósito: `new URL("tel:119...")` funciona, mas
 * `new URL` de um modelo com marcador (`https://x/?c={{id}}`) também — e ele
 * normalizaria a string ANTES da interpolação, que é justamente a etapa que
 * precisa ficar literal. O que se lê aqui é o prefixo, nada mais.
 */
export function esquemaDoModelo(bruto: string | null | undefined): string | null {
  const achado = /^([a-z][a-z0-9+.-]*):/i.exec(texto(bruto));
  const esquema = achado?.[1];
  return esquema ? `${esquema.toLowerCase()}:` : null;
}

/**
 * `true` se o endereço `http(s)` tem marcador na AUTORIDADE (host, porta,
 * usuário) — tudo entre as barras iniciais e o primeiro `/`, `?`, `#` ou `\\`.
 *
 * As barras iniciais são TODAS as `/` e `\\` depois do esquema, não só as duas
 * primeiras: é assim que o parser do navegador lê `http(s)` (`https:///x` abre o
 * host `x`). Recortar só `//` deixaria a autoridade vazia aos olhos da régua e
 * cheia aos olhos do navegador.
 *
 * `encodeURIComponent` não codifica `.`, então um marcador ali deixaria o valor
 * de um campo escolher o domínio para onde o botão leva. O domínio é decisão de
 * quem configura o funil; o dado do cliente só entra depois dele.
 */
function marcadorNoDominio(cauda: string): boolean {
  const autoridade = cauda.replace(/^[/\\]+/, "").split(/[/?#\\]/, 1)[0] ?? "";
  return autoridade.includes("{{");
}

const MARCADOR = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/**
 * O modelo de link passa na régua? (gravação E renderização usam ESTA função.)
 *
 * As recusas, cada uma por um motivo concreto:
 *  - esquema fora da lista → `javascript:`, `data:`, `file:`, `vbscript:`;
 *  - caractere de controle em qualquer posição → `java\nscript:` é executado
 *    por navegador que ignora o espaço em branco dentro do esquema, e a
 *    comparação de prefixo sozinha não pegaria;
 *  - nada depois do esquema → `tel:` sozinho não leva a lugar nenhum;
 *  - `http(s)` sem `//` → `https:javascript:…` é URL válida para o parser e
 *    seria um host esquisito; exigir `//` fecha a forma.
 *
 * O que esta função NÃO faz: resolver marcador. `{{erp_id}}` é texto legítimo
 * AQUI — quem decide se ele tem valor é `montarHref`, no clique.
 */
export function modeloAceito(bruto: string | null | undefined): boolean {
  const modelo = texto(bruto);
  if (!modelo || modelo.length > TAMANHO_MAXIMO_DO_MODELO) return false;
  if (CONTROLE.test(modelo)) return false;

  const esquema = esquemaDoModelo(modelo);
  if (!esquema || !(ESQUEMAS_DE_ATALHO as readonly string[]).includes(esquema)) return false;

  const cauda = modelo.slice(esquema.length);
  if (cauda.trim() === "") return false;
  if (esquema === "http:" || esquema === "https:") {
    if (!cauda.startsWith("//")) return false;
    if (marcadorNoDominio(cauda)) return false;
  }

  return true;
}

/**
 * O CÓDIGO da recusa, não a frase. `null` = passa.
 *
 * A frase é da TELA, e não deste módulo, por dois motivos práticos: a chave de
 * tradução tem de ser literal no arquivo da tela (o guarda de espanhol varre o
 * AST das telas e reprova prosa portuguesa fora de `t()`), e a razão em texto
 * solto aqui obrigaria quem traduz a mexer em domínio. Código é contrato; frase
 * é interface.
 */
export type RecusaDoModelo =
  | "vazio"
  | "longo"
  | "invisivel"
  | "sem_esquema"
  | "esquema_proibido"
  | "sem_destino"
  | "sem_barras"
  | "marcador_no_dominio";

export function motivoDaRecusaDoModelo(
  bruto: string | null | undefined,
): RecusaDoModelo | null {
  const modelo = texto(bruto);
  if (!modelo) return "vazio";
  if (modelo.length > TAMANHO_MAXIMO_DO_MODELO) return "longo";
  if (CONTROLE.test(modelo)) return "invisivel";
  const esquema = esquemaDoModelo(modelo);
  if (!esquema) return "sem_esquema";
  if (!(ESQUEMAS_DE_ATALHO as readonly string[]).includes(esquema)) return "esquema_proibido";
  const cauda = modelo.slice(esquema.length);
  if (cauda.trim() === "") return "sem_destino";
  if (esquema === "http:" || esquema === "https:") {
    if (!cauda.startsWith("//")) return "sem_barras";
    if (marcadorNoDominio(cauda)) return "marcador_no_dominio";
  }
  return null;
}

/**
 * Os marcadores escritos no modelo, na ordem em que aparecem, em minúsculas.
 *
 * Serve à tela de cadastro (mostrar o que o botão vai pedir) e ao teste que
 * garante que `{{telefone}}` e `{{ telefone }}` são a mesma variável.
 */
export function marcadoresDoModelo(bruto: string | null | undefined): string[] {
  const modelo = texto(bruto);
  const saida: string[] = [];
  for (const achado of modelo.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)) {
    const escrito = achado[1];
    if (!escrito) continue;
    const chave = escrito.toLowerCase();
    if (!saida.includes(chave)) saida.push(chave);
  }
  return saida;
}

/**
 * Telefone → o que pode entrar num `tel:`: `+` e dígitos, nada mais.
 *
 * Espaço, parêntese e hífen quebram o link em alguns softphones (o `+` vira
 * `%2B` ou o número é cortado no primeiro espaço), e é por isso que a
 * normalização acontece ANTES de montar o href — não é cosmética, é o que faz
 * o clique discar. O `+` só sobrevive se estava lá: inventar código de país
 * seria pior que não discar, e a issue deixa "sem código do país" para a 2ª
 * fatia.
 */
export function normalizarTelefoneParaTel(bruto: string | null | undefined): string | null {
  const original = texto(bruto);
  if (!original) return null;
  const digitos = original.replace(/\D/g, "");
  if (digitos.length < MINIMO_DE_DIGITOS_NO_TELEFONE) return null;
  return original.startsWith("+") ? `+${digitos}` : digitos;
}

function campoDe(
  campos: Record<string, unknown> | null | undefined,
  chave: string,
): string | null {
  const valor = campos?.[chave];
  if (typeof valor === "string" && valor.trim()) return valor.trim();
  // Número não é texto, mas "loja 12" existe: `number` e `boolean` viram string
  // só para o valor entrar no link — o que NÃO se faz é transformar objeto
  // (`{ rua, numero }`) em `[object Object]` dentro de uma URL.
  if (typeof valor === "number" || typeof valor === "boolean") return String(valor);
  return null;
}

function documentoDoContato(dados: DadosDoAtalho): string | null {
  const declarado = texto(dados.documento);
  if (declarado) return declarado;
  for (const chave of CHAVES_DE_DOCUMENTO) {
    const achado =
      campoDe(dados.contato?.campos, chave) ??
      campoDe(dados.lead?.campos, chave);
    if (achado) return achado;
  }
  return null;
}

/**
 * O valor de UM marcador, ou `null` quando o dado não existe.
 *
 * `null` é a resposta que importa: é ela que faz o botão sumir em vez de abrir
 * um link com `{{telefone}}` cru ou vazio — o defeito que a issue proíbe.
 *
 * Campo personalizado sem prefixo procura no NEGÓCIO primeiro e no contato
 * depois. A ordem não é arbitrária: o atalho mora no card do negócio, e é o
 * `custom_fields` do negócio que o funil manda preencher (`settings.fields`).
 * Quem quiser o do contato escreve `contact.<campo>` e não depende de sorte.
 */
export function valorDoMarcador(chave: string, dados: DadosDoAtalho): string | null {
  const k = chave.trim().toLowerCase();

  if (k === "telefone") return normalizarTelefoneParaTel(dados.telefone);
  if (k === "nome") return texto(dados.nome) || null;
  if (k === "primeiro_nome") {
    const nome = texto(dados.nome);
    return nome ? (nome.split(/\s+/)[0] ?? null) : null;
  }
  if (k === "email") {
    const email = texto(dados.email);
    // Sem `@` não é e-mail: jogar o lixo na URL só produz um link que falha do
    // lado de lá, e o botão existiria para não funcionar.
    return email.includes("@") ? email : null;
  }
  if (k === "documento") return documentoDoContato(dados);

  if (k === "lead.id") return texto(dados.lead?.id) || null;
  if (k === "contact.id" || k === "contato.id") return texto(dados.contato?.id) || null;

  if (k.startsWith("lead.")) return campoDe(dados.lead?.campos, k.slice("lead.".length));
  if (k.startsWith("contact.")) return campoDe(dados.contato?.campos, k.slice("contact.".length));
  if (k.startsWith("contato.")) return campoDe(dados.contato?.campos, k.slice("contato.".length));

  return campoDe(dados.lead?.campos, k) ?? campoDe(dados.contato?.campos, k);
}

/**
 * Preenche a cauda do modelo. `null` se ALGUM marcador ficou sem valor.
 *
 * A codificação é por valor, com `encodeURIComponent`, e só para `http(s)`:
 * assim `{{nome}}` com `&` ou `#` não corta a URL nem vira outro parâmetro —
 * é a regra da issue ("o operador não consegue injetar parâmetro nem trocar o
 * destino pelo conteúdo de um campo"). No `tel:` não se codifica nada: a cauda
 * inteira vira dígitos logo depois, e `%2B` no lugar do `+` quebraria o discado.
 */
function preencher(
  cauda: string,
  dados: DadosDoAtalho,
  codificar: boolean,
): string | null {
  let faltou = false;
  const saida = cauda.replace(MARCADOR, (_literal, bruto: string) => {
    const valor = valorDoMarcador(bruto, dados);
    if (valor === null) {
      faltou = true;
      return "";
    }
    return codificar ? encodeURIComponent(valor) : valor;
  });
  return faltou ? null : saida;
}

/**
 * O `href` do clique, ou `null`. `null` = o botão não aparece.
 *
 * A ordem é defesa em profundidade: o MODELO passa na régua, cada valor é
 * codificado, e o RESULTADO passa na mesma régua de novo. A última conferência
 * existe porque a interpolação é o único ponto em que texto de fora entra na
 * string — e um link que só é seguro porque ninguém pensou no caso é o tipo de
 * coisa que a próxima edição desfaz sem perceber.
 */
export function montarHref(
  modelo: string | null | undefined,
  dados: DadosDoAtalho,
): string | null {
  if (!modeloAceito(modelo)) return null;
  const inteiro = texto(modelo);
  const esquema = esquemaDoModelo(inteiro);
  if (!esquema) return null;
  const cauda = inteiro.slice(esquema.length);

  let href: string;
  if (esquema === "tel:") {
    const cru = preencher(cauda, dados, false);
    if (cru === null) return null;
    const telefone = normalizarTelefoneParaTel(cru);
    if (!telefone) return null;
    href = `tel:${telefone}`;
  } else {
    const cru = preencher(cauda, dados, true);
    if (cru === null) return null;
    href = `${esquema}${cru}`;
  }

  // A régua de novo, agora sobre o que vai para o DOM.
  if (!modeloAceito(href)) return null;

  if (esquema !== "tel:") {
    // Endereço que o parser recusa (ou sem ponto no host) abriria uma aba de
    // erro: melhor o botão não existir.
    try {
      const url = new URL(href);
      if (!url.hostname.includes(".")) return null;
      // O host do clique é o host do MODELO. Os marcadores viram um texto fixo
      // para ler o host que quem configurou o funil escreveu; se a interpolação
      // mudou o host, o dado do cliente escolheu o destino.
      const doModelo = new URL(`${esquema}${cauda.replace(MARCADOR, "x")}`);
      if (url.host !== doModelo.host) return null;
    } catch {
      return null;
    }
  }
  return href;
}

/**
 * O que a tela desenha: só atalho válido E com TODOS os marcadores resolvidos.
 *
 * A lista vem do `settings` de um funil, que é jsonb — pode estar suja. Cada
 * item é julgado SOZINHO, de propósito: um atalho quebrado não derruba os
 * outros, e é o mesmo critério de `motivosComCategoriaDoFunil`.
 */
export function atalhosParaExibir(
  atalhos: unknown,
  dados: DadosDoAtalho,
): AtalhoExibivel[] {
  const lista = Array.isArray(atalhos) ? atalhos : [];
  const saida: AtalhoExibivel[] = [];
  for (const item of lista.slice(0, MAX_ATALHOS)) {
    const atalho = lerAtalho(item);
    if (!atalho) continue;
    const href = montarHref(atalho.url, dados);
    if (!href) continue;
    saida.push({
      rotulo: atalho.rotulo,
      icone: atalho.icone,
      href,
      externo: !href.startsWith("tel:"),
    });
  }
  return saida;
}

/**
 * Um item do jsonb → `AtalhoDoCard`, ou `null` se não tem forma de atalho.
 *
 * Não aplica a régua do modelo: quem faz isso é `modeloAceito`/`montarHref`, e
 * a tela de cadastro precisa poder LER um item recusado para mostrá-lo à pessoa
 * que vai consertá-lo (apagar o que está errado seria esconder o problema).
 */
export function lerAtalho(item: unknown): AtalhoDoCard | null {
  if (!item || typeof item !== "object") return null;
  const bruto = item as { rotulo?: unknown; icone?: unknown; url?: unknown };
  const rotulo = texto(bruto.rotulo);
  const url = texto(bruto.url);
  if (!rotulo || rotulo.length > TAMANHO_MAXIMO_DO_ROTULO) return null;
  if (!(ICONES_DE_ATALHO as readonly string[]).includes(String(bruto.icone))) return null;
  if (!url) return null;
  return { rotulo, icone: bruto.icone as IconeDeAtalho, url };
}

/**
 * Os atalhos cadastrados neste funil, na ordem gravada.
 *
 * Espelha `motivosDoFunil`: é o que a tela de configuração e o leitor do cache
 * do quadro chamam. Item sem forma é descartado; item com modelo inválido FICA
 * (ver `lerAtalho`) — a diferença entre "não sei ler isto" e "isto está errado"
 * importa para quem vai consertar.
 */
export function atalhosDoFunil(settings: unknown): AtalhoDoCard[] {
  const bruto = (settings as { atalhos?: unknown } | null | undefined)?.atalhos;
  if (!Array.isArray(bruto)) return [];
  const saida: AtalhoDoCard[] = [];
  for (const item of bruto.slice(0, MAX_ATALHOS)) {
    const atalho = lerAtalho(item);
    if (atalho) saida.push(atalho);
  }
  return saida;
}
