/**
 * O AVISO DO ART. 12.º SAI DEPOIS DE APAGAR, E NUNCA DERRUBA O PEDIDO (#2342).
 *
 * ─── A ordem é o coração, e é medida ─────────────────────────────────────────────────────────
 *
 * O passo 1 da cascata zera `contacts.email`; a norma manda avisar DEPOIS do apagamento. O
 * worker lê o endereço enquanto ele ainda existe, roda a cascata e só então chama
 * `avisarTitularAposApagamento`. Inverter a ordem produz o pior resultado possível: pedido
 * cumprido, titular sem aviso, e nenhum erro em lugar nenhum. Por isso a ordem é asserção de
 * texto aqui — o worker inteiro roda no Postgres efêmero, mas a sequência das chamadas não
 * depende de banco nenhum.
 *
 * ─── O aviso é BEST-EFFORT, e o arquivo mede que é mesmo ─────────────────────────────────────
 *
 * O que o titular tem direito é ter os dados apagados. Transporte fora do ar vira
 * `{enviado: false, motivo}` + `logger.warn`, e o pedido segue `completed` — derrubar o SLA
 * por causa de um e-mail trocaria um direito exercido por uma falha. E o endereço do titular
 * NÃO entra no log (L-08: nada de PII em log).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";
import type { PerfilDoPais } from "@/lib/legal/perfil-do-pais";

const enviados = vi.hoisted(
  () => [] as Array<{ to: string; subject: string; html: string; text: string; tags?: unknown }>,
);
const roteador = vi.hoisted(() => ({ resposta: { ok: true, id: "m1" } as Record<string, unknown> }));
const marcaMock = vi.hoisted(() => ({ nome: "Silva & Filhos" }) as { nome: string });

vi.mock("@/lib/email/roteador", () => ({
  sendEmail: vi.fn(async (e: (typeof enviados)[number]) => {
    enviados.push(e);
    return roteador.resposta;
  }),
}));
vi.mock("@/lib/branding/saida", async (orig) => ({
  ...(await orig<typeof import("@/lib/branding/saida")>()),
  marcaDaSaida: vi.fn(async (): Promise<MarcaDeSaida> => marcaMock as unknown as MarcaDeSaida),
}));
vi.mock("@/lib/legal/perfil-do-pais", async (orig) => {
  const real = await orig<typeof import("@/lib/legal/perfil-do-pais")>();
  // Portugal: é o país para quem o aviso existe (decisão de 2026-10-16). A
  // guarda do BR mora no WORKER, e tem caso próprio em
  // `tests/invariants/lgpd-aviso-do-artigo-12-so-fora-do-brasil.test.ts`.
  return { ...real, perfilDaOrganizacao: vi.fn(async (): Promise<PerfilDoPais> => real.perfilDoPais("PT")) };
});
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { logger } from "@/lib/logger";
import { avisarTitularAposApagamento } from "@/lib/lgpd/aviso-apos-apagar";

const ORG = "0657aaaa-0000-4000-8000-000000000001";
const PEDIDO = "0657bbbb-0000-4000-8000-000000000001";
const RECEBIDO = new Date("2026-09-10T12:00:00Z");

/** O admin só existe como marcador: os dois leitores de banco estão mockados. */
const admin = {} as never;

function pedido(emailTitular: string | null): Parameters<typeof avisarTitularAposApagamento>[1] {
  return { organizationId: ORG, requestId: PEDIDO, emailTitular, recebidoEm: RECEBIDO };
}

beforeEach(() => {
  enviados.length = 0;
  roteador.resposta = { ok: true, id: "m1" };
  vi.mocked(logger.warn).mockClear();
});

