/**
 * MOSTRAR QUANDO — a condição que um campo personalizado declara sobre outro
 * (issue #2728): "mostrar o campo X só quando o campo Y = valor".
 *
 * ─── Onde a condição nasce e onde ela é lida ──────────────────────────────
 *
 * Nasce em `customFieldSchema.mostrar_quando` (o `settings.fields` do funil) e
 * chega à tela pelo MESMO caminho que o resto da definição: `camposDoFunil` →
 * `CustomFieldsEditor`. Quem MONTA a condição (campo + operador + valor) é o
 * editor de campos do funil, em Configurações; aqui fica só a régua — o schema
 * para gravar, `campoVisivel` para ler. Os quatro pontos que renderizam
 * (`EditContactDialog`, `CRMSidePanel`, `LeadFieldsForm` e `LeadDossier`, este
 * pelo `LeadFieldsForm`) passam todos pelo mesmo filtro, que mora no
 * `CustomFieldsEditor`.
 *
 * ─── Esconder não é limpar ────────────────────────────────────────────────
 *
 * `campoVisivel`/`camposVisiveis` só respondem QUEM APARECE. Nenhum valor é
 * apagado aqui: o objeto `custom_fields` segue inteiro, o editor continua com
 * a chave dentro do estado, e o que se salva não muda por causa da condição —
 * é por isso que trocar o gatilho não destrói dado, e reverter o gatilho
 * traz o valor de volta à tela.
 *
 * ─── Os operadores ────────────────────────────────────────────────────────
 *
 *   - `igual`     → o valor gravado é o esperado (caixa e acento não mudam
 *                   nada, e número casa com número);
 *   - `contem`    → o texto gravado contém o esperado, ou a LISTA de um
 *                   multiselect traz o item;
 *   - `maior_que` → número maior; `0` e `false` são RESPOSTA, não ausência —
 *                   a mesma régua de `valorPreenchido` em
 *                   `lib/leads/campos-exigidos.ts`;
 *   - `em`        → o valor gravado está no CONJUNTO declarado (#3036).
 *
 * Sem valor no campo que manda, a condição ainda não aconteceu: o condicional
 * fica escondido.
 *
 * ─── Fail-open, e por escrito ─────────────────────────────────────────────
 *
 * Condição ilegível (jsonb velho, `campo` em branco, operador desconhecido,
 * valor vazio) MOSTRA o campo. É o mesmo argumento de `camposDoFunil` e de
 * `settingsDoFunil`: esconder dado por lixo no banco é pior do que mostrar um
 * campo a mais, e a RECUSA à gravação já acontece no `mostrarQuandoSchema`,
 * na hora de salvar.
 */
import { z } from "zod";

/**
 * Os operadores da condição — e o único vocabulário que o editor oferece.
 *
 * Os três primeiros vêm da #2728. `em` nasceu na #3036: a pergunta "o tipo de
 * cliente é PJ **ou** MEI?" é um CONJUNTO de valores, e montá-la como duas
 * condições no mesmo campo não é possível — cada campo declara uma só. Sem
 * ele, o dono do funil repetiria o campo (ou aceitaria uma condição que casa
 * só com metade dos casos).
 */
export const OPERADORES_DE_MOSTRA = ["igual", "contem", "maior_que", "em"] as const;
export type OperadorDeMostra = (typeof OPERADORES_DE_MOSTRA)[number];

/**
 * O valor que a condição espera: texto ("Outro"), número (`criancas > 2`) ou
 * booleano. Em branco não é valor — é a metade de uma condição que ainda não
 * terminou de ser montada, e ela não grava.
 */
const valorDaCondicao = z.union([
  z
    .string()
    .max(200)
    .refine((s) => s.trim().length > 0, { message: "O valor da condição não pode ficar vazio" }),
  z.number().refine(Number.isFinite, { message: "Número inválido na condição" }),
  z.boolean(),
]);

/**
 * A condição GRAVÁVEL, nos dois formatos que ela pode chegar:
 *
 *   - `{ campo: "tipo_servico", contem: "Outro" }` — o da própria issue, em
 *     que o operador É a chave;
 *   - `{ campo, operador, valor }` — a forma par que o editor monta ao digitar.
 *
 * Os dois são lidos pelo MESMO `campoVisivel`; gravar em qualquer um dos dois
 * não muda o resultado na tela.
 */
