/**
 * Identidades do contato — a mesma pessoa vista por cada canal.
 *
 * ─── Por que isto não é "o telefone com outro nome" ─────────────────────────
 * `contacts.phone_number` e `contacts.email` guardam UMA ocorrência de cada
 * coisa, e `contacts.social_identity` guarda um perfil que a ingestão do canal
 * gravou em jsonb. Nenhum dos três responde à pergunta desta fatia:
 * *quais caminhos levam à MESMA ficha* — o número do WhatsApp, o @ do
 * Instagram, o perfil do Facebook e o e-mail profissional da mesma pessoa.
 * Quem chama no Instagram, depois no Facebook e depois no WhatsApp nasce em até
 * três fichas, e não existe onde dizer que são a mesma.
 *
 * ─── O que mora aqui, e o que não mora ─────────────────────────────────────
 * Só as três decisões PURAS da fatia 1 da issue #3764:
 *
 *   1. **a forma canônica** do identificador por canal (`normalizarIdentificador`);
 *   2. **a sugestão de vínculo** por identificador igual (`sugerirVinculo`);
 *   3. **a junção manual** de duas fichas sem duplicar identidade (`juntarFichas`).
 *
 * Nada aqui faz I/O: quem lê e grava é `contact_identities`
 * (migration 9082), e a régua do banco é a MESMA — `fn_identificador_canonico`
 * decide a FORMA (quando o `+55` está implícito, o que é e-mail, o que é perfil)
 * e chama `fn_telefone_canonico` (9043) para o nono dígito. A duplicação lib×SQL
 * já é a da 9043 e é deliberada: normalizar só aqui deixaria a porta do
 * PostgREST aberta para gravar variante, e o `unique
 * (organization_id, canal, identificador)` viraria decorativo. As duas réguas
 * são comparadas de verdade em
 * `tests/invariants/identidades-do-contato-canonico-paridade.test.ts`.
 *
 * ─── Fora de escopo, de propósito ──────────────────────────────────────────
 * Feed único no Inbox, resposta pelo canal escolhido com janela de 24 h, IA
 * lendo o histórico unificado e carteira por cliente são os itens 2 a 5 da
 * issue. Este módulo não sabe o que é conversa.
 */
import { normalizePhoneBR } from "@/lib/channels/phone-variants";

/**
 * Os canais desta fatia. Lista FECHADA no mesmo vocabulário do CHECK de
 * `contact_identities.canal` (migration 9082) — acrescentar um canal é acrescentar
 * aqui, na constraint e na régua de normalização, na mesma entrega.
 */
export const CANAIS_DE_IDENTIDADE = ["whatsapp", "instagram", "facebook", "email"] as const;

export type CanalDeIdentidade = (typeof CANAIS_DE_IDENTIDADE)[number];

/**
 * Uma identidade já ligada a uma ficha.
 *
 * `identificador` está SEMPRE na forma canônica: é o que a tabela garante por
 * constraint, e é o que `normalizarIdentificador` devolve. Comparar identidade
 * por igualdade de string só é honesto com essa promessa de pé.
 */
export interface IdentidadeDoContato {
  contactId: string;
  canal: CanalDeIdentidade;
  identificador: string;
}

/** O que a conversa entregou: pode vir cru (como o cliente digitou). */
export interface IdentidadeApresentada {
  canal: CanalDeIdentidade;
  identificador: string | null | undefined;
}

/** Uma ficha que já tem a identidade apresentada, e por qual identidade. */
export interface SugestaoDeVinculo {
  contactId: string;
  identidade: IdentidadeDoContato;
}

/**
 * A forma canônica do identificador por canal — ou `null` quando o valor não é
 * um identificador daquele canal.
 *
 *   whatsapp   E.164 com `+`, pela regra do nono dígito (`normalizePhoneBR`):
 *              `3198966398`, `+553198966398` e `+55 31 98966-398` colapsam no
 *              mesmo `+5531998966398`.
 *   email      minúsculas, sem espaço nas pontas; sem `@` ou sem domínio não é
 *              e-mail (a mesma régua de `contacts_email_format`).
 *   instagram  o perfil, sem `@`, sem URL e em minúsculas. O Instagram não
 *              diferencia maiúsculas no handle, e `@Fulano`/`fulano` é a mesma
 *              pessoa.
 *   facebook   idem, aceitando também o id numérico (PSID) que a página entrega.
 *
 * ─── A decisão de FORMA do telefone, e de quem ela é ────────────────────────
 * Com `+`, o número é internacional: 8 a 15 dígitos. Sem `+`, 12 ou 13 dígitos
 * têm de começar com 55, e 10 ou 11 são DDD + número brasileiro (o `+55`
 * implícito). Essa decisão é a de `normalizePhoneBR`, e ela mora TAMBÉM em
 * `fn_identificador_canonico` (migration 9082) — o banco é quem grava, então é
 * ele que manda, e a lib tem de devolver exatamente o que ele devolveria.
 * Divergência aqui não dá erro em lugar nenhum: a sugestão de vínculo procura
 * uma string que a coluna nunca contém, e a pessoa nasce na segunda ficha.
 * As duas réguas são medidas lado a lado, caso a caso, em
 * `tests/invariants/identidades-do-contato-canonico-paridade.test.ts`.
 *
 * `null` em vez de `""`: valor inválido NÃO vira identidade vazia, senão duas
 * fichas "sem identificador" colidiriam no índice.
 */
