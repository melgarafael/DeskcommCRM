import { describe, expect, it } from "vitest";

import { bloqueioDePublicacao, type EntradaDoBloqueio } from "./bloqueio-de-publicacao";

/** Um agente pronto para publicar: chave da instalação presente, número no ar. */
function pronto(over: Partial<EntradaDoBloqueio> = {}): EntradaDoBloqueio {
  return {
    temRascunhoVigente: true,
    formularioValido: true,
    alteracoesNaoSalvas: false,
    provedor: "anthropic",
    chave: {
      daInstalacao: true,
      instalacaoTemChaveDoProvedor: true,
      estadoDaCredencialDaOrg: null,
    },
    numero: { estado: "WORKING" },
    ...over,
  };
}

describe("bloqueioDePublicacao", () => {
  it("não bloqueia quando tudo está no lugar", () => {
    expect(bloqueioDePublicacao(pronto())).toBeNull();
  });

  // ─── O defeito 1: a chave da instalação ──────────────────────────────────
  //
  // Este é o caso que o editor bloqueava para sempre. Não é um canto: é a
  // escolha padrão de quem instala pelo kit e cola a chave no `.env`, que é o
  // jeito como o produto é vendido.
  it("PUBLICA com a chave da instalação, sem nenhuma linha de credencial da org", () => {
    const motivo = bloqueioDePublicacao(
      pronto({
        chave: {
          daInstalacao: true,
          instalacaoTemChaveDoProvedor: true,
          // Nenhuma credencial cadastrada na organização — o estado de uma
          // instalação fresca, e o que fazia `findCredential` devolver null.
          estadoDaCredencialDaOrg: null,
        },
      }),
    );
    expect(motivo).toBeNull();
  });

  it("recusa a chave da instalação quando o ambiente não tem chave do provedor", () => {
    const motivo = bloqueioDePublicacao(
      pronto({
        provedor: "openai",
        chave: {
          daInstalacao: true,
          instalacaoTemChaveDoProvedor: false,
          estadoDaCredencialDaOrg: null,
        },
      }),
    );
    expect(motivo).toEqual({
      codigo: "instalacao_sem_chave_do_provedor",
      provedor: "openai",
    });
  });

  // ─── O defeito 2: número é requisito de ATENDER, não de rascunhar ────────
  it("bloqueia a publicação — e só ela — quando nenhum número foi escolhido", () => {
    expect(bloqueioDePublicacao(pronto({ numero: { estado: null } }))).toEqual({
      codigo: "sem_numero",
    });
  });

  it("bloqueia número que não está conectado, dizendo o estado", () => {
    expect(bloqueioDePublicacao(pronto({ numero: { estado: "SCAN_QR_CODE" } }))).toEqual({
      codigo: "numero_desconectado",
      estado: "SCAN_QR_CODE",
    });
  });

  it("aceita o estado do canal em minúsculas — é o mesmo estado", () => {
    expect(bloqueioDePublicacao(pronto({ numero: { estado: "working" } }))).toBeNull();
  });

  // ─── Credencial da organização ───────────────────────────────────────────
  it("exige escolha quando não é a chave da instalação e nenhuma linha casou", () => {
    expect(
      bloqueioDePublicacao(
        pronto({
          chave: {
            daInstalacao: false,
            instalacaoTemChaveDoProvedor: true,
            estadoDaCredencialDaOrg: null,
          },
        }),
      ),
    ).toEqual({ codigo: "sem_chave", provedor: "anthropic" });
  });

  it.each(["validating", "unvalidated", "invalid", "inactive"] as const)(
    "recusa credencial da org no estado %s",
    (estado) => {
      expect(
        bloqueioDePublicacao(
          pronto({
            chave: {
              daInstalacao: false,
              instalacaoTemChaveDoProvedor: true,
              estadoDaCredencialDaOrg: estado,
            },
          }),
        ),
      ).toEqual({ codigo: "chave_nao_utilizavel", provedor: "anthropic", estado });
    },
  );

  it("aceita credencial da org validada", () => {
    expect(
      bloqueioDePublicacao(
        pronto({
          chave: {
            daInstalacao: false,
            instalacaoTemChaveDoProvedor: false,
            estadoDaCredencialDaOrg: "validated",
          },
        }),
      ),
    ).toBeNull();
  });

  // ─── Ordem: a dica do botão é UMA frase ─────────────────────────────────
  it("reporta o motivo de fora para dentro — rascunho antes de chave e número", () => {
    const tudoErrado = pronto({
      temRascunhoVigente: false,
      formularioValido: false,
      alteracoesNaoSalvas: true,
      chave: {
        daInstalacao: true,
        instalacaoTemChaveDoProvedor: false,
        estadoDaCredencialDaOrg: null,
      },
      numero: { estado: null },
    });
    expect(bloqueioDePublicacao(tudoErrado)).toEqual({ codigo: "sem_rascunho" });
    expect(bloqueioDePublicacao({ ...tudoErrado, temRascunhoVigente: true })).toEqual({
      codigo: "formulario_invalido",
    });
    expect(
      bloqueioDePublicacao({
        ...tudoErrado,
        temRascunhoVigente: true,
        formularioValido: true,
      }),
    ).toEqual({ codigo: "alteracoes_nao_salvas" });
  });
});
