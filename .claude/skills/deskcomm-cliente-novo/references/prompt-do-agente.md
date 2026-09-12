# O prompt do agente — o que ele controla e o que o motor já faz por ele

O texto que a pessoa escreve **não é** o prompt inteiro. A cada resposta o motor monta: regras de
compliance da plataforma (apresentar-se como assistente virtual, não fingir humano, não pedir dado
sensível, não inventar preço, mensagens curtas) → **o prompt do agente** → memória da organização
→ índice de skills → blocos fixos (nunca narrar problema interno; abrir caso antes de prometer
humano; nunca confirmar agenda sem usar a ferramenta). Depois disso vem o contexto do cliente:
resumo da conversa, estado no funil, compromissos, notas, a mensagem atual, "que horas são".

E, **na saída**, onze portões mecânicos barram a resposta antes de ir: STOP, LGPD, ritmo de
envio, janela de 24 h, cópia repetida, promessa fora da tabela, promessa sem caso aberto,
vocabulário interno, agenda sem ferramenta, aviso de IA. O veto volta ao modelo como correção.

## O que o prompt controla de verdade

1. **Identidade e contexto** — quem é, para que negócio trabalha, o que o negócio faz.
2. **Diagnóstico antes da oferta** — que perguntas fazer, em que ordem, antes de propor.
3. **Qualificação** — o que separa quem está pronto de quem ainda não está (e o que fazer com cada).
4. **Situações e o que dizer** — objeção de preço, "vou pensar", pedido fora do escopo, urgência.
5. **Quando usar uma capacidade** — "consulte a base antes de responder preço ou prazo", "ofereça
   horários quando a pessoa quiser marcar", "registre o que ficou combinado".
6. **Limites** — o que nunca promete, quando chama uma pessoa (situações, não uma pessoa nomeada).
7. **Estilo** — tom, tamanho, uma pergunta por vez, sem emoji ou com parcimônia.
8. **Follow-up** — o que registrar para o retorno fazer sentido.

## O que NÃO escrever (o motor já impõe, ou o texto atrapalha)

- "Apresente-se como assistente virtual", "não invente preço", "respeite quem pede para parar",
  "não mande mensagem de madrugada", "não confirme agenda sem verificar" — são portões.
- Nome de ferramenta ou de sistema (`update_lead_state`, "lead", "etapa qualified", "webhook",
  "admin") — o portão de vocabulário interno veta, e o prompt vira a origem do veto.
- "Encaminhe ao gerente Fulano tudo que não souber" — medido: faz o modelo responder "vou
  confirmar com o Fulano" **em vez de usar a agenda**. Restrinja a situações que nenhuma
  capacidade cobre.
- "Resuma o atendimento no fim", "leia o histórico antes de perguntar de novo", "que dia é hoje"
  — já vêm no contexto de cada turno.
- Preço e prazo em texto quando existe catálogo ou base de conhecimento — duas fontes divergem.
- Placeholders `{{assim}}` — o motor não substitui; ele injeta o contexto por conta própria.

## Esqueleto (preencha com a triagem; tire seções vazias)

```markdown
# Quem você é
Você atende os clientes de {negócio}, que é: {o que faz, em uma frase}. Seu nome é {nome}.
{tom em uma frase: caloroso e próximo / objetivo e cordial / curto e direto}

# O que você faz primeiro
Antes de oferecer qualquer coisa, entenda: {2-4 perguntas de diagnóstico do nicho, uma por vez}.

# Como você decide o próximo passo
- Se {sinal de pronto}: {ação — ofereça horários / envie a proposta / explique como comprar}.
- Se {sinal de dúvida}: {ação — tire a dúvida consultando os materiais; não force}.
- Se {fora do escopo}: diga o que você não cuida e chame uma pessoa do time.

# Situações
- Preço: consulte os materiais; se não houver, diga que uma pessoa confirma. Nunca estime.
- "Vou pensar": pergunte o que falta para decidir; combine um retorno e registre.
- {situação própria do nicho}: {o que dizer}.

# Limites
Você não {lista curta do que nunca faz}. Você chama uma pessoa do time quando {situações}.

# Estilo
Mensagens curtas, uma pergunta por vez, sem jargão. {emoji: nunca / com parcimônia}.
```

## Testar antes de publicar

O botão **Testar** da versão roda o motor real em modo sandbox com uma mensagem: mostra o texto
proposto, os portões que passaram ou vetaram, as ações que o agente tentaria. Limites: uma
mensagem sem histórico, contato fictício, consome crédito. Roteiro por nicho em `nichos.md`.

## Depois: otimizar com dados

Quando o agente já atendeu de verdade, o guia `deskcomm-prompt` lê as conversas, os vetos e os
custos e propõe a otimização — sempre como versão nova em rascunho.
