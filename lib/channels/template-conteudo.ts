/**
 * O CONTEÚDO de uma definição aprovada, legível.
 *
 * ─── Por que existe ────────────────────────────────────────────────────────
 *
 * A lista mostrava só nome, idioma e estado. Ver "APPROVED" sem ver o texto
 * obriga o operador a abrir a plataforma para saber o que a definição diz — e é
 * o texto que ele precisa para escolher qual mandar.
 *
 * ─── E por que os EXEMPLOS têm caso próprio ────────────────────────────────
 *
 * Medido no contrato da plataforma: o corpo aceita `{{n}}`, e o `example` com
 * valores de amostra é o que a revisão exige. Uma definição com variável e SEM
 * exemplo é recusada — e a recusa chega horas depois, sem que ninguém ligue uma
 * coisa à outra.
 *
 * Foi exatamente o que o formulário fazia: deixava digitar `{{1}}` e não
 * coletava o exemplo. Rejeição garantida, por omissão da nossa tela.
 */

/**
 * Os códigos de idioma que a plataforma aceita (`message_template_language`).
 *
 * LISTA, e não campo livre. O contrato descreve o formato mas não enumera os
 * valores, e digitar é onde o erro nasce: `esp`, `ES`, `es-AR` e `español` são
 * todos recusados, e a recusa vem como "language not supported" horas depois.
 * Escolher de uma lista não erra.
 *
 * Não é a lista INTEIRA da Meta (são dezenas): são os idiomas com que este
 * público trabalha, mais os que aparecem em conta de teste. Faltar um é um
 * pedido de uma linha; oferecer sessenta faz o operador procurar o dele numa
 * lista que não termina.
 */
export const IDIOMAS_DA_DEFINICAO: { codigo: string; rotulo: string }[] = [
  { codigo: "es", rotulo: "Espanhol" },
  { codigo: "es_AR", rotulo: "Espanhol (Argentina)" },
  { codigo: "es_MX", rotulo: "Espanhol (México)" },
  { codigo: "es_ES", rotulo: "Espanhol (Espanha)" },
  { codigo: "pt_BR", rotulo: "Português (Brasil)" },
  { codigo: "pt_PT", rotulo: "Português (Portugal)" },
  { codigo: "en", rotulo: "Inglês" },
  { codigo: "en_US", rotulo: "Inglês (EUA)" },
  { codigo: "en_GB", rotulo: "Inglês (Reino Unido)" },
];

/** Limites da plataforma. Passar deles é recusa, e o contador evita descobrir tarde. */
export const LIMITE_CORPO = 1024;
export const LIMITE_RODAPE = 60;
export const LIMITE_BOTOES = 3;

export type TipoDeBotao = "quick_reply" | "url" | "phone_number";

export interface BotaoDaDefinicao {
  tipo: TipoDeBotao;
  texto: string;
  /** Só para `url`. */
  url?: string;
  /** Só para `phone_number`. */
  telefone?: string;
}

type Bruto = Record<string, unknown>;

const obj = (v: unknown): Bruto | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export interface ConteudoDaDefinicao {
  /** `midiaUrl`: o link de exemplo do cabeçalho de mídia (`header_handle`), quando há. */
  header: { formato: string; texto: string | null; midiaUrl?: string | null } | null;
  body: string | null;
  footer: string | null;
  /** `url`/`telefone` só nos botões desses tipos — a edição precisa deles de volta. */
  botoes: { tipo: string; texto: string; url?: string; telefone?: string }[];
  /** Quantos `{{n}}` o corpo declara — o que o envio vai precisar preencher. */
  variaveis: number;
  /** As amostras de cada `{{n}}` que a revisão recebeu (`example.body_text[0]`). */
  exemplos?: string[];
}

/**
 * Lê o payload cru como a plataforma o devolveu.
 *
 * Tolerante a caixa (`BODY` e `body` convivem: a leitura vem da Meta em
 * maiúsculas, a escrita do intermediário em minúsculas) e a campo ausente —
 * uma definição sem rodapé é normal, não erro.
 */
export function lerConteudo(components: unknown): ConteudoDaDefinicao {
  const lista = Array.isArray(components) ? components : [];
  const vazio: ConteudoDaDefinicao = {
    header: null,
    body: null,
    footer: null,
    botoes: [],
    variaveis: 0,
  };

  for (const bruto of lista) {
    const c = obj(bruto);
    if (!c) continue;
    const tipo = (str(c.type) ?? "").toUpperCase();

    if (tipo === "HEADER") {
      const handle = obj(c.example)?.header_handle;
      vazio.header = {
        formato: (str(c.format) ?? "TEXT").toUpperCase(),
        texto: str(c.text),
        midiaUrl: Array.isArray(handle) ? str(handle[0]) : null,
      };
    } else if (tipo === "BODY") {
      vazio.body = str(c.text);
      const amostras = obj(c.example)?.body_text;
      const primeira = Array.isArray(amostras) && Array.isArray(amostras[0]) ? amostras[0] : [];
      vazio.exemplos = primeira.map((v: unknown) => (typeof v === "string" ? v : ""));
    } else if (tipo === "FOOTER") {
      vazio.footer = str(c.text);
    } else if (tipo === "BUTTONS") {
      const bts = Array.isArray(c.buttons) ? c.buttons : [];
      for (const b of bts) {
        const o = obj(b);
        if (!o) continue;
        vazio.botoes.push({
          tipo: (str(o.type) ?? "").toUpperCase(),
          texto: str(o.text) ?? "",
          ...(str(o.url) ? { url: str(o.url)! } : {}),
          ...(str(o.phone_number) ? { telefone: str(o.phone_number)! } : {}),
        });
      }
    }
  }

  vazio.variaveis = contarVariaveis(vazio.body ?? "");
  return vazio;
}

