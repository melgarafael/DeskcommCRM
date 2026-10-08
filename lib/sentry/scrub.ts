/**
 * Scrub compartilhado da telemetria (issue #100).
 *
 * Este arquivo existe porque a lógica anterior vivia TRIPLICADA, verbatim, em
 * `sentry.server.config.ts`, `sentry.edge.config.ts` e `instrumentation-client.ts`.
 * Foi exatamente essa triplicação que produziu o buraco: o `beforeSend` cobria
 * erro e mensagem nos três, e ninguém percebeu que transação, span e breadcrumb
 * têm hooks PRÓPRIOS — que não existiam em lugar nenhum. Com `tracesSampleRate: 1`,
 * o canal sem sanitização era justamente o de 100% de amostragem.
 *
 * Agora há um ponto só. Quem adicionar um hook novo adiciona para os três runtimes.
 */

/**
 * O PERFIL DO PAÍS entra aqui pela porta que a issue #2418 abriu: aplicar os
 * padrões de TODOS os perfis, porque quem chama este scrub não tem organização
 * na mão — os hooks do Sentry são globais (montados no `Sentry.init` de cada
 * runtime) e o Jev limpa texto solto, sem saber de qual linha de
 * `organizations.country` veio. Os padrões vêm do registro
 * (`lib/legal/perfil-do-pais.ts`), o mesmo que a ingestão já usa desde o #2416:
 * aqui não se copia regex nenhuma, para os dois pontos de saída não divergirem
 * no dia em que um país ganhar padrão.
 */
import { PERFIS_DO_PAIS, type PadraoDePiiDoPais } from "@/lib/legal/perfil-do-pais";

/**
 * Tipos estruturais mínimos, em vez de importar de `@sentry/core`.
 *
 * `StreamedSpanJSON` e `Event` não são reexportados por `@sentry/nextjs`, e o
 * `@sentry/core` é dependência TRANSITIVA — sob o node_modules estrito do pnpm ele
 * não resolve a partir da raiz. Importar dele funcionaria na máquina de quem tem
 * hoisting e quebraria no CI. Declarar só os campos que este arquivo toca mantém os
 * hooks atribuíveis ao `Sentry.init` por compatibilidade estrutural, sem acoplar a
 * um pacote que não é dependência direta.
 */
type EventLike = {
  // `unknown` de propósito nos campos que o Sentry tipa mais largo que string
  // (`query_string` é `string | Record<string,string> | Array<[string,string]>`).
  // A checagem de `typeof === "string"` acontece em runtime, logo abaixo.
  request?: {
    url?: unknown;
    query_string?: unknown;
    headers?: unknown;
    data?: unknown;
    cookies?: unknown;
  };
  user?: unknown;
  transaction?: string;
  contexts?: { trace?: { data?: Record<string, unknown> } };
  message?: string;
  exception?: { values?: Array<{ value?: string }> };
};
/** Formato do span no Sentry 11 (streaming): `description` virou `name`, `data` virou `attributes`. */
type SpanLike = { name?: string; attributes?: Record<string, unknown> };
type BreadcrumbLike = { message?: string; data?: Record<string, unknown> };

/**
 * Header sensível por PADRÃO, não por lista fechada.
 *
 * A lista anterior enumerava os headers de cada integração pelo nome. Isso tem dois
 * defeitos: header de integração nova entra vazando até alguém lembrar de somar à
 * lista, e o arquivo passa a nomear provider — o que a doutrina de restrição de canal
 * proíbe fora de `lib/channels/` (`docs/doctrine/restricao-de-canal.md`). Casar pelo
 * que torna o header sensível cobre os dois casos de uma vez.
 *
 * Sensível é credencial OU endereço do titular: `x-forwarded-for`, `x-real-ip`,
 * `cf-connecting-ip` e afins carregam o IP de quem acessou (a mesma lista que o
 * guia do Sentry 11 usa como "default do v10": forwarded, -ip, remote-, via).
 */
const SENSITIVE_HEADER =
  /authorization|cookie|api[-_]?key|token|secret|password|credential|forwarded|-ip\b|remote-|^via$/i;

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER.test(name);
}

