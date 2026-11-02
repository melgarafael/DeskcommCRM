/**
 * Contatos duplicados — quem é a MESMA pessoa cadastrada duas vezes.
 *
 * ─── Por que isto não é código morto num banco com índice único ─────────────
 * `contacts` tem três índices ÚNICOS PARCIAIS — telefone, e-mail normalizado e
 * hash de CPF — todos com `where ... and is_merged_into is null`. Num banco
 * saudável, portanto, duas linhas ATIVAS nunca repetem a MESMA string. A
 * duplicata real chega por dois caminhos que o índice não vê:
 *
 *  1. **Grafias diferentes do mesmo número.** `+553198966398` (12 dígitos, como
 *     o WhatsApp às vezes entrega o `wa_id`) e `+5531998966398` (13, como o
 *     brasileiro digita) são strings distintas para o Postgres e a mesma pessoa
 *     para o mundo. É o nono dígito, já tratado em `lib/channels/phone-variants`.
 *  2. **O conflito que a ingestão PARKOU de propósito.** Quando o webhook do
 *     WhatsApp descobre que o contato @lid tem um telefone que já pertence a
 *     outro contato vivo, `fn_upsert_wa_contact` não funde — grava o número em
 *     `source_metadata.telefone_em_conflito` e, nas palavras da própria
 *     migration, "a decisão de fundir fica para quem opera". Este módulo é o que
 *     leva essa decisão até quem opera.
 *
 * A igualdade EXATA continua sendo procurada porque o índice único é criado com
 * `if not exists` e o `update.sh` do clone roda **sem** `ON_ERROR_STOP`: numa
 * instalação onde a criação falhou (dados já duplicados na época), o índice
 * simplesmente não existe e a duplicata exata é possível. Procurar por ela custa
 * seis linhas e é a única coisa que enxerga esse clone.
 *
 * ─── Vocabulário ────────────────────────────────────────────────────────────
 * Contato é contato em todo nicho — não passa pelo `vocabulary` do funil, que
 * renomeia lead/deal/won/lost. Nada aqui conhece "Paciente", "Cliente" ou etapa.
 */
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";

/**
 * Por que estes dois registros caíram no mesmo grupo.
 *
 * `nome_parecido` é o único que NÃO é igualdade: o nome sugere, não prova (Spec 31,
 * B6/B7). Por isso a varredura o entrega em grupos separados, e a tela o mostra em
 * "Parecidos — confira", depois dos motivos fortes.
 */
export type MotivoDeDuplicidade = "telefone" | "email" | "telefone_em_conflito" | "nome_parecido";

/**
 * O recorte de `contacts` que a detecção precisa. Deliberadamente menor que
 * `Contact`: a detecção é pura e roda igual no servidor e no teste.
 */
export interface ContatoParaDeduplicar {
  id: string;
  name: string | null;
  display_name: string | null;
  /**
   * Nome salvo na agenda do celular. Opcional na leitura: quem monta o objeto sem
   * o campo (testes antigos) continua válido, e `undefined` vale como `null`.
   */
  address_book_name?: string | null;
  email: string | null;
  email_normalized: string | null;
  phone_number: string | null;
  is_merged_into: string | null;
  is_anonymized: boolean;
  source_metadata: Record<string, unknown> | null;
  created_at: string;
  last_activity_at: string | null;
}

export interface GrupoDeDuplicados {
  /** Estável entre chamadas: o menor id do grupo. Serve de `key` de lista. */
  chave: string;
  motivos: MotivoDeDuplicidade[];
  /** Ordenado: o mais antigo primeiro — é o candidato natural a principal. */
  contatos: ContatoParaDeduplicar[];
}

/** Chave de agrupamento por telefone: a forma canônica de CRM (BR com o nono). */
export function chaveDeTelefone(valor: string | null | undefined): string {
  if (!valor || !valor.trim()) return "";
  const canonico = canonicalPhoneBR(valor);
  return canonico.replace(/\D/g, "");
}

/**
 * Chave de agrupamento por e-mail, para o clone sem índice único.
 * O tipo é o recorte mínimo: a leitura da dispensa (`dispensar-par.ts`) monta só
 * estes campos, e não precisa fingir ser uma ficha inteira.
 */
export function chaveDeEmail(contato: Pick<ContatoParaDeduplicar, "email" | "email_normalized">): string {
  const bruto = contato.email_normalized ?? contato.email;
  return (bruto ?? "").trim().toLowerCase();
}

/** O telefone que a ingestão parkou por já pertencer a outro contato vivo. */
export function telefoneEmConflito(contato: Pick<ContatoParaDeduplicar, "source_metadata">): string {
  const valor = contato.source_metadata?.["telefone_em_conflito"];
  return typeof valor === "string" ? chaveDeTelefone(valor) : "";
}

