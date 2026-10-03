---
impacto: capacidade_nova
secao: corrigido
titulo: Formulários do Elementor Pro passam a criar lead pelo webhook
---
O webhook de captação agora entende o formato que a ação "Webhook" do Elementor Pro envia. Antes, o envio era recusado com "Nenhum campo mapeável" e nenhum lead entrava, porque o Elementor manda cada campo no formato `fields[id][value]`. Agora nome, telefone e e-mail são encontrados pelo tipo do campo (texto, `tel`, `email`), e os demais campos do formulário chegam ao lead pelo nome interno, junto com o nome do formulário. Campos ocultos `utm_*` seguem para a origem do lead. Na tela de cada fonte, a ajuda "Como conectar no seu caso" agora explica como ligar o Elementor Pro (Ações após o envio › Webhook) e o JetFormBuilder (ação Call Webhook).