describe("o aviso de apagamento (art. 12.º, n.º 3 do RGPD)", () => {
  it("com e-mail, manda o aviso de APAGAMENTO pelo transporte da casa", async () => {
    const r = await avisarTitularAposApagamento(admin, pedido("titular@exemplo.test"));

    expect(r).toEqual({ enviado: true, motivo: null, mensagemId: "m1" });
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.to).toBe("titular@exemplo.test");
    expect(enviados[0]!.subject).toContain("O seu pedido de dados pessoais foi atendido");
    // O rótulo vem do PERFIL (Portugal declara "Direito exercido"), e não de um
    // "Base legal:" fixo — o mesmo caminho do e-mail de exportação.
    expect(enviados[0]!.html).toContain("Direito exercido: RGPD art. 15.º");
    expect(enviados[0]!.tags).toContainEqual({ name: "kind", value: "lgpd_art12_apagamento" });
    expect(enviados[0]!.tags).toContainEqual({ name: "request_short", value: "0657bbbb" });
  });

  it("sem e-mail NÃO manda nada — e diz por quê, sem exceção", async () => {
    const r = await avisarTitularAposApagamento(admin, pedido(null));
    expect(r).toEqual({ enviado: false, motivo: "titular_sem_email", mensagemId: null });
    expect(enviados).toHaveLength(0);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it("transporte fora do ar NÃO derruba o pedido, e não joga o endereço no log", async () => {
    roteador.resposta = { ok: false, error: "http_500" };

    const r = await avisarTitularAposApagamento(admin, pedido("titular@exemplo.test"));

    // O pedido já está cumprido quando aqui: uma exceção aqui só trocaria um direito
    // exercido por uma falha que o SLA registraria como atraso.
    expect(r.enviado).toBe(false);
    expect(r.motivo).toBe("falha_no_envio");
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const registro = JSON.stringify(vi.mocked(logger.warn).mock.calls[0]);
    expect(registro, "o log do titular vazou o endereço dele").not.toContain("titular@exemplo.test");
    expect(registro).toContain("0657bbbb");
  });

  it("instalação sem transporte diz `email_nao_configurado` — o dono resolve isso, e não a rede", async () => {
    roteador.resposta = { ok: false, error: "not_configured" };

    const r = await avisarTitularAposApagamento(admin, pedido("titular@exemplo.test"));

    // O motivo vai para `art12_notice` no pedido e na auditoria: "não configurado"
    // e "falhou no envio" pedem ações diferentes de quem opera a instalação.
    expect(r).toEqual({ enviado: false, motivo: "email_nao_configurado", mensagemId: null });
  });

  it("o prazo afirmado no aviso é o do RECEBIMENTO do pedido", async () => {
    await avisarTitularAposApagamento(admin, pedido("titular@exemplo.test"));
    expect(enviados[0]!.text).toContain("10/10/2026");
  });
});

describe("a ordem no worker: ler o endereço ANTES de apagar, avisar DEPOIS", () => {
  const fonte = readFileSync(
    join(process.cwd(), "workers", "lgpd-redact-worker.ts"),
    "utf8",
  );
  const leitura = fonte.indexOf('from("contacts")');
  const cascata = fonte.indexOf("cascadeRedactContact({");
  const aviso = fonte.indexOf("avisarTitularAposApagamento(admin,");

  it("o worker lê o e-mail do contato antes de chamar a cascata", () => {
    expect(leitura, "o worker não lê mais o e-mail do contato").toBeGreaterThan(-1);
    expect(leitura, "a leitura do e-mail saiu de antes da cascata").toBeLessThan(cascata);
  });

  it("e o aviso sai DEPOIS da cascata — nunca antes do apagamento", () => {
    expect(aviso, "o worker não chama mais o aviso do art. 12.º").toBeGreaterThan(-1);
    expect(aviso, "o aviso foi para antes da cascata — o titular seria avisado sem apagar").toBeGreaterThan(
      cascata,
    );
  });

  it("o resultado do aviso entra no resultado do pedido, não num log perdido", () => {
    expect(fonte).toContain('const art12Notice = aviso ? (aviso.enviado ? "sent" : aviso.motivo) : null;');
  });

  it("o worker pergunta o PAÍS antes de decidir o envio — e é aqui que a guarda mora", () => {
    // Sabotagem escrita como asserção: apagar esta linha devolve o aviso ao
    // Brasil, e o caso do lado brasileiro
    // (`tests/invariants/lgpd-aviso-do-artigo-12-so-fora-do-brasil.test.ts`)
    // fica vermelho.
    expect(fonte).toContain("const avisaTitular = perfil.codigo !== PAIS_PADRAO;");
  });
});
