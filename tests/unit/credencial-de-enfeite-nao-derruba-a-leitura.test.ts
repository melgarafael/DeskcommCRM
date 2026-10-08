/**
 * Catraca da issue #754 — a credencial de enfeite não derruba a leitura.
 *
 * O QUE A ISSUE MEDIU
 *
 * Instalação self-host (1.17.0, Supabase): `POST /rest/v1/rpc/fn_decrypt_oauth`
 * devolvendo 500 entre 10% e 30% das chamadas, continuamente — 2 a 12 erros por
 * hora contra ~18 sucessos, em 24h de log, sem janela de normalidade.
 *
 * A CAUSA
 *
 * `public.fn_decrypt_oauth` era `return pgp_sym_decrypt(ciphertext, k);` — sem
 * olhar o que chegava. E o schema grava BYTE DE ENFEITE onde ainda não há
 * credencial: as colunas cifradas são NOT NULL (`channel_sessions
 * .webhook_secret_encrypted`, baseline:1300/1819), então "ainda não
 * configurado" virou `Buffer.from([0])` — um byte só para satisfazer a coluna.
 * O repo já sabia disso: `lib/waha/webhook-auth.ts` escreve, no próprio
 * cabeçalho, que esse "caso de exceção" era o estado PERMANENTE de toda
 * instalação. Falha quem cai no registro de enfeite — a taxa de 10-30% é a
 * heterogeneidade das LINHAS, não da chave (chave errada falharia ~100%).
 *
 * POR QUE ISSO É GATE, E NÃO SÓ UM FIX
 *
 * Quem lê já trata o erro como "sem credencial" (`lib/webhooks/secrets.ts`
 * devolve null em `error || !data`), então a tela nunca mostrou nada. O estrago
 * é o log: erro permanente nos MESMOS registros, indistinguível de chave
 * trocada ou dado corrompido — alarme que se aprende a ignorar. O que este
 * arquivo vigia é a guarda de forma que separa os dois casos.
 *
 * O QUE ESTE TESTE NÃO FAZ
 *
 * Ele não roda o SQL: `pnpm test:unit` não tem Postgres (o `test:db` exige
 * Docker e roda em job próprio). O que ele lê é o SQL que o self-host APLICA —
 * `supabase/baseline.sql` (install/update) e a migration 0240 — e cobra a
 * guarda, a ORDEM dela e a ACL. A prova comportamental, com Postgres de verdade,
 * mora em `tests/invariants/credencial-de-enfeite-nao-derruba-a-leitura.test.ts`
 * (job obrigatório `invariants`). Aqui não se afirma "a função devolve null" —
 * isso é do invariante; aqui se afirma "a guarda existe, nesta ordem, e o único
 * `pgp_sym_decrypt` do schema está dentro dela".
 *
 * VERMELHO NA BASE (medido): sem o fix, as asserções 1–4 falham — a última
 * definição de `fn_decrypt_oauth` no baseline chama `pgp_sym_decrypt` sem guarda
 * nenhuma. Com o fix, verde.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "../..");
const BASELINE = readFileSync(join(RAIZ, "supabase/baseline.sql"), "utf8");
const MIGRATIONS = join(RAIZ, "supabase/migrations");

const arquivoDaMigration = readdirSync(MIGRATIONS).find((n) =>
  n.endsWith("_0240_credencial_de_enfeite_nao_derruba_a_leitura.sql"),
);
if (!arquivoDaMigration) {
  throw new Error(
    "migration 0240 não encontrada em supabase/migrations/ — sem ela o self-host que ATUALIZA não recebe a guarda",
  );
}
const MIGRATION = readFileSync(join(MIGRATIONS, arquivoDaMigration), "utf8");

/** O piso medido: o menor pacote que `fn_encrypt_oauth` produz (texto vazio, aes256). */
const PISO_MEDIDO = 66;

interface Definicao {
  /** Índice do `create` da definição. */
  inicio: number;
  /** Índice do fim do corpo (depois do `$$;`). */
  fim: number;
  /** Texto do corpo, entre os dois `$$`. */
  corpo: string;
}

/**
 * Todas as definições de `public.<nome>` no arquivo, em ordem.
 *
 * São várias de propósito: `baseline.sql` é o dump (uma definição) + apêndices
 * idempotentes que redefinem a função (o forward-fix da 0041, esta 0240). No
 * Postgres vence a ÚLTIMA aplicada — e é ela que este teste cobra, porque é ela
 * que fica instalada na VPS de quem atualiza. O nome é parâmetro porque a
 * catraca do item 3 mede DONOS, e são dois desde a 0597 (#2522).
 */
