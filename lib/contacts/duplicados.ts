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

/** Por que estes dois registros caíram no mesmo grupo. */
export type MotivoDeDuplicidade = "telefone" | "email" | "telefone_em_conflito";

/**
 * O recorte de `contacts` que a detecção precisa. Deliberadamente menor que
 * `Contact`: a detecção é pura e roda igual no servidor e no teste.
 */
export interface ContatoParaDeduplicar {
  id: string;
  name: string | null;
  display_name: string | null;
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

/** Chave de agrupamento por e-mail, para o clone sem índice único. */
export function chaveDeEmail(contato: ContatoParaDeduplicar): string {
  const bruto = contato.email_normalized ?? contato.email;
  return (bruto ?? "").trim().toLowerCase();
}

/** O telefone que a ingestão parkou por já pertencer a outro contato vivo. */
export function telefoneEmConflito(contato: ContatoParaDeduplicar): string {
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
