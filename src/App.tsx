import { useState, useEffect, useRef, useCallback } from 'react';
import { Video, VideoOff, SkipForward, PhoneOff, Play, Send, MessageCircle, X, Users } from 'lucide-react';
import { supabase } from './lib/supabase';

type ConnectionState = 'idle' | 'searching' | 'connected';

interface ChatMessage {
  id: string;
  sender: 'me' | 'stranger' | 'system';
  text: string;
  timestamp: number;
}

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const FALLBACK_MESSAGES = [
  "Hey there! How's it going?",
  "Nice to meet you!",
  "Where are you from?",
  "What do you do for fun?",
  "This is pretty cool, right?",
  "Anyone else having a good day?",
  "Hello from the other side!",
  "What's your favorite movie?",
  "Do you travel much?",
  "I love meeting new people here!",
];

function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isFallback, setIsFallback] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [onlineCount] = useState(Math.floor(Math.random() * 5000) + 12000);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const myIdRef = useRef(generateId());
  const partnerIdRef = useRef<string | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackMsgTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const politeRef = useRef(false);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);

  const addSystemMessage = useCallback((text: string) => {
    setMessages(prev => [...prev, { id: generateId(), sender: 'system', text, timestamp: Date.now() }]);
  }, []);

  const addStrangerMessage = useCallback((text: string) => {
    setMessages(prev => [...prev, { id: generateId(), sender: 'stranger', text, timestamp: Date.now() }]);
  }, []);

  const cleanupConnection = useCallback(() => {
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    if (fallbackMsgTimerRef.current) {
      clearInterval(fallbackMsgTimerRef.current);
      fallbackMsgTimerRef.current = null;
    }
    setRemoteStream(null);
    partnerIdRef.current = null;
    setIsFallback(false);
  }, []);

  const startLocalCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: cameraOn,
        audio: micOn,
      });
      setLocalStream(stream);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      return stream;
    } catch (err) {
      console.error('Camera access denied:', err);
      addSystemMessage('Camera access denied. You can still use text chat.');
      return null;
    }
  }, [cameraOn, micOn, addSystemMessage]);

  const createPeerConnection = useCallback((stream: MediaStream) => {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    pc.ontrack = (event) => {
      if (event.streams[0]) {
        setRemoteStream(event.streams[0]);
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
        }
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && channelRef.current && partnerIdRef.current) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'ice-candidate',
          payload: { candidate: event.candidate, from: myIdRef.current, to: partnerIdRef.current },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        addSystemMessage('Stranger disconnected.');
        cleanupConnection();
        setConnectionState('idle');
      }
    };

    return pc;
  }, [cleanupConnection, addSystemMessage]);

  const handleSignalingMessage = useCallback(async (payload: Record<string, unknown>, pc: RTCPeerConnection) => {
    const data = payload as { type?: string; from?: string; to?: string; sdp?: RTCSessionDescription; candidate?: RTCIceCandidateInit };
    if (data.from === myIdRef.current) return;
    if (data.to && data.to !== myIdRef.current) return;

    if (data.type === 'offer' && data.sdp) {
      if (makingOfferRef.current || (pc.signalingState !== 'stable')) {
        if (!politeRef.current) {
          ignoreOfferRef.current = true;
          return;
        }
      }
      ignoreOfferRef.current = false;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp as RTCSessionDescriptionInit));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        channelRef.current?.send({
          type: 'broadcast',
          event: 'answer',
          payload: { sdp: pc.localDescription, from: myIdRef.current, to: data.from },
        });
      } catch (err) {
        console.error('Error handling offer:', err);
      }
    } else if (data.type === 'answer' && data.sdp) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp as RTCSessionDescriptionInit));
      } catch (err) {
        console.error('Error handling answer:', err);
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        if (!ignoreOfferRef.current) console.error('Error adding ICE candidate:', err);
      }
    }
  }, []);

  const startRealConnection = useCallback(async (stream: MediaStream) => {
    const roomId = generateId();
    const pc = createPeerConnection(stream);
    peerConnection.current = pc;

    const channel = supabase.channel(`room-${roomId}`, {
      config: { broadcast: { self: true } },
    });

    channelRef.current = channel;

    channel.on('broadcast', { event: 'offer' }, (payload) => {
      handleSignalingMessage(payload.payload as Record<string, unknown>, pc);
    });
    channel.on('broadcast', { event: 'answer' }, (payload) => {
      handleSignalingMessage(payload.payload as Record<string, unknown>, pc);
    });
    channel.on('broadcast', { event: 'ice-candidate' }, (payload) => {
      handleSignalingMessage(payload.payload as Record<string, unknown>, pc);
    });
    channel.on('broadcast', { event: 'join' }, (payload) => {
      const data = payload.payload as { from: string };
      if (data.from !== myIdRef.current && !partnerIdRef.current) {
        partnerIdRef.current = data.from;
        politeRef.current = true;
        setConnectionState('connected');
        addSystemMessage('You are now connected to a stranger!');

        makingOfferRef.current = true;
        pc.createOffer().then(offer => {
          return pc.setLocalDescription(offer);
        }).then(() => {
          channel.send({
            type: 'broadcast',
            event: 'offer',
            payload: { sdp: pc.localDescription, from: myIdRef.current, to: partnerIdRef.current },
          });
        }).finally(() => {
          makingOfferRef.current = false;
        });
      }
    });
    channel.on('broadcast', { event: 'chat' }, (payload) => {
      const data = payload.payload as { from: string; text: string };
      if (data.from !== myIdRef.current) {
        addStrangerMessage(data.text);
      }
    });

    await channel.subscribe();

    channel.send({
      type: 'broadcast',
      event: 'join',
      payload: { from: myIdRef.current },
    });

    fallbackTimerRef.current = setTimeout(() => {
      if (!partnerIdRef.current) {
        cleanupConnection();
        startFallbackMode(stream);
      }
    }, 8000);
  }, [createPeerConnection, handleSignalingMessage, cleanupConnection, addSystemMessage, addStrangerMessage]);

  const startFallbackMode = useCallback((stream: MediaStream) => {
    setIsFallback(true);
    setConnectionState('connected');
    setRemoteStream(stream);
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = stream;
    }
    addSystemMessage('No signaling server detected. Fallback mode active - your camera is echoed as the stranger feed for testing.');

    fallbackMsgTimerRef.current = setInterval(() => {
      const msg = FALLBACK_MESSAGES[Math.floor(Math.random() * FALLBACK_MESSAGES.length)];
      addStrangerMessage(msg);
    }, 4000 + Math.random() * 6000);
  }, [addSystemMessage, addStrangerMessage]);

  const handleStart = useCallback(async () => {
    setMessages([]);
    setConnectionState('searching');
    addSystemMessage('Looking for someone to chat with...');

    const stream = await startLocalCamera();
    if (!stream) {
      setConnectionState('idle');
      return;
    }

    try {
      await startRealConnection(stream);
    } catch {
      addSystemMessage('Could not reach signaling server. Switching to fallback mode.');
      startFallbackMode(stream);
    }
  }, [startLocalCamera, startRealConnection, startFallbackMode, addSystemMessage]);

  const handleNext = useCallback(() => {
    cleanupConnection();
    setConnectionState('idle');
    setMessages([]);

    if (localStream) {
      setTimeout(() => {
        setConnectionState('searching');
        addSystemMessage('Looking for someone new...');
        startFallbackMode(localStream);
      }, 300);
    }
  }, [localStream, cleanupConnection, startFallbackMode, addSystemMessage]);

  const handleStop = useCallback(() => {
    cleanupConnection();
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
    setConnectionState('idle');
    setMessages([]);
    addSystemMessage('Disconnected.');
  }, [localStream, cleanupConnection, addSystemMessage]);

  const handleSendMessage = useCallback(() => {
    if (!inputText.trim()) return;
    const text = inputText.trim();
    setMessages(prev => [...prev, { id: generateId(), sender: 'me', text, timestamp: Date.now() }]);
    setInputText('');

    if (channelRef.current && partnerIdRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'chat',
        payload: { from: myIdRef.current, to: partnerIdRef.current, text },
      });
    }
  }, [inputText]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    return () => {
      cleanupConnection();
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [cleanupConnection, localStream]);

  const toggleCamera = useCallback(async () => {
    if (localStream) {
      const videoTracks = localStream.getVideoTracks();
      videoTracks.forEach(track => {
        track.enabled = !track.enabled;
      });
      setCameraOn(prev => !prev);
    }
  }, [localStream]);

  const toggleMic = useCallback(() => {
    if (localStream) {
      const audioTracks = localStream.getAudioTracks();
      audioTracks.forEach(track => {
        track.enabled = !track.enabled;
      });
      setMicOn(prev => !prev);
    }
  }, [localStream]);

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 sm:px-6 py-3 bg-gray-900/80 backdrop-blur-md border-b border-gray-800 z-20">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center">
            <Video className="w-4 h-4 text-white" />
          </div>
          <h1 className="text-lg font-bold tracking-tight">ChatRoulette</h1>
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Users className="w-4 h-4" />
          <span>{onlineCount.toLocaleString()} online</span>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex flex-col lg:flex-row relative overflow-hidden">
        {/* Video Area */}
        <div className="flex-1 relative bg-gray-900 flex items-center justify-center min-h-[50vh] lg:min-h-0">
          {/* Remote / Stranger Video */}
          <div className="absolute inset-0 flex items-center justify-center">
            {remoteStream ? (
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="flex flex-col items-center gap-4 text-gray-500">
                <VideoOff className="w-16 h-16 opacity-30" />
                <p className="text-sm">
                  {connectionState === 'searching'
                    ? 'Searching for someone...'
                    : connectionState === 'idle'
                    ? 'Click Start to begin'
                    : 'Waiting for video...'}
                </p>
              </div>
            )}
          </div>

          {/* Searching overlay */}
          {connectionState === 'searching' && !remoteStream && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-900/60 backdrop-blur-sm z-10">
              <div className="flex flex-col items-center gap-4">
                <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-emerald-400 font-medium">Finding someone for you...</p>
              </div>
            </div>
          )}

          {/* Local / PiP Video */}
          <div className="absolute bottom-4 right-4 z-10 w-32 sm:w-44 aspect-video rounded-xl overflow-hidden shadow-2xl border-2 border-gray-700/50 bg-gray-800">
            {localStream ? (
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover"
                style={{ transform: 'scaleX(-1)' }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <VideoOff className="w-6 h-6 text-gray-600" />
              </div>
            )}
            <div className="absolute bottom-1 left-1 text-[10px] text-gray-300 bg-black/50 px-1.5 py-0.5 rounded">
              You
            </div>
          </div>

          {/* Connection status badge */}
          {connectionState === 'connected' && (
            <div className="absolute top-4 left-4 z-10 flex items-center gap-2 bg-black/50 backdrop-blur-sm px-3 py-1.5 rounded-full">
              <div className={`w-2 h-2 rounded-full ${isFallback ? 'bg-amber-400' : 'bg-emerald-400'} animate-pulse`} />
              <span className="text-xs font-medium">
                {isFallback ? 'Test Mode' : 'Connected'}
              </span>
            </div>
          )}
        </div>

        {/* Chat Panel - Desktop */}
        <div className="hidden lg:flex flex-col w-80 xl:w-96 bg-gray-900 border-l border-gray-800">
          <ChatPanel
            messages={messages}
            inputText={inputText}
            setInputText={setInputText}
            onSend={handleSendMessage}
            connectionState={connectionState}
          />
        </div>

        {/* Chat Panel - Mobile Overlay */}
        {chatOpen && (
          <div className="lg:hidden absolute inset-0 z-30 flex flex-col bg-gray-900">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <h2 className="font-semibold text-sm">Chat</h2>
              <button
                onClick={() => setChatOpen(false)}
                className="p-1 rounded-lg hover:bg-gray-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <ChatPanel
              messages={messages}
              inputText={inputText}
              setInputText={setInputText}
              onSend={handleSendMessage}
              connectionState={connectionState}
            />
          </div>
        )}
      </div>

      {/* Control Bar */}
      <div className="bg-gray-900/80 backdrop-blur-md border-t border-gray-800 px-4 sm:px-6 py-3 z-20">
        <div className="flex items-center justify-center gap-3 sm:gap-4 max-w-2xl mx-auto">
          {/* Camera toggle */}
          <button
            onClick={toggleCamera}
            disabled={!localStream}
            className={`p-2.5 rounded-xl transition-all duration-200 ${
              cameraOn
                ? 'bg-gray-700 hover:bg-gray-600 text-white'
                : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
            } disabled:opacity-30 disabled:cursor-not-allowed`}
            title={cameraOn ? 'Turn off camera' : 'Turn on camera'}
          >
            {cameraOn ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
          </button>

          {/* Mic toggle */}
          <button
            onClick={toggleMic}
            disabled={!localStream}
            className={`p-2.5 rounded-xl transition-all duration-200 ${
              micOn
                ? 'bg-gray-700 hover:bg-gray-600 text-white'
                : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
            } disabled:opacity-30 disabled:cursor-not-allowed`}
            title={micOn ? 'Mute' : 'Unmute'}
          >
            {micOn ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5m6 8.25a3 3 0 01-3 3z" />
                <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth={2} />
              </svg>
            )}
          </button>

          {/* Main action buttons */}
          {connectionState === 'idle' ? (
            <button
              onClick={handleStart}
              className="flex items-center gap-2 px-6 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-white font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-emerald-500/25 hover:shadow-emerald-400/30 active:scale-95"
            >
              <Play className="w-5 h-5" />
              <span>Start</span>
            </button>
          ) : (
            <>
              <button
                onClick={handleNext}
                disabled={connectionState === 'searching'}
                className="flex items-center gap-2 px-5 py-2.5 bg-amber-500 hover:bg-amber-400 text-white font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-amber-500/25 hover:shadow-amber-400/30 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <SkipForward className="w-5 h-5" />
                <span>Next</span>
              </button>
              <button
                onClick={handleStop}
                className="flex items-center gap-2 px-5 py-2.5 bg-red-500 hover:bg-red-400 text-white font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-red-500/25 hover:shadow-red-400/30 active:scale-95"
              >
                <PhoneOff className="w-5 h-5" />
                <span>Stop</span>
              </button>
            </>
          )}

          {/* Chat toggle (mobile) */}
          <button
            onClick={() => setChatOpen(prev => !prev)}
            className={`lg:hidden p-2.5 rounded-xl transition-all duration-200 ${
              chatOpen
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'bg-gray-700 hover:bg-gray-600 text-white'
            }`}
          >
            <MessageCircle className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}

