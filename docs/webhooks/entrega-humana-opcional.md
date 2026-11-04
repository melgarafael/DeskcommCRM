# Entrega humana opcional com recibos

Destino: núcleo, cadeia compartilhada de roteamento e entrega. A configuração é optativa por empresa. Nenhuma organização é ativada pela migration.

Entrada: passagem persistida do atendimento atual. O trigger captura episódio/revisão/configuração e emite ai.handoff_delivery. O dreno existente consome o evento; não há cron novo. A seleção reusa fn_channel_routing_claim, que revalida canal, fila, capacidade e membership; atualização do negócio e episódio participa da mesma transação. Dono anterior é preservado e uma divergência vira conflito.

A saída fica no Inbox/negócio, nos recibos e na seção Distribuição de atendimento. O usuário configura participantes/destinos e decide se haverá aviso externo. O aviso nativo anterior só é substituído na empresa que ativa esta entrega. Sem ativação, ele continua registrado e operante. Avisos não disparam quando notifications_enabled=false.

Falha antes da rede pode ser reavaliada pelo dreno; tentativa requested vencida vira ambiguous e não é repetida cegamente. blocked/ambiguous aparecem na consulta da tela com o próximo passo de conferência. Alteração de configuração/revisão/dono invalida o aviso antigo. Reabertura e continuação humanas conservam os mecanismos nativos do atendimento. Não é aprendizado autônomo nem autorização de envio em produção.

Não contém dados/configurações de clientes. A nova opção não altera jornadas, setores ou permissões dos demais caminhos nativos. Rollback operacional: desativar a entrega pela tela; manter tabelas/recibos para auditoria. Não apagar dados para reverter. A integração com outras propostas de resolução de dono (#3969) deve preservar a regra mais específica de carteira e fila.

Validação desta contribuição: unidades focalizadas de configuração, esquema e entrega; o conjunto de testes de banco acompanha o PR para fresh/update/RLS/concorrência. A ausência de Docker local não equivale a verde desse gate.
