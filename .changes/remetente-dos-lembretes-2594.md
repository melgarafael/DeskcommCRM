---
impacto: capacidade_nova
secao: corrigido
titulo: Lembretes da agenda deixam de escolher arbitrariamente entre números da organização
---

Em Configurações › Tipos de agendamento, é possível escolher o canal que enviará os lembretes de cada serviço. Essa escolha tem prioridade, inclusive em reservas manuais. Sem configuração, o sistema usa a conversa vinculada à reserva ou, na ausência dela, somente um canal elegível sem ambiguidade. Um vínculo indisponível não autoriza enviar por outro setor.

Sem remetente seguro ou com janela de atendimento fechada, o lembrete fica pendente e a Central de avisos mostra como corrigir. O aviso é deduplicado e fecha ao corrigir, vencer, cancelar, desligar os lembretes ou anonimizar o contato. Organizações com vários números devem configurar os serviços que recebem reservas sem conversa vinculada. Não há reenvio de lembretes já processados.

Excluir uma conexão remove somente seu vínculo nos tipos de agendamento, preservando os serviços. Eles voltam à seleção automática descrita acima; arquivar ou desconectar preserva a escolha e impede a troca por outro número.

Relacionado à issue #2594; preserva a proteção de janela introduzida no PR #2620.
