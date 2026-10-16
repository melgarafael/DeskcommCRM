/**
 * ═══ A GUARDA DE GERAÇÃO NOS DOIS MEMOS QUE O #2795 DEIXOU SEM ELA ═══
 *
 * O PR #2795 (mesclado) consertou o caso da marca: `marcaDaInstalacao()` tinha
 * lost-update — uma leitura em voo quando a escrita invalidava voltava com a
 * linha PRÉ-ESCRITA e a reinstalava por um TTL inteiro, desfazendo a
 * invalidação. A cura foi a GUARDA DE GERAÇÃO: a leitura captura um contador
 * antes da ida ao banco e só memoiza se o contador não tiver mudado depois.
 *
 * Aquele PR declarou o resto por escrito: os memos do Google Agenda
 * (`lib/agenda/google/config.ts`) e do app da Meta (`lib/channels/meta/app.ts`)
 * são cópias do molde, ficaram com o `abortSignal` (a outra perna do conserto) e
 * SEM a guarda de geração. Zerar o memo neles não basta: a leitura em voo
 * reinstala o valor velho por até 30 s do mesmo jeito.
 *
 * O sintoma para gente real, nos dois caminhos: o dono da VPS grava a
 * credencial pela tela, recebe o toast verde, e a Agenda continua sem conectar
 * / a entrega da Meta continua morrendo em 401 por até TTL_MS inteiros.
 *
 * ─── Como a corrida é reproduzida ───────────────────────────────────────────
 *
 * Pelo PORTÃO do dublê (mesma receita de `branding-memo-da-instalacao.test.ts`),
 * não por `sleep`: a leitura começa, a consulta SAI ao banco e fica presa; a
 * escrita grava e invalida no meio; a leitura presa volta com o valor de ANTES.
 * Sem a guarda, ela reinstala esse valor no memo com TTL novo — e a leitura
 * seguinte devolve o velho sem ir ao banco. Com a guarda, a leitura em voo
 * ainda devolve o velho a QUEM A CHAMOU (não há como desfazer a resposta que já
 * saiu), mas não o memoiza: a leitura seguinte vai ao banco e vê a escrita.
 *
 * Cada caminho tem ainda dois CONTROLES, porque sem eles os casos passariam
 * verdes com o memo simplesmente DESLIGADO ou com um dublê que não segura
 * leitura nenhuma:
 *
 *   1. o dublê segura de verdade (a consulta sai antes do portão);
 *   2. sem escrita no meio, a segunda leitura continua vindo do memo — o TTL de
 *      30 s e o contrato de "uma ida ao banco por TTL" seguem intactos.
 *
 * E o caso do `signal`: os dois selects continuam levando
 * `.abortSignal(new AbortController().signal)` — a outra perna do #2795, que
 * impede a 2ª chamada do MESMO render de receber a resposta deduplicada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configuracaoDoGoogle,
  invalidarCredencialDoGoogle,
} from "@/lib/agenda/google/config";
import { appDaMeta, invalidarAppDaMeta } from "@/lib/channels/meta/app";

/** O banco falso. O portão segura UMA leitura em voo; o sinal é conferido. */
const banco = vi.hoisted(() => ({
  linha: null as Record<string, unknown> | null,
  leituras: 0,
  sinalVisto: undefined as AbortSignal | undefined,
  portao: null as { liberar: () => void; esperar: Promise<void> } | null,
}));

/**
 * O `maybeSingle` do dublê. `sinal` = o que `.abortSignal()` pôs na consulta —
 * se a linha sair, o mock não tem mais `maybeSingle` no `eq` e o caso fica
 * vermelho na hora, que é o desfecho honesto.
 */
async function selectComPortao(sinal: AbortSignal | undefined) {
  banco.sinalVisto = sinal;
  banco.leituras += 1;
  // A linha é capturada AGORA, antes de esperar o portão — é o que um banco
  // real faz: a consulta sai antes da escrita, e a resposta que volta é a de
  // antes dela. Ler `banco.linha` depois do `await` faria a leitura "em voo"
  // enxergar o valor NOVO e o caso não reproduziria corrida nenhuma.
  const capturada = banco.linha;
  if (banco.portao) await banco.portao.esperar;
  return { data: capturada, error: null };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          abortSignal: (sinal: AbortSignal) => ({
            maybeSingle: () => selectComPortao(sinal),
          }),
        }),
      }),
    }),
  }),
}));

/** "Decifra" marcando o texto cifrado — o bastante para distinguir as versões. */
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async (_admin: unknown, cifrado: string) => `claro:${cifrado}`,
}));

interface Caminho {
  nome: string;
  /** A linha no banco ANTES da escrita. */
  antes: Record<string, unknown>;
  /** A linha no banco DEPOIS da escrita — o que tem de aparecer. */
  depois: Record<string, unknown>;
  /** O que quem chama lê, reduzido ao campo que a escrita muda. */
  ler: () => Promise<string | null>;
  invalidar: () => void;
  /** O que a leitura em voo, presa no portão, devolve. */
  velho: string;
  /** O que a leitura seguinte, já com a guarda, devolve. */
  novo: string;
}

