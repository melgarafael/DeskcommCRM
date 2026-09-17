/**
 * Issue #754 — a credencial de enfeite não derruba a leitura (Postgres de verdade).
 *
 * A IRMÃ DESTE ARQUIVO
 *
 * `tests/unit/credencial-de-enfeite-nao-derruba-a-leitura.test.ts` lê o SQL e cobra
 * a guarda de forma (roda em `pnpm test:unit`, sem banco). Este aqui é o outro
 * lado: mede COMPORTAMENTO da função instalada, com o `baseline.sql` aplicado e a
 * chave mestra configurada — que é a diferença entre "a guarda está escrita" e "a
 * leitura não estoura". Roda no job obrigatório `invariants` (`pnpm test:db`).
 *
 * O QUE A ISSUE MEDIU (instalação self-host, 24h de log)
 *
 * `POST /rest/v1/rpc/fn_decrypt_oauth` em 500 entre 10% e 30% das chamadas,
 * continuamente: 2 a 12 erros por hora contra ~18 sucessos, sem janela de
 * normalidade. Ninguém viu na tela porque quem lê trata o erro como "sem
 * credencial" (`lib/webhooks/secrets.ts` devolve null) — o que sobra é um erro
 * permanente no log, nos MESMOS registros, indistinguível de chave trocada.
 *
 * A causa é medida aqui, caso a caso: as colunas cifradas são NOT NULL, então
 * "ainda não configurado" é gravado como byte de enfeite (`'\x00'`, o
 * `Buffer.from([0])` das rotas de sessão — este próprio harness semeia
 * `channel_sessions.webhook_secret_encrypted` assim, ver `seedGov()`), e a função
 * decifrava QUALQUER bytea.
 *
 * A FRONTEIRA QUE ESTES CASOS CRAVAM
 *
 *   não é cifra (ausente, curta, sem cara de pacote)  => null, e a leitura segue
 *   é cifra e não abre (chave trocada, corrompida)    => AINDA levanta
 *
 * A segunda linha é decisão, não descuido: engolir isso transformaria "chave
 * mestra perdida" em "nenhuma credencial cadastrada" — mentira mais cara que o
 * erro, e o único caso em que um 500 aqui diz a verdade.
 *
 * Chave da GUC: sintética, de teste. Nunca um valor de instalação (LGPD).
 */
import { describe, expect, it } from "vitest";
import { lastLine, sql } from "./gov-helpers";

const CHAVE = "chave-de-teste-0754-0123456789abcdef0123456789abcdef";
const OUTRA_CHAVE = "outra-chave-de-teste-0754-fedcba9876543210fedcba9876";

/**
 * Configura a chave mestra NA SESSÃO e roda o resto. Sem a GUC, o caminho do
 * defeito nem é alcançado: `pgp_sym_decrypt(<qualquer>, NULL)` devolve null
 * sossegado, e o teste ficaria verde medindo a ausência de chave — instrumento
 * que não mede o produto.
 */
const comChave = (script: string, chave = CHAVE) => `
  select set_config('app.nuvemshop_oauth_key', '${chave}', false);
  ${script}
`;

/**
 * O SQLSTATE só aparece no stderr do psql se a gente PEDIR. A verbosidade
 * padrão imprime severidade + mensagem + contexto e **omite o código**, então
 * `toContain("39000")` falhava contra um erro que estava lá e certo:
 *
 *   ERROR:  Wrong key or corrupt data
 *   CONTEXT:  PL/pgSQL function fn_decrypt_oauth(bytea) line 28 at RETURN
 *
 * Asserir a MENSAGEM sozinha seria o conserto barato e o errado: a mensagem é
 * texto do pgcrypto e pode mudar de versão; o código de classe não. Então se
 * pede o código, em vez de desistir dele.
 */
const comCodigo = (script: string) => `\\set VERBOSITY verbose\n${script}`;

/** stderr do psql quando o script estoura (ON_ERROR_STOP=1 derruba o processo). */
function erroDe(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

describe("#754 — a leitura de credencial não é derrubada por valor que não é cifra", () => {
  it("sentinela de 1 byte (o byte de enfeite) devolve null", () => {
    const out = lastLine(
      sql(
        comChave(
          `select coalesce(public.fn_decrypt_oauth('\\x00'::bytea)::text, '<nulo>');`,
        ),
      ),
    );
    expect(out).toBe("<nulo>");
  });

  it("bytea vazio devolve null", () => {
    const out = lastLine(
      sql(comChave(`select coalesce(public.fn_decrypt_oauth(''::bytea)::text, '<nulo>');`)),
    );
    expect(out).toBe("<nulo>");
  });

  it("valor sem cara de pacote PGP (JSON em claro na coluna) devolve null", () => {
    // 200+ bytes: passa em qualquer piso de tamanho. O que o reprova é o
    // primeiro byte — pacote PGP tem o bit 7 ligado, e `{` não tem.
    const out = lastLine(
      sql(
        comChave(
          `select coalesce(public.fn_decrypt_oauth(('{"client_secret":"' || repeat('b', 200) || '"}')::bytea)::text, '<nulo>');`,
        ),
      ),
    );
    expect(out).toBe("<nulo>");
  });

  it("ida e volta de verdade continua abrindo o que foi cifrado", () => {
    const out = lastLine(
      sql(
        comChave(
          `select coalesce(public.fn_decrypt_oauth(public.fn_encrypt_oauth('token-do-teste-0754')), '<nulo>');`,
        ),
      ),
    );
    expect(out).toBe("token-do-teste-0754");
  });

  it("cifra de verdade com a chave errada AINDA levanta — não vira null silencioso", () => {
    const stderr = erroDe(() =>
      sql(comCodigo(`
        select set_config('app.nuvemshop_oauth_key', '${CHAVE}', false);
        create temp table ct_0754 as select public.fn_encrypt_oauth('segredo') as ct;
        select set_config('app.nuvemshop_oauth_key', '${OUTRA_CHAVE}', false);
        select public.fn_decrypt_oauth(ct) from ct_0754;
      `)),
    );
    expect(stderr, "a chave errada passou batido: a guarda engoliu uma cifra de verdade").toContain(
      "Wrong key or corrupt data",
    );
    expect(stderr).toContain("39000");
  });

  it("lixo com cara de pacote (bit 7 ligado) também levanta — a guarda não é rede de tudo", () => {
    const stderr = erroDe(() =>
      sql(
        comCodigo(
          comChave(
            `select public.fn_decrypt_oauth(('\\xC3' || repeat('00', 100))::bytea);`,
          ),
        ),
      ),
    );
    expect(
      stderr,
      "101 bytes começando em 0xC3 não é cifra do par, e isso tem de aparecer (não é sentinela)",
    ).toContain("39000");
  });
});
