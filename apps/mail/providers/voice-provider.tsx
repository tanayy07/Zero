import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { useSession } from '@/lib/auth-client';
import type { ReactNode } from 'react';
import { toast } from 'sonner';

interface VoiceContextType {
  status: 'idle' | 'recording' | 'processing' | 'speaking' | 'connected';
  isInitializing: boolean;
  isSpeaking: boolean;
  hasPermission: boolean;
  lastToolCall: string | null;
  isOpen: boolean;
  transcript: string;

  startConversation: (context?: any) => Promise<void>;
  endConversation: () => Promise<void>;
  requestPermission: () => Promise<boolean>;
  sendContext: (context: any) => void;
  stopRecording: () => void;
}

const VoiceContext = createContext<VoiceContextType | undefined>(undefined);

interface VoiceProviderProps {
  children: ReactNode;
  onTranscriptComplete?: (transcript: string) => void;
  onResponseReady?: (callback: (response: string) => void) => void;
}

export function VoiceProvider({
  children,
  onTranscriptComplete,
  onResponseReady,
}: VoiceProviderProps) {
  const { data: _session } = useSession();
  const [hasPermission, setHasPermission] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [_lastToolCall, _setLastToolCall] = useState<string | null>(null);
  const [isOpen, setOpen] = useState(false);
  const [status, setStatus] = useState<VoiceContextType['status']>('idle');
  const [transcript, setTranscript] = useState('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [_currentContext, setCurrentContext] = useState<any>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const requestPermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setHasPermission(true);
      return true;
    } catch {
      toast.error('Microphone access denied. Please enable microphone permissions.');
      setHasPermission(false);
      return false;
    }
  };

  const startRecording = useCallback(async () => {
    if (!streamRef.current) {
      const hasPermission = await requestPermission();
      if (!hasPermission) return;
    }

    try {
      audioChunksRef.current = [];

      const mediaRecorder = new MediaRecorder(streamRef.current!, {
        mimeType: 'audio/webm;codecs=opus',
      });

      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        setStatus('processing');
        await processAudioRecording();
      };

      mediaRecorder.start();
      setStatus('recording');
    } catch (error) {
      console.error('Error starting recording:', error);
      toast.error('Failed to start recording');
      setStatus('idle');
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const processAudioRecording = async () => {
    try {
      const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });

      // Convert blob to File object for OpenAI
      const audioFile = new File([audioBlob], 'recording.webm', { type: 'audio/webm' });

      // Send to OpenAI Whisper for transcription
      const transcription = await transcribeAudio(audioFile);
      setTranscript(transcription);

      // Call the callback to send transcript to AI chat
      if (onTranscriptComplete) {
        onTranscriptComplete(transcription);
      }

      setStatus('idle');
    } catch (error) {
      console.error('Error processing audio:', error);
      toast.error('Failed to process audio');
      setStatus('idle');
    }
  };

  const transcribeAudio = async (audioFile: File): Promise<string> => {
    try {
      // Create FormData to send the audio file
      const formData = new FormData();
      formData.append('file', audioFile);

      // Call our server endpoint with credentials
      const response = await fetch(`${import.meta.env.VITE_PUBLIC_BACKEND_URL}/voice/transcribe`, {
        method: 'POST',
        body: formData,
        credentials: 'include', // Use cookie-based auth
      });

      if (!response.ok) {
        throw new Error(`Transcription failed: ${response.statusText}`);
      }

      const data = (await response.json()) as { text: string };
      return data.text;
    } catch (error) {
      console.error('Error transcribing audio:', error);
      throw error;
    }
  };

  const speakText = async (text: string) => {
    try {
      setIsSpeaking(true);
      setStatus('speaking');

      // Use our server endpoint with credentials
      const response = await fetch(`${import.meta.env.VITE_PUBLIC_BACKEND_URL}/voice/speak`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          voice: 'alloy', // Available voices: alloy, echo, fable, onyx, nova, shimmer
          speed: 1.0,
        }),
        credentials: 'include', // Use cookie-based auth
      });

      if (!response.ok) {
        throw new Error(`TTS failed: ${response.statusText}`);
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);

      // Play the audio
      if (audioRef.current) {
        audioRef.current.pause();
      }

      audioRef.current = new Audio(audioUrl);
      audioRef.current.onended = () => {
        setIsSpeaking(false);
        setStatus('idle');
        URL.revokeObjectURL(audioUrl);
      };

      await audioRef.current.play();
    } catch (error) {
      console.error('Error speaking text:', error);
      setIsSpeaking(false);
      setStatus('idle');
      toast.error('Failed to generate speech');
    }
  };

  const startConversation = async (context?: any) => {
    if (!hasPermission) {
      const result = await requestPermission();
      if (!result) return;
    }

    try {
      setIsInitializing(true);
      setStatus('connected');
      if (context) {
        setCurrentContext(context);
      }
      setOpen(true);

      // Start recording immediately
      await startRecording();
      setIsInitializing(false);
    } catch (error) {
      console.error('Error starting conversation:', error);
      toast.error('Failed to start conversation. Please try again.');
      setIsInitializing(false);
      setStatus('idle');
    }
  };

  const endConversation = async () => {
    try {
      // Stop recording if active
      stopRecording();

      // Stop any playing audio
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }

      // Stop media stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      setCurrentContext(null);
      setStatus('idle');
      setOpen(false);
      setTranscript('');
    } catch (error) {
      console.error('Error ending conversation:', error);
      toast.error('Failed to end conversation');
    }
  };

  const sendContext = (context: any) => {
    setCurrentContext(context);
  };

  // Set up the response handler when transcript is complete
  useEffect(() => {
    if (onResponseReady) {
      onResponseReady((response: string) => {
        speakText(response);
      });
    }
  }, [onResponseReady]);

  const value: VoiceContextType = {
    status,
    isInitializing,
    isSpeaking,
    hasPermission,
    lastToolCall: _lastToolCall,
    isOpen,
    transcript,
    startConversation,
    endConversation,
    requestPermission,
    sendContext,
    stopRecording,
  };

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoice() {
  const context = useContext(VoiceContext);
  if (!context) {
    throw new Error('useVoice must be used within a VoiceProvider');
  }
  return context;
}

export { VoiceContext };