export function normalizarIdentificador(
  canal: CanalDeIdentidade,
  bruto: string | null | undefined,
): string | null {
  if (typeof bruto !== "string") return null;
  const texto = bruto.trim();
  if (!texto) return null;

  switch (canal) {
    case "whatsapp":
      return normalizePhoneBR(texto);
    case "email": {
      const email = texto.toLowerCase();
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
    }
    case "instagram": {
      const perfil = perfilDaUrl(texto).toLowerCase();
      // 1..30 caracteres, letra/número/ponto/underscore: a régua do próprio
      // Instagram. Qualquer outra coisa é link colado errado, não identidade.
      return /^[a-z0-9._]{1,30}$/.test(perfil) && !/^\.+$/.test(perfil) ? perfil : null;
    }
    case "facebook": {
      const perfil = perfilDaUrl(texto).toLowerCase();
      // Mais largo que o Instagram de propósito: o Facebook aceita ponto,
      // hífen e o id numérico da página (PSID) que a Graph API devolve.
      return /^[a-z0-9._-]{1,64}$/.test(perfil) ? perfil : null;
    }
  }
}

/**
 * Tira o que o atendente cola junto com o perfil: protocolo, domínio, `@`,
 * caminho final, query (`?hl=pt`) e fragmento.
 *
 * `https://www.instagram.com/fulano/?hl=pt` e `@fulano` são a mesma pessoa, e a
 * segunda forma é a que o cliente digita no direct.
 */
