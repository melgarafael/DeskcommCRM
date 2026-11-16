---
impacto: nada_mudou
secao: corrigido
titulo: Voz do agente só aparece com credencial do ElevenLabs validada
---

Em Agente de IA › Provedores › Voz do agente, a escolha de voz continuava na
tela mesmo sem credencial do ElevenLabs validada: dava para colar um Voice ID e
salvar uma voz que o agente não tinha como usar, porque a síntese precisa da
chave. Agora, sem credencial validada, o cartão mostra só o aviso e o link para
cadastrar a chave — seletor, campo e botões ficam ausentes.

Com credencial, nada muda: a lista é a que a conta do ElevenLabs devolve, com
nome e idioma de cada voz, e o campo continua aceitando um ID que não esteja na
lista.

Contribuição de @webtecnica (#4735), a partir da issue #4260.
