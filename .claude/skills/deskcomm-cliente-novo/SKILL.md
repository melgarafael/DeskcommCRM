---
name: deskcomm-cliente-novo
description: Guia para montar um cliente novo no DeskcommCRM por nicho — clínica, imobiliária, serviços/agência, curso/infoproduto, loja — criando os agentes de IA, roteadores, follow-ups, base de conhecimento, memória e funil, na ordem certa e pela tela. Use SEMPRE que alguém quiser "configurar o CRM para um cliente", "criar o agente da clínica", "montar o atendimento", "que prompt eu uso", "como faço o roteador/follow-up", "subir a base de conhecimento", ou terminou o onboarding e pergunta "e agora?" — inclusive agências implantando para terceiros. Faz a triagem, monta o pacote do nicho como texto pronto para colar e conduz tela a tela até o teste.
metadata:
  publico: leigo, agência, implantador
  ponto-de-partida: depois do onboarding (o wizard para no funil e nos convites)
---

# Montar um cliente novo, por nicho

O onboarding do produto vai até o funil e os convites. O que faz um agente **vender de verdade**
para um nicho — o prompt que conhece o negócio, o roteador quando há mais de um agente, os
follow-ups que puxam quem sumiu, a base de conhecimento, a memória da organização, as capacidades
certas — fica para depois, e não há tela que conduza isso. Este guia é o passo 8 que o wizard não
tem. Um usuário pediu exatamente isto na discussão #673 do repositório.

## Como você age

- **Triagem antes de qualquer configuração.** Você não sabe o negócio da pessoa; ela sabe. Uma
  pergunta por vez, do que o sistema exige (`references/triagem.md`).
- **Monta o pacote como texto, depois aplica pela tela.** O produto tem portões que só a tela
  atravessa (auditoria, publicação com validação, indexação da base). Não crie nada por SQL — o
  motor lê a **versão publicada** do agente, não a tabela; editar direto não muda nada e pula a
  auditoria. O caminho por arquivo, para técnicos, está em `references/por-arquivo.md`.
- **Não inventa regra de negócio.** Preço, prazo, política de cancelamento, horário: vêm da
  pessoa ou dos documentos dela. O que não está escrito vira pergunta, não suposição.
- **Não repete no prompt o que o motor já impõe.** Apresentar-se como assistente, não inventar
  preço, respeitar STOP, horário de envio, promessa sem caso aberto — tudo isso é portão mecânico
  (`references/prompt-do-agente.md`). Prompt que repete gasta contexto e vaza vocabulário.
- **Publicar é ato humano.** Você deixa tudo em rascunho, testa com o botão Testar (que roda o
  motor real em modo sandbox) e mostra o que o agente responderia; o clique em "Publicar" é da
  pessoa, ou vem depois de um "pode publicar" explícito.

## Passo 0 — onde a pessoa está

Pergunte, uma por vez: a instalação já está no ar e o onboarding terminou (nome do negócio,
WhatsApp conectado, atendente básico, funil)? É para o próprio negócio ou para um cliente? Qual o
nicho — clínica/consultório, imobiliária, serviços/agência/obra, curso/mentoria/infoproduto, loja?

Sem instalação: guia `deskcomm-instalar`. Sem WhatsApp conectado: nada publica — o agente exige um
número com status WORKING. Nicho fora dos cinco: use o pacote genérico e adapte com a triagem.

## Passo 1 — a triagem

`references/triagem.md` lista tudo que o sistema exige e por quê, agrupado: o negócio (nome, o
que faz, fuso), o canal (qual número, horário de atendimento), a IA (provedor, chave da OpenAI
para áudio e base de conhecimento), o funil (etapas com uma "ganhou" e uma "perdeu", vocabulário),
os agentes (um ou vários? tom, o que pode prometer, quando passa para humano), o roteador (só
com dois ou mais agentes no mesmo número), os follow-ups (silêncio, no-show, abandono), o
conhecimento (FAQ, documentos, catálogo), a memória (regras da casa), as promessas (piso de preço,
desconto, parcelas), as automações e o time.

