/**
 * "JÁ EXISTE UM AGENTE COM ESSE NOME" — o `23505` de UM índice, reconhecido num
 * lugar só (issue #3952).
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * `POST /api/v1/ai/agents` com um nome que a organização já usa furava o índice
 * `ai_agents_name_unique` e o erro cru do banco virava `500 internal_error`
 * ("Erro ao criar agent."). O mesmo valia para o `PATCH` que renomeia e para as
 * Server Actions da tela (criar, renomear, salvar rascunho): quem digitasse um
 * nome repetido lia "erro de sistema" e não tinha ideia de que o conserto era
 * trocar o nome.
 *
 * ─── Por que NÃO basta `code === "23505"` ──────────────────────────────────
 *
 * `23505` é `unique_violation` — o código GENÉRICO do Postgres para qualquer
 * índice único. `ai_agents` tem mais de um (`ai_agents_name_unique`,
 * `ai_agents_pkey`, `ai_agents_org_default_unique`), e a mesma transação de
 * criação toca `ai_agent_versions`, que tem o seu. Traduzir todo `23505` desta
 * rota para "nome repetido" seria trocar um 500 honesto por um 409 MENTIROSO:
 * quem recebesse "escolha outro nome" com o nome livre iria embora sem saber
 * que havia um defeito. Por isso o discriminador é o NOME DO ÍNDICE, e não o
 * código.
 *
 * ─── Como o índice é reconhecido ───────────────────────────────────────────
 *
 * O erro que chega do PostgREST (`@supabase/supabase-js`) tem quatro campos:
 *
 *   {
 *     code:    "23505",
 *     message: 'duplicate key value violates unique constraint "ai_agents_name_unique"',
 *     details: "Key (organization_id, name)=(<uuid>, Recepção) already exists.",
 *     hint:    null,
 *   }
 *
 * O nome do índice vive na `message`; as COLUNAS do índice, no `details`. Os
 * dois são lidos, porque driver/proxy que reescreve a mensagem (o PostgREST em
 * versões antigas devolve o texto do banco sem o nome do constraint em alguns
 * caminhos) ainda deixa o `details`. O que NÃO se faz é casar por texto solto
 * como "duplicate" na mensagem: isso casa os outros índices também.
 *
 * ─── O índice é POR ORGANIZAÇÃO ────────────────────────────────────────────
 *
 * `supabase/baseline.sql:1963` — `unique ("organization_id", "name")`. Duas
 * empresas podem ter um agente "Recepção" cada uma; o conflito só existe dentro
 * da mesma organização. É por isso que a régua olha o par e que nenhuma camada
 * desta correção faz "select por nome antes do insert": quem decide é o banco, e
 * o banco decide pelo par. (O teste de rota prende a definição lendo o baseline,
 * para a premissa não envelhecer em silêncio.)
 *
 * ─── A frase é da TELA, não daqui ──────────────────────────────────────────
 *
 * Este módulo devolve um CÓDIGO estável (`agent_name_taken`, já declarado em
 * `lib/api/errors.ts`). A frase é traduzida por quem responde — `traduzir()` na
 * rota, `t()` no formulário —, porque a mesma recusa precisa sair em pt/es/en e
 * o dicionário é a única fonte disso.
 */

/** O índice que esta régua reconhece. */
export const INDICE_NOME_DE_AGENTE = "ai_agents_name_unique";

/** O código estável da recusa (também em `lib/api/errors.ts`). */
export const CODIGO_NOME_DE_AGENTE_EM_USO = "agent_name_taken";

/** A frase em português — a CHAVE do dicionário. `traduzir`/`t` resolvem o resto. */
export const NOME_DE_AGENTE_EM_USO = "Já existe um agente com esse nome.";

/**
 * O complemento do "Salvar rascunho": o rascunho entrou, o nome do cadastro não.
 * Também é CHAVE do dicionário — o formulário traduz; o servidor só a devolve
 * em `message` para quem consome a Action sem tela.
 */
export const RASCUNHO_SALVO_NOME_NAO_MUDOU = "O rascunho foi salvo; o nome do agente não mudou.";

type ErroDoBanco = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
};

function textosDoErro(erro: unknown): string[] {
  if (!erro || typeof erro !== "object") return [];
  const { message, details, hint } = erro as ErroDoBanco;
  return [message, details, hint].filter((t): t is string => typeof t === "string" && t.length > 0);
}

/**
 * A recusa é "este nome já existe nesta organização"?
 *
 * Exige `23505` E o índice `ai_agents_name_unique`: um `23505` de outro índice
 * devolve `false` e segue o caminho de erro de sistema, que é o desfecho certo —
 * ali há um defeito para investigar, não um nome para trocar.
 */
export function ehNomeDeAgenteRepetido(erro: unknown): boolean {
  if (!erro || typeof erro !== "object") return false;
  const { code } = erro as ErroDoBanco;
  if (code !== "23505") return false;

  const textos = textosDoErro(erro);
  if (textos.some((texto) => texto.includes(INDICE_NOME_DE_AGENTE))) return true;

  // Caminho de reserva: o `details` nomeia as COLUNAS do índice vencedor —
  // `Key (organization_id, name)=(…) already exists.`. Só casa o par EXATO: um
  // `Key (organization_id)=` (índice de coluna única) não é este conflito.
  return textos.some((texto) =>
    /^Key \((organization_id, name|name, organization_id)\)=/.test(texto.trim()),
  );
}
