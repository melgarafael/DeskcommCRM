import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * O vocabulário do terceiro canal — o que entra ANTES do transporte.
 *
 * O tipo, a matriz de capabilities, a coluna de ref e os CHECKs do banco
 * nasceram JUNTOS e antes do transporte — o caminho inverso obriga a uma
 * migration de correção sobre dados que já existem, e é onde clone quebra.
 *
 * Aqui se prova o vocabulário e o ENCANAMENTO até o adapter. O transporte em si
 * (formato do corpo, autenticação, respostas da API) está em
 * `channel-adapter-zernio.test.ts`, contra o contrato medido na API real.
 */
import {
  CHANNEL_CAPABILITIES,
  CHANNEL_PROVIDER_ZERNIO,
  capabilitiesOf,
} from "@/lib/channels/capabilities";
import { getAdapter } from "@/lib/channels";
import type { OutboundEnvelope } from "@/lib/channels";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";

const ZERNIO = CHANNEL_PROVIDER_ZERNIO;

describe("capabilities do canal intermediado", () => {
  it("descreve o PERMITIDO, que é o do canal oficial — quem intermedeia muda o transporte", () => {
    expect(capabilitiesOf(ZERNIO)).toEqual({
      freeformOutsideWindow: false,
      requiresTemplates: true,
      canManageTemplates: true,
      banRisk: false,
      minIntervalMs: 6000,
      voiceNote: "opus-only",
      groups: "limited",
      costPerMessage: true,
      alteraMensagemEnviada: false,
    });
  });

  it("não herda o perfil do canal por QR — o que muda é o risco, e errar aqui desarma o anti-ban", () => {
    const porQr = CHANNEL_CAPABILITIES.waha;
    expect(capabilitiesOf(ZERNIO).banRisk).toBe(false);
    expect(porQr.banRisk).toBe(true);
    expect(capabilitiesOf(ZERNIO).requiresTemplates).not.toBe(porQr.requiresTemplates);
  });

  it("freeformOutsideWindow=false está MEDIDO: a API aceita e a Meta recusa a entrega", () => {
    // A API devolve 200 + wamid, e o webhook traz depois:
    //   131047 "The 24-hour customer service window for this contact is closed."
    // Declarar `true` aqui faria a cadeia before_send liberar um envio que a
    // plataforma descarta em silêncio — o operador vê "enviado" e o cliente
    // nunca recebe.
    expect(capabilitiesOf(ZERNIO).freeformOutsideWindow).toBe(false);
    expect(capabilitiesOf(ZERNIO).requiresTemplates).toBe(true);
  });

  it("voiceNote é opus-only: o provider tem a flag mas NÃO converte", () => {
    // Ler o booleano do provider como "ele resolve para mim" é o erro que manda
    // mp3 e entrega anexo de música em vez de bolha de voz.
    expect(capabilitiesOf(ZERNIO).voiceNote).toBe("opus-only");
  });
});

describe("identificador da sessão", () => {
  it("resolve pelo id do INTERMEDIÁRIO, não pelo da Meta", () => {
    expect(resolveSessionRef({ provider: ZERNIO as "zernio", zernio_account_id: "acc_123" })).toBe(
      "acc_123",
    );
  });

  it("a coluna entra no select — sem ela o ref volta indefinido em runtime", () => {
    expect(CHANNEL_SESSION_REF_COLUMNS).toContain("zernio_account_id");
  });

  it("cada canal resolve pela SUA coluna — nenhum cai na do outro", () => {
    expect(resolveSessionRef({ provider: "waha", waha_session_name: "s1" })).toBe("s1");
    expect(resolveSessionRef({ provider: "meta_cloud", meta_phone_number_id: "pn1" })).toBe("pn1");
  });
});

describe("o canal tem transporte", () => {
  it("getAdapter devolve o adapter do canal, não o de outro", () => {
    // Cair no canal por QR por default seria pior que lançar: enviar pelo canal
    // errado é pior que não enviar.
    expect(getAdapter(ZERNIO).provider).toBe(ZERNIO);
  });

  it("os códigos de erro nomeiam o canal — o operador precisa saber qual falhou", () => {
    expect(getAdapter(ZERNIO).codes.sendFailed).toContain("zernio");
  });
});

