---
impacto: nada_mudou
secao: corrigido
titulo: O editor do agente diz na tela por que o Publicar está desabilitado
---
No editor do agente, o motivo de o botão Publicar estar desabilitado existia só no `title` do botão: aparecia com o ponteiro parado em cima dele. Em celular e tablet não existe hover, e um botão desabilitado não recebe foco do teclado — quem mais precisava da explicação era exatamente quem não a recebia. Agora o motivo aparece como texto na própria tela, logo abaixo do cabeçalho do editor, e o botão aponta para ele por `aria-describedby`, então o leitor de tela anuncia a explicação junto do rótulo. As frases do motivo não mudaram e continuam traduzidas em espanhol. Nada muda na sua VPS: nenhuma migration, nenhuma variável, nenhum comando. Crédito: @webtecnica.
