# Configuração da agenda por serviço

A lista usa os serviços cadastrados, sem um segundo cadastro de títulos. `Configurar [nome]` abre Serviço, Horários, Google e Bloqueios. O formulário de nome/duração permanece uma operação própria. Contas Google e regras gerais ficam depois da lista, em seções recolhidas.

As abas mantêm os controles montados. Navegar não salva, não ativa serviços nem solicita sincronização. Horários resumem dia/data, hora, duração e capacidade; a edição conserva programação semanal e exceção em data. Opções adicionais mantêm profissionais, recursos e fuso. Erros de validação revelam a aba e os controles recolhidos correspondentes.

O calendário de destino é identificado primeiro pelo nome, depois pela conta. Fontes selecionadas permanecem visíveis; outras fontes elegíveis ficam recolhidas. A capacidade continua por serviço: compartilhar calendário não cria limite global. Consulta de horários, reserva, confirmação humana, comunicação e publicação continuam fatos separados.

## Título geral opcional

O gestor pode definir até 80 caracteres em **Título da área da agenda**, nas regras gerais. Vazio usa `Agendamentos` no idioma da interface. Nomes de serviços e título próprio são texto livre, nunca HTML ou chaves de tradução. Nenhum título é enviado aos contextos de agentes ou revisores.

`PATCH /api/v1/settings/agenda-apresentacao` aceita estritamente `{ "title": "Consultas" }`. Exige sessão e papel `manager` pela autorização existente, respeita bloqueio de escrita em suporte e usa a organização ativa da sessão. O corpo não aceita organização nem outras configurações. Grava somente `organizations.settings.agenda_presentation.title`, preservando as demais chaves, inclusive outras chaves do objeto de apresentação. Vazio grava `null`; não há migration.

A comparação do settings original na atualização impede perda por escrita concorrente; ausência de correspondência retorna 409 e pede recarregar. Leitura falha, organização ausente ou formato de settings incompatível impedem a gravação. A auditoria registra apenas presença de título próprio. A rota estrita de prazos permanece independente.

## Compatibilidade

Esta interface depende das agendas por serviço. Não altera o motor, schema, payloads de reserva, revisões esperadas, idempotência, elegibilidade de calendários ou contextos. Serviços em rascunho continuam inativos. Tipos individuais continuam no fluxo anterior. Usuários que só leem não ganham operações de gestor.
