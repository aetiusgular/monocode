import type { AudioCapture, CapturedAudio, OpenCapture } from "./recorder";
import { mixToMono } from "./wav";

/** The parts of the browser this needs, so tests can pass fakes. */
export type WebAudioEnv = {
  mediaDevices: Pick<MediaDevices, "getUserMedia"> | undefined;
  createContext: () => AudioContext;
};

const BUFFER_SIZE = 4096;

function browserEnv(): WebAudioEnv {
  return {
    mediaDevices:
      typeof navigator === "undefined" ? undefined : navigator.mediaDevices,
    createContext: () => new AudioContext(),
  };
}

/**
 * Opens the microphone with getUserMedia and collects mono float samples at
 * the device rate through a ScriptProcessorNode. ScriptProcessorNode is
 * deprecated, but an AudioWorklet module needs a script URL the app's CSP
 * (`script-src 'self'`) would have to allow. WebKit still supports it.
 *
 * In MonoCode, WKWebView's own permission question is answered by wry, which
 * grants every media capture request. macOS then asks the user once, using
 * NSMicrophoneUsageDescription from the app's Info.plist.
 */
export function webAudioCapture(env: WebAudioEnv = browserEnv()): OpenCapture {
  return async (maxSeconds) => {
    if (!env.mediaDevices?.getUserMedia) {
      throw new Error("This window cannot use the microphone.");
    }
    const stream = await env.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const stopTracks = () => {
      for (const track of stream.getTracks()) track.stop();
    };
    let context: AudioContext;
    try {
      context = env.createContext();
    } catch (error) {
      stopTracks();
      throw error;
    }
    const sampleRate = context.sampleRate;
    const maxSamples = Math.ceil(maxSeconds * sampleRate);
    const chunks: Float32Array[] = [];
    let collected = 0;
    let open = true;

    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1);
    processor.onaudioprocess = (event) => {
      if (!open || collected >= maxSamples) return;
      const input = event.inputBuffer;
      const channels: Float32Array[] = [];
      for (let c = 0; c < input.numberOfChannels; c += 1) {
        channels.push(input.getChannelData(c));
      }
      // getChannelData returns a view the engine reuses; mixToMono copies.
      const mono = mixToMono(channels).subarray(0, maxSamples - collected);
      chunks.push(mono);
      collected += mono.length;
    };
    source.connect(processor);
    // WebKit only runs a ScriptProcessorNode that is connected onward. The
    // output buffer is never written, so this plays silence.
    processor.connect(context.destination);
    if (context.state === "suspended") {
      await context.resume().catch(() => undefined);
    }

    const release = () => {
      if (!open) return;
      open = false;
      processor.onaudioprocess = null;
      try {
        source.disconnect();
        processor.disconnect();
      } catch {
        // Already disconnected.
      }
      stopTracks();
      void context.close().catch(() => undefined);
    };

    const capture: AudioCapture = {
      finish: (): CapturedAudio => {
        release();
        return { chunks, sampleRate };
      },
      cancel: () => {
        release();
        chunks.length = 0;
      },
    };
    return capture;
  };
}