/**
 * UUID tem forma exata (8-4-4-4-12 em hexadecimal) e é identificador de
 * depuração, não dado do titular. Ele é separado do texto ANTES dos padrões de
 * CPF e telefone, que por isso não precisam de borda de letra: com borda, o CPF
 * e o telefone grudados no rótulo (`cpf12345678909`, `tel-11987654321`) saíam
 * inteiros rumo ao Jev, e sem ela os padrões comiam pedaço de UUID (141 de
 * 5.000 alterados, `…-a9ff-811889831080` virava `…-a9ff-[CPF]0`). O grupo de
 * captura faz o `split` devolver o UUID nas posições ímpares.
 */
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Os padrões de PII declarados nos perfis do país, de TODOS os perfis
 * conhecidos, lidos a cada chamada: `PERFIS_DO_PAIS` é mutável de propósito
 * (os testes de tabela registram país sintético) e a instância de regex é nova
 * por chamada porque o `g` carrega `lastIndex` — a mesma razão anotada no
 * cabeçalho de `PadraoDePiiDoPais`.
 */
function padroesDoPerfil(): readonly PadraoDePiiDoPais[] {
  return Object.values(PERFIS_DO_PAIS).flatMap((perfil) => perfil.padroesDePii);
}

/**
 * Os padrões do perfil que têm de vir ANTES da cadeia de telefone/CPF — pela
 * mesma razão do `apikey` e do UUID, que já moram lá: a cadeia comeria a forma
 * por dentro. Medido, o IBAN `PT50 0002 0123 1234 5678 9015 4` saía
 * `PT50 [PHONE] [PHONE] 9015 4` (os blocos de 4 dígitos dele são a forma exata
 * de um telefone) e, destruído assim, não sobrava forma nenhuma para o padrão
 * do perfil reconhecer depois.
 *
 * Padrao novo cuja forma a cadeia destrói entra nesta lista. Os demais vêm
 * DEPOIS da cadeia, de propósito: é o que mantém o resultado de antes para o
 * que já saía apagado (o NIF sem prefixo continua saindo `[PHONE]`, como no
 * #2345) — o perfil só completa o que a cadeia não resolveu.
 */
const PERFIL_VEM_ANTES = new Set(["iban"]);

/** Aplica os padrões do perfil, na fase escolhida, com marcador do próprio perfil. */
function aplicarPadroesDoPerfil(texto: string, fase: "antes" | "depois"): string {
  let saida = texto;
  for (const padrao of padroesDoPerfil()) {
    if ((fase === "antes") !== PERFIL_VEM_ANTES.has(padrao.tipo)) continue;
    saida = saida.replace(new RegExp(padrao.fonte, "g"), padrao.marcador);
  }
  return saida;
}

/**
 * O telefone brasileiro. O segundo é o mesmo padrão como era antes do #2418
 * (separador depois do `55` só espaço), usado só com `perfisDePais: false`.
 */
const TELEFONE_BR =
  /(^|[^\w-])(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[-.\s]?)?(?:9[-.\s]?\d{4}|\d{4,5})[-.\s]?\d{4}(?![\w-])/g;
const TELEFONE_BR_ANTES_DO_2418 =
  /(^|[^\w-])(?:\+?55\s?)?(?:\(?\d{2}\)?[-.\s]?)?(?:9[-.\s]?\d{4}|\d{4,5})[-.\s]?\d{4}(?![\w-])/g;

/**
 * `perfisDePais: false` devolve a saída de ANTES do #2418: sem os padrões dos
 * perfis e com o `+55` aceitando só espaço depois dele. Existe para UM chamador,
 * a conferência de campo personalizado (`lib/mcp/conferencia-de-campos.ts`), que
 * não é telemetria — ela pergunta ao Jev se o valor CRU que a IA quer gravar
 * ("CEP é 01310-100?") foi dito nas mensagens que saem daqui. Lá, máscara a mais
 * não protege nada (o valor vai ao Jev pela pergunta de qualquer jeito) e faz a
 * conferência recusar o CEP ou o telefone que o cliente acabou de digitar.
 * Telemetria (Sentry e os demais textos do Jev) usa o padrão, com todos os perfis.
 */
export interface OpcoesDoScrub {
  perfisDePais?: boolean;
}

