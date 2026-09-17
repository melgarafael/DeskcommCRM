/**
 * O CANAL NÃO VOLTA SOZINHO PARA O MODO DE TESTE (issue #602).
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * A RPC da 0218 (`fn_configurar_pre_go_live_canal`) gravava o LITERAL
 * `'pre_go_live'` em `ai_gate_mode` em TODA chamada — inclusive quando o modo
 * escolhido era `open`. Abrir o canal ao público limpava o `ai_gate` e deixava o
 * marcador de teste para trás. Sozinho isso é inerte (quem discrimina é
 * `ai_gate` primeiro); na VOLTA é caro: o script CLI do allowlist POR ORIGEM
 * (`scripts/ativar-gate-elegibilidade-ia.ts`) escrevia só `{ai_gate}` e o canal
 * reaparecia em PRÉ-GO-LIVE, com a lista de testadores velha, em vez da
 * autorização por origem que o operador pediu. Falha fechada e silenciosa: a IA
 * para de responder a quem deveria atender e nada acusa erro.
 *
 * ─── Por que um teste só do CLI não pegaria ────────────────────────────────
 *
 * Cada caminho isolado está certo: a tela grava o modo que o operador escolheu,
 * o CLI grava o allowlist que o operador pediu. O que quebra é a ORDEM —
 * tela nova → abrir ao público → CLI —, então é a ordem que este arquivo
 * exercita, com a mesma metadata atravessando os três passos.
 *
 * O último caso mede a divergência que a issue descreve: o preflight do script
 * prometia `autorizado` enquanto o motor devolvia `fora_da_lista_de_teste`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { decidirElegibilidade, montarEstadoDeElegibilidade } from "@/lib/ai/elegibilidade/gate";
import { lerModoDeAcessoDaIa, metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import {
  checkPlanoDeEscrita,
  metadataComGate,
  vereditoDepoisDoGate,
  type CtxAtivacao,
} from "../../scripts/lib/gate-ativacao";

const RAIZ = process.cwd();
const MIGRATION = "supabase/migrations/20260914210000_0251_acesso_da_ia_volta_a_trilha_do_operador.sql";
const SCRIPT = "scripts/ativar-gate-elegibilidade-ia.ts";
const TTL_MS = 21 * 86_400_000;
/** O mesmo telefone-exemplo que o produto mostra na tela. */
const TELEFONE_DE_TESTE = "+551****8888";

/**
 * O estado que a RPC DEFEITUOSA deixava no canal: aberto ao público, com o
 * marcador de teste ainda no jsonb. É o ponto de partida da volta que a issue
 * #602 descreve — e o único jeito de esse estado existir de novo.
 */
const ABERTO_COM_MARCADOR_VENCIDO: Record<string, unknown> = {
  ai_gate: "open",
  ai_gate_mode: "pre_go_live",
  ai_test_phone_numbers: [TELEFONE_DE_TESTE],
};

/** A última definição da RPC — no baseline é a do apêndice mais recente. */
function corpoDaRpc(arquivo: string): string {
  const fonte = readFileSync(resolve(RAIZ, arquivo), "utf8");
  const inicio = fonte.lastIndexOf("create or replace function public.fn_configurar_pre_go_live_canal(");
  expect(inicio, `a RPC do pré-go-live sumiu de ${arquivo}`).toBeGreaterThan(-1);
  return fonte.slice(inicio).split("\n$$;")[0]!;
}

/** A expressão que o `jsonb_set` grava numa chave — o valor, não a presença. */
function expressaoDaChave(corpo: string, chave: string): string {
  const encontrado = new RegExp(`'\\{${chave}\\}',\\s*([^,]+),\\s*true`).exec(corpo);
  expect(encontrado, `a RPC não escreve a chave {${chave}}`).not.toBeNull();
  return encontrado![1]!.trim();
}

/** O que o MOTOR decide, lendo a metadata que está no banco. */
function decisaoDoMotor(
  metadata: Record<string, unknown>,
  contato: { aiAuthorizedAt: string | null },
  agora: Date,
) {
  return decidirElegibilidade(
    montarEstadoDeElegibilidade({
      aiGate: metadata.ai_gate,
      aiGateMode: metadata.ai_gate_mode,
      forceHuman: false,
      assigneeKind: "ai",
      botSilencedUntil: null,
      aiAuthorizedAt: contato.aiAuthorizedAt,
      agora,
      ttlMs: TTL_MS,
    }),
  );
}

function ctxDoCanal(metadata: Record<string, unknown>): CtxAtivacao {
  return {
    pool: { query: async () => ({ rows: [] }) },
    organizationId: "d1a7e000-0000-4000-8000-00000000f601",
    channelSessionId: "d1a7e000-0000-4000-8000-00000000f602",
    channelMetadata: metadata,
    raiz: RAIZ,
    ttlMs: TTL_MS,
    alvoModo: "allowlist",
    rollback: false,
    opcoes: { permitirSemAgente: true, campanhasPerigosasOk: true, tamAmostra: 5 },
  };
}

