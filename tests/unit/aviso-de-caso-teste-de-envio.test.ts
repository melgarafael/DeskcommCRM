/**
 * O BOTÃO "ENVIAR AVISO DE TESTE" — o caminho que manda de verdade.
 *
 * ## O que ele é, e o que ele deliberadamente NÃO é
 *
 * É o caminho do motor a partir do passo 8 (o canal), com um texto próprio e
 * **sem** linha em `entregas_de_aviso_de_caso`: a `unique (organization_id,
 * case_id, destino)` é por CASO, e não há caso nenhum aqui. Um teste que
 * gravasse ali ou inventaria um `case_id` (FK para `agent_cases`, que
 * reprovaria) ou queimaria o registro de um caso real.
 *
 * Mas ele **grava no `pacing_ledger`**, e isso não é zelo: a mensagem saiu de
 * verdade pelo número da organização. Não contar faria cinco conferências
 * sumirem do teto diário — que num número em aquecimento é 20 — e o 21º aviso
 * REAL do dia seria represado por uma conta que o produto não fez.
 *
 * ## Por que ele usa a configuração SALVA e não o formulário
 *
 * O que a pessoa quer saber é "o que eu acabei de salvar funciona?". Testar os
 * campos ainda não salvos provaria um caminho que não está em vigor — e a
 * primeira falha real depois disso viria de uma configuração que "tinha
 * passado no teste".
 */
import { describe, expect, it, vi } from "vitest";

import {
  enviarAvisoDeTeste,
  type DepsDoAvisoDeTeste,
} from "@/lib/escalacao/aviso-de-teste";
import type { CanalDoAviso } from "@/lib/escalacao/aviso-ao-suporte";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const TELEFONE = "+5531998966398";
const AGORA = new Date("2026-09-18T12:00:00.000Z");

const canalSaudavel: CanalDoAviso = {
  id: CANAL,
  status: "WORKING",
  archived_at: null,
  aceitaMensagemLivre: true,
};

function deps(patch: Partial<DepsDoAvisoDeTeste> = {}) {
  const enviados: Array<{ to: string; body: string }> = [];
  const ledger: Array<{ canal: string; quando: Date }> = [];
  const base: DepsDoAvisoDeTeste = {
    db: {
      carregaCanal: vi.fn(async () => canalSaudavel),
      marcaDaOrganizacao: vi.fn(async () => ({ nome: "Acme", idioma: "pt-BR" as const })),
      destinoEhDaPropriaOrganizacao: vi.fn(async () => false),
    },
    transporte: {
      configurado: vi.fn(async () => true),
      resolveDestino: vi.fn(async (_org, _canal, tel: string) => `${tel.slice(1)}@c.us`),
      envia: vi.fn(async (_org, _canal, to: string, body: string) => {
        enviados.push({ to, body });
        return { externalId: "wamid.TESTE" };
      }),
    },
    pacing: {
      decide: vi.fn(async () => ({ liberado: true as const })),
      registraEnvio: vi.fn(async (_org: string, canal: string, quando: Date) => {
        ledger.push({ canal, quando });
      }),
    },
    clock: () => AGORA,
    urlPublica: "https://crm.exemplo.com.br",
    ...patch,
  };
  return { deps: base, enviados, ledger };
}

const entrada = { organizationId: ORG, channelSessionId: CANAL, telefone: TELEFONE };

