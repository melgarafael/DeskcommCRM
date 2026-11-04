---
impacto: capacidade_nova
secao: corrigido
titulo: A transcrição de áudio pela OpenAI e a leitura de mídia por modelo do catálogo passam a contar no gasto de IA
---

Você não precisa fazer nada. A partir desta versão, esse custo aparece em Uso e orçamento e conta para o limite mensal de IA e para a cota do plano. Se a sua organização está perto do limite, ele será atingido um pouco antes, pelo valor real.

O que mudou:

- **Áudio transcrito pela OpenAI (`whisper-1`).** A linha de custo ficava vazia, enquanto o mesmo áudio transcrito pela OpenRouter já contava. Agora o custo é a duração que a própria OpenAI informa que cobrou, vezes o preço publicado por minuto (US$ 0,006). Vale só quando o pedido foi à OpenAI: um serviço compatível que aceite o mesmo nome de modelo (Groq, servidor próprio) continua sem custo, porque o preço dele é outro. O ElevenLabs Scribe continua sem custo registrado.
- **Leitura de imagem e transcrição pelo modelo de conversa**, quando o modelo não está na tabela de preços do sistema (provedor personalizado, modelo do catálogo): o custo passa a sair do catálogo da instalação, como já acontecia no atendimento. A resposta ao cliente não espera por isso.
- **Respostas e análises de sentimento com modelo sem preço em lugar nenhum** gravavam custo 0, o que a tela lia como "grátis". Agora gravam custo desconhecido, e o aviso de gasto incompleto aparece. O total do mês não muda. Modelo gratuito do catálogo (os `:free` da OpenRouter) continua custando 0 e não acende o aviso.
