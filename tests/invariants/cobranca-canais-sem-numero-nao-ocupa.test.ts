import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import { assinar, chaveDeCobranca, criarOrg, criarPlano, erroDe, uuid } from "./cobranca-helpers";

/**
 * A VAGA DO PLANO É DO NÚMERO, NÃO DA LINHA (#3416).
 *
 * O que este arquivo vigia são as DUAS cópias da régua de contagem de números
 * conectados:
 *
 *   · o gatilho `public.fn_trava_canais_do_plano()` (0583), cujo `count(*)` é o
 *     que decide o PT402 — é ELE que recusa a conexão, não a tela;
 *   · o gêmeo do app, `lerUsoDaOrganizacao` (`lib/cobranca/uso.ts`), que é quem
 *     diz à tela e à troca de plano quantas vagas estão em uso.
 *
 * ─── O caminho do defeito, medido no produto ─────────────────────────────────
 *
 * Plano com "Máximo de números conectados: 1" (v1.88/1.89, WAHA NOWEB, canal
 * QR). No assistente do primeiro acesso a pessoa abre o QR e não lê com o
 * celular. O QR expira e o transporte entrega `FAILED` — a sessão fica com
 * `status = 'FAILED'` e `phone_number` NULO, porque nunca houve pareamento.
 * Essa linha, que nunca atendeu nada, ocupava a única vaga: a conexão do número
 * real seguinte era recusada com "Seu plano permite 1 número conectado", e o
 * slot ficava preso numa conexão que não existe. Quem olhava o teste grátis
 * concluía que o produto estava quebrado.
 *
 * ─── A régua que este arquivo fixa ───────────────────────────────────────────
 *
 *   · linha MORTA e SEM NÚMERO (`FAILED`/`STOPPED` com `phone_number` nulo) NÃO
 *     ocupa vaga — e também não é recusada quando a empresa já está no teto
 *     (recusar seria cobrar por uma vaga que ela não ocupa);
 *   · linha COM número ocupa, `FAILED` inclusive: número pareado é número
 *     ocupado, e a queda do transporte não devolve a vaga enquanto o número
 *     existir. É o controle que a issue exige;
 *   · `WORKING` ocupa mesmo ANTES do número ser sincronizado: o pareamento grava
 *     `phone_number` na leitura de saúde (`app/api/v1/channel-sessions/[id]/route.ts`,
 *     via `numeroObservadoDaSessao`), e "WORKING sem número" é atraso de espelho,
 *     não ausência de conexão;
 *   · conexão EM CURSO (`STARTING`/`SCAN_QR_CODE` sem número) ocupa: é a vaga
 *     RESERVADA. Sem essa metade, abrir N QRs com teto 1 e parear todos daria N
 *     números — a regra trocaria um defeito de cobrança por outro maior, porque
 *     a trava é de criação de linha e o pareamento não passa por ela.
 *
 * `tests/invariants/cobranca-canais.test.ts` continua sendo o invariante da
 * contagem em si (teto, arquivamento, provider, org, corrida); este cobre a
 * régua de QUEM ocupa.
 */

const P = "c0b00008-0000-4000-8000";
const org = (n: number) => uuid(P, n);
const canal = (n: number) => uuid(P, 100 + n);
const PLANO_1 = uuid(P, 901);

type Estado = "STARTING" | "SCAN_QR_CODE" | "WORKING" | "STOPPED" | "FAILED";

/**
 * INSERT de canal, SEM `;`, com o estado e o número explícitos — é a única coisa
 * que este arquivo precisa e que `insercaoDeCanal` (congelado) não oferece. Os
 * números são distintos por construção porque `channel_sessions_phone_per_org_unique`
 * (0107) recusa o mesmo telefone duas vezes na mesma organização.
 */
function insercaoDeCanal(
  id: string,
  orgId: string,
  opcoes: { estado?: Estado; telefone?: string | null; provider?: "waha" | "wacalls" } = {},
): string {
  const sufixo = id.slice(-12);
  if (opcoes.provider === "wacalls") {
    return `insert into public.channel_sessions
      (id, organization_id, provider, wacalls_session_id, webhook_secret_encrypted, status)
      values ('${id}', '${orgId}', 'wacalls', 'wac-${sufixo}', '\\x00'::bytea, '${opcoes.estado ?? "STARTING"}')`;
  }
  const telefone = opcoes.telefone ?? null;
  return `insert into public.channel_sessions
    (id, organization_id, waha_session_name, webhook_secret_encrypted, status, phone_number)
    values ('${id}', '${orgId}', 'cob-${sufixo}', '\\x00'::bytea, '${opcoes.estado ?? "STARTING"}',
            ${telefone === null ? "null" : `'${telefone}'`})`;
}

/** Quantas linhas a régua NOVA considera ocupantes — a leitura que a tela faz. */
function ocupadas(orgId: string): number {
  return Number(
    sql(`select count(*) from public.channel_sessions
          where organization_id = '${orgId}'
            and archived_at is null
            and provider <> 'wacalls'
            and (phone_number is not null or status not in ('FAILED', 'STOPPED'));`),
  );
}

beforeAll(() => {
  criarPlano({ id: PLANO_1, nome: "Um número conectado", maxCanais: 1 });
  for (let n = 1; n <= 8; n++) criarOrg(org(n), `cob-sem-numero-${n}`);
  chaveDeCobranca("ligado");
});