export const mostrarQuandoSchema = z
  .object({
    /** A chave do OUTRO campo — o que manda na condição. */
    campo: z.string().min(1).max(80),
    /** Forma par (a que o editor escreve). */
    operador: z.enum(OPERADORES_DE_MOSTRA).optional(),
    /**
     * O valor — e, no operador `em`, o CONJUNTO deles (#3036). A lista vive
     * aqui (e não só na chave `em`) porque o editor grava sempre na forma par;
     * `condicaoDe` lê as duas.
     */
    valor: z.union([valorDaCondicao, z.array(valorDaCondicao).min(1).max(50)]).optional(),
    /** Forma da issue: o operador é a chave. */
    igual: valorDaCondicao.optional(),
    contem: valorDaCondicao.optional(),
    maior_que: valorDaCondicao.optional(),
    /**
     * O CONJUNTO de valores aceitos (#3036): casa quando o valor gravado é
     * qualquer um da lista. Lista vazia não é valor — é a condição meio
     * montada, e `presente()` já a trata como ausência.
     */
    em: z.array(valorDaCondicao).min(1).max(50).optional(),
  })
  .superRefine((condicao, ctx) => {
    const emChave = OPERADORES_DE_MOSTRA.filter((op) => condicao[op] !== undefined);
    if (condicao.operador !== undefined && condicao.valor === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["valor"],
        message: "A condição precisa de um valor ao lado do operador",
      });
      return;
    }
    if (emChave.length === 0 && condicao.operador === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operador"],
        message: "A condição precisa de um operador: igual, contem ou maior_que",
      });
    }
  });

/** O tipo que `CustomFieldDef.mostrar_quando` carrega. */
export type MostrarQuando = z.input<typeof mostrarQuandoSchema>;

/** Os valores gravados do registro — `custom_fields` é jsonb livre. */
type Valores = Record<string, unknown> | null | undefined;

interface CondicaoLida {
  campo: string;
  operador: OperadorDeMostra;
  valor: unknown;
}

/** `undefined`/`null`/branco/array vazio são ausência; `false` e `0` são resposta. */
function presente(valor: unknown): boolean {
  if (valor === undefined || valor === null) return false;
  if (typeof valor === "string") return valor.trim().length > 0;
  if (Array.isArray(valor)) return valor.length > 0;
  return true;
}