export function scrubMessage(input: string, { perfisDePais = true }: OpcoesDoScrub = {}): string {
  return input
    // Chave do Jev (`apikey_<hex>_<hex>`) solta no texto. PRIMEIRO, porque os
    // padrões de CPF e telefone abaixo comeriam pedaços numéricos dela e
    // deixariam o resto passar.
    .replace(/apikey_[A-Za-z0-9_]{16,}/g, "[CHAVE]")
    // E-mail antes dos números, para o telefone não comer dígito de dentro do
    // endereço e deixar o resto dele passar.
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]")
    .split(UUID)
    .map((trecho, i) => (i % 2 === 1 ? trecho : apagarCpfETelefone(trecho, perfisDePais)))
    .join("");
}

function apagarCpfETelefone(trecho: string, perfisDePais: boolean): string {
  // O IBAN (e o que mais o `PERFIL_VEM_ANTES` declarar) primeiro: a cadeia de
  // telefone comeria os blocos de 4 dígitos dele por dentro.
  const comIban = perfisDePais ? aplicarPadroesDoPerfil(trecho, "antes") : trecho;
  const aposCadeia = comIban
    // Números em formato internacional (+DDI), ANTES de tudo: sem esta
    // passada o `+351912345678` caía no padrão de CPF e saía como
    // `+[CPF]8` (issue #2345). Cobre `+351912345678` e `+351 912 345 678`;
    // os +55 ficam com o padrão brasileiro logo abaixo — o `(?!55)` cumpre
    // isso e mantém o número brasileiro saindo exatamente como antes. O último
    // bloco é `\d{3,}`, não `\d{3,4}`, para não sobrar dígito no fim de número
    // estrangeiro (`+49 30 12345678` saía `[PHONE]8`). Sem as duas peças,
    // `+55 11 987654321` saía `[PHONE]21`.
      .replace(/\+(?!55)\d{1,3}[\s.-]?\(?\d{2,3}\)?[\s.-]?\d{3}[\s.-]?\d{3,}/g, "[PHONE]")
      // Telefone como se escreve no Brasil: +55 opcional, DDD opcional (com ou
      // sem parênteses), 8 ou 9 dígitos (o 9 da frente pode vir solto), e hífen,
      // ponto, espaço ou nada entre os blocos — `11-98765-4321` e `11.98765.4321`
      // saíam inteiros enquanto a tela prometia apagar o telefone. Com 8 dígitos
      // o padrão é curto, e a borda (`[^\w-]` antes, `(?![\w-])` depois) o tira de
      // dentro de hash: sem ela, 1.390 de 5.000 SHA-1 saíam alterados. Os dois
      // padrões de baixo seguem pegando o número colado em outro texto.
      // O separador depois do `55` é `[\s.-]`, não `\s`: sem isso `+55-11-98765-4321`
      // saía inteiro e `+55.11.98765.4321` saía `+55.[PHONE]` (#2418).
      .replace(perfisDePais ? TELEFONE_BR : TELEFONE_BR_ANTES_DO_2418, "$1[PHONE]")
      // CPF com qualquer separador entre os blocos (ponto, espaço, hífen ou nada):
      // `123 456 789 09` e `123.456.789.09` também são CPF de quem digita rápido.
      .replace(/\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[.\s-]?\d{2}/g, "[CPF]")
      // 9 dígitos em três blocos (`123 456 789`) — o NIF português e o telemóvel
      // nacional. Vem DEPOIS do CPF para não partir um CPF separado
      // (`123.456.789-09`) em `[PHONE]-09`.
      .replace(/\b\d{3}[.\s-]\d{3}[.\s-]\d{3}\b/g, "[PHONE]")
      .replace(/\+?\d{2}\s?\d{4,5}-?\d{4}/g, "[PHONE]");

  // Depois da cadeia, os padrões do perfil completam o que ela não cobre: NIF
  // com prefixo `PT`, código postal PT, IBAN de quem digitou sem espaço. Vir
  // DEPOIS é o que preserva o resultado de antes — o NIF sem prefixo e o
  // `+351 912 345 678` já saíram `[PHONE]` acima, e o perfil não acha mais
  // dígito nenhum para trocar.
  return perfisDePais ? aplicarPadroesDoPerfil(aposCadeia, "depois") : aposCadeia;
}