interface ChatPanelProps {
  messages: ChatMessage[];
  inputText: string;
  setInputText: (text: string) => void;
  onSend: () => void;
  connectionState: ConnectionState;
}

function ChatPanel({ messages, inputText, setInputText, onSend, connectionState }: ChatPanelProps) {
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            {connectionState === 'idle'
              ? 'Start a chat to begin messaging'
              : connectionState === 'searching'
              ? 'Finding someone to chat with...'
              : 'Say hello!'}
          </div>
        )}
        {messages.map(msg => (
          <div
            key={msg.id}
            className={`flex ${msg.sender === 'me' ? 'justify-end' : msg.sender === 'stranger' ? 'justify-start' : 'justify-center'}`}
          >
            {msg.sender === 'system' ? (
              <div className="text-xs text-gray-500 bg-gray-800/50 px-3 py-1.5 rounded-full">
                {msg.text}
              </div>
            ) : (
              <div
                className={`max-w-[80%] px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${
                  msg.sender === 'me'
                    ? 'bg-emerald-500 text-white rounded-br-md'
                    : 'bg-gray-700 text-gray-100 rounded-bl-md'
                }`}
              >
                {msg.text}
              </div>
            )}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>

      <div className="p-3 border-t border-gray-800">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={connectionState === 'connected' ? 'Type a message...' : 'Connect to start chatting'}
            disabled={connectionState !== 'connected'}
            className="flex-1 bg-gray-800 text-white text-sm rounded-xl px-4 py-2.5 outline-none border border-gray-700 focus:border-emerald-500/50 transition-colors placeholder:text-gray-500 disabled:opacity-40 disabled:cursor-not-allowed"
          />
          <button
            onClick={onSend}
            disabled={connectionState !== 'connected' || !inputText.trim()}
            className="p-2.5 bg-emerald-500 hover:bg-emerald-400 rounded-xl transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed active:scale-95"
          >
            <Send className="w-4 h-4 text-white" />
          </button>
        </div>
      </div>
    </>
  );
}

export default App;
