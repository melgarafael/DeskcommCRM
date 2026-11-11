/**
 * Status do WhatsApp PELO adapter (#3397).
 *
 * Este arquivo mede o caminho inteiro SEM tocar em provedor: o cliente do
 * transporte é dublê, e o adapter é o DE VERDADE (`getAdapter("waha")`). É de
 * propósito — o que a issue pede não é "o handler chama isto", é que a
 * publicação passe pelo CONTRATO do canal:
 *
 *   - o envelope que chega ao transporte é o do Status (imagem + legenda +
 *     público em JID), montado pelo adapter, não por quem publica;
 *   - quem não publica Status responde pela CAPABILITY, sem que a feature
 *     precise saber qual canal é;
 *   - canal desativado e canal fora do ar recusam ANTES do envio;
 *   - publicar para TODOS depende do acervo do histórico, e a falta dele é
 *     EXPLICADA — nunca consertada ligando o acervo por conta própria (#999);
 *   - a chave de idempotência é reservada antes do efeito: retry não publica
 *     duas vezes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendStatusImage } = vi.hoisted(() => ({ sendStatusImage: vi.fn() }));

vi.mock("@/lib/waha/client", () => ({
  getWahaClient: () => ({ sendStatusImage }),
}));

import { bancoFalso, type Linha } from "@/tests/helpers/banco-falso-do-status";

import { lerPublico, publicarStatusDoWhatsapp } from "./publicacao-de-status";
import { getAdapter } from "./index";
import type { PublishStatusInput } from "./types";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const IMG = "A".repeat(200);

const SESSAO: Linha = {
  id: CANAL,
  provider: "waha",
  status: "WORKING",
  archived_at: null,
  waha_session_name: "loja",
  meta_phone_number_id: null,
  zernio_account_id: null,
  datafy_phone_number_id: null,
  metadata: { guardar_historico: true },
};

const entrada = (over: Partial<Parameters<typeof publicarStatusDoWhatsapp>[0]> = {}) => ({
  canalId: CANAL,
  organizationId: ORG,
  imagem: { mime: "image/jpeg" as const, base64: IMG },
  contatos: ["+55 (15) 99999-9999"],
  ...over,
});

describe("publicação de Status — o caminho passa pelo adapter do canal", () => {
  beforeEach(() => {
    sendStatusImage.mockReset().mockResolvedValue({ id: { id: "ST-1" } });
  });

  it("manda ao provedor o envelope do Status, com o público já em JID (o adapter traduz)", async () => {
    const { db } = bancoFalso({ sessao: SESSAO });

    const feita = await publicarStatusDoWhatsapp({
      db,
      ...entrada({ contatos: ["+55 (15) 99999-9999", "5515988887777"], legenda: "Promo" }),
    });

    expect(sendStatusImage).toHaveBeenCalledWith("loja", {
      mimetype: "image/jpeg",
      data: IMG,
      caption: "Promo",
      contacts: ["5515999999999@c.us", "5515988887777@c.us"],
    });
    expect(feita).toEqual({
      publicado: true,
      statusId: "ST-1",
      publico: "2 contato(s)",
      excluidos: 0,
      deduplicado: false,
    });
  });

  it("`todos` sai SEM lista: no provedor, sem lista é o número inteiro", async () => {
    const { db } = bancoFalso({ sessao: SESSAO });

    const feita = await publicarStatusDoWhatsapp({ db, ...entrada({ contatos: undefined, todos: true }) });

    const envelope = sendStatusImage.mock.calls[0]![1] as Record<string, unknown>;
    expect(envelope).not.toHaveProperty("contacts");
    expect(feita.publico).toBe("todos");
  });

  it("quem publica é o MÉTODO do adapter, e o público chega NEUTRO (dígitos, não JID)", async () => {
    // A prova de que a publicação passa pelo CONTRATO e não por uma chamada
    // direta ao provedor: o adapter recebe o público sem dialeto nenhum. Quem
    // vira `@c.us` é ele, uma camada abaixo — e é essa divisão que permite
    // outro canal publicar Status sem que a feature mude uma linha.
    const adapter = getAdapter("waha");
    const original = adapter.publishStatus;
    if (!original) throw new Error("o adapter WAHA deveria implementar publishStatus");
    const vistos: PublishStatusInput[] = [];
    adapter.publishStatus = async (publicacao) => {
      vistos.push(publicacao);
      return original.call(adapter, publicacao);
    };

    try {
      const { db } = bancoFalso({ sessao: SESSAO });
      await publicarStatusDoWhatsapp({ db, ...entrada({ legenda: "Promo" }) });
    } finally {
      adapter.publishStatus = original;
    }

    expect(vistos).toHaveLength(1);
    expect(vistos[0]?.sessionRef).toBe("loja");
    expect(vistos[0]?.publico).toEqual({ tipo: "contatos", numeros: ["5515999999999"] });
    expect(vistos[0]?.legenda).toBe("Promo");
    expect(vistos[0]?.imagem).toEqual({ mime: "image/jpeg", base64: IMG });
  });

  it("canal desativado pelo operador recusa antes de publicar", async () => {
    const { db } = bancoFalso({ sessao: { ...SESSAO, metadata: { disabled: true, guardar_historico: true } } });

    await expect(publicarStatusDoWhatsapp({ db, ...entrada() })).rejects.toThrow(/canal_desativado/);
    expect(sendStatusImage).not.toHaveBeenCalled();
  });

  it("canal que não publica Status responde pela capability, sem a feature saber qual é", async () => {
    const { db } = bancoFalso({
      sessao: { ...SESSAO, provider: "meta_cloud", waha_session_name: null, meta_phone_number_id: "123" },
    });

    await expect(publicarStatusDoWhatsapp({ db, ...entrada() })).rejects.toThrow(/canal_sem_status/);
    expect(sendStatusImage).not.toHaveBeenCalled();
  });

  it("canal fora do ar recusa com o estado na mensagem", async () => {
    const { db } = bancoFalso({ sessao: { ...SESSAO, status: "SCAN_QR_CODE" } });

    await expect(publicarStatusDoWhatsapp({ db, ...entrada() })).rejects.toThrow(/SCAN_QR_CODE/);
    expect(sendStatusImage).not.toHaveBeenCalled();
  });

  it("publicar para TODOS sem acervo do histórico EXPLICA o que falta e não liga nada", async () => {
    const { db, contagem } = bancoFalso({ sessao: { ...SESSAO, metadata: {} } });

    await expect(
      publicarStatusDoWhatsapp({ db, ...entrada({ contatos: undefined, todos: true }) }),
    ).rejects.toThrow(/acervo_desligado/);
    expect(sendStatusImage).not.toHaveBeenCalled();
    // A decisão da #999: quem liga o acervo é o operador, na tela. A publicação
    // não pode "resolver" a falta escrevendo no canal.
    expect(contagem.escritasEmCanais).toBe(0);
  });

  it("sem acervo, a LISTA continua valendo (o acervo só governa `todos`)", async () => {
    const { db } = bancoFalso({ sessao: { ...SESSAO, metadata: {} } });

    const feita = await publicarStatusDoWhatsapp({ db, ...entrada() });

    expect(feita.publicado).toBe(true);
    expect(sendStatusImage).toHaveBeenCalledTimes(1);
  });

  it.each(["waha_status_400", "waha_status_422"])(
    "`todos` recusado pelo canal (%s) vira frase de quem opera, sem nome de provedor",
    async (recusa) => {
      sendStatusImage.mockRejectedValue(new Error(recusa));
      const { db } = bancoFalso({ sessao: SESSAO });

      const erro = await publicarStatusDoWhatsapp({
        db,
        ...entrada({ contatos: undefined, todos: true }),
      }).catch((e: Error) => e);

      expect(String(erro)).toMatch(/publico_indisponivel: .*Guardar histórico/);
      expect(String(erro)).not.toMatch(/waha/i);
    },
  );

  it.each([
    ["sem resposta no teto", "waha_timeout: sem resposta em 30000ms"],
    ["conexão caída", "fetch failed"],
    ["erro do provedor", "waha_status_500"],
  ])("%s: é incerto, e a recusa manda conferir em vez de repetir", async (_caso, falha) => {
    sendStatusImage.mockRejectedValue(new Error(falha));
    const { db } = bancoFalso({ sessao: SESSAO });

    await expect(publicarStatusDoWhatsapp({ db, ...entrada() })).rejects.toThrow(/publicacao_incerta/);
  });

  it("incerto com chave: o retry NÃO publica de novo, porque a primeira pode ter saído", async () => {
    sendStatusImage.mockRejectedValue(new Error("waha_timeout: sem resposta em 30000ms"));
    const { db } = bancoFalso({ sessao: SESSAO });
    const comum = entrada({ idempotencyKey: "run-3" });

    await expect(publicarStatusDoWhatsapp({ db, ...comum })).rejects.toThrow(/publicacao_incerta/);
    await expect(publicarStatusDoWhatsapp({ db, ...comum })).rejects.toThrow(/publicacao_incerta/);

    expect(sendStatusImage).toHaveBeenCalledTimes(1);
  });

  it("recusa do canal libera a chave: nada saiu, e o retry publica", async () => {
    sendStatusImage.mockRejectedValueOnce(new Error("waha_status_400"));
    const { db } = bancoFalso({ sessao: SESSAO });
    const comum = entrada({ idempotencyKey: "run-4" });

    await expect(publicarStatusDoWhatsapp({ db, ...comum })).rejects.toThrow(/publicacao_recusada/);
    const feita = await publicarStatusDoWhatsapp({ db, ...comum });

    expect(feita.publicado).toBe(true);
    expect(sendStatusImage).toHaveBeenCalledTimes(2);
  });

  it("recusa do canal com lista também sai em português", async () => {
    sendStatusImage.mockRejectedValue(new Error("waha_status_400"));
    const { db } = bancoFalso({ sessao: SESSAO });

    const erro = await publicarStatusDoWhatsapp({ db, ...entrada() }).catch((e: Error) => e);

    expect(String(erro)).toMatch(/publicacao_recusada: .*HTTP 400/);
    expect(String(erro)).not.toMatch(/waha/i);
  });

  it("o público é escolha declarada: nem omitido, nem os dois", async () => {
    const { db } = bancoFalso({ sessao: SESSAO });

    await expect(publicarStatusDoWhatsapp({ db, ...entrada({ contatos: undefined }) })).rejects.toThrow(
      /publico_ausente/,
    );
    await expect(
      publicarStatusDoWhatsapp({ db, ...entrada({ contatos: ["5515999999999"], todos: true }) }),
    ).rejects.toThrow(/publico_ambiguo/);
    expect(sendStatusImage).not.toHaveBeenCalled();
  });

  it("idempotência: a mesma chave devolve a primeira publicação e NÃO publica de novo", async () => {
    const { db } = bancoFalso({ sessao: SESSAO });
    const comum = entrada({ idempotencyKey: "run-1:step-3", legenda: "Promo" });

    const primeira = await publicarStatusDoWhatsapp({ db, ...comum });
    const segunda = await publicarStatusDoWhatsapp({ db, ...comum });

    expect(sendStatusImage).toHaveBeenCalledTimes(1);
    expect(primeira.deduplicado).toBe(false);
    expect(segunda).toEqual({ ...primeira, deduplicado: true });
  });

  it("a mesma chave com OUTRA imagem é conflito, não replay", async () => {
    const { db } = bancoFalso({ sessao: SESSAO });

    await publicarStatusDoWhatsapp({ db, ...entrada({ idempotencyKey: "run-2" }) });
    await expect(
      publicarStatusDoWhatsapp({
        db,
        ...entrada({ idempotencyKey: "run-2", imagem: { mime: "image/jpeg", base64: "B".repeat(200) } }),
      }),
    ).rejects.toThrow(/idempotency_conflict/);
    expect(sendStatusImage).toHaveBeenCalledTimes(1);
  });
});

describe("publicação de Status — quem pediu para sair fica de fora da lista", () => {
  const BLOQUEADO = {
    phone_number: "+5515999999999",
    is_blocked: true,
    is_anonymized: false,
    is_personal: false,
  };

  beforeEach(() => {
    sendStatusImage.mockReset().mockResolvedValue({ id: { id: "ST-1" } });
  });

  it("tira o bloqueado, publica para o resto e diz quantos saíram", async () => {
    const { db } = bancoFalso({ sessao: SESSAO, contatos: [BLOQUEADO] });

    const feita = await publicarStatusDoWhatsapp({
      db,
      ...entrada({ contatos: ["5515999999999", "5515988887777"] }),
    });

    const envelope = sendStatusImage.mock.calls[0]![1] as { contacts: string[] };
    expect(envelope.contacts).toEqual(["5515988887777@c.us"]);
    expect(feita).toMatchObject({ publico: "1 contato(s)", excluidos: 1 });
  });

  it("casa pela outra grafia do número: cadastro sem o nono dígito também sai", async () => {
    const { db } = bancoFalso({ sessao: SESSAO, contatos: [BLOQUEADO] });

    const feita = await publicarStatusDoWhatsapp({
      db,
      ...entrada({ contatos: ["551599999999", "5515988887777"] }),
    });

    expect(feita.excluidos).toBe(1);
  });

  it("alcança o telefone extra da ficha de quem pediu para sair", async () => {
    const { db } = bancoFalso({
      sessao: SESSAO,
      telefonesExtras: [
        {
          phone_number: "+5515977776666",
          contacts: { is_blocked: true, is_anonymized: false, is_personal: false },
        },
        {
          phone_number: "+5515988887777",
          contacts: { is_blocked: false, is_anonymized: false, is_personal: false },
        },
      ],
    });

    const feita = await publicarStatusDoWhatsapp({
      db,
      ...entrada({ contatos: ["5515977776666", "5515988887777"] }),
    });

    const envelope = sendStatusImage.mock.calls[0]![1] as { contacts: string[] };
    expect(envelope.contacts).toEqual(["5515988887777@c.us"]);
    expect(feita.excluidos).toBe(1);
  });

  it("tira quem passou pela cascata de LGPD: sem telefone na ficha e sem extras, só a marca lembra", async () => {
    // A forma pós-cascata: `phone_number` nulo e nenhuma linha em `contact_phones`.
    // A ficha existe, mas nenhuma leitura por telefone a encontra.
    const { db } = bancoFalso({
      sessao: SESSAO,
      contatos: [{ phone_number: null, is_blocked: false, is_anonymized: true, is_personal: false }],
      telefonesExtras: [],
      apagados: ["5515999999999"],
    });

    const feita = await publicarStatusDoWhatsapp({
      db,
      ...entrada({ contatos: ["+55 (15) 99999-9999", "5515988887777"] }),
    });

    const envelope = sendStatusImage.mock.calls[0]![1] as { contacts: string[] };
    expect(envelope.contacts).toEqual(["5515988887777@c.us"]);
    expect(feita).toMatchObject({ publico: "1 contato(s)", excluidos: 1 });
  });

  it.each([
    ["erro de leitura", { data: null, error: { message: "fora do ar" } }],
    ["resposta sem sim nem não", { data: null, error: null }],
  ])("sem a marca de apagamento (%s), nada é publicado", async (_caso, respostaDaMarca) => {
    const { db } = bancoFalso({ sessao: SESSAO, respostaDaMarca });

    await expect(publicarStatusDoWhatsapp({ db, ...entrada() })).rejects.toThrow(/opt_out_ilegivel/);
    expect(sendStatusImage).not.toHaveBeenCalled();
  });

  it("contato pessoal sai pelo telefone principal", async () => {
    const { db } = bancoFalso({
      sessao: SESSAO,
      contatos: [{ phone_number: "+5515999999999", is_blocked: false, is_anonymized: false, is_personal: true }],
    });

    const feita = await publicarStatusDoWhatsapp({
      db,
      ...entrada({ contatos: ["5515999999999", "5515988887777"] }),
    });

    const envelope = sendStatusImage.mock.calls[0]![1] as { contacts: string[] };
    expect(envelope.contacts).toEqual(["5515988887777@c.us"]);
    expect(feita.excluidos).toBe(1);
  });

  it("contato pessoal sai pelo telefone extra da ficha", async () => {
    const { db } = bancoFalso({
      sessao: SESSAO,
      telefonesExtras: [
        {
          phone_number: "+5515977776666",
          contacts: { is_blocked: false, is_anonymized: false, is_personal: true },
        },
      ],
    });

    const feita = await publicarStatusDoWhatsapp({
      db,
      ...entrada({ contatos: ["5515977776666", "5515988887777"] }),
    });

    const envelope = sendStatusImage.mock.calls[0]![1] as { contacts: string[] };
    expect(envelope.contacts).toEqual(["5515988887777@c.us"]);
    expect(feita.excluidos).toBe(1);
  });

  it("contato comum continua no público: a ficha lida não exclui por si só", async () => {
    const { db } = bancoFalso({
      sessao: SESSAO,
      contatos: [{ phone_number: "+5515999999999", is_blocked: false, is_anonymized: false, is_personal: false }],
    });

    const feita = await publicarStatusDoWhatsapp({ db, ...entrada() });

    expect(feita).toMatchObject({ publico: "1 contato(s)", excluidos: 0 });
  });

  it("lista inteira de fora não publica, e diz por quê", async () => {
    const { db } = bancoFalso({ sessao: SESSAO, contatos: [BLOQUEADO] });

    await expect(publicarStatusDoWhatsapp({ db, ...entrada() })).rejects.toThrow(/publico_vazio/);
    expect(sendStatusImage).not.toHaveBeenCalled();
  });

  it("sem conseguir ler quem saiu, nada é publicado", async () => {
    const { db } = bancoFalso({ sessao: SESSAO, erroEmContatos: { message: "fora do ar" } });

    await expect(publicarStatusDoWhatsapp({ db, ...entrada() })).rejects.toThrow(/opt_out_ilegivel/);
    expect(sendStatusImage).not.toHaveBeenCalled();
  });

  it("quem sai depois da publicação não vira conflito de chave: o retry recebe o recibo", async () => {
    const contatos: Linha[] = [];
    const { db } = bancoFalso({ sessao: SESSAO, contatos });
    const comum = entrada({ idempotencyKey: "run-5" });

    await publicarStatusDoWhatsapp({ db, ...comum });
    contatos.push(BLOQUEADO);

    await expect(publicarStatusDoWhatsapp({ db, ...comum })).resolves.toMatchObject({
      deduplicado: true,
      excluidos: 0,
    });
    expect(sendStatusImage).toHaveBeenCalledTimes(1);
  });

  it("`todos` não consulta contatos: a escolha ali é do WhatsApp", async () => {
    const { db } = bancoFalso({
      sessao: SESSAO,
      erroEmContatos: { message: "não devia ler" },
      respostaDaMarca: { data: null, error: { message: "não devia perguntar" } },
    });

    const feita = await publicarStatusDoWhatsapp({ db, ...entrada({ contatos: undefined, todos: true }) });

    expect(feita).toMatchObject({ publico: "todos", excluidos: 0 });
  });
});

describe("lerPublico — a régua é o dígito, não a máscara", () => {
  it("aceita os formatos em que as pessoas escrevem telefone", () => {
    expect(lerPublico(["+55 (15) 99999-9999", "5515 98888-7777"])).toEqual({
      tipo: "contatos",
      numeros: ["5515999999999", "5515988887777"],
    });
  });

  it("recusa o que não é telefone, dizendo QUAL entrada errou", () => {
    expect(() => lerPublico(["abc"])).toThrow(/contato_invalido: a entrada 1 /);
    expect(() => lerPublico(["5515999999999", "1234"])).toThrow(/contato_invalido: a entrada 2 /);
  });

  it("a recusa diz a posição e NÃO repete a entrada: a mensagem vai para a auditoria", () => {
    expect(() => lerPublico(["joao 123"])).toThrow(/^(?!.*joao)(?!.*123)/);
  });

  it("não repete o mesmo número (mandar duas vezes é ruído, não público)", () => {
    expect(lerPublico(["+55 15 99999-9999", "5515999999999"])).toEqual({
      tipo: "contatos",
      numeros: ["5515999999999"],
    });
  });

  it("lista vazia não é 'todos'", () => {
    expect(() => lerPublico([])).toThrow(/publico_ausente/);
    expect(() => lerPublico(undefined)).toThrow(/publico_ausente/);
  });
});
