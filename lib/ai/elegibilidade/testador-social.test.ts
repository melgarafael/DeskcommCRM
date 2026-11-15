/**
 * Testadores de IA por IDENTIDADE SOCIAL no pré-go-live.
 *
 * Contato de Instagram/Facebook não tem telefone: entra por
 * `contacts.social_identity = <rede>:<conta conectada (24 hex)>:<participante>`
 * (gravada pela ingestão do intermediário social). Até aqui a lista só aceitava
 * telefone, e um canal social em teste não tinha como liberar a IA para UMA
 * conta de confiança. Este arquivo prova a lista nova de ponta a ponta na
 * regra pura — leitura, gravação, comparação e o gate — e que o canal de
 * telefone segue exatamente como era.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { decidirElegibilidade, montarEstadoDeElegibilidade } from "./gate";
import {
  AI_TEST_SOCIAL_IDENTITIES_KEY,
  aiAccessUpdateSchema,
  contatoPodeTestar,
  ehIdentidadeSocialDeTeste,
  identidadeSocialPodeTestar,
  lerIdentidadesSociaisDeTeste,
  MAX_TESTADORES_SOCIAIS,
  REDES_COM_TESTADOR_SOCIAL,
} from "./pre-go-live";
import { avaliarCanal } from "@/lib/channels/canal-mudo";

const CONTA = "6af9e0ef28984e27de07bef4";
const OUTRA_CONTA = "0123456789abcdef01234567";
const TESTADOR = `instagram:${CONTA}:1011223655361506`;
const MESMA_PESSOA_OUTRA_CONTA = `instagram:${OUTRA_CONTA}:1011223655361506`;
const AGORA = new Date("2026-11-15T12:00:00Z");

describe("a forma de uma identidade social testadora", () => {
  it("aceita Instagram e Facebook pela conta conectada de 24 hex", () => {
    expect(ehIdentidadeSocialDeTeste(TESTADOR)).toBe(true);
    expect(ehIdentidadeSocialDeTeste(`facebook:${CONTA}:987654321`)).toBe(true);
  });

  it("recusa telefone, WhatsApp, Telegram, rede sem atendimento e conta fora da forma", () => {
    for (const ruim of [
      "+5511999998888",
      `whatsapp:${CONTA}:5511999998888`,
      `telegram:${CONTA}:123`,
      `tiktok:${CONTA}:123`,
      `instagram:${CONTA.slice(1)}:123`,
      `instagram:${CONTA}:`,
      `instagram:${CONTA}:1 2`,
      `instagram:${CONTA}:123:extra`,
      42,
      null,
    ]) {
      expect(ehIdentidadeSocialDeTeste(ruim), String(ruim)).toBe(false);
    }
  });

  it("as redes aceitas são as do atendimento social, nunca WhatsApp nem Telegram", () => {
    expect([...REDES_COM_TESTADOR_SOCIAL].sort()).toEqual(["facebook", "instagram"]);
  });

  it("o SQL da migration aceita exatamente as mesmas redes (gravação e espelho do Inbox)", () => {
    const dir = join(process.cwd(), "supabase", "migrations");
    const arquivo = readdirSync(dir).find((f) => f.endsWith("_testadores_de_ia_por_identidade_social.sql"));
    expect(arquivo).toBeDefined();
    const sql = readFileSync(join(dir, arquivo!), "utf8");
    const redes = [...sql.matchAll(/\^\(([a-z|]+)\):\[0-9a-fA-F\]\{24\}/g)].map((m) => m[1]);
    // Uma vez na RPC de gravação, uma em `fn_automatico_da_conversa`.
    expect(redes).toHaveLength(2);
    for (const r of redes) expect(r!.split("|").sort()).toEqual([...REDES_COM_TESTADOR_SOCIAL].sort());
  });
});

describe("a lista social na metadata do canal", () => {
  it("lê, apara e remove repetidos", () => {
    expect(
      lerIdentidadesSociaisDeTeste({ [AI_TEST_SOCIAL_IDENTITIES_KEY]: [TESTADOR, ` ${TESTADOR} `] }),
    ).toEqual([TESTADOR]);
  });

  it("falha fechado: item inválido é descartado, chave ausente ou malformada é lista vazia", () => {
    expect(
      lerIdentidadesSociaisDeTeste({ [AI_TEST_SOCIAL_IDENTITIES_KEY]: ["lixo", TESTADOR, 7, "+5511999998888"] }),
    ).toEqual([TESTADOR]);
    expect(lerIdentidadesSociaisDeTeste({})).toEqual([]);
    expect(lerIdentidadesSociaisDeTeste({ [AI_TEST_SOCIAL_IDENTITIES_KEY]: TESTADOR })).toEqual([]);
    expect(lerIdentidadesSociaisDeTeste(null)).toEqual([]);
  });
});

describe("o contrato da tela", () => {
  it("lista social ausente continua ausente: a gravação não mexe nela", () => {
    const r = aiAccessUpdateSchema.parse({ mode: "pre_go_live", test_phone_numbers: [] });
    expect("test_social_identities" in r).toBe(false);
  });

  it("lista social presente é validada e deduplicada; vazia esvazia", () => {
    expect(
      aiAccessUpdateSchema.parse({
        mode: "pre_go_live", test_phone_numbers: [], test_social_identities: [TESTADOR, TESTADOR],
      }).test_social_identities,
    ).toEqual([TESTADOR]);
    expect(
      aiAccessUpdateSchema.parse({ mode: "open", test_phone_numbers: [], test_social_identities: [] })
        .test_social_identities,
    ).toEqual([]);
  });

  it("recusa a lista inteira quando um item não é identidade social, e acima do teto", () => {
    expect(
      aiAccessUpdateSchema.safeParse({
        mode: "pre_go_live", test_phone_numbers: [], test_social_identities: [TESTADOR, "+5511999998888"],
      }).success,
    ).toBe(false);
    const demais = Array.from({ length: MAX_TESTADORES_SOCIAIS + 1 }, (_, i) => `instagram:${CONTA}:${i}`);
    expect(
      aiAccessUpdateSchema.safeParse({ mode: "pre_go_live", test_phone_numbers: [], test_social_identities: demais })
        .success,
    ).toBe(false);
  });
});

describe("quem pode testar", () => {
  it("a identidade casa por igualdade exata — a mesma pessoa vista por OUTRA conta não casa", () => {
    expect(identidadeSocialPodeTestar(TESTADOR, [TESTADOR])).toBe(true);
    expect(identidadeSocialPodeTestar(MESMA_PESSOA_OUTRA_CONTA, [TESTADOR])).toBe(false);
    expect(identidadeSocialPodeTestar(`facebook:${CONTA}:1011223655361506`, [TESTADOR])).toBe(false);
    expect(identidadeSocialPodeTestar(null, [TESTADOR])).toBe(false);
    expect(identidadeSocialPodeTestar("", [TESTADOR])).toBe(false);
  });

  it("telefone OU identidade social, cada um pela sua lista", () => {
    const metadata = { ai_test_phone_numbers: ["+5585987654321"], ai_test_social_identities: [TESTADOR] };
    expect(contatoPodeTestar({ telefone: null, identidadeSocial: TESTADOR }, metadata)).toBe(true);
    expect(contatoPodeTestar({ telefone: "+558587654321", identidadeSocial: null }, metadata)).toBe(true);
    expect(contatoPodeTestar({ telefone: null, identidadeSocial: MESMA_PESSOA_OUTRA_CONTA }, metadata)).toBe(false);
    // Um telefone não "vira" identidade nem o contrário.
    expect(
      contatoPodeTestar({ telefone: "+5585987654321", identidadeSocial: null }, { ai_test_social_identities: [TESTADOR] }),
    ).toBe(false);
  });
});

/** O estado cru como os transportes (pg, supabase, varredura) o montam. */
function estado(over: Partial<Parameters<typeof montarEstadoDeElegibilidade>[0]>) {
  return montarEstadoDeElegibilidade({
    orgStatus: "active",
    aiGate: "allowlist",
    aiGateMode: "pre_go_live",
    aiTestPhoneNumbers: [],
    aiTestSocialIdentities: [TESTADOR],
    contactPhoneNumber: null,
    contactSocialIdentity: TESTADOR,
    forceHuman: false,
    aiOptOut: false,
    assigneeKind: "ai",
    metadataDaConversa: null,
    botSilencedUntil: null,
    aiAuthorizedAt: null,
    agora: AGORA,
    ttlMs: 21 * 24 * 60 * 60 * 1000,
    ...over,
  });
}

