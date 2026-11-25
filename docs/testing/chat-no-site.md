# Roteiro de prova pela tela — Chat no site (F2-A)

> Prova dirigida pelo navegador (Playwright), banco fresco do `supabase/baseline.sql`,
> variáveis opcionais ausentes, estado real de uma instalação nova. Cada caso mede o
> que a tela mostra, não o que o código afirma.

Este é o **roteiro de prova pela tela**. **Não há spec automatizada nem execução ainda**:
a prova pela tela fica com o mantenedor, no PR para a main; o roteiro abaixo é o que ela deve cobrir.

## Contexto

O módulo `canal_webchat` nasce desligado e, por enquanto, está em
`MODULOS_AINDA_NAO_LIGAVEIS` (`lib/instalacao/modulos.ts`): nem `/admin/sistema` nem o
bloco por empresa deixam ligá-lo. Nesta prova o módulo é ligado **por fixture**, gravando
`platform_config.MODULO_CANAL_WEBCHAT = 'ligado'` direto no banco (o mesmo molde da
cobrança antes da PR 3a). Depois o admin da empresa entra em Conexões › "Chat no site"
para criar a conexão. Quando o módulo sair da lista, o C2 passa a ligar pela tela.

## Casos

| # | Caso | Expectativa | Observação |
|---|------|-------------|-------------------|
| C1 | Módulo desligado → nenhuma diferença | Sem aba "Chat no site" em Conexões; `/chat/<chave>` e `/api/v1/webchat/*` respondem 404  | 
| C2 | Módulo ligado por fixture; admin da empresa cria a conexão | A aba "Chat no site" aparece em Conexões; cadastrar o domínio do servidor de teste gera a chave `wck_...`  | 
| C3 | Servidor de teste serve a página com o código colado | A bolha aparece no canto da página; abrir a janela carrega `/chat/<chave>`  | 
| C4 | Visitante conversa | Aceitar o aviso de LGPD (controlador + link de política), enviar mensagem; a conversa aparece no Inbox com o selo "Chat no site"; responder pelo Inbox e a resposta aparece na janela  | 
| C5 | Site fora da lista | O iframe não carrega (`frame-ancestors` não inclui a origem); prova pela ausência do conteúdo da janela  | 
| C6 | Girar a chave | Página com o código antigo mostra "Chat indisponível" ao abrir conversa nova  | 
| C7 | Pausar o chat | `/chat/<chave>` passa a dar 404/indisponível; retomar volta a abrir  | 
| C9 | Fora do horário e sem agente. (a) Na conexão de C2, sem agente publicado (ou com o único agente pausado): abrir a página de teste, aceitar, enviar uma mensagem. (b) Publicar um agente com horário de atendimento já fechado e um aviso configurado; abrir a janela e aceitar. | (a) Depois do envio aceito, a janela mostra "Recebemos sua mensagem. Nossa equipe responde por aqui.", uma vez só. (b) Aparece o aviso configurado no agente. Sem aviso, aparece "Estamos fora do horário de atendimento. Voltamos às HH:MM de DD/MM (no horário do seu aparelho)." e a conversa segue aberta | Prova o que o visitante lê na tela, não o código. A hora da volta confere com o horário do agente, no fuso do aparelho de teste |

## O que não está neste roteiro

- Formatos da janela (painel, embutido, página inteira) — F2-B (Tarefa 9)
- Feriado nacional e horário próprio do canal — F3 da issue #1333 usa o horário do agente da conexão e deixa ambos de fora (o caso C9 cobre o horário do agente)
- Teto do visitante anônimo — F4 da issue #1333