function definicoesDeFuncao(texto: string, nome: string): Definicao[] {
  const out: Definicao[] = [];
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+("?public"?\\s*\\.\\s*)?"?${nome}"?\\s*\\(`,
    "gi",
  );
  for (const m of texto.matchAll(re)) {
    const inicio = m.index ?? 0;
    const abre = texto.indexOf("$$", inicio);
    const fecha = texto.indexOf("$$;", abre + 2);
    if (abre === -1 || fecha === -1) continue;
    out.push({ inicio, fim: fecha + 3, corpo: texto.slice(abre + 2, fecha) });
  }
  return out;
}

/** O atalho dos itens 1, 2 e 5: só `fn_decrypt_oauth`. */
function definicoesDe(texto: string): Definicao[] {
  return definicoesDeFuncao(texto, "fn_decrypt_oauth");
}

const DEFINICOES_BASELINE = definicoesDe(BASELINE);
const EFETIVA = DEFINICOES_BASELINE[DEFINICOES_BASELINE.length - 1];
// A régua inteira assume que fn_decrypt_oauth está no baseline (é o que ela
// vigia). Sem a definição não há o que medir: falhar aqui, com o motivo, é mais
// honesto do que um TypeError solto no meio de um expect.
if (!EFETIVA) throw new Error("fn_decrypt_oauth não aparece em supabase/baseline.sql");

describe("credencial de enfeite não derruba a leitura (#754)", () => {
  it("1. a definição que fica instalada tem as três guardas, na ordem, antes de decifrar", () => {
    expect(EFETIVA, "fn_decrypt_oauth não aparece no baseline").toBeDefined();
    const corpo = EFETIVA.corpo;

    const iNull = corpo.indexOf("ciphertext is null");
    const iTamanho = corpo.indexOf(String(PISO_MEDIDO));
    const iPacote = corpo.search(/get_byte\s*\(\s*ciphertext\s*,\s*0\s*\)\s*<\s*128/);
    const iDecifra = corpo.indexOf("pgp_sym_decrypt");

    expect(iNull, "falta a guarda de NULL").toBeGreaterThan(-1);
    expect(iTamanho, `falta o piso medido (${PISO_MEDIDO} bytes)`).toBeGreaterThan(-1);
    expect(iPacote, "falta a checagem de cara de pacote PGP (bit 7)").toBeGreaterThan(-1);
    expect(iDecifra, "a função não decifra mais nada").toBeGreaterThan(-1);

    // A ORDEM é o conserto: `get_byte()` em bytea vazio estoura
    // (`index 0 out of valid range, 0..-1` — medido), então o tamanho tem de
    // vir antes, e a decifra depois de todas.
    expect(iNull, "NULL depois do piso").toBeLessThan(iTamanho);
    expect(iTamanho, "o piso tem de vir antes da checagem de pacote").toBeLessThan(iPacote);
    expect(iPacote, "a checagem de pacote tem de vir antes da decifra").toBeLessThan(iDecifra);

    // O piso não pode ser "subido" para engolir pacote de verdade: 66 é o
    // MENOR pacote do par, medido. Um piso maior deixaria credencial real cair
    // como "sem credencial".
    const pisoNoSql = corpo.match(/octet_length\s*\(\s*ciphertext\s*\)\s*<\s*(\d+)/);
    expect(pisoNoSql?.[1], "piso ausente ou diferente do medido").toBe(String(PISO_MEDIDO));
  });

  it("2. o apêndice do baseline e a migration 0240 são o MESMO corpo (quem instala e quem atualiza recebem igual)", () => {
    const naMigration = definicoesDe(MIGRATION);
    expect(naMigration.length, "a migration não redefine fn_decrypt_oauth").toBe(1);
    expect(
      naMigration[0]!.corpo,
      "corpo divergente entre baseline (install) e migration 0240 (update) — quem instala do zero ficaria com outra função",
    ).toBe(EFETIVA.corpo);
  });

  it("3. todo `pgp_sym_decrypt` do schema vive num decifrador COM GUARDA (fn_decrypt_oauth ou decrypt_cpf)", () => {
    const ocorrencias = [...BASELINE.matchAll(/pgp_sym_decrypt\s*\(/g)].map((m) => m.index ?? 0);
    expect(ocorrencias.length, "sumiu o pgp_sym_decrypt do baseline?").toBeGreaterThan(0);

    // Dois donos, e cada um com a SUA guarda: `fn_decrypt_oauth` (0240, itens
    // 1–2) e `decrypt_cpf` (0597, #2522, medido no item 6 abaixo). Qualquer
    // TERCEIRO sítio — um `pgp_sym_decrypt` solto em corpo de trigger ou em
    // apêndice de migration — continua reprovando com o mesmo motivo de sempre:
    // cifra nova, guarda nova. A lista de donos não encolhe sozinha: só entra
    // aqui quem passa no item 6.
    const donas = [...DEFINICOES_BASELINE, ...definicoesDeFuncao(BASELINE, "decrypt_cpf")];
    const fora: number[] = [];
    for (const i of ocorrencias) {
      if (!donas.some((d) => d.inicio < i && i < d.fim)) fora.push(i);
    }
    expect(
      fora,
      `há um pgp_sym_decrypt() fora de fn_decrypt_oauth/decrypt_cpf (offset ${fora.join(", ")}) — cifra nova, guarda nova`,
    ).toEqual([]);

    // Sem os DOIS decifradores a lista de donos encolheria e o case passaria
    // por vacuidade — o mesmo cuidado do controle do cabeçalho.
    expect(DEFINICOES_BASELINE.length).toBeGreaterThan(0);
    expect(definicoesDeFuncao(BASELINE, "decrypt_cpf").length).toBeGreaterThan(0);
  });

  it("4. a ACL não reabre: continua só service_role", () => {
    expect(MIGRATION).toMatch(
      /grant execute on function public\.fn_decrypt_oauth\(bytea\) to service_role;/,
    );
    expect(
      MIGRATION,
      "a migration concedeu EXECUTE a anon/authenticated/public — a função lê a chave mestra",
    ).not.toMatch(
      /grant execute on function public\.fn_decrypt_oauth\(bytea\) to (public|anon|authenticated)/,
    );
  });

  it("5. o bloco de varredura anon continua sendo o ÚLTIMO do baseline (apêndice novo entra antes dele)", () => {
    const ultimoBloco = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
    const meuApendice = BASELINE.indexOf("(migration 0240)");
    expect(meuApendice, "apêndice da 0240 não está no baseline").toBeGreaterThan(-1);
    expect(
      meuApendice,
      "o apêndice da 0240 entrou DEPOIS do bloco de varredura anon, que tem de fechar o arquivo",
    ).toBeLessThan(ultimoBloco);
  });

  it("6. decrypt_cpf é a segunda porta, e ela TAMBÉM nasce com guarda, tenancy e audit (#2522)", () => {
    const noBaseline = definicoesDeFuncao(BASELINE, "decrypt_cpf");
    expect(noBaseline.length, "decrypt_cpf não aparece no baseline").toBeGreaterThan(0);
    const corpo = noBaseline[noBaseline.length - 1]!.corpo;

    const iNull = corpo.search(/v_cipher is null/);
    const iTamanho = corpo.search(/octet_length\s*\(\s*v_cipher\s*\)\s*<\s*66/);
    const iPacote = corpo.search(/get_byte\s*\(\s*v_cipher\s*,\s*0\s*\)\s*<\s*128/);
    const iTenancy = corpo.indexOf("fn_user_org_ids()");
    const iAudit = corpo.indexOf("insert into public.api_audit_log");
    const iDecifra = corpo.indexOf("pgp_sym_decrypt");

    expect(iNull, "falta a guarda de NULL").toBeGreaterThan(-1);
    expect(iTamanho, "falta o piso medido (66 bytes)").toBeGreaterThan(-1);
    expect(iPacote, "falta a checagem de cara de pacote PGP").toBeGreaterThan(-1);
    expect(iTenancy, "falta a checagem de organização do contato").toBeGreaterThan(-1);
    expect(iAudit, "falta o audit do decrypt").toBeGreaterThan(-1);
    expect(iDecifra, "a função não decifra nada").toBeGreaterThan(-1);

    // A MESMA ordem do conserto da 0240: null < piso < pacote < decifra.
    expect(iNull, "NULL depois do piso").toBeLessThan(iTamanho);
    expect(iTamanho, "o piso tem de vir antes da checagem de pacote").toBeLessThan(iPacote);
    expect(iPacote, "a checagem de pacote tem de vir antes da decifra").toBeLessThan(iDecifra);
    // Tenancy e audit ANTES de o plaintext sair da função.
    expect(iTenancy, "quem não é da organização lê o CPF antes da checagem").toBeLessThan(iDecifra);
    expect(iAudit, "decrypt sairia sem deixar rastro").toBeLessThan(iDecifra);

    // Quem instala (baseline) e quem atualiza (migration 0597) recebem igual.
    const arquivo0597 = readdirSync(MIGRATIONS).find((n) => n.includes("_0597_"));
    expect(arquivo0597, "migration 0597 não está em supabase/migrations/").toBeTruthy();
    const naMigration = definicoesDeFuncao(
      readFileSync(join(MIGRATIONS, arquivo0597!), "utf8"),
      "decrypt_cpf",
    );
    expect(naMigration.length, "a migration não define decrypt_cpf").toBe(1);
    expect(
      naMigration[0]!.corpo,
      "corpo divergente entre baseline (install) e migration 0597 (update)",
    ).toBe(corpo);
  });
});
