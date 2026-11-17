/**
 * A agenda do celular e o titular apagado a pedido (LGPD) — #3432, a SEGUNDA
 * porta do defeito.
 *
 * A primeira porta (`smb_app_state_sync` → `ingestMetaAppContactSync`) foi
 * fechada perguntando `fn_titular_apagado_a_pedido` ANTES de qualquer escrita,
 * com falha fechada (`lib/channels/meta/ingest.ts`). A sincronização da agenda
 * do celular ("Sincronizar agenda do celular", #2736) chama a MESMA
 * `fn_upsert_wa_contact` sem fazer essa pergunta: a anonimização zera o telefone
 * (`phone_number = null`) e apaga `contact_phones`, então a pré-leitura não
 * acha a ficha e o upsert CRIA uma nova — com o número e o nome da agenda.
 *
 * O que este arquivo mede: a porta da agenda faz a MESMA pergunta, em LOTE (o
 * helper `perguntarTitularesApagadosNoLote`, migration 9321), e o desfecho é o
 * mesmo da porta fechada — não cria nada; na dúvida (erro ou resposta fora do
 * contrato) também não cria.
 */
import { describe, expect, it } from "vitest";

import type { ContatoDoAparelho } from "@/lib/channels";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";

import { sincronizarAgendaDoCelular, type AgendaDeps } from "./agenda-do-celular";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
/** O número como a agenda do aparelho costuma entregar: sem o nono dígito. */
const TELEFONE_DA_AGENDA = "+553188887777";
/** O mesmo número na forma canônica do CRM — é a que a pergunta do lote devolve. */
const TELEFONE_CANONICO = canonicalPhoneBR(TELEFONE_DA_AGENDA);

function contatoDaAgenda(): ContatoDoAparelho {
  return {
    id: `${TELEFONE_DA_AGENDA.slice(1)}@c.us`,
    name: "Ana Souza",
    pushname: null,
    isMyContact: true,
    isWAContact: true,
    isMe: false,
  };
}

function depsDaAgenda(opcoes: { apagados?: string[]; erroDaPergunta?: string } = {}) {
  const upserts: Array<{ telefone: string }> = [];
  const audits: Array<{ metadata?: Record<string, unknown> }> = [];
  const deps = {
    // A agenda entrega UMA pessoa — a que pediu anonimização.
    listarPagina: async () => [contatoDaAgenda()],
    // A ficha anonimizada não tem mais telefone: a pré-leitura não acha nada.
    telefonesExistentes: async () => new Set<string>(),
    upsertContato: async ({ telefone }: { telefone: string }) => {
      upserts.push({ telefone });
      return `contato-${upserts.length}`;
    },
    // A pergunta LGPD em lote — a MESMA das duas portas.
    titularesApagados: async () =>
      opcoes.erroDaPergunta
        ? { apagados: new Set<string>(), erro: opcoes.erroDaPergunta }
        : { apagados: new Set((opcoes.apagados ?? []).map(canonicalPhoneBR)) },
    emitirContatoCriado: async () => undefined,
    marcarOrigem: async () => undefined,
    gravarNomeDaAgenda: async () => undefined,
    audit: async (entry: unknown) => {
      audits.push(entry as { metadata?: Record<string, unknown> });
    },
  } as AgendaDeps;
  return { deps, upserts, audits };
}

async function sincronizar(deps: AgendaDeps) {
  return sincronizarAgendaDoCelular(deps, {
    organizationId: ORG,
    session: "s1",
    actorUserId: USER,
    requestId: "req-lgpd",
  });
}

describe("agenda do celular e o titular apagado a pedido", () => {
  it("titular apagado: não cria ficha e conta como ignorado", async () => {
    const { deps, upserts, audits } = depsDaAgenda({ apagados: [TELEFONE_CANONICO] });

    const resumo = await sincronizar(deps);

    expect(upserts).toEqual([]);
    expect(resumo.importados).toBe(0);
    expect(resumo.ignorados).toBe(1);
    expect(resumo.erros).toBe(0);
    // O resumo auditado é o que a tela mostra: nada foi criado.
    expect(audits.at(-1)?.metadata).toMatchObject({ importados: 0, ignorados: 1 });
  });

  it("a marca casa com as duas grafias do número", async () => {
    // O lote devolve sempre a forma canônica; a agenda pode entregar a outra.
    const { deps, upserts } = depsDaAgenda({ apagados: [TELEFONE_CANONICO] });

    await sincronizar(deps);

    expect(upserts).toEqual([]);
  });

  it("a pergunta falha: falha fechada — nada é criado", async () => {
    const { deps, upserts } = depsDaAgenda({ erroDaPergunta: "rpc indisponível" });

    await expect(sincronizar(deps)).rejects.toThrow(/titular_apagado/);
    expect(upserts).toEqual([]);
  });

  it("controle: titular não apagado segue o fluxo e cria a ficha", async () => {
    const { deps, upserts } = depsDaAgenda({ apagados: [] });

    const resumo = await sincronizar(deps);

    expect(upserts).toEqual([{ telefone: TELEFONE_DA_AGENDA }]);
    expect(resumo.importados).toBe(1);
    expect(resumo.ignorados).toBe(0);
  });
});
