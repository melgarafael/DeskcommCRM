/**
 * O ENCAIXE ESTÁ LIGADO — não só escrito.
 *
 * Os testes de decisão provam a régua e os de porta provam a linha gravada. Falta
 * a metade que nenhum deles vê: o produto CHAMAR o encaixe nos dois momentos em
 * que ele existe.
 *
 * - Quando um compromisso é desmarcado (`cancelarAgendamentoHandler`), a vaga
 *   tem de ser oferecida na hora. Sem a chamada, tudo o que este PR traz é
 *   código morto e o horário continua indo para o lixo.
 * - Quando a vaga segurada é CONFIRMADA (`alterarAgendamentoHandler`), a
 *   inscrição tem de sair da fila — senão a pessoa segue "esperando" um horário
 *   que já é dela.
 * - Quando a rodada de cron passa (`agenda-expira-pendentes`), a oferta vencida
 *   tem de soltar o horário — a mesma lei do pedido que ninguém confirmou.
 *
 * É invariante de FONTE, como `playbook-cita-a-ferramenta.test.ts`: o que se
 * protege aqui é o fio, e o fio só se perde em refatoração de arquivo — o tipo
 * não acusa uma chamada apagada, e o teste de unidade do módulo continua verde.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");

function ler(caminho: string): string {
  return readFileSync(join(RAIZ, caminho), "utf8");
}

/** O corpo de uma função de topo, até o próximo `export` de mesmo nível. */
function corpoDaFuncao(fonte: string, assinatura: string): string {
  const inicio = fonte.indexOf(assinatura);
  if (inicio < 0) throw new Error(`função não encontrada: ${assinatura}`);
  const proximo = fonte.indexOf("\nexport ", inicio + assinatura.length);
  return fonte.slice(inicio, proximo < 0 ? undefined : proximo);
}

describe("o cancelamento entrega a vaga", () => {
  const handler = ler("app/api/v1/agenda/agendamentos/_handler.ts");

  it("`cancelarAgendamentoHandler` chama o encaixe com o compromisso que abriu", () => {
    const corpo = corpoDaFuncao(handler, "export async function cancelarAgendamentoHandler");
    expect(corpo).toContain("aposVagaLiberada(");
    expect(corpo).toContain("appointmentId: atual.id");
  });

  it("a chamada vem DEPOIS de a desmarcação estar gravada", () => {
    const corpo = corpoDaFuncao(handler, "export async function cancelarAgendamentoHandler");
    // `alteraComRevisao` é quem grava (via `fn_appointment_change`); oferecer
    // antes dela ofereceria uma vaga que ainda não abriu.
    expect(corpo.indexOf("alteraComRevisao(")).toBeGreaterThan(-1);
    expect(corpo.indexOf("aposVagaLiberada(")).toBeGreaterThan(
      corpo.indexOf("alteraComRevisao("),
    );
  });

  it("o encaixe não derruba a resposta do cancelamento", () => {
    // O módulo já não lança; o `await` (em vez de `void`) é o que garante que a
    // rota só responde depois de a oferta existir. Se virar `void`, o teste
    // abaixo continua verde mas o de cima não — por isso a asserção explícita.
    const corpo = corpoDaFuncao(handler, "export async function cancelarAgendamentoHandler");
    expect(corpo).toMatch(/await aposVagaLiberada\(/);
  });
});

describe("a confirmação fecha a inscrição", () => {
  const handler = ler("app/api/v1/agenda/agendamentos/_handler.ts");

  it("`alterarAgendamentoHandler` fecha a inscrição quando o status vira `confirmed`", () => {
    const corpo = corpoDaFuncao(handler, "export async function alterarAgendamentoHandler");
    expect(corpo).toContain("fecharEncaixeConfirmado(");
    expect(corpo).toContain('"confirmed"');
  });
});

describe("o cron solta a oferta vencida", () => {
  const rota = ler("app/api/v1/cron/agenda-expira-pendentes/route.ts");

  it("a varredura de encaixe roda na mesma rodada dos pendentes", () => {
    expect(rota).toContain("varrerOfertasVencidas(admin");
  });

  it("o que a varredura fez volta no corpo da resposta", () => {
    expect(rota).toContain("encaixes: encaixes.vencidas");
  });
});

describe("a migration entra na cadeia", () => {
  it("existe e cria a fila com o índice de uma inscrição viva", () => {
    const arquivo = "supabase/migrations/20261026130000_0771_lista_de_espera_com_encaixe.sql";
    const sql = ler(arquivo);
    expect(sql).toContain("create table if not exists public.calendar_waitlist");
    expect(sql).toContain("calendar_waitlist_viva_por_contato_servico_idx");
    expect(sql).toContain("'waitlist'");
  });

  it("o baseline de self-host tem a mesma tabela — quem instala não roda migrations", () => {
    const baseline = ler("supabase/baseline.sql");
    expect(baseline).toContain("create table if not exists public.calendar_waitlist");
    expect(baseline).toContain("'ui','mcp','google_sync','public_page','waitlist'");
  });
});
