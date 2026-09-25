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
 * Tipos estruturais mínimos, em vez de importar de `@sentry/core`.
 *
 * `SpanJSON` e `TransactionEvent` não são reexportados por `@sentry/nextjs`, e o
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
  request?: { url?: unknown; query_string?: unknown; headers?: unknown };
  transaction?: string;
  contexts?: { trace?: { data?: Record<string, unknown> } };
  message?: string;
  exception?: { values?: Array<{ value?: string }> };
};
type SpanLike = { description?: string; data?: Record<string, unknown> };
type BreadcrumbLike = { message?: string; data?: Record<string, unknown> };

/**
 * Header sensível por PADRÃO, não por lista fechada.
 *
 * A lista anterior enumerava os headers de cada integração pelo nome. Isso tem dois
 * defeitos: header de integração nova entra vazando até alguém lembrar de somar à
 * lista, e o arquivo passa a nomear provider — o que a doutrina de restrição de canal
 * proíbe fora de `lib/channels/` (`docs/doctrine/restricao-de-canal.md`). Casar pelo
 * que torna o header sensível cobre os dois casos de uma vez.
 */
const SENSITIVE_HEADER = /authorization|cookie|api[-_]?key|token|secret|password|credential/i;

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

export function scrubMessage(input: string): string {
  return input
    // Chave do Jev (`apikey_<hex>_<hex>`) solta no texto. PRIMEIRO, porque os
    // padrões de CPF e telefone abaixo comeriam pedaços numéricos dela e
    // deixariam o resto passar.
    .replace(/apikey_[A-Za-z0-9_]{16,}/g, "[CHAVE]")
    // E-mail antes dos números, para o telefone não comer dígito de dentro do
    // endereço e deixar o resto dele passar.
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]")
    .split(UUID)
    .map((trecho, i) => (i % 2 === 1 ? trecho : apagarCpfETelefone(trecho)))
    .join("");
}

function apagarCpfETelefone(trecho: string): string {
  return trecho
    // Telefone como se escreve no Brasil: +55 opcional, DDD opcional (com ou
    // sem parênteses), 8 ou 9 dígitos (o 9 da frente pode vir solto), e hífen,
    // ponto, espaço ou nada entre os blocos — `11-98765-4321` e `11.98765.4321`
    // saíam inteiros enquanto a tela prometia apagar o telefone. Com 8 dígitos
    // o padrão é curto, e a borda (`[^\w-]` antes, `(?![\w-])` depois) o tira de
    // dentro de hash: sem ela, 1.390 de 5.000 SHA-1 saíam alterados. Os dois
    // padrões de baixo seguem pegando o número colado em outro texto.
    .replace(
      /(^|[^\w-])(?:\+?55\s?)?(?:\(?\d{2}\)?[-.\s]?)?(?:9[-.\s]?\d{4}|\d{4,5})[-.\s]?\d{4}(?![\w-])/g,
      "$1[PHONE]",
    )
    // CPF com qualquer separador entre os blocos (ponto, espaço, hífen ou nada):
    // `123 456 789 09` e `123.456.789.09` também são CPF de quem digita rápido.
    .replace(/\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[.\s-]?\d{2}/g, "[CPF]")
    .replace(/\+?\d{2}\s?\d{4,5}-?\d{4}/g, "[PHONE]");
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

/** Atributos de span/trace que carregam URL crua na convenção OpenTelemetry. */
const URL_ATTRIBUTES = [
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

function scrubHeaders(headers: unknown): void {
  if (!headers || typeof headers !== "object") return;
  const record = headers as Record<string, string>;
  for (const key of Object.keys(record)) {
    if (isSensitiveHeader(key)) delete record[key];
  }
}

/**
 * Limpa os campos que carregam URL em QUALQUER evento — erro ou transação.
 * O nome da transação entra aqui porque o `@sentry/node` puro não parametriza a
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
  }
  if (typeof event.transaction === "string") {
    event.transaction = scrubUrl(event.transaction);
  }
  scrubAttributes(event.contexts?.trace?.data);
  return event;
}

/**
 * Os quatro hooks, prontos para espalhar dentro do `Sentry.init` de cada runtime.
 * Espalhar o objeto inteiro é o ponto: adicionar um hook aqui cobre servidor, edge
 * e cliente de uma vez, sem depender de alguém lembrar dos três arquivos.
 */
export const sentryScrubHooks = {
  beforeSend<T extends EventLike>(event: T): T {
    scrubEventUrls(event);
    if (typeof event.message === "string") {
      event.message = scrubMessage(event.message);
    }
    if (event.exception?.values) {
      for (const ex of event.exception.values) {
        if (ex.value) ex.value = scrubMessage(ex.value);
      }
    }
    return event;
  },

  beforeSendTransaction<T extends EventLike>(event: T): T {
    return scrubEventUrls(event);
  },

  beforeSendSpan<T extends SpanLike>(span: T): T {
    if (typeof span.description === "string") {
      span.description = scrubUrl(span.description);
    }
    scrubAttributes(span.data);
    return span;
  },

  beforeBreadcrumb<T extends BreadcrumbLike>(breadcrumb: T): T {
    if (typeof breadcrumb.message === "string") {
      breadcrumb.message = scrubUrl(breadcrumb.message);
    }
    const url = breadcrumb.data?.url;
    if (typeof url === "string" && breadcrumb.data) {
      breadcrumb.data.url = scrubUrl(url);
    }
    return breadcrumb;
  },
};
