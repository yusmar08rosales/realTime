const LOCAL_RELAY_SERVER_URL: string =
  process.env.REACT_APP_LOCAL_RELAY_SERVER_URL || '';

import { useEffect, useRef, useCallback, useState } from 'react';

import { RealtimeClient } from '@openai/realtime-api-beta';
import { ItemType } from '@openai/realtime-api-beta/dist/lib/client.js';
import { WavRecorder, WavStreamPlayer } from '../lib/wavtools/index.js';
import { instructions } from '../utils/conversation_config.js';
import { WavRenderer } from '../utils/wav_renderer';

import { X, Zap } from 'react-feather';
import { Button } from '../components/button/Button';

import './ConsolePage.scss';
import axios from 'axios';

/**
 * Type for all event logs
 */
interface RealtimeEvent {
  time: string;
  source: 'client' | 'server';
  count?: number;
  event: { [key: string]: any };
}

export function ConsolePage() {
  /**
   * Ask user for API Key
   * If we're using the local relay server, we don't need this
   */
  const apiKey = LOCAL_RELAY_SERVER_URL
    ? ''
    : localStorage.getItem('tmp::voice_api_key') ||
    prompt('OpenAI API Key') ||
    '';
  if (apiKey !== '') {
    localStorage.setItem('tmp::voice_api_key', apiKey);
  }

  /**
   * Instantiate:
   * - WavRecorder (speech input)
   * - WavStreamPlayer (speech output)
   * - RealtimeClient (API client)
   */
  const wavRecorderRef = useRef<WavRecorder>(
    new WavRecorder({ sampleRate: 24000 })
  );
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(
    new WavStreamPlayer({ sampleRate: 24000 })
  );
  const clientRef = useRef<RealtimeClient>(
    new RealtimeClient(
      LOCAL_RELAY_SERVER_URL
        ? { url: LOCAL_RELAY_SERVER_URL }
        : {
          apiKey: apiKey,
          dangerouslyAllowAPIKeyInBrowser: true,
        }
    )
  );

  /**
   * References for
   * - Rendering audio visualization (canvas)
   * - Autoscrolling event logs
   * - Timing delta for event log displays
   */
  const clientCanvasRef = useRef<HTMLCanvasElement>(null);
  const serverCanvasRef = useRef<HTMLCanvasElement>(null);
  const eventsScrollHeightRef = useRef(0);
  const eventsScrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<string>(new Date().toISOString());

  /**
   * All of our variables for displaying application state
   * - items are all conversation items (dialog)
   * - realtimeEvents are event logs, which can be expanded
   * - memoryKv is for set_memory() function
   * - coords, marker are for get_weather() function
   */
  const [items, setItems] = useState<ItemType[]>([]);
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimeEvent[]>([]);
  const [isConversationEnded, setIsConversationEnded] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [report, setReport] = useState<string | null>(null); // Estado para el informe
  const [memoryKv, setMemoryKv] = useState<{ [key: string]: any }>({});

  // Función para generar el informe con la transcripción
  const generateReport = async (transcription: string) => {
    const prompt = `Genera un informe de esta conversación de entrevista de trabajo: \n${transcription} para ver si califica para el cargo y al final puntualo del 1/10`;

    try {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: prompt
            },
          ]
        },
        {
          headers: {
            "Authorization": `Bearer `,
            "Content-Type": "application/json",
          },
        }
      );

      console.log(response.data); // Ver el resultado completo
      if (response.data) {
        const generatedReport = response.data.choices[0].message.content;
        setReport(generatedReport); // Almacenar el informe
        return generatedReport;
      }
    } catch (error) {
      console.error("Error al obtener el análisis:", error);
      return null;
    }
  };

  // Función para descargar el informe como archivo de texto
  const downloadReport = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Simular el clic para iniciar la descarga
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    // Limpiar: eliminar el enlace y liberar la URL
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };
  //funcion para conectar
  const connectConversation = useCallback(async () => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;

    setIsConversationEnded(false);
    setIsConnected(true);
    startTimeRef.current = new Date().toISOString();
    setRealtimeEvents([]);
    setItems(client.conversation.getItems());

    await wavRecorder.begin();
    await wavStreamPlayer.connect();
    await client.connect();

    // Activa el modo "En vivo"
    await enableLiveMode();

    client.sendUserMessageContent([
      {
        type: `input_text`,
        text: `Hello!`,
      },
    ]);
  }, []);

  /**
   * Desconectar la conversación y mostrar el video
   */
  const disconnectConversation = useCallback(async () => {
    setIsConnected(false);
    setRealtimeEvents([]);
    setItems([]);

    const client = clientRef.current;
    client.disconnect();

    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.end();

    const wavStreamPlayer = wavStreamPlayerRef.current;
    await wavStreamPlayer.interrupt();

    // Generar transcripción completa
    const fullTranscription = items
      .map((item) => item.formatted.transcript)
      .filter(Boolean)
      .join('\n');

    // Llamar a la función para generar el informe y esperar que se complete
    const generatedReport = await generateReport(fullTranscription);

    // Crear el contenido combinado
    const combinedContent = `
                INFORME DE LA ENTREVISTA
                ------------------------
               ${generatedReport || 'No se pudo generar el informe.'}

                TRANSCRIPCIÓN COMPLETA
                -----------------------
               ${fullTranscription || 'No hay transcripción disponible.'}
                `;
    // Descargar el informe automáticamente
    downloadReport(combinedContent, 'Informe_Entrevista_Completo.txt');

    setIsConversationEnded(true); // Mostrar video de despedida
  }, [items]);

  /**
   * Switch between Manual <> VAD mode for communication
   */
  const enableLiveMode = async () => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;

    // Configura siempre en "En vivo"
    client.updateSession({
      turn_detection: { type: 'server_vad' },
    });

    if (client.isConnected() && wavRecorder.getStatus() !== 'recording') {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
  };


  /**
   * Auto-scroll the event logs
   */
  useEffect(() => {
    if (eventsScrollRef.current) {
      const eventsEl = eventsScrollRef.current;
      const scrollHeight = eventsEl.scrollHeight;
      // Only scroll if height has just changed
      if (scrollHeight !== eventsScrollHeightRef.current) {
        eventsEl.scrollTop = scrollHeight;
        eventsScrollHeightRef.current = scrollHeight;
      }
    }
  }, [realtimeEvents]);

  /**
   * Auto-scroll the conversation logs
   */
  useEffect(() => {
    const conversationEls = [].slice.call(
      document.body.querySelectorAll('[data-conversation-content]')
    );
    for (const el of conversationEls) {
      const conversationEl = el as HTMLDivElement;
      conversationEl.scrollTop = conversationEl.scrollHeight;
    }
  }, [items]);

  /**
   * Set up render loops for the visualization canvas
   */
  useEffect(() => {
    let isLoaded = true;

    const wavRecorder = wavRecorderRef.current;
    const clientCanvas = clientCanvasRef.current;
    let clientCtx: CanvasRenderingContext2D | null = null;

    const wavStreamPlayer = wavStreamPlayerRef.current;
    const serverCanvas = serverCanvasRef.current;
    let serverCtx: CanvasRenderingContext2D | null = null;

    const render = () => {
      if (isLoaded) {
        if (clientCanvas) {
          if (!clientCanvas.width || !clientCanvas.height) {
            clientCanvas.width = clientCanvas.offsetWidth;
            clientCanvas.height = clientCanvas.offsetHeight;
          }
          clientCtx = clientCtx || clientCanvas.getContext('2d');
          if (clientCtx) {
            clientCtx.clearRect(0, 0, clientCanvas.width, clientCanvas.height);
            const result = wavRecorder.recording
              ? wavRecorder.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              clientCanvas,
              clientCtx,
              result.values,
              '#A000EB',
              10,
              0,
              8
            );
          }
        }
        if (serverCanvas) {
          if (!serverCanvas.width || !serverCanvas.height) {
            serverCanvas.width = serverCanvas.offsetWidth;
            serverCanvas.height = serverCanvas.offsetHeight;
          }
          serverCtx = serverCtx || serverCanvas.getContext('2d');
          if (serverCtx) {
            serverCtx.clearRect(0, 0, serverCanvas.width, serverCanvas.height);
            const result = wavStreamPlayer.analyser
              ? wavStreamPlayer.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              serverCanvas,
              serverCtx,
              result.values,
              '#6FB0F0',
              10,
              0,
              8
            );
          }
        }
        window.requestAnimationFrame(render);
      }
    };
    render();

    return () => {
      isLoaded = false;
    };
  }, []);

  /**
   * Core RealtimeClient and audio capture setup
   * Set all of our instructions, tools, events and more
   */
  useEffect(() => {
    // Get refs
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const client = clientRef.current;

    // Set instructions
    client.updateSession({ instructions: instructions });
    // Set transcription, otherwise we don't get user transcriptions back
    client.updateSession({ input_audio_transcription: { model: 'whisper-1' } });

    // Add tools
    client.addTool(
      {
        name: 'set_memory',
        description: 'Saves important data about the user into memory.',
        parameters: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description:
                'The key of the memory value. Always use lowercase and underscores, no other characters.',
            },
            value: {
              type: 'string',
              description: 'Value can be anything represented as a string',
            },
          },
          required: ['key', 'value'],
        },
      },
      async ({ key, value }: { [key: string]: any }) => {
        setMemoryKv((memoryKv) => {
          const newKv = { ...memoryKv };
          newKv[key] = value;
          return newKv;
        });
        return { ok: true };
      }
    );
    // handle realtime events from client + server for event logging
    client.on('realtime.event', (realtimeEvent: RealtimeEvent) => {
      setRealtimeEvents((realtimeEvents) => {
        const lastEvent = realtimeEvents[realtimeEvents.length - 1];
        if (lastEvent?.event.type === realtimeEvent.event.type) {
          // if we receive multiple events in a row, aggregate them for display purposes
          lastEvent.count = (lastEvent.count || 0) + 1;
          return realtimeEvents.slice(0, -1).concat(lastEvent);
        } else {
          return realtimeEvents.concat(realtimeEvent);
        }
      });
    });
    client.on('error', (event: any) => console.error(event));
    client.on('conversation.interrupted', async () => {
      const trackSampleOffset = await wavStreamPlayer.interrupt();
      if (trackSampleOffset?.trackId) {
        const { trackId, offset } = trackSampleOffset;
        await client.cancelResponse(trackId, offset);
      }
    });
    client.on('conversation.updated', async ({ item, delta }: any) => {
      const items = client.conversation.getItems();
      if (delta?.audio) {
        wavStreamPlayer.add16BitPCM(delta.audio, item.id);
      }
      // Si hay una transcripción de audio, añádela al estado
      if (delta?.transcription) {
        item.formatted.transcript = delta.transcription.text;
      }

      if (item.status === 'completed' && item.formatted.audio?.length) {
        const wavFile = await WavRecorder.decode(
          item.formatted.audio,
          24000,
          24000
        );
        item.formatted.file = wavFile;
      }
      setItems(items);
    });

    setItems(client.conversation.getItems());

    return () => {
      // cleanup; resets to defaults
      client.reset();
    };
  }, []);

  /**
   * Render the application
   */
  return (
    <div data-component="ConsolePage">
      <div className="content-top">
        <div className="content-title">
          <img src="/SEO-COLORES-04 (1).png" />
          <span className='titulo'>Entrevista Seo Contenidos</span>
        </div>
      </div>

      <div className="content-main">
        <div className="content-logs">
          <div className="content-block events">
            <div className="visualization">
              <div className="visualization-entry client">
                <canvas ref={clientCanvasRef} />
              </div>
              <div className="visualization-entry server">
                <canvas ref={serverCanvasRef} />
              </div>
            </div>
            {report && (
              <div className="report-section">
                <h2>Informe de la Entrevista</h2>
                <p>{report}</p>
              </div>
            )}

          </div>

          {/*-----------------------------------------
                transcripcion de lA CONVERSACION 
          -----------------------------------------*/}
          {/* <div className="content-block conversation">
            <div className="content-block-title">Conversación</div>
            <div className="content-block-body" data-conversation-content>
              {!items.length && `Esperando para conectar...`}
              {items.map((conversationItem, i) => {
                return (
                  <div className="conversation-item" key={conversationItem.id}>
                    <div className={`speaker ${conversationItem.role || ''}`}>
                      <div>
                        {(conversationItem.role || conversationItem.type).replaceAll('_', ' ')}
                      </div>
                    </div>
                    <div className={`speaker-content`}>
                      {conversationItem.formatted.transcript || '(esperando transcripción...)'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>*/}

          <div className="content-actions">
            <div className="status">En vivo</div> {/* Indica el estado */}


            {/*<Button label="Descargar transcripción" onClick={downloadTranscription} />*/}
            <Button
              label={isConnected ? 'Desconectar' : 'Conectar'}
              iconPosition={isConnected ? 'end' : 'start'}
              icon={isConnected ? X : Zap}
              buttonStyle={isConnected ? 'regular' : 'action'}
              onClick={isConnected ? disconnectConversation : connectConversation}
            />
          </div>
        </div>
      </div>
    </div >
  );
}