describe("o gate do pré-go-live com o testador social", () => {
  it("a conta da lista é atendida pela IA", () => {
    expect(decidirElegibilidade(estado({}))).toEqual({
      permite: true, motivo: "numero_de_teste", bloqueioPorAllowlist: false,
    });
  });

  it("a mesma pessoa por outra conta conectada fica de fora", () => {
    expect(decidirElegibilidade(estado({ contactSocialIdentity: MESMA_PESSOA_OUTRA_CONTA })).motivo)
      .toBe("fora_da_lista_de_teste");
  });

  it("transporte que não lê a lista social falha FECHADO", () => {
    expect(decidirElegibilidade(estado({ aiTestSocialIdentities: undefined })).motivo)
      .toBe("fora_da_lista_de_teste");
    expect(decidirElegibilidade(estado({ contactSocialIdentity: undefined })).motivo)
      .toBe("fora_da_lista_de_teste");
  });

  it("canal em teste com a lista social vazia ou corrompida: ninguém passa, nem o contato social", () => {
    for (const lista of [[], ["lixo", 7, null], `{${TESTADOR}}`, { 0: TESTADOR }]) {
      expect(decidirElegibilidade(estado({ aiTestSocialIdentities: lista })).motivo, JSON.stringify(lista))
        .toBe("fora_da_lista_de_teste");
    }
  });

  it("vetos humanos continuam acima da lista social", () => {
    expect(decidirElegibilidade(estado({ forceHuman: true })).motivo).toBe("force_human");
    expect(decidirElegibilidade(estado({ aiOptOut: true })).motivo).toBe("ai_opt_out");
  });

  it("fora do pré-go-live a lista social não autoriza nada sozinha (allowlist por origem)", () => {
    expect(decidirElegibilidade(estado({ aiGateMode: undefined })).motivo).toBe("sem_autorizacao");
  });

  it("o canal de telefone segue como era: o número da lista passa, o resto não", () => {
    const telefone = { aiTestPhoneNumbers: ["+5585987654321"], aiTestSocialIdentities: undefined, contactSocialIdentity: null };
    expect(decidirElegibilidade(estado({ ...telefone, contactPhoneNumber: "+558587654321" })).motivo)
      .toBe("numero_de_teste");
    expect(decidirElegibilidade(estado({ ...telefone, contactPhoneNumber: "+5585987654000" })).motivo)
      .toBe("fora_da_lista_de_teste");
  });
});

describe("o aviso de canal mudo", () => {
  it("canal em teste com conta social autorizada não é mudo: o aviso se resolve", () => {
    expect(
      avaliarCanal(
        {
          id: "c", organization_id: "o", status: "WORKING", archived_at: null,
          last_status_change_at: "2026-11-01T00:00:00Z",
          metadata: { ai_gate: "allowlist", ai_test_phone_numbers: [], ai_test_social_identities: [TESTADOR] },
        },
        AGORA,
      ),
    ).toEqual({ acao: "resolver", motivo: "ganhou_numero" });
  });
});