/**
 * Um contato só é candidato se está VIVO.
 *
 * `is_merged_into` já resolvido sai porque a fusão dele acabou. Anonimizado sai
 * porque L-04 é irreversível: reencaixar a linha anonimizada num contato ativo
 * a traria de volta ao atendimento pela porta dos fundos.
 */
export function elegivelParaMesclagem(contato: ContatoParaDeduplicar): boolean {
  return contato.is_merged_into === null && !contato.is_anonymized;
}

/**
 * Agrupa os contatos em componentes conexos sobre "é a mesma pessoa".
 *
 * Componente conexo, e não um grupo por critério, porque os critérios se
 * encadeiam: A e B compartilham o telefone, B e C o e-mail — os três são a mesma
 * pessoa e oferecer duas fusões separadas produziria a segunda já inválida (a
 * primeira teria mesclado B). Union-find resolve isso em uma passada.
 */
export function encontrarContatosDuplicados(
  contatos: ContatoParaDeduplicar[],
): GrupoDeDuplicados[] {
  const vivos = contatos.filter(elegivelParaMesclagem);

  const pai = new Map<string, string>();
  const motivosPorAresta = new Map<string, Set<MotivoDeDuplicidade>>();
  for (const contato of vivos) pai.set(contato.id, contato.id);

  const raiz = (id: string): string => {
    let atual = id;
    while (pai.get(atual) !== atual) {
      const acima = pai.get(atual)!;
      pai.set(atual, pai.get(acima)!);
      atual = pai.get(atual)!;
    }
    return atual;
  };
  const unir = (a: string, b: string, motivo: MotivoDeDuplicidade) => {
    const ra = raiz(a);
    const rb = raiz(b);
    const alvo = ra < rb ? ra : rb;
    const outro = ra < rb ? rb : ra;
    if (ra !== rb) pai.set(outro, alvo);
    for (const id of [a, b]) {
      const conjunto = motivosPorAresta.get(id) ?? new Set<MotivoDeDuplicidade>();
      conjunto.add(motivo);
      motivosPorAresta.set(id, conjunto);
    }
  };

  const porTelefone = new Map<string, string[]>();
  const porEmail = new Map<string, string[]>();
  for (const contato of vivos) {
    const telefone = chaveDeTelefone(contato.phone_number);
    if (telefone) porTelefone.set(telefone, [...(porTelefone.get(telefone) ?? []), contato.id]);
    const email = chaveDeEmail(contato);
    if (email) porEmail.set(email, [...(porEmail.get(email) ?? []), contato.id]);
  }

  for (const ids of porTelefone.values()) {
    for (let i = 1; i < ids.length; i++) unir(ids[0]!, ids[i]!, "telefone");
  }
  for (const ids of porEmail.values()) {
    for (let i = 1; i < ids.length; i++) unir(ids[0]!, ids[i]!, "email");
  }
  for (const contato of vivos) {
    const conflito = telefoneEmConflito(contato);
    if (!conflito) continue;
    for (const outroId of porTelefone.get(conflito) ?? []) {
      if (outroId !== contato.id) unir(contato.id, outroId, "telefone_em_conflito");
    }
  }

  const grupos = new Map<string, ContatoParaDeduplicar[]>();
  for (const contato of vivos) {
    const r = raiz(contato.id);
    grupos.set(r, [...(grupos.get(r) ?? []), contato]);
  }

  return [...grupos.entries()]
    .filter(([, membros]) => membros.length > 1)
    .map(([chave, membros]) => {
      const ordenados = [...membros].sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      );
      const motivos = new Set<MotivoDeDuplicidade>();
      for (const membro of ordenados) {
        for (const motivo of motivosPorAresta.get(membro.id) ?? []) motivos.add(motivo);
      }
      return {
        chave,
        motivos: [...motivos].sort(),
        contatos: ordenados,
      };
    })
    .sort((a, b) => a.chave.localeCompare(b.chave));
}

/**
 * Quem o produto sugere manter: o contato com atividade mais recente e, no
 * empate, o mais antigo. Atividade recente é o que o atendente tem aberto na
 * frente; a antiguidade desempata sem sortear.
 *
 * É SUGESTÃO — quem decide é quem opera, na tela. Nunca aplicada sozinha.
 */
export function principalSugerido(grupo: GrupoDeDuplicados): string {
  const ordenado = [...grupo.contatos].sort((a, b) => {
    const atividade = (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "");
    if (atividade !== 0) return atividade;
    return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  });
  return ordenado[0]!.id;
}

