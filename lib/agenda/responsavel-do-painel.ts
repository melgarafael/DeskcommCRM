import type { Pessoa } from "@/components/agenda/tipos";

/**
 * QUEM a agenda mostra no painel — e a única condição em que ele pode dizer "Você".
 *
 * O defeito: com a lista da equipe vazia (papel sem leitura de `/api/v1/team`, o
 * `403` do item 1 da issue 896) o painel caía num fallback fixo
 * `{ id: "", nome: "Você" }`. Aí a tela dizia "com Você" e "Você ainda não
 * publicou seus horários" sobre a jornada de OUTRA pessoa — a dona da agenda,
 * que não estava naquela sessão. Quem lê "Você" nessa tela é quem está logado.
 *
 * A ordem de resolução:
 *
 *   0. o PROFISSIONAL ISOLADO no filtro da agenda (#4186) — quando há um, é ele
 *      a pergunta da tela: "o que a Ana tem hoje?";
 *   1. o DONO DO TIPO (`default_owner_user_id`), que é quem de fato atende — a
 *      tela antes oferecia os horários de um e marcava na agenda de outro;
 *   2. quem está logado, quando ele está na lista;
 *   3. o dono do tipo SEM lista da equipe: nome desconhecido, e nunca "Você" —
 *      "Sem nome" é o mesmo texto que `usePessoasDaAgenda` usa para um
 *      `full_name` nulo, e é honesto: não sei quem é.
 *
 * O rótulo "Você" sai daqui, e só sai quando o id resolvido é o de quem está
 * logado. É a MESMA fonte de `oResponsavelEhQuemEstaLogado`, para a tela não
 * voltar a dizer "Você" sobre a jornada de outra pessoa.
 */
export function resolverResponsavelDoPainel(entrada: {
  pessoas: Pessoa[];
  donoId: string | null;
  usuarioId: string;
  /**
   * O PROFISSIONAL ISOLADO no filtro da agenda (issue #4186) — `null` = "todos".
   *
   * Entra ANTES do dono do tipo porque é a pergunta que a pessoa acabou de
   * fazer: ela clicou na Ana, a grade passou a mostrar só a Ana, e o painel que
   * abre do bloco livre tem de ser o da Ana. Sem isto o filtro era cosmético —
   * a tela dizia "só a Ana" e o painel dizia "com o Bruno" (dono do tipo), e o
   * compromisso nascia na agenda do Bruno, fora da visão filtrada. Medido:
   * `app/app/agenda/_client.test.tsx`, "isolando a Ana...".
   *
   * Só vale se a pessoa estiver na lista da equipe: id que não está em
   * `pessoas` não tem nome nem trilha, e inventar um aqui devolveria o "Sem
   * nome" que este módulo existe para não mostrar.
   */
  isoladaId?: string | null;
}): Pessoa {
  const { pessoas, donoId, usuarioId, isoladaId } = entrada;

  const pessoa =
    (isoladaId ? pessoas.find((p) => p.id === isoladaId) : undefined) ??
    pessoas.find((p) => p.id === donoId) ??
    pessoas.find((p) => p.id === usuarioId) ??
    // Nunca "Você": sem lista da equipe, o nome de outra pessoa é desconhecido.
    { id: donoId ?? "", nome: "Sem nome", trilha: 1 };

  return { ...pessoa, nome: pessoa.id === usuarioId ? "Você" : pessoa.nome };
}

/**
 * A agenda resolvida é a de quem está logado?
 *
 * Deriva do MESMO id que `resolverResponsavelDoPainel` devolve, para o texto e o
 * rótulo não divergirem.
 */
export function oResponsavelEhQuemEstaLogado(entrada: {
  pessoas: Pessoa[];
  donoId: string | null;
  usuarioId: string;
}): boolean {
  return resolverResponsavelDoPainel(entrada).id === entrada.usuarioId;
}
