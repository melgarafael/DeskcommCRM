# Mensagens rápidas

O botão **Mensagens** no canto inferior direito acompanha a navegação autenticada.
Abra a lista, busque um contato e selecione uma conversa para ler e responder sem
sair da tela. O ícone de ampliar abre a mesma conversa no Inbox completo; o lápis
leva aos Contatos para iniciar um atendimento pelo fluxo existente.

Minimizar mantém a conversa, anexos e texto em edição. Voltar à lista mantém um
rascunho de texto por conversa durante esta navegação. Recarregar a página ou trocar
de organização limpa esses rascunhos locais. Não há persistência adicional de
conteúdo no navegador. O contador mostra conversas não lidas em todo o escopo de
acesso, inclusive fora da primeira página de resultados.

## Limites e recuperação

- As APIs, RLS, envio, anexos, notas e histórico são os mesmos do Inbox.
- Suporte somente leitura, contato bloqueado/anonimizado e conversa encerrada
  continuam impedindo envio. Janela fechada orienta a abrir o Inbox completo.
- Conversa minimizada não é marcada como lida. As duas conversas visíveis (Inbox
  e painel) são reconhecidas pelo controle de notificações.
- Falhas de leitura mostram **Tentar novamente**; falhas de envio usam o tratamento
  e a restauração de texto do Composer existente.
- Uma chamada ativa desloca o botão para cima para preservar os controles da chamada.

## Living System Checklist

1. Entrada: `useConversationsRealtime`, `useConversationCounts` e `useConversation`.
2. Saída: `ChatThread`, `Composer` e link `/app/inbox/[id]`.
3. Registro: envio/nota passam por `useSendMessage`/`useCreateNote` e APIs existentes.
4. Visibilidade: histórico compartilhado no painel e no Inbox.
5. Porta: `AppShell` monta `FloatingInbox` em todas as telas autenticadas.
6. Anti-morte: contador global, atualização realtime e retry explícito; nenhuma
   nova campanha ou resposta automática é criada por abrir o painel.
7. Configuração: permissões e canais existentes; sem nova credencial ou env.
8. Continuidade: o mesmo atendimento IA/humano e histórico; controles completos de
   responsabilidade e retorno à IA permanecem disponíveis pelo botão de ampliar.
9. Retorno: erros de envio chegam ao Composer; operador corrige/reenvia ou amplia
   para resolver bloqueios. Abrir/minimizar não toma decisões automáticas.
10. Mapa: `docs/architecture/mensagens-rapidas.architecture.json`.
