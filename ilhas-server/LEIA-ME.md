# Ilhas do Portal: servidor multiplayer

Este pacote tem o jogo e o servidor multiplayer. O servidor entrega o jogo no navegador e sincroniza os jogadores.

## O que o multiplayer faz nesta versão
- Jogadores no **mesmo bloco e na mesma ilha** se veem andando, com nome, nível e tag da guilda.
- **Chat Global** (todo o mundo) e **Local** (só a sua ilha no seu bloco). Aperte **Enter** para escrever.
- **Mercado Global** compartilhado: o que um jogador anuncia aparece para todos. Quem compra recebe o item. O vendedor recebe o valor menos 5% de taxa. Se o vendedor estiver offline, o valor fica guardado e é entregue quando ele entrar.
- **Porto:** mostra quantos jogadores há em cada bloco.
- O canto inferior direito mostra 🟢 Online, quantos jogadores há no bloco e quantos no mundo.

Monstros, chefes, baús e o progresso do personagem continuam em cada navegador. Cada jogador enfrenta os próprios monstros.

## Rodar no seu computador
1. Instale o **Node.js 18 ou mais novo** (https://nodejs.org).
2. Abra um terminal nesta pasta e rode:
   ```
   npm install
   npm start
   ```
3. Abra **http://localhost:3000** no navegador.
4. Outras pessoas na mesma rede Wi-Fi podem entrar pelo IP do seu computador, por exemplo `http://192.168.0.10:3000`.

## Colocar na internet (exemplo com Render)
1. Crie um repositório no GitHub e envie esta pasta (sem a pasta `node_modules`).
2. Em https://render.com, crie um **Web Service** ligado a esse repositório.
   - Build Command: `npm install`
   - Start Command: `npm start`
3. O Render gera um endereço como `https://ilhas-do-portal.onrender.com`. É esse link que os jogadores abrem.
4. **Anúncios do mercado:** ficam em `data/market.json` e `data/proceeds.json`. No plano gratuito do Render esses arquivos se perdem quando o servidor reinicia. Para mantê-los, adicione um **Persistent Disk** montado em `/opt/render/project/src/data`.

Railway, Fly.io ou uma VPS também funcionam. Basta rodar `npm start` com a variável `PORT` definida pelo serviço.

## Arquivos
- `server.js`: servidor HTTP e WebSocket (rota `/ws`)
- `public/index.html`: o jogo
- `data/`: anúncios e pagamentos pendentes do mercado, criado sozinho

## Observação
O servidor confia no que o navegador informa (ouro, itens). Isso é suficiente para jogar com amigos. Antes de abrir para o público, será preciso mover o ouro, os itens e o progresso para o servidor, para evitar trapaça.
