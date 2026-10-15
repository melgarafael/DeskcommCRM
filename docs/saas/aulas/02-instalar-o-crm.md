# Aula 2 · O CRM e o banco no ar

**Entrega:** o CRM e o banco de dados rodando na VPS, atrás do Coolify, com cadeado, e o
primeiro login feito.
**Guia de referência:** [`../coolify.md`](../coolify.md), Passos 5 e 6.

## Preparar antes de gravar

- A Aula 1 concluída na mesma VPS, com o proxy `(healthy)`.
- Um gerenciador de senhas aberto, **fora da área gravada**.

## Cenas

1. **Baixar o sistema** e entrar na pasta.
2. **O bloco do instalador** (Passo 5): o que cada linha diz, sobretudo a porta 8001 (a 8000 é
   do painel do Coolify). O instalador não faz perguntas.
3. **Esperar** (cerca de 3 minutos na primeira vez). Comente as linhas que aparecem.
4. **As credenciais**: pause a gravação antes do bloco "Credenciais iniciais" e mostre só o
   caminho do arquivo onde elas ficam guardadas.
5. **Conferir por fora** (Passo 6): `curl -sSI https://SEU_DOMINIO/app | head -1` dá `307`.
   Explique por que é `/app`: a raiz é uma página pública e dá `200`.
6. **O primeiro login** e o assistente "Boas-vindas ao DeskcommCRM", que dá para pular por
   enquanto.

## O erro que vale mostrar

"Quase lá — falta o cadeado (HTTPS) do seu domínio", se aparecer: é o certificado que ainda
não saiu. Mostre o `curl` até dar `307` e o mesmo comando rodado de novo terminando saudável.
Em versão anterior à que trouxe essa tela, a mensagem é "Quase lá — falta o app responder".

## Tarefa do aluno

O `307` em `/app` e um print da tela de login com a marca padrão.