describe("o caminho feliz", () => {
  it("manda a mensagem e devolve o destino MASCARADO", async () => {
    const { deps: d, enviados } = deps();
    const r = await enviarAvisoDeTeste(d, entrada);

    expect(r.enviado).toBe(true);
    if (!r.enviado) return;
    expect(r.destinoMascarado).toBe("••••6398");
    // O número inteiro NUNCA volta para a tela: quem pediu o teste é admin, mas
    // a resposta de uma rota entra em log de proxy e em aba aberta.
    expect(JSON.stringify(r)).not.toContain("998966398");
    expect(enviados).toHaveLength(1);
  });

  it("o texto diz que é teste, diz o que vai chegar de verdade, e leva o link", async () => {
    const { deps: d, enviados } = deps();
    await enviarAvisoDeTeste(d, entrada);
    const corpo = enviados[0]!.body;

    expect(corpo).toContain("Acme");
    expect(corpo).toContain("https://crm.exemplo.com.br/app/ai/cases");
    // A última linha do aviso real precisa estar AQUI também: é no teste que a
    // pessoa aprende que aquele número não recebe resposta.
    expect(corpo).toContain("Responder aqui não chega ao cliente");
    // E ele NÃO se passa por um caso: não há caso nenhum.
    expect(corpo).not.toContain("novo caso esperando você");
  });

  it("o teste PAGA a mensagem no ledger — o número gastou uma", async () => {
    const { deps: d, ledger } = deps();
    await enviarAvisoDeTeste(d, entrada);
    expect(ledger).toEqual([{ canal: CANAL, quando: AGORA }]);
  });

  it("não escreve no registro de entregas — o `db` que ele recebe só tem TRÊS leituras", async () => {
    // ⚠️ A régua deste caso é o FIXTURE, e isso é deliberado: o `db` entregue ao
    // módulo tem exatamente `carregaCanal`, `marcaDaOrganizacao` e
    // `destinoEhDaPropriaOrganizacao` — as três são leituras. Se alguém
    // acrescentar `deps.db.reivindicaEntrega(...)` ao caminho do teste, a
    // chamada estoura aqui com "is not a function" e este caso fica vermelho.
    //
    // A guarda FORTE, porém, não é esta — é o `Pick<AvisoDb, …>` do tipo, que
    // reprova no `pnpm typecheck` antes de qualquer teste rodar. Está escrito
    // para ninguém confundir o alcance: sabotar a escrita da entrega NÃO
    // produz um unit vermelho por si só; produz um typecheck vermelho.
    const { deps: d } = deps();
    expect(Object.keys(d.db).sort()).toEqual([
      "carregaCanal",
      "destinoEhDaPropriaOrganizacao",
      "marcaDaOrganizacao",
    ]);
    const r = await enviarAvisoDeTeste(d, entrada);
    expect(r.enviado).toBe(true);
  });
});