Registre as respostas num arquivo `pacote-<cliente>.md` na pasta que a pessoa indicar — é o
documento de implantação, e é o que você vai colar nas telas.

## Passo 2 — monte o pacote do nicho

Parta do pacote pronto do nicho em `references/nichos.md` (funil, vocabulário, esqueleto de prompt,
intenções do roteador, follow-ups, perguntas de FAQ, itens de memória, capacidades) e preencha
com a triagem. O prompt segue a anatomia de `references/prompt-do-agente.md`: identidade, o que o
negócio faz, diagnóstico antes da oferta, qualificação, situações e o que dizer em cada uma,
limites, estilo, quando chamar uma pessoa. Nada de nomear ferramenta, nada de "encaminhe ao
gerente Fulano" para tudo que não souber — isso faz o modelo parar de usar a agenda.

## Passo 3 — aplique pela tela, nesta ordem (o schema impõe)

A ordem importa porque cada peça exige a anterior. Tela a tela, com os campos e o que cada um
faz: `references/pela-tela.md`.

1. **Conexões** — o número precisa estar WORKING (o onboarding já fez).
2. **IA › Credenciais** — a chave do provedor (validada em segundo plano; só credencial validada
   publica) e, se a IA não for OpenAI, a chave da OpenAI para áudio e base de conhecimento.
3. **IA › Provedores** — o modelo dos auxiliares (classificador do roteador, follow-up) num modelo
   barato; o do atendimento num modelo que usa ferramentas.
4. **Funil** — etapas do pacote, exatamente uma "ganhou" e uma "perdeu", o mapa dos 7 passos do
   agente (novo, contatado, qualificando, qualificado, negociando, ganhou, perdeu), vocabulário.
5. **IA › Conhecimento** — FAQ (pares pergunta/resposta) e documentos (PDF/MD/TXT até 20 MB);
   a indexação é assíncrona e precisa da chave da OpenAI — confira o status "pronto".
6. **IA › Follow-ups** — crie, monte o fluxo (gatilho → espera → mensagem → condição → fim),
   publique. Fluxo não publicado não roda.
7. **IA › Agentes** — um agente por papel: prompt, provedor/modelo/credencial, canal, funis que
   ele pode mover, fontes de conhecimento, follow-ups que arma, capacidades (pacotes; as críticas
   uma a uma), palavras de passagem para humano, casos. Salve como rascunho.
8. **Testar** — o botão roda o motor real em modo sandbox com uma mensagem: veja o texto, as ações
   que ele tentaria e os portões que barraram. Roteiro de 5 mensagens do nicho em
   `references/nichos.md`.
9. **Publicar** — a pessoa clica. Só depois: **IA › Roteadores** (dois ou mais agentes no mesmo
   número: intenções com descrição e exemplos, fallback), **IA › Memória** (regras da casa),
   **IA › Skills** (instalar `agendamento` e `objecao-preco` se for personalizar), automações,
   convites do time.

## Passo 4 — entregue

Checklist final, medido na tela: agente publicado com o número certo; roteador ativo com todos
os membros publicados; follow-ups ativos; base com status "pronto"; memória publicada; um teste
de cada situação do roteiro respondido como esperado; a pessoa sabe onde muda cada coisa. Se algo
ficou de fora (sem chave da OpenAI, sem documentos), escreva no `pacote-<cliente>.md` o que falta e
o que acontece enquanto falta — não deixe a lacuna invisível.

## O que você nunca faz

- Não escreve nem altera tabela do banco para configurar (não muda nada e pula a auditoria).
- Não publica versão de agente sem a pessoa ver o teste e mandar publicar.
- Não põe preço, prazo ou política no prompt se existe catálogo ou base de conhecimento para isso
  — duas fontes de verdade divergem.
- Não cola vocabulário interno no prompt (nome de ferramenta, "lead_id", "etapa qualified"): o
  motor veta resposta com jargão, e o prompt vira a origem do veto.
- Não instala uma skill do produto ou liga uma capacidade "crítica" (enviar mensagem avulsa,
  cancelar agenda, fechar caso) sem dizer o que ela permite ao agente fazer sozinho.
