const { Server } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { createServer } = require('http');
const express = require('express');
const { KronRoom } = require('./rooms/KronRoom');

const app = express();
const httpServer = createServer(app);

app.get('/', (req, res) => res.send('KRON STRIKE Server running'));

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer })
});

gameServer.define('kron_room', KronRoom);

const PORT = process.env.PORT || 2567;
httpServer.listen(PORT, () => {
  console.log(`KRON STRIKE server listening on port ${PORT}`);
});
