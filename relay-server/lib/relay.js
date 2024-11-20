import { WebSocketServer } from 'ws';
import { RealtimeClient } from '@openai/realtime-api-beta';

export class RealtimeRelay {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.sockets = new WeakMap();
    this.wss = null;
    this.clientAnalysisData = new Map(); // Para almacenar los análisis por cliente
  }

  listen(port) {
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', this.connectionHandler.bind(this));
    this.log(`Listening on buildconsola-realtime-production.up.railway.app:${port}/ws`);
  }

  async connectionHandler(ws, req) {
    if (!req.url) {
      this.log('No URL provided, closing connection.');
      ws.close();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname !== '/') {
      this.log(`Invalid pathname: "${pathname}"`);
      ws.close();
      return;
    }

    // Crear un cliente Realtime
    this.log(`Connecting with key "${this.apiKey.slice(0, 3)}..."`);
    const client = new RealtimeClient({ apiKey: this.apiKey });

    // Relay: OpenAI Realtime API Event -> Browser Event
    client.realtime.on('server.*', (event) => {
      this.log(`Relaying "${event.type}" to Client`);
      ws.send(JSON.stringify(event));
    });
    client.realtime.on('close', () => ws.close());

    // Queue para mensajes mientras esperamos conexión a OpenAI
    const messageQueue = [];
    const messageHandler = (data) => {
      try {
        const event = JSON.parse(data);
        this.log(`Relaying "${event.type}" to OpenAI`);

        // Si el evento contiene análisis del CV, almacenarlo para este cliente
        if (event.type === 'analysis') {
          this.clientAnalysisData.set(ws, event.analysis);
          this.log('Stored analysis for the client.');
        } else {
          // Enviar el evento al servidor de OpenAI
          client.realtime.send(event.type, event);
        }
      } catch (e) {
        console.error(e.message);
        this.log(`Error parsing event from client: ${data}`);
      }
    };

    ws.on('message', (data) => {
      if (!client.isConnected()) {
        messageQueue.push(data);
      } else {
        messageHandler(data);
      }
    });

    ws.on('close', () => {
      client.disconnect();
      this.clientAnalysisData.delete(ws); // Eliminar el análisis almacenado cuando el cliente se desconecta
      this.log('Client disconnected and analysis data removed.');
    });

    // Conectar con la API Realtime de OpenAI
    try {
      this.log(`Connecting to OpenAI...`);
      await client.connect();
    } catch (e) {
      this.log(`Error connecting to OpenAI: ${e.message}`);
      ws.close();
      return;
    }

    this.log(`Connected to OpenAI successfully!`);

    // Procesar mensajes en la cola
    while (messageQueue.length) {
      messageHandler(messageQueue.shift());
    }

    // Enviar el análisis almacenado al cliente cuando se conecta
    if (this.clientAnalysisData.has(ws)) {
      const analysis = this.clientAnalysisData.get(ws);
      this.log('Sending stored analysis to the client');
      
      // Enviar análisis al cliente de OpenAI
      client.realtime.send('server.analysis', { analysis });
    }
  }

  log(...args) {
    console.log(`[RealtimeRelay]`, ...args);
  }
}