describe("o envelope carrega a thread do provider", () => {
  it("OutboundEnvelope aceita providerConversationId e é OPCIONAL", () => {
    // Opcional é o ponto: os dois adapters existentes derivam o destinatário do
    // contato e não mudam uma linha por causa deste campo.
    const semThread: OutboundEnvelope = {
      organizationId: "00000000-0000-4000-8000-000000000236",
      sessionRef: "s",
      to: "t",
      kind: "text",
      body: "x",
    };
    const comThread: OutboundEnvelope = { ...semThread, providerConversationId: "6a35" };
    expect(semThread.providerConversationId).toBeUndefined();
    expect(comThread.providerConversationId).toBe("6a35");
  });

  it("o handler LÊ a coluna e a PASSA ao adapter — o elo que some sem barulho", () => {
    const fonte = readFileSync("app/api/v1/messages/_handler.ts", "utf8");
    // Ler sem passar, ou passar sem ler, deixa o envio livre quebrado só neste
    // canal — e só quando alguém tentar responder dentro da janela.
    // A régua é PERTENCER ao select, não ficar ao lado de uma coluna vizinha.
    // A versão anterior casava /group_chat_id,\s*provider_conversation_id/ — e
    // adjacência é acidente de formatação, não a propriedade guardada: o PR #225
    // inseriu `bot_silenced_until` entre as duas e reprovou um handler que lia e
    // passava a coluna exatamente como antes. Gate que reprova o inocente ensina
    // a contornar gate.
    const convSelect = /const convSelect =[\s\S]*?`([^`]+)`/.exec(fonte)?.[1];
    expect(convSelect, "não achei o convSelect do handler — o teste ficou cego").toBeTruthy();
    expect(convSelect, "falta a coluna no select da conversa").toContain(
      "provider_conversation_id",
    );
    // QUATRO desde que o cartão de contato passou a sair pelo canal: texto,
    // mídia, modelo e contato. O número é conferido, e não `>= 1`, justamente
    // para obrigar quem acrescenta um call site novo a DECIDIR se ele também
    // carrega a thread — foi assim que este caso pegou a rama de modelo, que a
    // princípio não precisaria dela mas precisa quando o provider reaproveita a
    // conversa existente, e foi assim que ele pegou a de contato agora.
    //
    // A resposta para o cartão de contato é a mesma das outras três: o canal
    // oficial endereça por thread própria, e um cartão enviado sem ela abriria
    // conversa nova em vez de continuar a que está aberta.
    const passagens = [...fonte.matchAll(/providerConversationId:\s*c\.provider_conversation_id/g)];
    expect(
      passagens.length,
      "todos os call sites (texto, mídia, modelo e contato) precisam passar",
    ).toBe(4);
  });
});

describe("banco e TypeScript falam o mesmo vocabulário", () => {
  // O `pnpm test:db` prova isto contra um Postgres real; aqui é a leitura do
  // artefato que o self-hoster de fato aplica — o baseline, não as migrations.
  const baseline = readFileSync("supabase/baseline.sql", "utf8");

  it("o CHECK de provider do baseline conhece o canal novo", () => {
    expect(baseline).toMatch(/channel_sessions_provider_check[\s\S]{0,300}'zernio'/);
  });

  it("o CHECK de ref exige a coluna do canal novo", () => {
    expect(baseline).toMatch(
      /provider (?:= 'zernio'|in \('zernio', 'zernio_social'\))\s+and zernio_account_id\s+is not null/,
    );
  });

  it("os CHECKs são RECRIADOS, não protegidos por duplicate_object", () => {
    // Num clone eles já existem na versão de dois providers. `exception when
    // duplicate_object` engoliria a versão nova em silêncio: `update.sh` verde
    // e o banco recusando a sessão do canal novo.
    expect(baseline).toContain("drop constraint if exists channel_sessions_provider_check");
    expect(baseline).toContain("drop constraint if exists channel_sessions_provider_ref_check");
  });

  it("a coluna nasce antes do CHECK que a referencia", () => {
    const col = baseline.indexOf("add column if not exists zernio_account_id");
    const check = baseline.search(/provider (?:= 'zernio'|in \('zernio', 'zernio_social'\))/);
    expect(col).toBeGreaterThan(-1);
    expect(col).toBeLessThan(check);
  });

  it("a migration versionada existe junto do apêndice — clone atualiza pelas duas vias", () => {
    const mig = readFileSync(
      "supabase/migrations/20260808020000_0131_canal_zernio_vocabulario.sql",
      "utf8",
    );
    expect(mig).toContain("zernio_account_id");
    expect(readFileSync("supabase/migrations/MANIFEST.md", "utf8")).toContain(
      "0131_canal_zernio_vocabulario",
    );
  });
});
