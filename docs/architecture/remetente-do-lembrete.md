# Remetente do lembrete de agenda

## Contrato

`calendar_event_types.reminder_channel_session_id` é opcional. Prioridade:

1. Canal configurado no tipo, para todas as suas reservas.
2. Canal da `calendar_appointments.conversation_id`, conferindo organização e contato.
3. Sem vínculo: único canal de mensagem elegível da organização.

Canal explícito/vinculado desconectado, arquivado, pausado ou fora da janela de texto livre não libera troca de número. Dois elegíveis no automático são ambiguidade, sem carimbo nem envio. Erro de leitura também impede envio; não é ausência. Contagem exata protege contra lista truncada pelo PostgREST.

Não se altera horário, conteúdo dos lembretes, degraus, cooldown, guardas do envio nativo ou carimbo antes do envio. Não se deduz remetente de tags, título, responsável ou última conversa. O campo nasce nulo; nenhum dado legado é remapeado.

## Sistema vivo

- **Entrada e leitura:** Configurações › Tipos de agendamento (`page.tsx`, `_client.tsx`) e GET `/api/v1/agenda/tipos`.
- **Escrita:** POST/PATCH da mesma API, papel manager, validação de canal e auditoria nativa `agenda.tipo_criado/alterado`.
- **Isolamento:** chave estrangeira composta organização/canal, também para service_role; RLS dos tipos preservada.
- **Consumidor:** cron `agenda-reminder` → `resolverRemetenteDoLembrete` → handler canônico de mensagens.
- **Falha visível:** `atualizarAvisoDeRemetente` abre um item `other` na Central. Índice parcial impede dois avisos abertos para a mesma reserva.
- **Porta de resolução:** `inbox-destino.ts` projeta link para os tipos de agendamento após conferir organização, existência da reserva e papel manager.
- **Retorno:** corrigir remetente permite a próxima tentativa ainda no prazo; sucesso na escolha resolve o aviso. Limpeza via RPC fecha vencidos, cancelados, apagados ou lembretes desligados. Trigger de anonimização remove referência do aviso; exportação LGPD inclui a referência nova.
- **Não ressuscita:** os carimbos existentes permanecem; a limpeza de aviso não rearma degraus. Sem consumidor após atualização parcial, a falha da RPC sai no log do cron.

## Provas

Testes de decisão pura, caminho completo do cron com transporte capturado, API, seletor pela árvore real React e invariantes PostgreSQL. A prova React não é declarada como prova de navegador ou de instalação completa. Evidências de execução e limites ficam no relatório da contribuição.
