import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { TETO_NOME_DE_SESSAO_WAHA } from "../../lib/channels/nome-da-sessao";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres` });
afterAll(() => pool.end());

/** O nome de 69 caracteres que a 0228/0230 gravavam — o que a recusa tem de deixar viver. */
const NOME_ANTIGO = `org_${randomUUID().replaceAll("-", "")}_${randomUUID().replaceAll("-", "")}`;

async function novaOrg(): Promise<string> {
  const org = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Teto','Teto')",
    [org, org],
  );
  return org;
}

async function insereCanal(org: string, nome: string): Promise<void> {
  await pool.query(
    "insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,$2,'STARTING',decode('00','hex'))",
    [org, nome],
  );
}

/** Executa e devolve `errcode:mensagem`; falha o teste se o banco deixar passar. */
async function recusaDoBanco(executar: () => Promise<unknown>): Promise<string> {
  try {
    await executar();
  } catch (erro) {
    const e = erro as { code?: string; message?: string };
    return `${e.code}:${e.message}`;
  }
  throw new Error("esperava recusa do banco e a escrita passou");
}

describe("o banco recusa nome de sessão WAHA acima do teto", () => {
  it("o teto é o mesmo 54 que o código usa", () => {
    expect(TETO_NOME_DE_SESSAO_WAHA).toBe(54);
  });

  it("54 passa, 55 cai — o limite é inclusivo igual ao @MaxLength do WAHA", async () => {
    const org = await novaOrg();
    await insereCanal(org, "x".repeat(TETO_NOME_DE_SESSAO_WAHA));
    const recusa = await recusaDoBanco(() => insereCanal(org, "x".repeat(TETO_NOME_DE_SESSAO_WAHA + 1)));
    expect(recusa).toContain("22023");
    expect(recusa).toContain("waha_session_name_acima_do_teto");
    expect(recusa).toContain("no máximo 54");
  });

  it("o nome novo do gerador (45) segue entrando — a recusa não pega caminho real", async () => {
    const org = await novaOrg();
    const nome = `org_${org.replaceAll("-", "").slice(0, 8)}_${randomUUID().replaceAll("-", "")}`;
    expect(nome).toHaveLength(45);
    expect(nome.length).toBeLessThanOrEqual(TETO_NOME_DE_SESSAO_WAHA);
    await insereCanal(org, nome);
  });
});

describe("instalação existente com nome antigo não quebra", () => {
  it("a linha de 69 que a 0232 não renomeou continua atualizável", async () => {
    const org = await novaOrg();
    expect(NOME_ANTIGO).toHaveLength(69);
    // A linha PRECEDE a guarda: é assim que uma instalação antiga a recebe.
    await pool.query("alter table public.channel_sessions disable trigger trg_teto_nome_de_sessao_waha");
    try {
      await insereCanal(org, NOME_ANTIGO);
    } finally {
      await pool.query("alter table public.channel_sessions enable trigger trg_teto_nome_de_sessao_waha");
    }

    // Status/metadata/lease mudam o tempo todo e não escrevem o nome: passam.
    await pool.query(
      "update channel_sessions set status='FAILED', status_reason='connection_repair_required' where organization_id=$1 and waha_session_name=$2",
      [org, NOME_ANTIGO],
    );
    const depois = await pool.query(
      "select waha_session_name, status from channel_sessions where organization_id=$1 and waha_session_name=$2",
      [org, NOME_ANTIGO],
    );
    expect(depois.rows[0].waha_session_name).toBe(NOME_ANTIGO);
    expect(depois.rows[0].status).toBe("FAILED");

    // Renomear para OUTRO nome acima do teto continua proibido — a 0232 já
    // decidia isso pelo lado do CRM; agora o banco também decide.
    const paraCima = await recusaDoBanco(() =>
      pool.query(
        "update channel_sessions set waha_session_name=$3 where organization_id=$1 and waha_session_name=$2",
        [org, NOME_ANTIGO, `org_${randomUUID().replaceAll("-", "")}_${randomUUID().replaceAll("-", "")}`],
      ),
    );
    expect(paraCima).toContain("22023");
    expect(paraCima).toContain("waha_session_name_acima_do_teto");

    // E a cura do lado do CRM (rename para 45) continua cabendo na mesma linha.
    const curado = `org_${org.replaceAll("-", "").slice(0, 8)}_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      "update channel_sessions set waha_session_name=$3 where organization_id=$1 and waha_session_name=$2",
      [org, NOME_ANTIGO, curado],
    );
    const linha = await pool.query(
      "select waha_session_name from channel_sessions where organization_id=$1 and id=(select id from channel_sessions where organization_id=$1 limit 1)",
      [org],
    );
    expect(linha.rows[0].waha_session_name).toBe(curado);
  });
});
