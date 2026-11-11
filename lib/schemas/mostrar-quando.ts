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
 * ─── Os três operadores, os mesmos que a issue pede ───────────────────────
 *
 *   - `igual`     → o valor gravado é o esperado (caixa e acento não mudam
 *                   nada, e número casa com número);
 *   - `contem`    → o texto gravado contém o esperado, ou a LISTA de um
 *                   multiselect traz o item;
 *   - `maior_que` → número maior; `0` e `false` são RESPOSTA, não ausência —
 *                   a mesma régua de `valorPreenchido` em
 *                   `lib/leads/campos-exigidos.ts`.
 *
 * Sem valor no campo que manda, a condição ainda não aconteceu: o condicional
 * fica escondido.
 *
 * ─── MAIS DE UMA CONDIÇÃO (#4041) ─────────────────────────────────────────
 *
 * Um campo pode declarar uma LISTA de condições, em um de dois modos:
 *
 *   - `qualquer` (o padrão, e o pedido da issue): o campo aparece se PELO
 *     MENOS UMA condição casar. É o caso real da agência de viagens — os
 *     campos de voo valem quando "Tipo de serviço" tem "Passagem aérea" OU
 *     "Pacote";
 *   - `todas`: o campo aparece se TODAS casarem.
 *
 * A condição única (`{campo, operador, valor}` ou `{campo, contem: "..."}`) é o
 * formato gravado por todo funil que já existe, e continua valendo byte a
 * byte: é lida como uma lista de um item, e é para ela que a lista de um item
 * volta ao ser salva. Lista vazia — ou lista com item ilegível — é condição
 * ilegível, e condição ilegível MOSTRA o campo (o fail-open de baixo).
 *
 * FORA, de propósito: referência a campo de outro card (o campo do contato
 * mora em outra tabela e não está na lista do funil do negócio) e aninhamento
 * (um grupo `todas` dentro de um `qualquer`). O caso real que abriu a issue é
 * plano, e grupo aninhado não tem tela que o monte sem virar árvore.
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

/** Os operadores da issue #2728 — e o único vocabulário que o editor oferece. */
export const OPERADORES_DE_MOSTRA = ["igual", "contem", "maior_que"] as const;
export type OperadorDeMostra = (typeof OPERADORES_DE_MOSTRA)[number];

/**
 * Os modos da lista de condições (#4041): "qualquer uma delas" (OU, o padrão) e
 * "todas elas" (E). É o mesmo vocabulário no editor, no schema e na leitura —
 * não há segundo nome para a mesma pergunta em lugar nenhum.
 */
export const MODOS_DE_CONDICAO = ["qualquer", "todas"] as const;
export type ModoDeCondicao = (typeof MODOS_DE_CONDICAO)[number];

/** O teto da lista: acima disto a tela não é conferível a olho. */
export const MAXIMO_DE_CONDICOES = 20;

/** O valor que a condição espera: texto ("Outro"), número (`criancas > 2`) ou booleano. */
export type ValorDaCondicao = string | number | boolean;

/**
 * UMA condição, nos dois formatos graváveis que ela pode chegar:
 *
 *   - `{ campo: "tipo_servico", contem: "Outro" }` — o da própria issue, em
 *     que o operador É a chave;
 *   - `{ campo, operador, valor }` — a forma par que o editor monta ao digitar.
 */
export interface CondicaoDeMostra {
  /** A chave do OUTRO campo — o que manda na condição. */
  campo: string;
  /** Forma par (a que o editor escreve). */
  operador?: OperadorDeMostra;
  valor?: ValorDaCondicao;
  /** Forma da issue: o operador é a chave. */
  igual?: ValorDaCondicao;
  contem?: ValorDaCondicao;
  maior_que?: ValorDaCondicao;
}

/**
 * A LISTA de condições (#4041) — o OU (e, quando o dono do funil escolher, o E).
 *
 * `modo` ausente vale `qualquer`: é o pedido da issue, e é o lado que não
 * surpreende quem só olha a lista.
 */
export interface ListaDeCondicoes {
  modo?: ModoDeCondicao;
  condicoes: CondicaoDeMostra[];
}

/** O que `CustomFieldDef.mostrar_quando` carrega: uma condição OU uma lista. */
export type MostrarQuando = CondicaoDeMostra | ListaDeCondicoes;

/**
 * O valor que a condição espera — e em branco não é valor: é a metade de uma
 * condição que ainda não terminou de ser montada, e ela não grava.
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
 * A condição ÚNICA, no formato gravável — e exportada porque a tela precisa
 * conferir UMA condição de cada vez: a linha meio preenchida de uma lista não
 * pode derrubar as outras.
 */
export const condicaoDeMostraSchema = z
  .object({
    campo: z.string().min(1).max(80),
    operador: z.enum(OPERADORES_DE_MOSTRA).optional(),
    valor: valorDaCondicao.optional(),
    igual: valorDaCondicao.optional(),
    contem: valorDaCondicao.optional(),
    maior_que: valorDaCondicao.optional(),
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

/**
 * A LISTA de condições (#4041). Lista VAZIA é recusada: `[]` casaria com nada
 * no modo `qualquer` e com tudo no `todas` — os dois resultados escondem ou
 * mostram o campo por um valor que ninguém digitou. Quem quer "sem condição"
 * apaga a chave, que é o que a tela faz ao remover a última condição.
 */
export const listaDeCondicoesSchema = z.object({
  modo: z.enum(MODOS_DE_CONDICAO).optional(),
  condicoes: z.array(condicaoDeMostraSchema).min(1).max(MAXIMO_DE_CONDICOES),
});

/**
 * O que se GRAVA em `mostrar_quando`: a condição única de sempre (o JSON de
 * todo funil que já existe) ou a lista (#4041). As duas formas entram pela
 * mesma porta, e nenhuma delas passa a exigir a outra.
 */
export const mostrarQuandoSchema: z.ZodType<MostrarQuando> = z.union([
  condicaoDeMostraSchema,
  listaDeCondicoesSchema,
]);

/** Os valores gravados do registro — `custom_fields` é jsonb livre. */
type Valores = Record<string, unknown> | null | undefined;

interface CondicaoLida {
  campo: string;
  operador: OperadorDeMostra;
  valor: unknown;
}

interface ListaLida {
  modo: ModoDeCondicao;
  condicoes: CondicaoLida[];
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

/**
 * A LEITURA da condição gravada, já como lista — a condição única vira uma
 * lista de um item, e é isso que faz o JSON antigo valer sem conversão.
 *
 * `null` significa "ilegível": nada gravado, formato desconhecido, `campo` em
 * branco, operador fora do vocabulário, ou lista com item ilegível. Quem chama
 * decide o que fazer com isso, e as duas respostas são opostas de propósito:
 * mostrar (visibilidade) e não cobrar (obrigatoriedade, #3036).
 */
function leituraDe(bruta: unknown): ListaLida | null {
  if (!bruta || typeof bruta !== "object" || Array.isArray(bruta)) return null;
  const crua = bruta as Record<string, unknown>;

  if (Array.isArray(crua.condicoes)) {
    const condicoes: CondicaoLida[] = [];
    for (const item of crua.condicoes) {
      const lida = condicaoDe(item);
      // Um item ilegível contamina a lista: sem ele não dá para saber se o OU
      // estava satisfeito, e chutar "satisfeito" esconderia dado por lixo.
      if (!lida) return null;
      condicoes.push(lida);
    }
    if (condicoes.length === 0) return null;
    return { modo: crua.modo === "todas" ? "todas" : "qualquer", condicoes };
  }

  const unica = condicaoDe(bruta);
  if (!unica) return null;
  return { modo: "qualquer", condicoes: [unica] };
}

function testa(condicao: CondicaoLida, gravado: unknown): boolean {
  const { operador, valor } = condicao;

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

/** Uma condição já lida contra os valores gravados: valor ausente não casa. */
function casa(condicao: CondicaoLida, valores: Valores): boolean {
  const gravado = (valores ?? {})[condicao.campo];
  if (!presente(gravado)) return false;
  return testa(condicao, gravado);
}

/**
 * A CONDIÇÃO CASOU? — a metade de baixo de `campoVisivel` (#2728) e a pergunta
 * da OBRIGATORIEDADE condicional (#3036): uma função só, para "aparece?" e
 * "cobra?" nunca divergirem.
 *
 * Sem condição, ou condição ilegível, devolve `false` — o oposto de
 * `campoVisivel`, e de propósito: existe um chamador (o "exigir só quando" do
 * #3036) para quem `true` obrigaria TODO campo do funil, e exigir por lixo no
 * banco travaria a escrita por uma regra que ninguém consegue ler.
 */
export function condicaoCasa(bruta: unknown, valores: Valores): boolean {
  const lida = leituraDe(bruta);
  if (!lida) return false;
  return lida.modo === "todas"
    ? lida.condicoes.every((condicao) => casa(condicao, valores))
    : lida.condicoes.some((condicao) => casa(condicao, valores));
}

/**
 * O campo aparece? — a pergunta única de quem renderiza.
 *
 * `bruta` é `unknown` de propósito: a condição vem de jsonb, e a borda que
 * garante o formato é o `mostrarQuandoSchema` na gravação, não esta leitura.
 */
export function campoVisivel(bruta: unknown, valores: Valores): boolean {
  // Sem condição (ou condição ilegível) = mostrar: o funil de sempre, byte a byte.
  if (!leituraDe(bruta)) return true;
  return condicaoCasa(bruta, valores);
}

/**
 * As condições DECLARADAS de um campo, na forma par e em lista — é o que o
 * editor precisa para desenhar uma linha por condição. O JSON antigo
 * (`{campo, contem: "Outro"}`) sai como `{campo, operador: "contem", valor}`.
 *
 * A leitura aqui é TOLERANTE de propósito, ao contrário de `leituraDe`: uma
 * linha ainda em branco (a pessoa acabou de clicar em "+ condição") tem de
 * chegar à tela como linha vazia, e não derrubar as outras. Quem decide o que
 * GRAVA é `normalizaMostrarQuando`, linha por linha.
 */
export function condicoesDeclaradas(bruta: unknown): CondicaoDeMostra[] {
  if (!bruta || typeof bruta !== "object" || Array.isArray(bruta)) return [];
  const crua = bruta as Record<string, unknown>;
  const itens = Array.isArray(crua.condicoes) ? crua.condicoes : [bruta];
  const deLista = Array.isArray(crua.condicoes);
  const linhas: CondicaoDeMostra[] = [];

  for (const item of itens) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const declarada = item as Record<string, unknown>;
    const campo = typeof declarada.campo === "string" ? declarada.campo.trim() : "";
    const emChave = OPERADORES_DE_MOSTRA.find((op) => declarada[op] !== undefined);
    // `{}` (ou um objeto sem campo e sem operador) não é condição nenhuma: é o
    // resto de uma condição apagada, e não vira linha na tela. Dentro de uma
    // LISTA é diferente: a linha vazia é o que o "+ condição" acabou de criar e
    // TEM de aparecer — e só toda linha da lista virando uma linha de tela é
    // que a posição que a tela usa (remover/editar) casa com o item do JSON.
    if (!deLista && campo.length === 0 && !emChave && declarada.operador === undefined) continue;
    const operador: OperadorDeMostra = (OPERADORES_DE_MOSTRA as readonly string[]).includes(
      String(declarada.operador),
    )
      ? (declarada.operador as OperadorDeMostra)
      : (emChave ?? "igual");
    const bruto = declarada.operador !== undefined ? declarada.valor : declarada[operador];
    const valor =
      typeof bruto === "string" || typeof bruto === "number" || typeof bruto === "boolean"
        ? bruto
        : undefined;
    linhas.push({ campo, operador, ...(valor !== undefined ? { valor } : {}) });
  }

  return linhas;
}

/**
 * O modo declarado — `todas` só quando está escrito; o resto é `qualquer`.
 *
 * TOLERANTE como `condicoesDeclaradas`, e não por `leituraDe`: a linha em
 * branco do "+ condição" deixa a lista ilegível para a leitura, e o modo lido
 * por ali voltava a `qualquer` — o seletor desfazia o "todas" e o save gravava
 * um OU onde a pessoa escolheu E.
 */
export function modoDeclarado(bruta: unknown): ModoDeCondicao {
  if (!bruta || typeof bruta !== "object" || Array.isArray(bruta)) return "qualquer";
  return (bruta as Record<string, unknown>).modo === "todas" ? "todas" : "qualquer";
}

/**
 * Os campos que a tela renderiza ESTA vez — e a ÚNICA régua de quem aparece,
 * para a tela (`CustomFieldsEditor`) e para o servidor (`validaCamposExigidos`).
 *
 * Ela olha a LISTA, não só a condição, e por isso fecha quatro casos que a
 * condição sozinha não vê:
 *
 *   - campo que manda APAGADO ou RENOMEADO → a condição aponta para nada, é
 *     ilegível, e o campo APARECE (o mesmo fail-open de cima). Sem isto o
 *     dependente sumia para sempre de todo lead, sem aviso;
 *   - LAÇO (A depende de B que depende de A, ou mais longo) → ninguém do laço
 *     conseguiria aparecer primeiro; a condição é ilegível e o campo APARECE.
 *     Com várias condições basta UM dos campos que mandam fechar o laço;
 *   - campo que manda ESCONDIDO → aquela condição não responde, mesmo que o
 *     valor antigo case. No modo `qualquer` as outras ainda podem responder;
 *     no `todas`, o dependente some;
 *   - lista cujas condições apontam TODAS para campo inexistente → cada uma é
 *     ilegível e o campo APARECE (senão ele sumiria de vez).
 *
 * Devolve uma lista NOVA — `campos` e `valores` ficam intocados, que é
 * exatamente a promessa da issue: esconder não apaga o que estava gravado.
 */
export function camposVisiveis<T extends { key: string; mostrar_quando?: unknown }>(
  campos: readonly T[],
  valores: Valores,
): T[] {
  const porChave = new Map(campos.map((campo) => [campo.key, campo]));

  /** Seguindo QUAISQUER dos campos que mandam, a cadeia volta a este campo? */
  const emLaco = (campo: T): boolean => {
    const vistos = new Set<string>();
    const pilha: T[] = [campo];
    while (pilha.length > 0) {
      const atual = pilha.pop();
      if (!atual) break;
      const lida = leituraDe(atual.mostrar_quando);
      if (!lida) continue;
      for (const condicao of lida.condicoes) {
        if (condicao.campo === campo.key) return true;
        if (vistos.has(condicao.campo)) continue;
        vistos.add(condicao.campo);
        const quemManda = porChave.get(condicao.campo);
        if (quemManda) pilha.push(quemManda);
      }
    }
    return false;
  };

  const visivel = (campo: T): boolean => {
    const lida = leituraDe(campo.mostrar_quando);
    if (!lida) return true;
    // Sem laço, a recursão termina: a cadeia acaba num campo sem condição, num
    // campo que manda inexistente ou num membro de laço (que responde `true`).
    if (emLaco(campo)) return true;
    const respostas = lida.condicoes.map((condicao) => {
      const quemManda = porChave.get(condicao.campo);
      // Condição apontando para campo que não existe é ilegível: responde
      // `true`, o mesmo fail-open do topo — e é o que impede o dependente de
      // sumir para sempre quando o dono do funil renomeia o campo de origem.
      if (!quemManda) return true;
      return visivel(quemManda) && casa(condicao, valores);
    });
    return lida.modo === "todas" ? respostas.every(Boolean) : respostas.some(Boolean);
  };

  return campos.filter(visivel);
}

