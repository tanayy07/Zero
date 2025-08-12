import { env } from 'cloudflare:workers';
import { createAuth } from '../lib/auth';
import { Hono } from 'hono';

export const voiceRouter = new Hono<{ Bindings: typeof env }>();

// Add CORS headers
voiceRouter.use('/*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (c.req.method === 'OPTIONS') {
    return c.text('');
  }
  return next();
});

// Speech-to-text endpoint
voiceRouter.post('/transcribe', async (c) => {
  try {
    // Verify authentication using better-auth
    const auth = createAuth();
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (!session) {
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }

    // Get audio file from request
    const formData = await c.req.formData();
    const audioFile = formData.get('file') as File;

    if (!audioFile) {
      return c.json({ success: false, error: 'No audio file provided' }, 400);
    }

    // Create FormData for OpenAI
    const openAIFormData = new FormData();
    openAIFormData.append('file', audioFile);
    openAIFormData.append('model', 'whisper-1');
    openAIFormData.append('language', 'en');

    // Call OpenAI Whisper API
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: openAIFormData,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('OpenAI API error:', error);
      throw new Error(`Transcription failed: ${response.statusText}`);
    }

    const data = await response.json();

    return c.json({
      success: true,
      text: data.text,
    });
  } catch (error) {
    console.error('Transcription error:', error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Transcription failed',
      },
      500,
    );
  }
});

// Text-to-speech endpoint
voiceRouter.post('/speak', async (c) => {
  try {
    // Verify authentication using better-auth
    const auth = createAuth();
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (!session) {
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }

    // Parse request body
    const { text, voice = 'alloy', speed = 1.0 } = await c.req.json();

    if (!text) {
      return c.json({ success: false, error: 'No text provided' }, 400);
    }

    // Call OpenAI TTS API
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice,
        speed,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('OpenAI TTS API error:', error);
      throw new Error(`TTS failed: ${response.statusText}`);
    }

    // Get the audio data
    const audioBuffer = await response.arrayBuffer();

    // Return audio file
    return new Response(audioBuffer, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.byteLength.toString(),
      },
    });
  } catch (error) {
    console.error('TTS error:', error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'TTS failed',
      },
      500,
    );
  }
});
