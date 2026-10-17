/**
 * Lê o `SHOW GRANTS` do usuário MySQL e diz, em português, se há motivo para
 * avisar (D5, camada 4 da spec). É uma AJUDA, não a garantia: a garantia são
 * `START TRANSACTION READ ONLY`, o `SELECT` gerado só por nós e o usuário só-leitura.
 *
 * Quem cola a senha do `wp-config` de um WordPress está colando um usuário com
 * todos os poderes; este aviso aparece em amarelo na tela depois do teste.
 *
 * O formato das linhas é o do MySQL (`GRANT <privilégios> ON <alvo> TO <usuário>`).
 * É conservador de propósito: tudo que NÃO for `SELECT`/`USAGE`/`SHOW VIEW`/`SHOW DATABASES`
 * conta como poder de escrita ou de administração — um falso aviso custa uma frase;
 * um aviso que faltou, um usuário com poder demais conectado ao assistente.
 */
export const AVISO_ESCRITA =
  "Este usuário do banco pode escrever. Crie um usuário só de leitura (apenas SELECT) para o assistente.";
export const AVISO_LEITURA_AMPLA =
  "Este usuário lê o banco inteiro. Libere só as tabelas e views que o assistente deve ver.";
export const AVISO_ROLE = "Não consegui conferir os papéis deste usuário. Confirme que ele só lê.";
export const AVISO_SEM_CONFERIR = "Não consegui conferir os privilégios deste usuário. Confirme que ele só lê.";

const TETO_DO_AVISO = 500;

/** O que NÃO é escrita nem administração. */
const INOFENSIVOS = new Set(["SELECT", "USAGE", "SHOW VIEW", "SHOW DATABASES"]);

const LINHA_DE_GRANT = /^GRANT\s+([\s\S]+?)\s+ON\s+([\s\S]+?)\s+TO\s+/i;
const LINHA_SEM_ALVO = /^GRANT\s+[\s\S]+?\s+TO\s+/i;
const ALVO = /^(\*|`(?:[^`]|``)*`)\.(\*|`(?:[^`]|``)*`)$/;

function desquotar(parte: string): string {
  if (parte === "*") return "*";
  return parte.slice(1, -1).replace(/``/g, "`");
}

function privilegiosDe(lista: string): string[] {
  // `SELECT (a, b)` (nível de coluna) traz vírgula dentro de parênteses.
  return lista
    .replace(/\([^)]*\)/g, "")
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter((p) => p.length > 0);
}

export function interpretarGrants(linhas: readonly string[], database: string): string | null {
  if (linhas.length === 0) return AVISO_SEM_CONFERIR;

  let escrita = false;
  let leituraAmpla = false;
  let role = false;
  let semConferir = false;

  for (const linha of linhas) {
    const casou = LINHA_DE_GRANT.exec(linha.trim());
    if (!casou) {
      if (LINHA_SEM_ALVO.test(linha.trim())) role = true;
      else semConferir = true;
      continue;
    }
    const privilegios = privilegiosDe(casou[1]!);
    const comOpcao = /\bWITH\s+GRANT\s+OPTION\b/i.test(linha);
    const todos = privilegios.includes("ALL PRIVILEGES") || privilegios.includes("ALL");

    if (comOpcao || todos || privilegios.some((p) => !INOFENSIVOS.has(p))) escrita = true;

    const alvo = ALVO.exec(casou[2]!.trim());
    if (!alvo) {
      semConferir = true;
      continue;
    }
    const banco = desquotar(alvo[1]!).replace(/\\/g, "");
    const tabela = desquotar(alvo[2]!);
    const incluiSelect = todos || privilegios.includes("SELECT");
    // `GRANT SELECT (colunas) ON banco.tabela` NÃO é o banco inteiro: só `*.*` e `banco.*`.
    if (incluiSelect && tabela === "*" && (banco === "*" || banco === database)) leituraAmpla = true;
  }

  const avisos: string[] = [];
  if (escrita) avisos.push(AVISO_ESCRITA);
  if (leituraAmpla) avisos.push(AVISO_LEITURA_AMPLA);
  if (role) avisos.push(AVISO_ROLE);
  if (semConferir) avisos.push(AVISO_SEM_CONFERIR);
  if (avisos.length === 0) return null;
  return avisos.join(" ").slice(0, TETO_DO_AVISO);
}
