# Aula 1 · Do servidor vazio ao Coolify

**Entrega:** uma VPS com o Coolify instalado, o painel fechado para a internet e a portaria
(o proxy) no ar.
**Guia de referência:** [`../coolify.md`](../coolify.md), Antes de começar e Passos 0 a 4.

## Preparar antes de gravar

- VPS nova, 8 GB de memória, com IP, porta de SSH e senha do root à mão.
- Um subdomínio de teste já apontado para o IP (o DNS leva tempo; não grave esperando).

## Cenas

1. **As peças em uma frase cada:** VPS (o terreno), Coolify (o condomínio, com portaria),
   CRM (a casa), domínio (o endereço). Por que 8 GB: o CRM, o banco e o Coolify moram juntos.
2. **Entrar na VPS** (Passo 0). Mostre a senha que não aparece ao digitar e o "yes" da
   primeira conexão.
3. **Apontar o domínio** (Passo 1) e conferir com `nslookup`.
4. **Instalar o Coolify** (Passo 2), **sem número de versão no fim do comando**. Explique o
   `AUTOUPDATE=false`.
5. **Túnel e conta** (Passo 3): por que o painel não pode ficar aberto, o túnel, a regra de senha.
6. **Fechar o painel para fora** (Passo 3, item 4): o bloco, os números `3` e `3`, e a prova
   de fora (o endereço com `:8000` não abre mais).
7. **A porta 22022** (Passo 4): a caixa "Server is not reachable", a troca da porta, o Check
   Again e o **Skip setup**.
8. **Esperar o proxy**: o comando `docker ps --filter name=coolify-proxy …` até aparecer
   `(healthy)`.

## O erro que vale mostrar

A caixa "Server is not reachable" com a porta 22. Todo aluno com HostGator vai vê-la, e quem
já a viu acontecer na aula não trava.

## Tarefa do aluno

Chegar ao `coolify-proxy … (healthy)` e mandar um print **sem IP** do painel depois do
Skip setup.
