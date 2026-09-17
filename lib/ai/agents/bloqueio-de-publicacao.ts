/**
 * O QUE AINDA IMPEDE DE PUBLICAR O AGENTE — a régua do botão "Publicar".
 *
 * ─── Os dois defeitos que tiraram esta regra de dentro do componente ────────
 *
 * **1. Quem usa a chave da instalação nunca conseguia publicar.** A regra morava
 * no `AgentForm` e perguntava por uma LINHA em `ai_provider_credentials`
 * (`findCredential(props.credentials, form.credential_id)`). Só que a escolha
 * mais comum do produto é "a chave desta instalação" — quem instala pelo kit
 * cola a chave no `.env` e nunca abre a tela de Credenciais —, e essa escolha
 * não é uma linha: é o token `__instalacao__`, que o formulário traduz em
 * `credential_id: null`. `findCredential` devolvia `null`, a régua lia isso como
 * "não escolheu chave", e o botão ficava desabilitado para sempre, com a dica
 * mandando escolher a chave que a pessoa ACABOU de escolher. O caminho de
 * publicação do servidor sempre aceitou o caso (`publishAgentVersion` confere
 * `chaveDePlataforma(provider)` e avisa o Postgres com
 * `p_platform_credential_verified`); era só a tela que não deixava chegar lá.
 *
 * **2. Faltar número não é o mesmo que faltar configuração.** Antes, o editor
 * tratava "nenhum número de WhatsApp escolhido" como erro de formulário, então
 * ele bloqueava o SALVAR também — numa instalação fresca, onde não existe número
 * nenhum, o dono não conseguia guardar uma linha do prompt que acabou de
 * escrever. Escolher o número é requisito para ATENDER, não para rascunhar: o
 * bloqueio vive aqui, do lado da publicação, e o `channel_session_id` virou
 * anulável no rascunho (migration 0239).
 *
 * ─── Por que função pura, fora do componente ────────────────────────────────
 *
 * Porque é a regra que decide se o agente entra no ar, e dentro do `useMemo` ela
 * não tinha um único teste. As mensagens continuam na tela (são texto de UI, e
 * passam pelo tradutor); daqui sai o CÓDIGO do motivo, que é o que se pode
 * cobrar num teste sem depender de redação.
 */

/** O estado de uma credencial da organização — espelha `credentialStatus`. */
export type EstadoDaCredencial =
  "validated" | "validating" | "unvalidated" | "invalid" | "inactive";

export interface ChaveDaVersao {
  /** A pessoa escolheu "a chave desta instalação" (a do `.env`)? */
  daInstalacao: boolean;
  /** Esta instalação tem chave DESTE provedor no ambiente? */
  instalacaoTemChaveDoProvedor: boolean;
  /**
   * O estado da credencial da organização escolhida. `null` = nenhuma linha
   * casou com a escolha — o que, fora do caso `daInstalacao`, significa que não
   * há chave escolhida.
   */
  estadoDaCredencialDaOrg: EstadoDaCredencial | null;
}

export interface NumeroDaVersao {
  /**
   * O estado do canal, como vem de `channel_sessions.status`. `null` = nenhum
   * número escolhido ainda — rascunho legítimo, bloqueio só da publicação.
   */
  estado: string | null;
}

export interface EntradaDoBloqueio {
  /** Há rascunho VIGENTE para publicar (ver `versoes-da-tela.ts`). */
  temRascunhoVigente: boolean;
  /** O formulário passa nas próprias réguas de campo. */
  formularioValido: boolean;
  /** Há edição na tela que ainda não foi salva no rascunho. */
  alteracoesNaoSalvas: boolean;
  provedor: string;
  chave: ChaveDaVersao;
  numero: NumeroDaVersao;
}

export type MotivoDeBloqueio =
  | { codigo: "sem_rascunho" }
  | { codigo: "formulario_invalido" }
  | { codigo: "alteracoes_nao_salvas" }
  | { codigo: "instalacao_sem_chave_do_provedor"; provedor: string }
  | { codigo: "sem_chave"; provedor: string }
  | { codigo: "chave_nao_utilizavel"; provedor: string; estado: EstadoDaCredencial }
  | { codigo: "sem_numero" }
  | { codigo: "numero_desconectado"; estado: string };

/**
 * O canal está de pé? O banco grava `WORKING` em maiúsculas (é o enum do provider do canal) e
 * parte do produto normaliza para minúsculas — as duas formas são o mesmo estado,
 * e exigir só uma delas reprovaria um número que está atendendo.
 */
function canalNoAr(estado: string): boolean {
  return estado.toUpperCase() === "WORKING";
}

/**
 * O primeiro motivo que impede a publicação, ou `null` quando nada impede.
 *
 * A ordem é a da tela, de fora para dentro: existe rascunho? ele é válido? está
 * salvo? tem cérebro (chave)? tem boca (número)? Devolver só o primeiro é
 * deliberado — a dica do botão é uma frase, e listar cinco pendências de uma vez
 * é o que faz ninguém ler nenhuma.
 */
export function bloqueioDePublicacao(e: EntradaDoBloqueio): MotivoDeBloqueio | null {
  if (!e.temRascunhoVigente) return { codigo: "sem_rascunho" };
  if (!e.formularioValido) return { codigo: "formulario_invalido" };
  if (e.alteracoesNaoSalvas) return { codigo: "alteracoes_nao_salvas" };

  if (e.chave.daInstalacao) {
    // A escolha é legítima, mas só se a chave EXISTIR no ambiente. Publicar sem
    // ela entrega um agente que morre em toda mensagem — a mesma recusa que a
    // rota de versões faz com `lerAmbiente()`, e que o `publishAgentVersion`
    // repete com `chaveDePlataforma`.
    if (!e.chave.instalacaoTemChaveDoProvedor) {
      return { codigo: "instalacao_sem_chave_do_provedor", provedor: e.provedor };
    }
  } else {
    const estado = e.chave.estadoDaCredencialDaOrg;
    if (estado === null) return { codigo: "sem_chave", provedor: e.provedor };
    if (estado !== "validated") {
      return { codigo: "chave_nao_utilizavel", provedor: e.provedor, estado };
    }
  }

  if (e.numero.estado === null) return { codigo: "sem_numero" };
  if (!canalNoAr(e.numero.estado)) {
    return { codigo: "numero_desconectado", estado: e.numero.estado };
  }

  return null;
}