function perfilDaUrl(texto: string): string {
  return texto
    .replace(/^https?:\/\//i, "")
    // `www.` e `m.` na frente de QUALQUER um dos domínios: o link do celular
    // (`https://m.instagram.com/fulano`) é o mesmo perfil, e a régua do banco
    // (`fn_identificador_canonico`) já os tirava — a lib recusava o que o banco
    // aceitava. Divergência assim não aparece em revisão: as duas regex parecem
    // iguais escritas em linguagens diferentes.
    .replace(/^(?:www\.|m\.)?(?:instagram\.com|facebook\.com|fb\.com|fb\.me)\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    // O `@` que o cliente digita no direct. Vem DEPOIS da URL: `@fulano` não é
    // URL, e `instagram.com/@fulano` também existe.
    .replace(/^@+/, "")
    .trim();
}

/**
 * A chave de comparação: canal + identificador canônico.
 *
 * O canal faz parte da chave porque `instagram:fulano` e `facebook:fulano` são
 * duas identidades, não uma — o mesmo nome em redes diferentes não prova nada
 * sobre ser a mesma pessoa.
 */
export function chaveDaIdentidade(canal: CanalDeIdentidade, identificador: string): string {
  return `${canal}:${identificador}`;
}

/**
 * Quem já tem esta identidade — a sugestão de vínculo.
 *
 * É a pergunta que a tela faz quando o cliente passa o WhatsApp no direct do
 * Instagram (ou quando o e-mail do formulário chega junto do número que já está
 * numa ficha): *esta identidade já é de alguém?* A resposta é a lista das fichas
 * donas, ordenada por id para a tela não pular de ordem entre duas leituras.
 *
 * `ignorarContatoId` é a ficha que está aberta: a identidade dela não é sugestão
 * de vínculo consigo mesma.
 *
 * A sugestão NÃO funde nada. Juntar é ação de gente — `juntarFichas` —, e a
 * issue pede as duas coisas separadas por esse motivo.
 */
export function sugerirVinculo(
  apresentada: IdentidadeApresentada,
  identidades: readonly IdentidadeDoContato[],
  opcoes: { ignorarContatoId?: string } = {},
): SugestaoDeVinculo[] {
  const normalizado = normalizarIdentificador(apresentada.canal, apresentada.identificador);
  if (normalizado === null) return [];

  const alvo = chaveDaIdentidade(apresentada.canal, normalizado);
  const achadas: SugestaoDeVinculo[] = [];
  const jaVistas = new Set<string>();

  for (const identidade of identidades) {
    if (identidade.contactId === opcoes.ignorarContatoId) continue;
    if (jaVistas.has(identidade.contactId)) continue;
    if (chaveDaIdentidade(identidade.canal, identidade.identificador) !== alvo) continue;
    jaVistas.add(identidade.contactId);
    achadas.push({ contactId: identidade.contactId, identidade });
  }

  return achadas.sort((a, b) => a.contactId.localeCompare(b.contactId));
}

/** Por que a junção foi recusada. */
export type MotivoDaRecusaDeJuncao = "mesma_ficha" | "identidade_de_terceiro";

/**
 * O desfecho da junção: ou a lista final de identidades, todas apontando para a
 * ficha principal — ou a recusa, com as identidades que a impediram.
 */
export type ResultadoDaJuncao =
  | {
      ok: true;
      /** Todas as identidades das duas fichas, sem repetição, já na principal. */
      identidades: IdentidadeDoContato[];
      /** As que já eram da principal e por isso não foram duplicadas. */
      repetidas: IdentidadeDoContato[];
    }
  | {
      ok: false;
      motivo: MotivoDaRecusaDeJuncao;
      /** As identidades que impedem a junção (vazio em `mesma_ficha`). */
      conflitos: IdentidadeDoContato[];
    };

/**
 * Junta duas fichas sem duplicar identidade.
 *
 * Regras, nesta ordem:
 *
 *   1. **A mesma ficha duas vezes é recusa** (`mesma_ficha`). Não é no-op: quem
 *      pediu para juntar A com A leu a tela errada, e devolver sucesso esconderia
 *      isso.
 *   2. **Identidade que já é de uma TERCEIRA ficha é recusa**
 *      (`identidade_de_terceiro`). O índice único é por organização, então duas
 *      fichas da mesma organização nunca deveriam ter o mesmo par — quando têm, é
 *      banco que nasceu antes do índice ou escrita direta, e juntar as duas
 *      deixaria uma das três sem dono. Recusar inteiro (e não em parte) mantém a
 *      promessa de que junção ou acontece toda, ou não acontece.
 *   3. **Identidade repetida entre as duas é COLAPSADA**, não duplicada: o par
 *      `(canal, identificador)` aparece uma vez só na saída, e a linha que sai
 *      de "absorvida" é contada em `repetidas` para quem quiser explicar a fusão
 *      na tela.
 *
 * A saída é estável (canal na ordem de `CANAIS_DE_IDENTIDADE`, depois o
 * identificador) para o teste e a tela não dependerem da ordem de entrada.
 */
export function juntarFichas(
  principalId: string,
  absorvidoId: string,
  identidades: readonly IdentidadeDoContato[],
): ResultadoDaJuncao {
  if (principalId === absorvidoId) {
    return { ok: false, motivo: "mesma_ficha", conflitos: [] };
  }

  const daPrincipal = identidades.filter((i) => i.contactId === principalId);
  const daAbsorvida = identidades.filter((i) => i.contactId === absorvidoId);
  const deTerceiros = identidades.filter(
    (i) => i.contactId !== principalId && i.contactId !== absorvidoId,
  );

  const chavesDaPrincipal = new Set(
    daPrincipal.map((i) => chaveDaIdentidade(i.canal, i.identificador)),
  );
  const conflitos = daAbsorvida.filter((i) =>
    deTerceiros.some(
      (t) =>
        t.canal === i.canal &&
        t.identificador === i.identificador,
    ),
  );
  if (conflitos.length > 0) {
    return { ok: false, motivo: "identidade_de_terceiro", conflitos };
  }

  const vistas = new Set<string>(chavesDaPrincipal);
  const repetidas: IdentidadeDoContato[] = [];
  const herdadas: IdentidadeDoContato[] = [];

  for (const identidade of daAbsorvida) {
    const chave = chaveDaIdentidade(identidade.canal, identidade.identificador);
    if (vistas.has(chave)) {
      repetidas.push(identidade);
      continue;
    }
    vistas.add(chave);
    herdadas.push({ ...identidade, contactId: principalId });
  }

  const final = [...daPrincipal.map((i) => ({ ...i })), ...herdadas].sort(compararIdentidade);
  return { ok: true, identidades: final, repetidas };
}

/** Ordem estável: canal, depois identificador. */
function compararIdentidade(a: IdentidadeDoContato, b: IdentidadeDoContato): number {
  const porCanal = CANAIS_DE_IDENTIDADE.indexOf(a.canal) - CANAIS_DE_IDENTIDADE.indexOf(b.canal);
  if (porCanal !== 0) return porCanal;
  return a.identificador.localeCompare(b.identificador);
}
