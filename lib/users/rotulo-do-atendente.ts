/**
 * O rótulo de quem atende — UM lugar para as telas que precisam dele (#3023).
 *
 * ## O defeito que este arquivo existe para consertar
 *
 * Membro sem `full_name` no cadastro (service role fora do ar, perfil antigo sem
 * nome, convite nunca completado) aparecia na tela de jeitos diferentes, e quase
 * todos errados: o seletor de transferência montava `Atendente 4fa3a91c` — os
 * oito primeiros dígitos do `user_id` —, a menção do compositor escrevia o mesmo
 * `uuid8` (que ia parar GRAVADO no corpo da nota), a carteira do contato e a
 * auditoria mostravam o **uuid inteiro**, e o resto das telas improvisava
 * `"Sem nome"`, `"Membro sem nome"` ou `Atendente <uuid8>`. O `user_id` é
 * identificador interno: não é nome, muda de instalação para instalação, não
 * ajuda ninguém a reconhecer a pessoa e vaza um pedaço de uuid para dentro de
 * texto que circula (a nota é lida por colegas e notifica quem foi mencionado).
 *
 * ## A RÉGUA (uma só, para todas as telas)
 *
 * `rotuloDoMembro` decide nesta ordem, e para no primeiro passo que render texto:
 *
 *   1. `full_name` com conteúdo depois do `trim` — o nome cadastrado, como está;
 *   2. `email` com conteúdo — quem não tem nome ainda é reconhecível pelo
 *      endereço. Só aparece onde a tela JÁ recebe o e-mail (`/api/v1/team`);
 *      `/api/v1/team/assignable` segue omitindo-o, e expô-lo ali continua
 *      pergunta de LGPD em aberto na #3023;
 *   3. `"Atendente" + sufixo curto e ESTÁVEL` — hash do `user_id`, não um pedaço
 *      dele. Dois membros sem nome e sem e-mail continuam distinguíveis na lista,
 *      e o sufixo não deixa ninguém reconstruir o uuid lendo a tela;
 *   4. `"Atendente sem nome"` — quando nem `user_id` existe (rascunho de
 *      formulário, DTO parcial). Ainda é o mesmo texto, nunca um uuid.
 *
 * O que a régua NUNCA devolve: o uuid inteiro, o uuid cru, ou os 8 primeiros
 * caracteres do uuid (era exatamente o que a issue fotografou como defeito).
 *
 * `full_name` em branco conta como sem nome: `"   "` não é nome de ninguém, e
 * sem o `trim` a lista mostraria uma linha vazia e o `<Select>` do shadcn uma
 * opção em branco. O mesmo vale para o e-mail.
 *
 * ## Por que aqui, e não em `lib/membros/rotulo.ts`
 *
 * Este módulo já existia com o rótulo do atendente e é de onde o
 * `ReassignDialog` e o `MentionMenu` leem — a #3023 pede UM helper, não um
 * segundo ao lado do primeiro. Criar `lib/membros/rotulo.ts` agora daria duas
 * casas para a mesma régua e a próxima tela escolheria a que visse primeiro. O
 * nome `lib/users/` segue a pasta dos outros dois módulos de nome de usuário
 * (`nome-do-atendente.ts`, `com-nome-do-atendente.ts`).
 *
 * Puro de propósito, sem I/O: é chamado dentro do `map` de uma lista a cada
 * render. Todo o custo do nome mora no servidor (`lib/users/nome-do-atendente.ts`,
 * `lib/users/com-nome-do-atendente.ts`) — aqui só se decide o que a tela escreve.
 *
 * LGPD: o rótulo expõe o `full_name` (ou o e-mail) que a própria tela já
 * recebia do servidor. Nada além disso — nunca `user_metadata` inteiro, nunca
 * telefone.
 */

/**
 * A chave i18n do rótulo de quem não tem nome NEM e-mail NEM id. Vive aqui, e
 * não na tela, para todas as telas pedirem a MESMA tradução —
 * `lib/i18n/dicionario.ts` já tem esta chave com o espanhol.
 */
export const ROTULO_ATENDENTE_SEM_NOME = "Atendente sem nome";

/** A chave i18n do prefixo de quem tem id mas nenhum nome: `Atendente 7K2P`. */
export const ROTULO_ATENDENTE = "Atendente";

/** O `t` do `useT()` (`lib/i18n/IdiomaProvider.tsx`): chave → texto no idioma. */
export type Tradutor = (texto: string) => string;

/** Identidade mínima que qualquer tela já tem em mãos sobre um membro. */
export interface MembroRotulavel {
  full_name?: string | null;
  email?: string | null;
  user_id?: string | null;
}

/** Texto com conteúdo, já sem espaços nas pontas; `null` para vazio/ausente. */
function comConteudo(valor: string | null | undefined): string | null {
  const limpo = valor?.trim();
  return limpo ? limpo : null;
}

/**
 * Sufixo curto, estável e derivado do `user_id` — NUNCA um pedaço dele.
 *
 * FNV-1a de 32 bits em base 36, quatro caracteres em maiúsculas. Estável porque
 * o mesmo id sempre produz o mesmo hash (mesma tela, mesmo idioma, mesmo
 * servidor, entre renders e entre instalações); curto porque é para caber num
 * `SelectItem` ao lado de "Atendente"; e hash porque o defeito da #3023 era
 * justamente vazar dígitos do uuid — quem lê "Atendente 7K2P" não consegue
 * montar o `user_id` a partir disso.
 */
export function sufixoDoMembro(user_id: string | null | undefined): string | null {
  const id = comConteudo(user_id);
  if (!id) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    // Multiplicação FNV (2^24 + 2^8 + 0x93) em aritmética de 32 bits.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(4, "0").slice(-4);
}

/**
 * A régua: nome → e-mail → `Atendente <sufixo>` → `Atendente sem nome`.
 *
 * Recebe o objeto do membro (e não campos soltos) para o chamador não escolher
 * a ordem por acidente: passar `full_name` e `user_id` já basta, e quem tem
 * `email` também passa. `t` é opcional para teste puro fora do React.
 */
export function rotuloDoMembro(
  membro: MembroRotulavel,
  t: Tradutor = (texto) => texto,
): string {
  const nome = comConteudo(membro.full_name);
  if (nome) return nome;

  const email = comConteudo(membro.email);
  if (email) return email;

  const sufixo = sufixoDoMembro(membro.user_id);
  if (sufixo) return `${t(ROTULO_ATENDENTE)} ${sufixo}`;

  return t(ROTULO_ATENDENTE_SEM_NOME);
}

/**
 * Compatibilidade: o rótulo a partir do nome solto, como o `ReassignDialog` e o
 * `MentionMenu` já chamavam. Delega para `rotuloDoMembro` — a régua é uma só, e
 * esta função não decide nada por conta própria (sem nome, sem id: o rótulo
 * genérico).
 */
export function rotuloDoAtendente(
  full_name: string | null | undefined,
  t: Tradutor,
): string {
  return rotuloDoMembro({ full_name }, t);
}