describe("inv. 6b — quem ocupa a vaga de número do plano (#3416)", () => {
  it("⭐ FAILED sem número (o QR que expirou) não ocupa: o número real seguinte entra", () => {
    assinar(org(1), PLANO_1);
    // O caminho medido da issue: QR aberto, ninguém leu, o transporte desistiu.
    sql(`${insercaoDeCanal(canal(1), org(1), { estado: "FAILED", telefone: null })};`);
    expect(ocupadas(org(1))).toBe(0);
    // A conexão do número REAL seguinte. Antes do conserto: PT402
    // "limite_do_plano:canais:1", com a vaga presa na sessão que nunca pareou.
    expect(erroDe(`${insercaoDeCanal(canal(2), org(1), { estado: "STARTING" })};`)).toBe("");
    // ...e a vaga que ela reservou é real: o teto continua valendo a partir dela.
    expect(erroDe(`${insercaoDeCanal(canal(3), org(1), { estado: "WORKING", telefone: "5511900000003" })};`))
      .toContain("limite_do_plano:canais:1");
  });

  it("⭐ CONTROLE: FAILED COM número continua ocupando — a queda não devolve o slot", () => {
    assinar(org(2), PLANO_1);
    // Número pareado que caiu: é número ocupado, o plano é cobrado por ele.
    sql(`${insercaoDeCanal(canal(4), org(2), { estado: "FAILED", telefone: "5511900000004" })};`);
    expect(ocupadas(org(2))).toBe(1);
    const e = erroDe(`${insercaoDeCanal(canal(5), org(2), { estado: "WORKING", telefone: "5511900000005" })};`);
    expect(e).toContain("PT402");
    expect(e).toContain("limite_do_plano:canais:1");
  });

  it("CONTROLE: CONNECTED ocupa — e WORKING sem número também (espelho atrasado não libera vaga)", () => {
    assinar(org(3), PLANO_1);
    sql(`${insercaoDeCanal(canal(6), org(3), { estado: "WORKING", telefone: "5511900000006" })};`);
    expect(erroDe(`${insercaoDeCanal(canal(7), org(3), { estado: "WORKING", telefone: "5511900000007" })};`))
      .toContain("PT402");

    // O número só é gravado na leitura de saúde, com o transporte em WORKING. Uma
    // conexão no ar cujo espelho ainda não sincronizou NÃO pode liberar a vaga —
    // senão o "sem número" viraria a porta de entrada de um segundo número.
    assinar(org(4), PLANO_1);
    sql(`${insercaoDeCanal(canal(8), org(4), { estado: "WORKING", telefone: null })};`);
    expect(ocupadas(org(4))).toBe(1);
    expect(erroDe(`${insercaoDeCanal(canal(9), org(4), { estado: "STARTING" })};`)).toContain("PT402");
  });

  it("conexão em curso (STARTING/SCAN_QR_CODE) reserva a vaga — sem isso o teto sumiria no pareamento", () => {
    assinar(org(5), PLANO_1);
    sql(`${insercaoDeCanal(canal(10), org(5), { estado: "SCAN_QR_CODE", telefone: null })};`);
    expect(ocupadas(org(5))).toBe(1);
    expect(erroDe(`${insercaoDeCanal(canal(11), org(5), { estado: "STARTING" })};`)).toContain("PT402");
  });

  it("org já no teto: a linha morta e sem número não é recusada (não se cobra vaga que não se ocupa)", () => {
    assinar(org(6), PLANO_1);
    sql(`${insercaoDeCanal(canal(12), org(6), { estado: "WORKING", telefone: "5511900000012" })};`);
    // É o espelho de status chegando pelo webhook (`lib/waha/ingest.ts`) numa org
    // cheia: antes do conserto o ingest levantava PT402 e o espelho congelava.
    expect(erroDe(`${insercaoDeCanal(canal(13), org(6), { estado: "FAILED", telefone: null })};`)).toBe("");
    expect(ocupadas(org(6))).toBe(1);
    expect(erroDe(`${insercaoDeCanal(canal(14), org(6), { estado: "STOPPED", telefone: null })};`)).toBe("");
    expect(erroDe(`${insercaoDeCanal(canal(15), org(6), { estado: "WORKING", telefone: "5511900000015" })};`))
      .toContain("PT402");
  });

  it("sessão que PERDE o número em FAILED libera a vaga; `wacalls` e arquivada seguem fora", () => {
    assinar(org(7), PLANO_1);
    sql(`${insercaoDeCanal(canal(16), org(7), { estado: "WORKING", telefone: "5511900000016" })};`);
    expect(erroDe(`${insercaoDeCanal(canal(17), org(7), { estado: "STARTING" })};`)).toContain("PT402");
    // A régua é por CONTEÚDO, não por histórico: sem número e morta, não ocupa.
    // Medido no código: nenhum caminho apaga `phone_number` sozinho —
    // `numeroObservadoDaSessao` devolve o valor gravado quando não há observação
    // boa, e a rota de saúde só grava número não vazio. Por isso o controle do
    // caso 2 (FAILED com número) vale em produção; este caso fixa a régua no banco.
    sql(`update public.channel_sessions set phone_number = null, status = 'FAILED' where id = '${canal(16)}';`);
    expect(ocupadas(org(7))).toBe(0);
    expect(erroDe(`${insercaoDeCanal(canal(18), org(7), { estado: "STARTING" })};`)).toBe("");
  });

  it("a exceção `wacalls` e o arquivamento continuam valendo para a linha morta sem número", () => {
    assinar(org(8), PLANO_1);
    expect(erroDe(`${insercaoDeCanal(canal(19), org(8), { estado: "FAILED", provider: "wacalls" })};`)).toBe("");
    sql(`${insercaoDeCanal(canal(20), org(8), { estado: "WORKING", telefone: "5511900000020" })};`);
    sql(`update public.channel_sessions set archived_at = now() where id = '${canal(20)}';`);
    expect(erroDe(`${insercaoDeCanal(canal(21), org(8), { estado: "WORKING", telefone: "5511900000021" })};`)).toBe("");
    expect(ocupadas(org(8))).toBe(1);
  });
});