describe("as recusas, cada uma com o seu código", () => {
  it("canal removido ou arquivado", async () => {
    const semCanal = deps({
      db: {
        carregaCanal: vi.fn(async () => null),
        marcaDaOrganizacao: vi.fn(),
        destinoEhDaPropriaOrganizacao: vi.fn(),
      },
    } as Partial<DepsDoAvisoDeTeste>);
    await expect(enviarAvisoDeTeste(semCanal.deps, entrada)).resolves.toMatchObject({
      enviado: false,
      codigo: "canal_arquivado",
    });
  });

  it("canal que não manda texto livre", async () => {
    const d = deps({
      db: {
        carregaCanal: vi.fn(async () => ({ ...canalSaudavel, aceitaMensagemLivre: false })),
        marcaDaOrganizacao: vi.fn(),
        destinoEhDaPropriaOrganizacao: vi.fn(),
      },
    } as Partial<DepsDoAvisoDeTeste>);
    await expect(enviarAvisoDeTeste(d.deps, entrada)).resolves.toMatchObject({
      codigo: "canal_nao_aceita_aviso_livre",
    });
  });

  it("canal PAUSADO pelo operador: o teste também não sai por ele (#2318)", async () => {
    const d = deps({
      db: {
        carregaCanal: vi.fn(async () => ({ ...canalSaudavel, desativado: true })),
        marcaDaOrganizacao: vi.fn(),
        destinoEhDaPropriaOrganizacao: vi.fn(),
      },
    } as Partial<DepsDoAvisoDeTeste>);
    await expect(enviarAvisoDeTeste(d.deps, entrada)).resolves.toMatchObject({
      enviado: false,
      codigo: "canal_desativado",
    });
    expect(d.enviados).toHaveLength(0);
  });

  it("canal fora do ar — e o teste NÃO fica esperando 24 h como o aviso real", async () => {
    const d = deps({
      db: {
        carregaCanal: vi.fn(async () => ({ ...canalSaudavel, status: "STOPPED" })),
        marcaDaOrganizacao: vi.fn(),
        destinoEhDaPropriaOrganizacao: vi.fn(),
      },
    } as Partial<DepsDoAvisoDeTeste>);
    await expect(enviarAvisoDeTeste(d.deps, entrada)).resolves.toMatchObject({
      codigo: "canal_desconectado",
    });
  });

  it("sem endereço público — o link do teste não abriria nada", async () => {
    const d = deps({ urlPublica: "http://localhost:3000" });
    await expect(enviarAvisoDeTeste(d.deps, entrada)).resolves.toMatchObject({
      codigo: "sem_endereco_publico",
    });
  });

  it("transporte fora do ar", async () => {
    const d = deps();
    d.deps.transporte.configurado = vi.fn(async () => false);
    await expect(enviarAvisoDeTeste(d.deps, entrada)).resolves.toMatchObject({
      codigo: "transporte_ausente",
    });
  });

  it("teto diário do aquecimento — o código PRÓPRIO, com o instante em que libera", async () => {
    const libera = new Date("2026-09-19T03:00:00.000Z");
    const d = deps();
    d.deps.pacing.decide = vi.fn(async () => ({
      liberado: false as const,
      motivo: "teto_diario" as const,
      liberaEm: libera,
    }));
    const r = await enviarAvisoDeTeste(d.deps, entrada);
    expect(r).toMatchObject({ enviado: false, codigo: "teto_diario_do_numero" });
    expect(r.enviado === false && r.liberaEm).toBe(libera.toISOString());
  });

  it("espaçamento entre mensagens — motivo próprio, porque não é falha nenhuma", async () => {
    const libera = new Date(AGORA.getTime() + 1200);
    const d = deps();
    d.deps.pacing.decide = vi.fn(async () => ({
      liberado: false as const,
      motivo: "espacamento" as const,
      liberaEm: libera,
    }));
    await expect(enviarAvisoDeTeste(d.deps, entrada)).resolves.toMatchObject({
      enviado: false,
      codigo: "espacamento",
    });
  });

  it("destino que voltou a ser número de uma conexão ATIVA da própria organização — não envia", async () => {
    // O passo 11b do motor, repetido aqui: reativar a conexão cujo número é o
    // destino não pode fazer o teste sair verde enquanto o aviso real é recusado.
    const d = deps();
    d.deps.db.destinoEhDaPropriaOrganizacao = vi.fn(async () => true);
    const r = await enviarAvisoDeTeste(d.deps, entrada);
    expect(r).toEqual({ enviado: false, codigo: "destino_da_propria_organizacao" });
    expect(d.deps.db.destinoEhDaPropriaOrganizacao).toHaveBeenCalledWith(ORG, TELEFONE);
    expect(d.deps.transporte.envia).not.toHaveBeenCalled();
    expect(d.enviados).toEqual([]);
    expect(d.ledger).toEqual([]);
  });

  it("a leitura do destino falhou — `indeterminado`, nunca um throw nem um envio às cegas", async () => {
    const d = deps();
    d.deps.db.destinoEhDaPropriaOrganizacao = vi.fn(async () => {
      throw new Error("connection reset");
    });
    await expect(enviarAvisoDeTeste(d.deps, entrada)).resolves.toEqual({
      enviado: false,
      codigo: "indeterminado",
    });
    expect(d.enviados).toEqual([]);
  });

  it("destino que o canal não sabe endereçar", async () => {
    const d = deps();
    d.deps.transporte.resolveDestino = vi.fn(async () => null);
    await expect(enviarAvisoDeTeste(d.deps, entrada)).resolves.toMatchObject({
      codigo: "destino_invalido",
    });
  });

  it("o transporte recusou — a causa vira detalhe curto, nunca um throw solto", async () => {
    const d = deps();
    d.deps.transporte.envia = vi.fn(async () => {
      throw new Error("422 number not on whatsapp");
    });
    const r = await enviarAvisoDeTeste(d.deps, entrada);
    expect(r).toMatchObject({ enviado: false, codigo: "falha_no_envio" });
    expect(r.enviado === false && r.detalhe).toContain("422");
  });

  it("nenhuma recusa gasta o ledger — só o que SAIU é contado", async () => {
    const d = deps();
    d.deps.transporte.envia = vi.fn(async () => {
      throw new Error("recusado");
    });
    await enviarAvisoDeTeste(d.deps, entrada);
    expect(d.ledger).toEqual([]);
  });
});

describe("o teste nunca dorme", () => {
  it("não chama `setTimeout` em nenhum desfecho", async () => {
    const espiao = vi.spyOn(globalThis, "setTimeout");
    const d = deps();
    d.deps.pacing.decide = vi.fn(async () => ({
      liberado: false as const,
      motivo: "espacamento" as const,
      liberaEm: new Date(AGORA.getTime() + 1200),
    }));
    await enviarAvisoDeTeste(d.deps, entrada);
    expect(espiao).not.toHaveBeenCalled();
    espiao.mockRestore();
  });
});
