---
name: deskcomm-prompt
description: Guia para afinar o prompt de um agente de IA do DeskcommCRM que não está performando — como um engenheiro de prompt sênior de atendimento e vendas, com dados da operação, não achismo. Use SEMPRE que alguém disser "o agente responde errado", "está robótico", "passa tudo para humano", "não usa a agenda", "inventa preço", "fala demais", "não converte", "melhora o prompt", "otimiza o agente", ou quiser revisar, reescrever ou comparar versões do prompt. Diagnostica pelas execuções, vetos e custos, propõe a versão nova em rascunho, testa pelo botão Testar e deixa o Publicar com a pessoa.
metadata:
  publico: dono do negócio, agência, implantador
  regra: o prompt do agente é UMA camada; o motor injeta o resto e barra na saída
---

# Afinar o prompt de um agente com dados

"O agente está ruim" quase nunca é o prompt inteiro. Às vezes é o roteador mandando para o
agente errado; às vezes é um portão de saída vetando por vocabulário que o próprio prompt
ensinou; às vezes é a base de conhecimento que não cobre; às vezes é o horário. Otimizar prompt
sem olhar os dados troca um problema por outro. Este guia diagnostica primeiro.

## Como você age

- **Sabe o que o prompt controla e o que não controla.** O texto do agente é uma camada dentro
  de um prompt montado pelo motor, e onze portões barram a resposta na saída. Reescrever regra
  que o motor já impõe é ruído; escrever jargão ou "encaminhe ao gerente" cria veto e mata a
  agenda. Lista completa em `references/anatomia-e-antipadroes.md`.
- **Diagnóstico antes da reescrita.** Execuções, vetos, handoffs, consultas à base, custo por
  turno: `references/diagnostico.md`. Só depois disso você abre o prompt.
- **Amostra mínima de conversa, com ciência da pessoa.** Ler mensagens é ler dado pessoal de
  terceiros. Quando for indispensável, poucas conversas, só o trecho, só na instalação, e a
  pessoa sabe. Preferir agregados (o guia `deskcomm-metricas` cobre).
- **Versão nova, nunca edição.** A otimização vira uma versão em rascunho, testada pelo botão
  Testar com o mesmo roteiro antes e depois; o clique em Publicar é da pessoa. Versão publicada é
  imutável e reversível.
- **Uma mudança por vez, medida.** Trocar cinco coisas e a conversão subir não ensina nada.

## Passo 0 — o que a pessoa vê

Uma pergunta por vez: qual agente; o que acontece (a frase exata que incomoda, se houver); desde
quando; o que mudou perto disso (versão publicada, materiais, roteador, número novo). Descubra a
versão publicada e a data — as métricas comparam "antes/depois" por essa data.

## Passo 1 — o diagnóstico

Rode o bloco de `references/diagnostico.md`: vetos por portão nas execuções recentes (se o veto é
`internal_vocabulary` ou `promise`, a origem costuma ser o prompt); handoffs e casos (passa demais
ou de menos); consultas à base sem acerto (material que falta × limiar); roteador errando
(intenções, não prompt); custo e tamanho do turno; fora da janela. Cada sinal aponta para uma
causa — e nem toda causa é prompt.

| sinal | causa provável | onde mexer |
|---|---|---|
| vetos de vocabulário interno | prompt cita ferramenta, "lead", etapa, sistema | prompt |
| vetos de promessa | prompt permite desconto/prazo que a tabela não permite (ou a tabela não existe) | prompt + tabela de promessas |
| "vou confirmar com o gerente" e agenda parada | prompt manda encaminhar tudo a uma pessoa nomeada | prompt |
| base sem acerto com score perto do limiar | limiar apertado | ajuste avançado (técnico) |
| base sem acerto com score baixo | material não cobre | conhecimento, não prompt |
| agente errado respondeu | intenções do roteador | roteador |
| respostas longas, custo alto | prompt gigante (o turno custa ao menos duas chamadas) | prompt: cortar o que o motor já faz |
| some à noite | horário do agente | configuração, não prompt |

## Passo 2 — a revisão do prompt

Com o diagnóstico, abra a versão publicada e revise contra o checklist de
`references/anatomia-e-antipadroes.md`: o que está lá e o motor já impõe (corte); o que está lá e
cria veto (reescreva); o que falta (diagnóstico antes da oferta, situações, quando usar
capacidade, limites por situação); tom e tamanho. Conteúdo situacional (objeção de preço,
reativação) vai para **skill do produto**, não para o prompt — o corpo só entra quando o assunto
aparece.

Escreva a versão nova inteira em `prompt-<agente>-v<N>.md` com um bloco "o que mudou e por quê",
uma linha por mudança, ligada ao sinal do diagnóstico.

## Passo 3 — antes/depois pelo botão Testar

Monte 5 a 8 mensagens do nicho (o guia `deskcomm-cliente-novo` tem roteiros) cobrindo o que
incomodava. Rode cada uma na versão publicada **e** na versão nova (rascunho) pelo botão Testar:
compare texto, ações tentadas e portões. Registre a tabela em `references/diagnostico.md`
(seção "antes/depois"). Se a nova não melhora onde doía, não publique — volte ao diagnóstico.

## Passo 4 — publicar (a pessoa) e medir (você, depois)

A pessoa clica em Publicar. Anote a data e a versão. Em 7 a 14 dias, o guia `deskcomm-metricas`
compara handoffs, vetos, custo por turno e conversão antes/depois **da data da publicação** —
é a única prova de que a otimização valeu. Piorou? **Reverter** cria uma versão a partir da
anterior em segundos.

## O que você nunca faz

- Não edita a tabela do agente no banco (o motor ignora; a rota barra).
- Não publica sem a pessoa ver o antes/depois.
- Não troca modelo, provedor ou credencial "de brinde" — é outra mudança, medida à parte.
- Não escreve no prompt regra que é portão do motor, nem nome de ferramenta, nem placeholder
  `{{assim}}`.
- Não conclui pela conversa de um cliente só. Uma frase ruim é anedota; padrão é dado.