/*
 * ─── Nome parecido (Spec 31, PR A) ──────────────────────────────────────────────
 *
 * Telefone e e-mail são igualdade; o nome não é. A mesma empresa entra com dois
 * telefones e vira duas fichas (B1), e é o nome que as liga — mas o nome sozinho
 * também junta gente diferente: a palavra do nicho ("Odontologia") casa com meia
 * base. Por isso a régua é de RARIDADE: só conta a palavra que aparece em poucas
 * fichas. Endereço, site e rede não entram aqui de propósito (B2–B4: 0 de 52 reais).
 */

/**
 * Rara = aparece em até 3 fichas varridas. Medida em B6 da Spec 31: com esta régua
 * a base de 260 fichas dá 4 pares, 1 real. Base maior dá menos pares, nunca mais.
 */
export const TETO_DA_PALAVRA_RARA = 3;

/** Palavras de ligação e títulos: não distinguem uma empresa de outra. */
const PALAVRAS_DE_LIGACAO = new Set(["de", "da", "do", "das", "dos", "e", "em", "a", "o", "dr", "dra"]);

/** Nome inteiro contido no outro só vale com este tamanho mínimo, em letras (B7). */
const LETRAS_MINIMAS_DO_NOME_CONTIDO = 6;

/**
 * O nome que a varredura compara: o primeiro não vazio entre `name`, `display_name`
 * e `address_book_name`. A ficha que nasce do WhatsApp pode não ter `name` — e é
 * nesse caso que ler só `name` deixaria o par de fora.
 */
export function nomeDoContatoParaComparar(
  contato: Pick<ContatoParaDeduplicar, "name" | "display_name" | "address_book_name">,
): string {
  for (const valor of [contato.name, contato.display_name, contato.address_book_name]) {
    const limpo = (valor ?? "").trim();
    if (limpo) return limpo;
  }
  return "";
}

/**
 * As palavras que comparam dois nomes: minúsculas, sem acento, sem pontuação, sem
 * palavra de ligação e sem repetição. Mantém a ordem da primeira aparição.
 */
export function palavrasDoNome(nome: string): string[] {
  const normal = nome.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const vistas = new Set<string>();
  for (const palavra of normal.split(/[^\p{L}\p{N}]+/u)) {
    if (!palavra || PALAVRAS_DE_LIGACAO.has(palavra)) continue;
    vistas.add(palavra);
  }
  return [...vistas];
}

/**
 * A chave de um PAR de fichas: os dois ids em ordem crescente, unidos por `:`.
 * A-B e B-A são o mesmo par. É a mesma forma em que a dispensa grava
 * `merge_queue.candidates` (em ordem crescente), por isso a comparação funciona
 * entre a varredura e o banco.
 */