/**
 * Rotas cujo último segmento é CREDENCIAL, não identificador.
 *
 * Os ~134 segmentos `[id]` do app são UUID e ficam de fora de propósito: redigir
 * tudo cegamente tornaria o Sentry inútil para depurar, que é o oposto do objetivo.
 * Estes são diferentes — o token É o mecanismo de autenticação:
 *
 *   /api/v1/webhooks/<canal>/<token>  — a variante por tenant é pública por desenho
 *     (o Caddyfile diz isso com todas as letras) e se apoia em o token ser
 *     imprevisível. Pior: a exigência de assinatura nasce desligada, porque nem todo
 *     transporte assina — então na instalação padrão o token do path é a credencial
 *     INTEIRA daquela rota. Publicá-lo na telemetria a anula.
 *   /team/accept-invite/<token>       — link de convite, aberto no browser.
 *
 * O segmento do canal é `[^/]+` de propósito, não uma lista: canal novo ganha a
 * proteção sozinho, e este arquivo não precisa nomear provider (invariante 1 de
 * `docs/doctrine/restricao-de-canal.md`).
 */
const CREDENTIAL_PATH =
  /(\/api\/v1\/webhooks\/[^/?#\s]+\/|\/team\/accept-invite\/)[^/?#\s]+/g;

/** Parâmetro de query (ou de fragmento) que carrega credencial: `token_hash`, `code`… */
const CREDENTIAL_PARAM = /token|code|secret|password|otp|^sig$/i;

/**
 * A URL carrega credencial: no path (as rotas acima) ou num parâmetro com nome de
 * credencial. É o critério de quem NÃO pode gravar a URL crua (o Replay, em
 * `./replay`), não de quem a redige — `scrubUrl` apaga todo valor de query.
 */
export function urlComCredencial(input: string): boolean {
  if (input.search(CREDENTIAL_PATH) >= 0) return true;
  let url: URL;
  try {
    url = new URL(input, "http://x");
  } catch {
    return false;
  }
  const nomes = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()];
  return nomes.some((nome) => CREDENTIAL_PARAM.test(nome));
}

/**
 * Redige credencial de path e valor de query string, preservando as CHAVES da query.
 *
 * Manter as chaves é deliberado: `?cursor=[REDACTED]&limit=[REDACTED]` ainda diz o
 * que a requisição estava fazendo, que é o que serve para depurar. O valor é o que
 * pode carregar assinatura, token ou dado do titular.
 */
export function scrubUrl(input: string): string {
  const withoutToken = input.replace(CREDENTIAL_PATH, "$1[TOKEN]");
  // O `^` da alternância não é adorno: o Sentry preenche `request.query_string`
  // com a query CRUA, sem o `?` na frente (`sig=abc`, não `?sig=abc`). Sem ele a
  // assinatura sobrevivia nesse campo — medido, não suposto.
  const withoutQueryValues = withoutToken.replace(
    /(^|[?&])([^=&#\s]+)=[^&#\s]*/g,
    "$1$2=[REDACTED]",
  );
  return scrubMessage(withoutQueryValues);
}

/**
 * Atributos de span/trace que carregam URL crua na convenção OpenTelemetry.
 * `sentry.segment.name` é a cópia do nome do span raiz que o Sentry 11 põe em
 * TODO span — limpar só o `name` deixava o token sair por ela (medido pelo SDK).
 */
const URL_ATTRIBUTES = [
  "sentry.segment.name",
  "url.full",
  "url.path",
  "url.query",
  "http.url",
  "http.target",
  "http.request.url",
];

function scrubAttributes(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of URL_ATTRIBUTES) {
    const value = data[key];
    if (typeof value === "string") data[key] = scrubUrl(value);
  }
}

/**
 * No span, header vira atributo `http.request.header.<nome>` (valor em array no
 * Sentry 11). O mesmo padrão de `isSensitiveHeader` decide quais saem.
 */
const HEADER_ATTRIBUTE = /^http\.(request|response)\.header\.(.+)$/;

/**
 * Atributo de span que é dado do titular, e não metadado: o corpo (o
 * `requestData` anexa `http.request.body.data` com o que houver no escopo, sem
 * olhar `httpBodies` — medido pelo SDK), o usuário e o IP de quem acessou.
 */
const TITULAR_ATTRIBUTE = /^(http\.(request|response)\.body\.data|user\..+|client\.address)$/;

function scrubSpanAttributes(attributes: Record<string, unknown> | undefined): void {
  if (!attributes) return;
  scrubAttributes(attributes);
  for (const key of Object.keys(attributes)) {
    const header = HEADER_ATTRIBUTE.exec(key)?.[2];
    if ((header && isSensitiveHeader(header)) || TITULAR_ATTRIBUTE.test(key)) {
      delete attributes[key];
    }
  }
}

function scrubHeaders(headers: unknown): void {
  if (!headers || typeof headers !== "object") return;
  const record = headers as Record<string, string>;
  for (const key of Object.keys(record)) {
    if (isSensitiveHeader(key)) delete record[key];
    // O `Referer` é a URL da página anterior — com o token dela, se tinha um.
    else if (/^referer$/i.test(key) && typeof record[key] === "string") {
      record[key] = scrubUrl(record[key]);
    }
  }
}

/**
 * Limpa os campos do evento de erro que carregam URL ou dado do titular. O
 * evento de erro ainda traz `transaction` e `contexts.trace` no Sentry 11, e o
 * nome da transação entra aqui porque o `@sentry/node` puro não parametriza a
 * rota; só o wrapper do Next parametriza, e nem todo caminho passa por ele.
 */
function scrubEventUrls<T extends EventLike>(event: T): T {
  if (event.request) {
    scrubHeaders(event.request.headers);
    if (typeof event.request.url === "string") {
      event.request.url = scrubUrl(event.request.url);
    }
    if (typeof event.request.query_string === "string") {
      event.request.query_string = scrubUrl(event.request.query_string);
    }
    // Corpo e cookies não saem, nem se o SDK os anexar: o `requestData` do
    // Sentry 11 anexa o corpo que estiver no escopo sem olhar `httpBodies`
    // (que só barra a escrita) — medido em `privacidade.sdk.test.ts`.
    delete event.request.data;
    delete event.request.cookies;
  }
  // Não chamamos `setUser`; o que chega aqui é o que o SDK INFERIU (IP). Se um
  // dia for preciso identificar usuário no Sentry, é decisão de LGPD, não default.
  delete event.user;
  if (typeof event.transaction === "string") {
    event.transaction = scrubUrl(event.transaction);
  }
  scrubAttributes(event.contexts?.trace?.data);
  return event;
}

/**
 * Os hooks, prontos para espalhar dentro do `Sentry.init` de cada runtime (via
 * `opcoesDePrivacidade`, em `./privacidade`). Espalhar o objeto inteiro é o
 * ponto: adicionar um hook aqui cobre todos os runtimes de uma vez.
 *
 * Não há `beforeSendTransaction`: no Sentry 11 o span é transmitido em
 * streaming, não existe mais evento de transação, e o hook é no-op (MIGRATION.md
 * 11.0.0, "Replacing `beforeSendTransaction`"). O que ele limpava — o nome da
 * transação e a URL nos atributos — é o `name` e os `attributes` do span raiz,
 * e o `beforeSendSpan` limpa todo span, raiz (`is_segment`) inclusive.
 */
export const sentryScrubHooks = {
  beforeSend<T extends EventLike>(event: T): T {
    scrubEventUrls(event);
    // `scrubUrl`, não só `scrubMessage`: mensagem de erro carrega URL (erro de
    // fetch, de rota), e o token do path saía nela — medido pelo SDK.
    if (typeof event.message === "string") {
      event.message = scrubUrl(event.message);
    }
    if (event.exception?.values) {
      for (const ex of event.exception.values) {
        if (ex.value) ex.value = scrubUrl(ex.value);
      }
    }
    return event;
  },

  beforeSendSpan<T extends SpanLike>(span: T): T {
    if (typeof span.name === "string") {
      span.name = scrubUrl(span.name);
    }
    scrubSpanAttributes(span.attributes);
    return span;
  },

  beforeBreadcrumb<T extends BreadcrumbLike>(breadcrumb: T): T {
    if (typeof breadcrumb.message === "string") {
      breadcrumb.message = scrubUrl(breadcrumb.message);
    }
    // `from`/`to` são da navegação (troca de rota): a rota de onde se saiu pode
    // ter o token no path.
    const data = breadcrumb.data;
    for (const campo of ["url", "from", "to"]) {
      const valor = data?.[campo];
      if (data && typeof valor === "string") data[campo] = scrubUrl(valor);
    }
    return breadcrumb;
  },
};