const CAMINHOS: Caminho[] = [
  {
    nome: "credencial do Google Agenda (lib/agenda/google/config.ts)",
    antes: { client_id: "id-velho", client_secret_encrypted: "cif-velho" },
    depois: { client_id: "id-novo", client_secret_encrypted: "cif-novo" },
    ler: async () => (await configuracaoDoGoogle("https://crm.exemplo.com"))?.clientId ?? null,
    invalidar: invalidarCredencialDoGoogle,
    velho: "id-velho",
    novo: "id-novo",
  },
  {
    nome: "app da Meta (lib/channels/meta/app.ts)",
    antes: { app_secret_encrypted: "cif-segredo-velho", verify_token_encrypted: "cif-token-velho" },
    depois: { app_secret_encrypted: "cif-segredo-novo", verify_token_encrypted: "cif-token-novo" },
    ler: async () => (await appDaMeta()).appSecret,
    invalidar: invalidarAppDaMeta,
    velho: "claro:cif-segredo-velho",
    novo: "claro:cif-segredo-novo",
  },
];

beforeEach(() => {
  banco.linha = null;
  banco.leituras = 0;
  banco.sinalVisto = undefined;
  banco.portao = null;
  // Isolamento pela porta do PRODUTO (o memo mora no `globalThis`, que o
  // `resetModules` não limpa), não apagando a chave do `globalThis` na mão.
  invalidarCredencialDoGoogle();
  invalidarAppDaMeta();
});

afterEach(() => {
  banco.portao = null;
});

describe.each(CAMINHOS)("guarda de geração — $nome", (caminho) => {
  it("CONTROLE: o dublê segura a leitura em voo — a consulta sai ANTES do portão", async () => {
    // Sem este caso, o caso da corrida passaria verde com um dublê que nunca
    // segura leitura nenhuma, e nenhuma corrida teria sido reproduzida.
    banco.linha = caminho.antes;
    let liberar!: () => void;
    banco.portao = { liberar: () => {}, esperar: new Promise<void>((r) => (liberar = r)) };
    const emVoo = caminho.ler();
    expect(
      banco.leituras,
      "a consulta tem de ter SAÍDO ao banco antes de travar no portão",
    ).toBe(1);
    liberar();
    await emVoo;
  });

  it("a consulta continua levando `signal` — a linha do abortSignal não saiu", async () => {
    // A outra perna do #2795: sem o `signal`, a 2ª chamada do MESMO render
    // recebe da deduplicação do Next a resposta de ANTES da escrita. Este caso
    // é o casal do teste que mede aquilo; aqui ele só garante que a linha segue.
    banco.linha = caminho.antes;
    expect(await caminho.ler()).toBe(caminho.velho);
    expect(banco.sinalVisto, "o select precisa levar um AbortSignal").toBeInstanceOf(
      AbortSignal,
    );
  });

  it("a leitura em voo NÃO reinstala o valor velho no memo", async () => {
    banco.linha = caminho.antes;

    // 1. Um render começa com o memo vazio: a 1ª leitura vai ao banco e trava
    //    no portão, ainda com a linha de ANTES da escrita.
    let liberar!: () => void;
    banco.portao = { liberar: () => {}, esperar: new Promise<void>((r) => (liberar = r)) };
    const emVoo = caminho.ler();
    expect(banco.leituras, "controle: a leitura em voo saiu ao banco").toBe(1);

    // 2. No meio dela, a escrita grava e invalida — a ordem de toda rota e
    //    server action que grava estas credenciais.
    banco.linha = caminho.depois;
    caminho.invalidar();

    // 3. A leitura presa volta AGORA, com o valor de antes da escrita. Ela
    //    devolve esse valor a quem a chamou — a resposta já tinha saído —, e
    //    é isso que a corrida reproduz.
    liberar();
    expect(
      await emVoo,
      "controle: a leitura em voo tem mesmo de voltar com o valor velho",
    ).toBe(caminho.velho);

    // 4. A leitura seguinte TEM de ir ao banco. Se a leitura em voo tiver
    //    reinstalado o memo, ela devolve o valor velho sem ler nada — que é o
    //    defeito: a tela negando a escrita por até 30 s, atrás do toast verde.
    banco.portao = null;
    const leiturasAntes = banco.leituras;
    const depois = await caminho.ler();
    expect(
      banco.leituras,
      "a leitura seguinte tem de ir ao banco — o memo não pode ter sido reinstalado",
    ).toBeGreaterThan(leiturasAntes);
    expect(depois, "a leitura seguinte tem de enxergar a escrita").toBe(caminho.novo);
  });

  it("CONTROLE: sem escrita no meio, a 2ª leitura continua vindo do memo", async () => {
    // Controle NEGATIVO do caso acima: se a guarda tivesse desligado o memo em
    // geral, a leitura iria ao banco a cada chamada e ninguém notaria a perda —
    // o TTL de 30 s e o contrato de "uma ida ao banco por TTL" são o que está
    // sendo protegido aqui.
    banco.linha = caminho.antes;
    const primeira = await caminho.ler();
    const leiturasDepoisDaPrimeira = banco.leituras;
    expect(leiturasDepoisDaPrimeira, "a primeira leitura tem de ter ido ao banco").toBe(1);
    const segunda = await caminho.ler();
    expect(banco.leituras, "a segunda leitura tem de vir do memo").toBe(
      leiturasDepoisDaPrimeira,
    );
    expect(segunda).toBe(primeira);
  });
});
