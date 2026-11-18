/**
 * O grupo escolhido no aviso de agendamento pertence à conexão que envia?
 *
 * O RPC (`fn_definir_aviso_de_agendamento`) só confere o FORMATO (`…@g.us`):
 * quais grupos um número tem só o canal sabe, e o banco não fala com o canal.
 * Esta conferência mora na rota, antes do RPC, e pergunta ao mesmo serviço que
 * a tela usa para listar os grupos (`listarGruposDoNumero`), com a mesma régua
 * da tela: vale o grupo em que o número está (`presente`), e o grupo já salvo
 * NA MESMA CONEXÃO passa sem nova pergunta — salvar outro campo não pode exigir
 * que o número continue num grupo de que saiu; isso o envio trata, só para o
 * grupo. Trocou a conexão, o mesmo grupo é pergunta nova: ele foi conferido
 * contra o número de antes, não contra o que vai enviar.
 *
 * Canal que não responde vira `sem_resposta`, nunca `ok`: gravar um grupo novo
 * sem conferir é o que esta peça existe para impedir.
 */
import { listarGruposDoNumero, type DepsDeGrupos } from "@/lib/grupos/servico";

export type ConferenciaDoGrupo = "ok" | "fora_da_conexao" | "sem_resposta";

export async function confereGrupoDaConexao(
  deps: DepsDeGrupos,
  e: {
    organizationId: string;
    channelSessionId: string | null;
    grupo: string;
    grupoAtual: string | null;
    /** A conexão que enviava quando `grupoAtual` foi salvo. */
    conexaoAtual: string | null;
  },
): Promise<ConferenciaDoGrupo> {
  if (!e.channelSessionId) return "fora_da_conexao";
  if (e.grupo === e.grupoAtual && e.channelSessionId === e.conexaoAtual) return "ok";
  try {
    const grupos = await listarGruposDoNumero(deps, {
      organizationId: e.organizationId,
      channelSessionId: e.channelSessionId,
    });
    return grupos.some((g) => g.chatId === e.grupo && g.presente) ? "ok" : "fora_da_conexao";
  } catch {
    return "sem_resposta";
  }
}
