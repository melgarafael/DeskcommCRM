/**
 * O vocabulário de permissões da área da agência (docs/agencia/SPEC-equipe.md, E6).
 *
 * Lista FECHADA no código: a função da equipe guarda quais itens daqui ela tem, e
 * o membro tem a soma das funções. Permissão escrita à mão em outro lugar vira
 * string sem dono — por isso toda checagem importa o tipo daqui.
 *
 * A ordem é a da tela de funções. Itens de fases futuras já existem para nenhuma
 * fase inventar nome próprio; a tela mostra só os que já têm efeito
 * (`PERMISSOES_EM_USO`).
 */
export const PERMISSOES_DA_AGENCIA = [
  "equipe.gerenciar",
  "configuracoes.gerenciar",
  "avisos.gerais",
  "clientes.gerenciar",
  "tarefas.criar",
  "tarefas.atribuir",
  "tarefas.ver_todas",
  "calendario.gerenciar",
  "trilhas.gerenciar",
  "cofre.ver_senhas",
  "contratos.gerenciar",
  "mapa.editar",
] as const;

export type PermissaoDaAgencia = (typeof PERMISSOES_DA_AGENCIA)[number];

/** O que cada permissão libera, como a tela de funções mostra. */
export const DESCRICAO_DA_PERMISSAO: Record<PermissaoDaAgencia, string> = {
  "equipe.gerenciar": "Cadastrar, editar e desativar membros e funções",
  "configuracoes.gerenciar": "WhatsApp da agência e horário dos avisos",
  "avisos.gerais": "Receber os avisos gerais da agência, além dos próprios",
  "clientes.gerenciar": "Cadastrar e editar clientes, contratações e quem atende cada um",
  "tarefas.criar": "Criar tarefas",
  "tarefas.atribuir": "Mandar tarefas para outras pessoas ou funções",
  "tarefas.ver_todas": "Ver as tarefas de todos, não só as próprias",
  "calendario.gerenciar": "Marcar e remarcar reuniões",
  "trilhas.gerenciar": "Editar o modelo da trilha dos clientes",
  "cofre.ver_senhas": "Ver as senhas dos clientes",
  "contratos.gerenciar": "Gerar e enviar contratos",
  "mapa.editar": "Editar o mapa mental",
};

/** As permissões que já têm efeito nesta versão — as outras ficam escondidas na tela. */
export const PERMISSOES_EM_USO: readonly PermissaoDaAgencia[] = [
  "equipe.gerenciar",
  "configuracoes.gerenciar",
  "avisos.gerais",
  "clientes.gerenciar",
  "tarefas.criar",
  "tarefas.atribuir",
  "tarefas.ver_todas",
  "calendario.gerenciar",
];

export function ehPermissaoDaAgencia(valor: string): valor is PermissaoDaAgencia {
  return (PERMISSOES_DA_AGENCIA as readonly string[]).includes(valor);
}

/**
 * A soma das permissões de um membro: a união das funções ATIVAS. Item que não
 * pertence ao vocabulário (linha antiga, digitação no banco) é ignorado, nunca
 * concedido.
 */
export function somarPermissoes(
  funcoes: ReadonlyArray<{ ativa: boolean; permissoes: readonly string[] }>,
): Set<PermissaoDaAgencia> {
  const soma = new Set<PermissaoDaAgencia>();
  for (const funcao of funcoes) {
    if (!funcao.ativa) continue;
    for (const p of funcao.permissoes) {
      if (ehPermissaoDaAgencia(p)) soma.add(p);
    }
  }
  return soma;
}

/** O dono (platform admin `full`) tem tudo, sem precisar de função. */
export function todasAsPermissoes(): Set<PermissaoDaAgencia> {
  return new Set(PERMISSOES_DA_AGENCIA);
}