export function parDeContatos(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Os dois já estão ligados por motivo FORTE, pela mesma regra de
 * `encontrarContatosDuplicados`: mesmo telefone, mesmo e-mail, ou o telefone em
 * conflito de um apontando para o outro. Um par assim não é sugestão de nome e não
 * se dispensa: "mesmo telefone ou mesmo e-mail não se dispensa: junte as fichas".
 */
export function ligadosPorMotivoForte(
  a: Pick<ContatoParaDeduplicar, "phone_number" | "email" | "email_normalized" | "source_metadata">,
  b: Pick<ContatoParaDeduplicar, "phone_number" | "email" | "email_normalized" | "source_metadata">,
): boolean {
  const telefoneA = chaveDeTelefone(a.phone_number);
  const telefoneB = chaveDeTelefone(b.phone_number);
  if (telefoneA && telefoneA === telefoneB) return true;
  const emailA = chaveDeEmail(a);
  if (emailA && emailA === chaveDeEmail(b)) return true;
  const conflitoA = telefoneEmConflito(a);
  if (conflitoA && conflitoA === telefoneB) return true;
  const conflitoB = telefoneEmConflito(b);
  return Boolean(conflitoB && conflitoB === telefoneA);
}

/**
 * Pares de fichas que parecem a mesma empresa pelo NOME. Cada par é uma sugestão
 * separada — NÃO é union-find: A~B e B~C são duas sugestões, e a pessoa decide
 * cada uma. Quem já está no mesmo grupo forte (telefone, e-mail, conflito) não entra
 * aqui: ele já aparece no grupo forte.
 *
 * Um par entra quando:
 *  (a) divide DUAS OU MAIS palavras raras (até `TETO_DA_PALAVRA_RARA` fichas); ou
 *  (b) um nome inteiro, com 6 letras ou mais, aparece dentro do outro; ou
 *  (b') os nomes são idênticos — cai em (b), com o mesmo mínimo de 6 letras.
 *
 * `dispensados` são as chaves de `parDeContatos` que a pessoa já tirou da lista.
 */
export function encontrarParecidosPorNome(
  contatos: ContatoParaDeduplicar[],
  opcoes: { dispensados?: ReadonlySet<string> } = {},
): GrupoDeDuplicados[] {
  const vivos = contatos.filter(elegivelParaMesclagem);
  const dispensados = opcoes.dispensados ?? new Set<string>();
  const porId = new Map(vivos.map((c) => [c.id, c] as const));

  // Quem já está no mesmo grupo forte não vira par de nome. Superconjunto de
  // `ligadosPorMotivoForte`: pega também o par ligado pelo meio (A-tel-C-email-B).
  const grupoForteDe = new Map<string, string>();
  for (const grupo of encontrarContatosDuplicados(vivos)) {
    for (const contato of grupo.contatos) grupoForteDe.set(contato.id, grupo.chave);
  }

  // Palavras de cada ficha e, para cada palavra, as fichas em que ela aparece.
  // `push` e não `[...lista, id]`: "odontologia" em 2.000 fichas não pode copiar a
  // lista a cada ficha (seria O(n²) só na cópia).
  const palavrasDe = new Map<string, string[]>();
  const fichasDaPalavra = new Map<string, string[]>();
  for (const contato of vivos) {
    const palavras = palavrasDoNome(nomeDoContatoParaComparar(contato));
    palavrasDe.set(contato.id, palavras);
    for (const palavra of palavras) {
      const lista = fichasDaPalavra.get(palavra) ?? [];
      lista.push(contato.id);
      fichasDaPalavra.set(palavra, lista);
    }
  }

  const pares = new Map<string, [string, string]>();
  const registrar = (a: string, b: string) => {
    if (a === b) return;
    const [x, y]: [string, string] = a < b ? [a, b] : [b, a];
    pares.set(parDeContatos(x, y), [x, y]);
  };

  // (a) Índice por palavra rara: só as fichas de uma palavra rara (no máximo 3) se
  // comparam entre si. Conta quantas palavras raras cada par divide.
  const palavrasRarasEmComum = new Map<string, { a: string; b: string; n: number }>();
  for (const ids of fichasDaPalavra.values()) {
    if (ids.length > TETO_DA_PALAVRA_RARA) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const x = ids[i]!;
        const y = ids[j]!;
        const [a, b]: [string, string] = x < y ? [x, y] : [y, x];
        const chave = parDeContatos(a, b);
        const atual = palavrasRarasEmComum.get(chave) ?? { a, b, n: 0 };
        atual.n += 1;
        palavrasRarasEmComum.set(chave, atual);
      }
    }
  }
  for (const { a, b, n } of palavrasRarasEmComum.values()) {
    if (n >= 2) registrar(a, b);
  }

  // (b) Nome inteiro (igual ou contido). A comparação é DIRETA, sem índice, mas só entre nomes
  // com ≥ 6 letras: são poucos, e no teto de 2.000 fichas a conta é ~2 milhões de
  // comparações de string curta — aceitável para uma tela de limpeza.
  // Nome IGUAL entra por aqui também (contido nos dois sentidos), e só com 6 letras
  // ou mais: "João" e "João" da agenda do WhatsApp não são a mesma empresa.
  const nomesLongos: Array<{ id: string; contido: string }> = [];
  for (const contato of vivos) {
    const palavras = palavrasDe.get(contato.id) ?? [];
    if (palavras.length === 0) continue;
    const nome = palavras.join(" ");
    if (palavras.join("").length >= LETRAS_MINIMAS_DO_NOME_CONTIDO) {
      // Espaço nas pontas: " ana paula " não casa dentro de " joana paula ".
      nomesLongos.push({ id: contato.id, contido: ` ${nome} ` });
    }
  }
  for (let i = 0; i < nomesLongos.length; i++) {
    for (let j = i + 1; j < nomesLongos.length; j++) {
      const x = nomesLongos[i]!;
      const y = nomesLongos[j]!;
      const nosDoisSentidos = x.contido.includes(y.contido) || y.contido.includes(x.contido);
      if (nosDoisSentidos) registrar(x.id, y.id);
    }
  }

  const grupos: GrupoDeDuplicados[] = [];
  for (const [chavePar, [a, b]] of pares) {
    const forteA = grupoForteDe.get(a);
    if (forteA !== undefined && forteA === grupoForteDe.get(b)) continue;
    if (dispensados.has(chavePar)) continue;
    const ca = porId.get(a);
    const cb = porId.get(b);
    if (!ca || !cb) continue;
    const ordenados = [ca, cb].sort(
      (p, q) => p.created_at.localeCompare(q.created_at) || p.id.localeCompare(q.id),
    );
    grupos.push({ chave: `nome:${chavePar}`, motivos: ["nome_parecido"], contatos: ordenados });
  }
  return grupos.sort((p, q) => p.chave.localeCompare(q.chave));
}