/** Caixa e acento não decidem se a condição casa: "Outro" e "OUTRO" são o mesmo texto. */
function normalizar(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  return String(valor)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * O número que o valor representa, ou `null`.
 *
 * O texto só conta quando É número: `Number("")` é `0` e `Number(" ")` também,
 * e tratar a falta de valor como zero faria `maior_que` casar sozinho no campo
 * recém-criado.
 */
function numeroSePossivel(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  if (typeof valor === "string" && /^-?\d+([.,]\d+)?$/.test(valor.trim())) {
    const n = Number(valor.trim().replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Lê a condição em QUALQUER um dos dois formatos; ilegível devolve `null`. */
function condicaoDe(bruta: unknown): CondicaoLida | null {
  if (!bruta || typeof bruta !== "object" || Array.isArray(bruta)) return null;
  const crua = bruta as Record<string, unknown>;
  const campo = typeof crua.campo === "string" ? crua.campo.trim() : "";
  if (campo.length === 0) return null;

  if (
    typeof crua.operador === "string" &&
    (OPERADORES_DE_MOSTRA as readonly string[]).includes(crua.operador) &&
    presente(crua.valor)
  ) {
    return { campo, operador: crua.operador as OperadorDeMostra, valor: crua.valor };
  }

  for (const operador of OPERADORES_DE_MOSTRA) {
    const valor = crua[operador];
    if (presente(valor)) return { campo, operador, valor };
  }
  return null;
}

function testa(condicao: CondicaoLida, gravado: unknown): boolean {
  const { operador, valor } = condicao;

  if (operador === "em") {
    // O CONJUNTO (#3036): o gravado é um dos valores da lista. Multiselect
    // responde "algum item da lista está no conjunto?" — a mesma leitura do
    // `contem`, que é o que a pessoa quer dizer ao marcar dois tipos.
    const alvos = (Array.isArray(valor) ? valor : [valor]).map(normalizar);
    if (Array.isArray(gravado)) {
      return gravado.some((item) => alvos.includes(normalizar(item)));
    }
    return alvos.includes(normalizar(gravado));
  }

  if (operador === "maior_que") {
    const a = numeroSePossivel(gravado);
    const b = numeroSePossivel(valor);
    if (a !== null && b !== null) return a > b;
    // Data `AAAA-MM-DD` não é número, e se ordena pelo texto — a mesma
    // leitura que um `<input type="date">` já entrega.
    if (typeof gravado === "string" && typeof valor === "string") return gravado > valor;
    return false;
  }

  if (Array.isArray(gravado)) {
    // Multiselect: para os DOIS operadores a pergunta é "a lista tem este item?".
    return gravado.some((item) => normalizar(item) === normalizar(valor));
  }

  if (operador === "igual") {
    const a = numeroSePossivel(gravado);
    const b = numeroSePossivel(valor);
    if (a !== null && b !== null) return a === b;
    return normalizar(gravado) === normalizar(valor);
  }

  // `contem`: o texto gravado contém o esperado.
  return normalizar(gravado).includes(normalizar(valor));
}

/**
 * A CONDIÇÃO CASOU com os valores gravados? — a pergunta da OBRIGATORIEDADE
 * condicional (#3036), e a diferença que a separa de `campoVisivel`.
 *
 * `campoVisivel` responde "mostrar?" e por isso devolve `true` quando não há
 * condição nenhuma (fail-open). Aqui a ausência de condição é o contrário:
 * `false` — um campo sem `exigir_quando` não é exigido por condição nenhuma, e
 * responder `true` obrigaria TODO campo do funil.
 *
 * Condição ilegível também devolve `false`: exigir por lixo no banco travaria
 * a escrita por uma regra que ninguém consegue ler — a visibilidade é que é
 * fail-open, porque esconder dado é pior do que mostrar um campo a mais.
 */
export function condicaoCasa(bruta: unknown, valores: Valores): boolean {
  const condicao = condicaoDe(bruta);
  if (!condicao) return false;
  const gravado = (valores ?? {})[condicao.campo];
  if (!presente(gravado)) return false;
  return testa(condicao, gravado);
}

/**
 * O campo aparece? — a pergunta única de quem renderiza.
 *
 * `bruta` é `unknown` de propósito: a condição vem de jsonb, e a borda que
 * garante o formato é o `mostrarQuandoSchema` na gravação, não esta leitura.
 */
export function campoVisivel(bruta: unknown, valores: Valores): boolean {
  // Sem condição (ou condição ilegível) = mostrar: o funil de sempre, byte a byte.
  if (!condicaoDe(bruta)) return true;
  return condicaoCasa(bruta, valores);
}

/**
 * Os campos que a tela renderiza ESTA vez — e a ÚNICA régua de quem aparece,
 * para a tela (`CustomFieldsEditor`) e para o servidor (`validaCamposExigidos`).
 *
 * Ela olha a LISTA, não só a condição, e por isso fecha três casos que a
 * condição sozinha não vê:
 *
 *   - campo que manda APAGADO ou RENOMEADO → a condição aponta para nada, é
 *     ilegível, e o campo APARECE (o mesmo fail-open de cima). Sem isto o
 *     dependente sumia para sempre de todo lead, sem aviso;
 *   - LAÇO (A depende de B que depende de A, ou mais longo) → ninguém do laço
 *     conseguiria aparecer primeiro; a condição é ilegível e o campo APARECE;
 *   - campo que manda ESCONDIDO → o dependente também some, mesmo que o valor
 *     antigo do que manda ainda case: escondido não responde.
 *
 * Devolve uma lista NOVA — `campos` e `valores` ficam intocados, que é
 * exatamente a promessa da issue: esconder não apaga o que estava gravado.
 */
export function camposVisiveis<T extends { key: string; mostrar_quando?: unknown }>(
  campos: readonly T[],
  valores: Valores,
): T[] {
  const porChave = new Map(campos.map((campo) => [campo.key, campo]));

  /** Seguindo quem manda, a cadeia volta a este campo? */
  const emLaco = (campo: T): boolean => {
    let atual: T | undefined = campo;
    for (let passo = 0; passo < campos.length && atual; passo += 1) {
      const condicao = condicaoDe(atual.mostrar_quando);
      if (!condicao) return false;
      if (condicao.campo === campo.key) return true;
      atual = porChave.get(condicao.campo);
    }
    return false;
  };

  const visivel = (campo: T): boolean => {
    const condicao = condicaoDe(campo.mostrar_quando);
    if (!condicao) return true;
    const quemManda = porChave.get(condicao.campo);
    if (!quemManda || emLaco(campo)) return true;
    // Sem laço, a recursão termina: a cadeia acaba num campo sem condição,
    // num campo que manda inexistente ou num membro de laço (que responde true).
    return visivel(quemManda) && campoVisivel(campo.mostrar_quando, valores);
  };

  return campos.filter(visivel);
}
