# A triagem — o que perguntar, em que ordem, e por que o sistema precisa disso

Uma pergunta por vez. Cada bloco existe porque uma tela ou uma regra do produto exige a resposta;
o "por quê" está ao lado para você explicar quando a pessoa hesitar. Registre tudo em
`pacote-<cliente>.md`.

## 1. O negócio

| pergunta | por quê |
|---|---|
| Como o negócio se chama e o que ele faz, em uma frase? | vira a primeira linha do prompt ("Você atende os clientes de X, que é: …") e escolhe o pacote do nicho |
| Razão social e cidade/fuso horário | a razão social nomeia o controlador nos documentos de LGPD; o fuso decide "que horas são" para o agente e a janela de envio |
| Quem é o cliente típico e o que ele costuma pedir primeiro? | é o diagnóstico que o agente faz antes de oferecer |

## 2. O canal

| pergunta | por quê |
|---|---|
| Qual número de WhatsApp vai atender (já conectado?) | o agente exige um número com status WORKING para publicar |
| Horário em que o agente responde (dias, início, fim) | fora da janela o turno é **adiado**, não perdido — mas a pessoa precisa saber que o cliente das 23h só recebe resposta de manhã |
| Quantas mensagens por dia esse número aguenta? (número novo = aquecimento) | limite diário e aquecimento evitam bloqueio do WhatsApp |

## 3. A IA

| pergunta | por quê |
|---|---|
| Qual provedor (OpenRouter, Anthropic, OpenAI, Google) e a chave | credencial precisa ser **validada** para publicar; Google só funciona como credencial da organização |
| Tem chave da OpenAI para áudio e base de conhecimento? | sem ela o agente não ouve áudio nem consulta documentos — e não avisa |
| Teto de gasto mensal com IA | o produto pausa o agente ao estourar; sem teto, não pausa |

## 4. O funil

| pergunta | por quê |
|---|---|
| As etapas do pacote do nicho servem? Quer renomear alguma? | exatamente uma etapa "ganhou" e uma "perdeu"; 4 a 8 etapas |
| Como vocês chamam o cliente, o negócio, o "ganhou" e o "perdeu"? (paciente/consulta marcada; interessado/fechou) | é o vocabulário que aparece na tela e que o agente usa para não falar "lead" com paciente |
| Motivos de perda que valem registrar | vão para a lista de motivos e para a análise depois |

## 5. Os agentes

| pergunta | por quê |
|---|---|
| Um agente só, ou papéis separados (recepção/vendas/suporte/pós-venda)? | mais de um agente no mesmo número exige roteador |
| Como o agente se chama e em que tom fala (caloroso, objetivo, formal)? | tom é texto no prompt — não há botão |
| O que ele **pode** fazer sozinho: agendar, mover no funil, mandar proposta, dar desconto até X? | capacidades e tabela de promessas |
| O que ele **nunca** faz e quando chama uma pessoa (palavras-gatilho, situações) | palavras de passagem para humano + casos |
| O que a pessoa do time precisa receber quando assume (resumo, o que já foi prometido) | o handoff entrega isso; o prompt pode pedir o que registrar |

## 6. O roteador (só com 2+ agentes no mesmo número)

| pergunta | por quê |
|---|---|
| Que assuntos vão para cada agente? Três exemplos de frase de cliente por assunto | intenção = nome + descrição + exemplos; o classificador decide por eles |
| Quem atende quando não dá para saber? | agente de fallback |
| O cliente fica com o mesmo agente na conversa? | modo "grudado" (sticky) |

## 7. Os follow-ups

| pergunta | por quê |
|---|---|
| O que fazer quando o cliente some no meio (após quanto tempo, quantas vezes, com que mensagem)? | gatilho por silêncio + esperas + mensagens; no máximo o que o número aguenta |
| Situações próprias do nicho: faltou à consulta, abandonou o pagamento, não respondeu o orçamento | gatilhos de no-show, mudança de etapa, caso aberto |
| O que **para** o follow-up (respondeu, pediu humano, pediu para parar) | política de handoff e cancelamento por resposta |

## 8. Conhecimento

| pergunta | por quê |
|---|---|
| Perguntas que os clientes mais fazem e as respostas oficiais (10 a 30) | FAQ — a fonte mais barata e mais usada |
| Documentos (PDF/MD/TXT até 20 MB cada): tabela de preços, políticas, catálogo, manual | fontes por documento; catálogo de loja vem da integração |
| O que o agente **não** deve responder mesmo sabendo | limites no prompt + passagem para humano |

## 9. Memória da organização (regras da casa)

Fatos que valem para **todos** os agentes: "não abrimos domingo", "só atendemos maiores de 18",
"parcelamos em até 6x sem juros", "o endereço é…". Curtos, um por linha.

## 10. Promessas e limites comerciais

Piso de preço, desconto máximo, parcelas máximas. O produto veta promessa fora da tabela — mas
só se a tabela existir.

## 11. Automações e integrações

Formulário do site, anúncios (Meta), loja (Nuvemshop), agenda (Google): o que entra no funil e o que
o agente faz quando entra.

## 12. O time

Quem atende quando a IA passa, com que e-mail e papel (atendente, gerente, admin); como as
conversas se distribuem (manual ou rodízio).

## O que você não pergunta

Nada técnico (modelo exato, temperatura, tokens): você escolhe pelo pacote e explica em uma
frase. Nada que esteja nos documentos que a pessoa entregou — leia antes de perguntar.
