import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TETO_NOME_DE_SESSAO_WAHA, nomeCurtoDaSessao, nomeDaSessaoCabeNoWaha,
  nomeDaSessaoNovo, podeRenomearSessaoDoWaha,
} from "@/lib/channels/nome-da-sessao";

const RAIZ = process.cwd();
const ORG = "20000000-0000-4000-8000-000000000001";
const AJUDANTE = join("lib", "channels", "nome-da-sessao.ts");
/** Montagem à mão do formato curto: `org_${…slice(0, 8)}` fora do helper. */
const MONTAGEM_A_MAO = /`org_\$\{[^}]*slice\(\s*0\s*,\s*8\s*\)/;
/** Construções à mão que ficam de fora, com o motivo escrito. */
const EXCECOES: Record<string, string> = {
  // Mesmo formato curto, mas para o WaCalls (voz), não para o WAHA: o nome já
  // nasce com 12 caracteres e não tem o defeito da #667. Trocar o motor de voz
  // não é assunto desta correção.
  [join("app", "api", "v1", "voice", "sessions", "pair", "route.ts")]: "WaCalls, não WAHA",
};

function varrer(dir: string, achados: string[] = []): string[] {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) {
      if (["node_modules", ".next", "dist", "coverage"].includes(entrada.name)) continue;
      varrer(caminho, achados);
    } else if (/\.(ts|tsx)$/.test(entrada.name) && !/\.(test|spec)\./.test(entrada.name)) achados.push(caminho);
  }
  return achados;
}

describe("nome da sessão do WAHA cabe no teto de 54", () => {
  it("o teto é o `@MaxLength(54)` do WAHA", () => {
    expect(TETO_NOME_DE_SESSAO_WAHA).toBe(54);
  });
  it("o formato curto do onboarding cabe com folga", () => {
    const nome = nomeCurtoDaSessao(ORG);
    expect(nome).toBe("org_20000000");
    expect(nome).toHaveLength(12);
    expect(nomeDaSessaoCabeNoWaha(nome)).toBe(true);
  });
  it("o limite é inclusivo: 54 cabe, 55 não", () => {
    expect(nomeDaSessaoCabeNoWaha("x".repeat(54))).toBe(true);
    expect(nomeDaSessaoCabeNoWaha("x".repeat(55))).toBe(false);
  });
  it("o formato antigo do banco (69) passava do teto; o de hoje (45) não", () => {
    const antigo = `org_${ORG.replaceAll("-", "")}_${ORG.replaceAll("-", "")}`;
    const hoje = `org_${ORG.replaceAll("-", "").slice(0, 8)}_${ORG.replaceAll("-", "")}`;
    expect(antigo).toHaveLength(69);
    expect(nomeDaSessaoCabeNoWaha(antigo)).toBe(false);
    expect(hoje).toHaveLength(45);
    expect(nomeDaSessaoCabeNoWaha(hoje)).toBe(true);
  });
  it("recusa caractere que o WAHA também recusa", () => {
    expect(nomeDaSessaoCabeNoWaha("org/slash")).toBe(false);
    expect(nomeDaSessaoCabeNoWaha("org.ponto")).toBe(false);
    expect(nomeDaSessaoCabeNoWaha("")).toBe(false);
    expect(nomeDaSessaoCabeNoWaha("org_1-2")).toBe(true);
  });
  it("o nome novo reproduz o mesmo formato que a 0232 gera no banco", () => {
    const nome = nomeDaSessaoNovo(ORG, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(nome).toBe("org_20000000_aaaaaaaabbbbccccddddeeeeeeeeeeee");
    expect(nome).toHaveLength(45);
    expect(nomeDaSessaoCabeNoWaha(nome)).toBe(true);
  });
  it("nenhuma superfície monta o nome à mão — a fonte é uma só", () => {
    const arquivos = [...varrer(join(RAIZ, "app")), ...varrer(join(RAIZ, "lib"))];
    // a varredura só vale alguma coisa se tiver varrido a árvore de verdade
    expect(arquivos.length).toBeGreaterThan(200);
    expect(arquivos.some((a) => a.endsWith(join("app", "onboarding", "connect-whatsapp", "page.tsx")))).toBe(true);
    const permitido = (a: string) => a.endsWith(AJUDANTE) || Object.keys(EXCECOES).some((e) => a.endsWith(e));
    expect(arquivos.filter((a) => !permitido(a) && MONTAGEM_A_MAO.test(readFileSync(a, "utf8")))).toEqual([]);
  });
  it("as duas superfícies derivam do helper", () => {
    const tela = readFileSync(join(RAIZ, "app", "onboarding", "connect-whatsapp", "page.tsx"), "utf8");
    const sessao = readFileSync(join(RAIZ, "lib", "channels", "onboarding-session.ts"), "utf8");
    expect(tela).toContain("nomeCurtoDaSessao(activeOrg.orgId)");
    expect(sessao).toContain("nomeCurtoDaSessao(organizationId)");
  });
});

describe("renomear só o que a 0232 renomearia", () => {
  it("canal que nunca pareou e não está de pé: pode", () => {
    expect(podeRenomearSessaoDoWaha({ phone_number: null, status: "STARTING" })).toBe(true);
    expect(podeRenomearSessaoDoWaha({ phone_number: null, status: "FAILED" })).toBe(true);
    expect(podeRenomearSessaoDoWaha({ status: "STOPPED" })).toBe(true);
  });
  it("canal PAREADO não pode — mesmo parado, que é o caso perigoso", () => {
    expect(podeRenomearSessaoDoWaha({ phone_number: "5511999990000", status: "STOPPED" })).toBe(false);
    expect(podeRenomearSessaoDoWaha({ phone_number: "5511999990000", status: "STARTING" })).toBe(false);
  });
  it("canal WORKING não pode", () => {
    expect(podeRenomearSessaoDoWaha({ phone_number: null, status: "WORKING" })).toBe(false);
  });
  it("é a MESMA condição do backfill da 0232, lida do SQL que o clone aplica", () => {
    // Prosa dizendo "é a mesma condição" envelhece; ler o SQL não envelhece.
    // Se alguém afrouxar um dos dois lados, este caso reprova.
    const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
    const backfill = baseline.split("\n").find((l) => l.includes("length(waha_session_name) > 54"));
    expect(backfill).toBeDefined();
    expect(backfill).toContain("phone_number is null");
    expect(backfill).toContain("status <> 'WORKING'");
    const fonte = readFileSync(join(RAIZ, AJUDANTE), "utf8");
    expect(fonte).toContain('(canal.phone_number ?? null) === null && canal.status !== "WORKING"');
  });
});

describe("o teto do nome de sessão mora no banco, não só no teste", () => {
  /** A migration que leva a recusa para o banco. */
  const MIGRACAO = join(
    RAIZ, "supabase", "migrations",
    "20261005090000_0543_teto_do_nome_de_sessao_waha_no_banco.sql",
  );
  const A_CORPO = "create or replace function public.fn_teto_nome_de_sessao_waha()";
  const sqlDaMigration = readFileSync(MIGRACAO, "utf8");
  const corpo = sqlDaMigration.slice(sqlDaMigration.indexOf(A_CORPO)).trim();
  const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

  it("a recusa existe: INSERT e rename acima do teto caem, com o 22023 da reserva", () => {
    expect(sqlDaMigration).toContain("-- manifest:");
    expect(sqlDaMigration).toContain("before insert or update on public.channel_sessions");
    expect(sqlDaMigration).toContain(
      "raise exception 'waha_session_name_acima_do_teto: % caracteres; o WAHA aceita no máximo 54', length(new.waha_session_name) using errcode='22023'",
    );
    expect(sqlDaMigration).toContain("if tg_op = 'INSERT' then");
    expect(sqlDaMigration).toContain("is distinct from old.waha_session_name");
  });

  it("o 54 do SQL é o MESMO da constante que o código usa — mudar de um lado só reprova", () => {
    const tetoNoSql = Number(
      corpo.match(/length\(coalesce\(new\.waha_session_name,''\)\) > (\d+)/)?.[1],
    );
    expect(tetoNoSql).toBe(TETO_NOME_DE_SESSAO_WAHA);
    expect(tetoNoSql).toBe(54);
  });

  it("o apêndice do baseline termina exatamente no corpo da migration — sem deriva", () => {
    // O kit self-host aplica o baseline, não a migration: corpo que existe só
    // num dos dois lados é corpo que não roda em instalação nenhuma.
    expect(corpo.length).toBeGreaterThan(300);
    // O apêndice fica ACIMA do bloco da varredura de anon (função nova não pode
    // nascer depois dela), então o baseline não pode TERMINAR no corpo: o que
    // tem que bater é cada sentença do corpo, na mesma ordem, sem nenhuma
    // sobrando — a leitura de posição vira ordem.
    const linhasDoBaseline = baseline.split("\n");
    let vista = -1;
    for (const sentenca of corpo.split("\n").filter((l) => l.trim().length > 0)) {
      const achou = linhasDoBaseline.findIndex((l, i) => i > vista && l === sentenca);
      expect(achou, `sentença do corpo ausente no baseline: ${sentenca}`).toBeGreaterThan(vista);
      vista = achou;
    }
  });

  it("a recusa é IF aninhado em tg_op: `old` não é avaliado dentro de INSERT", () => {
    // `A or B` num único teste deixaria a leitura de `old.campo` no caminho do
    // INSERT dependendo do curto-circuito do executor. Aninhado, cada ramo só
    // roda com o gatilho que lhe cabe.
    expect(corpo).not.toMatch(/> \d+ and tg_op/);
    // sonda-do-baseline: primeira-de-proposito — o alvo é a FATIA da migration (corpo, recortado em A_CORPO), onde esse literal existe uma vez só.
    expect(corpo.indexOf("if tg_op = 'INSERT' then")).toBeGreaterThan(
      corpo.indexOf("length(coalesce(new.waha_session_name,'')) > 54"),
    );
  });

  it("a linha antiga acima do teto continua atualizável: o trigger só olha o nome que MUDA", () => {
    // O nome mantido não entra em nenhuma das duas recusas — é o que faz a
    // instalação com `org_<32>_<32>` não depender do backfill para operar.
    expect(corpo).toContain("elsif new.waha_session_name is distinct from old.waha_session_name then");
    // sonda-do-baseline: primeira-de-proposito — dentro de `corpo` o primeiro `elsif` é o do ramo de rename; o que vem depois é de outro teste.
    const voltaAoInicio = corpo.slice(0, corpo.indexOf("elsif"));
    expect(voltaAoInicio).not.toContain("is distinct from");
  });

  it("o teste de banco continua conferindo o teto pela MESMA constante", () => {
    const invariante = readFileSync(join(RAIZ, "tests", "invariants", "pre-go-live-reservation.test.ts"), "utf8");
    expect(invariante).toContain("toBeLessThanOrEqual(TETO_NOME_DE_SESSAO_WAHA)");
    const novoInvariante = readFileSync(
      join(RAIZ, "tests", "invariants", "teto-do-nome-de-sessao-no-banco.test.ts"), "utf8",
    );
    expect(novoInvariante).toContain("waha_session_name_acima_do_teto");
    expect(novoInvariante).toContain("TETO_NOME_DE_SESSAO_WAHA");
  });
});