/**
 * Quantos `{{n}}` distintos o texto usa.
 *
 * DISTINTOS, e pelo MAIOR índice: um texto que repete `{{1}}` duas vezes pede
 * um valor, não dois — e um que usa `{{1}}` e `{{3}}` pede três, porque a
 * plataforma numera por posição e recusa a lista com buracos.
 */
export function contarVariaveis(texto: string): number {
  const achados = [...texto.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return achados.length === 0 ? 0 : Math.max(...achados);
}

/**
 * Monta os `components` de uma definição nova, com os exemplos que a revisão
 * exige.
 *
 * `example.body_text` é ARRAY DE ARRAYS — o formato do contrato, um conjunto de
 * amostras por variável. Mandar um array simples é recusado, e a mensagem de
 * erro não diz qual dos dois formatos ela queria.
 */
export function montarComponents(input: {
  body: string;
  footer?: string | null;
  exemplos: string[];
  cabecalho?: { texto?: string | null; midiaUrl?: string | null } | null;
  botoes?: BotaoDaDefinicao[];
}): unknown[] {
  const n = contarVariaveis(input.body);
  const components: unknown[] = [];

  // O cabeçalho vem PRIMEIRO: a plataforma lê a ordem dos componentes como a
  // ordem da mensagem, e um header depois do corpo é recusado.
  const midia = input.cabecalho?.midiaUrl?.trim();
  const tituloTexto = input.cabecalho?.texto?.trim();
  if (midia) {
    // `header_handle` é o campo do contrato para mídia, e pede URL PÚBLICA —
    // a plataforma baixa o arquivo na revisão. Link autenticado é recusado.
    components.push({
      type: "HEADER",
      format: "IMAGE",
      example: { header_handle: [midia] },
    });
  } else if (tituloTexto) {
    const cab: Bruto = { type: "HEADER", format: "TEXT", text: tituloTexto };
    const nCab = contarVariaveis(tituloTexto);
    // O cabeçalho tem exemplo PRÓPRIO (`header_text`), separado do corpo. Usar
    // o do corpo aqui manda a amostra errada e a revisão recusa.
    if (nCab > 0) cab.example = { header_text: Array.from({ length: nCab }, () => "exemplo") };
    components.push(cab);
  }

  const corpo: Bruto = { type: "BODY", text: input.body };
  if (n > 0) {
    // Preenche o que faltar com um marcador: o exemplo VAZIO é recusado pela
    // revisão, e um campo em branco esquecido no formulário não pode virar uma
    // recusa que só aparece horas depois.
    const amostras = Array.from({ length: n }, (_, i) => input.exemplos[i]?.trim() || "exemplo");
    corpo.example = { body_text: [amostras] };
  }
  components.push(corpo);

  const rodape = input.footer?.trim();
  if (rodape) components.push({ type: "FOOTER", text: rodape });

  // Botões por último, e todos num ÚNICO componente: o contrato pede
  // `{type:"BUTTONS", buttons:[…]}`, não um componente por botão.
  const botoes = (input.botoes ?? [])
    .filter((b) => b.texto.trim())
    .slice(0, LIMITE_BOTOES)
    .map((b) => {
      const base: Bruto = { type: b.tipo.toUpperCase(), text: b.texto.trim() };
      if (b.tipo === "url") base.url = (b.url ?? "").trim();
      if (b.tipo === "phone_number") base.phone_number = (b.telefone ?? "").trim();
      return base;
    })
    // URL sem endereço e telefone sem número são recusados pela revisão. Barrar
    // aqui evita mandar para revisão algo que já se sabe que volta.
    .filter((b) => (b.type !== "URL" || b.url) && (b.type !== "PHONE_NUMBER" || b.phone_number));

  if (botoes.length > 0) components.push({ type: "BUTTONS", buttons: botoes });

  return components;
}

/**
 * O conteúdo de uma definição EXISTENTE, na forma do formulário — é o que deixa
 * editar partindo do texto aprovado, em vez de redigitar tudo. O caminho de volta
 * é `montarComponents`, e os dois juntos fecham a ida e volta (ver o teste).
 */
export function paraFormulario(c: ConteudoDaDefinicao): {
  cabecalho: string;
  midiaUrl: string;
  corpo: string;
  rodape: string;
  exemplos: string[];
  botoes: BotaoDaDefinicao[];
} {
  const tipos: Record<string, TipoDeBotao> = { QUICK_REPLY: "quick_reply", URL: "url", PHONE_NUMBER: "phone_number" };
  return {
    cabecalho: c.header?.formato === "TEXT" ? (c.header.texto ?? "") : "",
    midiaUrl: c.header && c.header.formato !== "TEXT" ? (c.header.midiaUrl ?? "") : "",
    corpo: c.body ?? "",
    rodape: c.footer ?? "",
    exemplos: c.exemplos ?? [],
    botoes: c.botoes
      .filter((b) => tipos[b.tipo])
      .map((b) => ({
        tipo: tipos[b.tipo]!,
        texto: b.texto,
        ...(b.url ? { url: b.url } : {}),
        ...(b.telefone ? { telefone: b.telefone } : {}),
      })),
  };
}