describe("o acesso da IA volta à trilha do operador (issue #602)", () => {
  it("a RPC da tela grava o modo REAL — abrir ao público devolve ai_gate_mode = 'open'", () => {
    // O baseline é o que o kit self-host aplica; a migration é o mesmo contrato
    // em arquivo. Os dois têm de dizer a mesma coisa.
    for (const arquivo of ["supabase/baseline.sql", MIGRATION]) {
      const corpo = corpoDaRpc(arquivo);
      expect(expressaoDaChave(corpo, "ai_gate_mode"), `${arquivo} grava um literal`).toBe("to_jsonb(p_modo)");
      expect(expressaoDaChave(corpo, "ai_gate")).toBe("to_jsonb(v_gate)");
      // Guarda de vacuidade: a tradução do modo para o gate continua a mesma.
      expect(corpo).toContain("case when p_modo = 'pre_go_live' then 'allowlist' else 'open' end");
    }
  });

  it("a escrita do CLI grava os DOIS campos do gate, da mesma fonte", () => {
    const fonte = readFileSync(resolve(RAIZ, SCRIPT), "utf8");
    const inicio = fonte.indexOf("const depois = metadataComGate(");
    expect(inicio, "o script parou de usar o contrato `metadataComGate`").toBeGreaterThan(-1);
    const bloco = fonte.slice(inicio, fonte.indexOf('await cliente.query("commit")'));

    expect(bloco).toMatch(/'\{ai_gate\}'/);
    expect(bloco).toMatch(/'\{ai_gate_mode\}'/);
    // Os valores vêm do contrato compartilhado com o preflight — não de um
    // literal no meio do SQL, que é onde os dois divergem sem ninguém ver.
    expect(bloco).toMatch(/\[\s*canal\.id,\s*canal\.organization_id,\s*depois\.ai_gate,\s*depois\.ai_gate_mode\s*\]/);
    expect(bloco).not.toMatch(/JSON\.stringify\(ALVO_MODO\)/);
  });

  it("tela nova → abrir ao público → CLI liga o gate → o motor usa a autorização por origem", () => {
    const agora = new Date("2026-09-14T12:00:00.000Z");

    // 1. canal novo pelo produto: nasce fechado, em teste, com lista vazia.
    const aoNascer = metadataInicialDoCanal();
    expect(aoNascer).toMatchObject({ ai_gate: "allowlist", ai_gate_mode: "pre_go_live" });

    // 2. o operador abre ao público pela tela. A RPC grava `v_gate` em `ai_gate`
    //    e o modo REAL em `ai_gate_mode` (o censo acima é o que garante isso).
    const aberto = {
      ...aoNascer,
      ai_gate: "open",
      ai_gate_mode: "open",
      ai_test_phone_numbers: [TELEFONE_DE_TESTE],
    };
    expect(lerModoDeAcessoDaIa(aberto)).toBe("open");

    // 3. mais tarde o CLI liga o gate POR ORIGEM (0206) no mesmo canal.
    const depoisDoCli = metadataComGate(aberto, "allowlist");

    // 4. o motor passa a decidir pela autorização por origem — e a lista de
    //    testadores que sobrou no jsonb deixa de mandar.
    expect(lerModoDeAcessoDaIa(depoisDoCli)).toBe("allowlist");
    expect(decisaoDoMotor(depoisDoCli, { aiAuthorizedAt: agora.toISOString() }, agora)).toEqual({
      permite: true,
      motivo: "autorizado",
      bloqueioPorAllowlist: false,
    });
    expect(decisaoDoMotor(depoisDoCli, { aiAuthorizedAt: null }, agora).motivo).toBe("sem_autorizacao");
    expect(depoisDoCli.ai_test_phone_numbers).toEqual([TELEFONE_DE_TESTE]);
  });

  it("deixar o marcador para trás é o defeito: o motor volta a exigir a lista de testadores", () => {
    const agora = new Date("2026-09-14T12:00:00.000Z");

    // A escrita ANTIGA (só `ai_gate`) deixava a metadata assim — e o contato com
    // autorização por origem era bloqueado em silêncio.
    const comoOCliAntigoDeixava = { ...ABERTO_COM_MARCADOR_VENCIDO, ai_gate: "allowlist" };
    expect(decisaoDoMotor(comoOCliAntigoDeixava, { aiAuthorizedAt: agora.toISOString() }, agora)).toEqual({
      permite: false,
      motivo: "fora_da_lista_de_teste",
      bloqueioPorAllowlist: true,
    });

    // A escrita de agora não deixa esse estado existir: o alvo vale nos dois
    // campos, e as demais chaves do canal (lista, transporte) ficam onde estavam.
    expect(metadataComGate(ABERTO_COM_MARCADOR_VENCIDO, "allowlist")).toEqual({
      ai_gate: "allowlist",
      ai_gate_mode: "allowlist",
      ai_test_phone_numbers: [TELEFONE_DE_TESTE],
    });
  });

  it("o preflight do CLI promete exatamente o que o motor executa", () => {
    const agora = new Date("2026-09-14T12:00:00.000Z");
    const ctx = ctxDoCanal(ABERTO_COM_MARCADOR_VENCIDO);
    const promessa = vereditoDepoisDoGate(ctx, agora);
    const plano = checkPlanoDeEscrita(ctx);
    const texto = (plano.linhas ?? []).join("\n");

    // Motor × preflight, na mesma metadata: era aqui que os dois divergiam.
    const lidoPeloMotor = decisaoDoMotor(
      metadataComGate(ABERTO_COM_MARCADOR_VENCIDO, "allowlist"),
      { aiAuthorizedAt: agora.toISOString() },
      agora,
    );
    expect(promessa.comOrigem).toEqual(lidoPeloMotor);
    expect(promessa.comOrigem).toEqual({ permite: true, motivo: "autorizado", bloqueioPorAllowlist: false });
    expect(promessa.semOrigem.motivo).toBe("sem_autorizacao");

    // …e o plano impresso diz o mesmo, inclusive que o canal sai do pré-go-live.
    expect(texto).toMatch(/SAI do pré-go-live/);
    expect(texto).toContain("(autorizado)");
    expect(texto).not.toContain("fora_da_lista_de_teste");
    expect(plano.status).toBe("INFO");
    expect(plano.detalhe).toMatch(/marcador ainda diz "pre_go_live"/);
  });
});
