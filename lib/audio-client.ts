'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

// ===========================================================================
// Shared
// ===========================================================================

type IceServer = { urls: string | string[]; username?: string; credential?: string };

/** Non-trickle ICE: wait for candidates so one offer/answer round-trip is enough. */
function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number = 3000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }
    function onChange() {
      if (pc.iceGatheringState === 'complete') done();
    }
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/** Level 0..1 of a live media stream, for a meter. */
function useLevelMeter(stream: MediaStream | null) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream) {
      setLevel(0);
      return;
    }
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx: AudioContext = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let peak = 0;
      for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i] - 128));
      setLevel(Math.min(1, peak / 90));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      ctx.close();
    };
  }, [stream]);
  return level;
}

async function getMicrophone(): Promise<MediaStream> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error(window.isSecureContext ? 'This browser cannot access a microphone.' : 'The microphone needs HTTPS — open the console through your Cloudflare Tunnel address.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err: any) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      throw new Error('Microphone permission was denied. Allow it in the browser’s site settings.');
    }
    if (err && err.name === 'NotFoundError') throw new Error('No microphone was found on this device.');
    throw new Error('Could not open the microphone.');
  }
}

// ===========================================================================
// Recorder (admin)
// ===========================================================================

export const MAX_RECORDING_SECONDS = 180;

function pickRecorderMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export type Recording = { blob: Blob; url: string; seconds: number };

export function useRecorder() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Recording | null>(null);
  const [error, setError] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const level = useLevelMeter(recording ? stream : null);

  const releaseMic = useCallback((s: MediaStream | null) => {
    if (s) s.getTracks().forEach((t) => t.stop());
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, []);

  const start = useCallback(async () => {
    setError('');
    if (typeof MediaRecorder === 'undefined') {
      setError('This browser cannot record audio.');
      return;
    }
    let mic: MediaStream;
    try {
      mic = await getMicrophone();
    } catch (err: any) {
      setError(err.message);
      return;
    }
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);

    const mime = pickRecorderMime();
    const recorder = new MediaRecorder(mic, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const seconds = Math.max(0.5, (Date.now() - startedAtRef.current) / 1000);
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mime || 'audio/webm' });
      setResult({ blob, url: URL.createObjectURL(blob), seconds });
      setRecording(false);
      releaseMic(mic);
      setStream(null);
    };

    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setStream(mic);
    setElapsed(0);
    setRecording(true);
    recorder.start(250);
  }, [releaseMic, result]);

  useEffect(() => {
    if (!recording) return;
    const interval = setInterval(() => {
      const seconds = (Date.now() - startedAtRef.current) / 1000;
      setElapsed(seconds);
      if (seconds >= MAX_RECORDING_SECONDS) stop();
    }, 200);
    return () => clearInterval(interval);
  }, [recording, stop]);

  const discard = useCallback(() => {
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
    setElapsed(0);
  }, [result]);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, []);

  return { start, stop, discard, recording, elapsed, level, result, error };
}

/** Uploads a recording and broadcasts it. */
export async function sendClip(recording: Recording, title: string, target: string) {
  const form = new FormData();
  const ext = recording.blob.type.indexOf('mp4') !== -1 ? 'm4a' : recording.blob.type.indexOf('ogg') !== -1 ? 'ogg' : 'webm';
  form.append('file', recording.blob, 'announcement.' + ext);
  form.append('title', title);
  form.append('target', target);
  form.append('duration', String(Math.round(recording.seconds * 10) / 10));

  try {
    const res = await fetch('/api/admin/audio/clips', { method: 'POST', body: form, credentials: 'same-origin' });
    const payload = await res.json().catch(() => ({}));
    if (res.status === 401) window.location.href = '/login?reason=expired';
    if (!res.ok) return { data: null, error: { message: payload.error || 'Upload failed.', status: res.status } };
    return { data: payload as { id: string; reached: number }, error: null };
  } catch {
    return { data: null, error: { message: 'Network error — the recording was not sent.', status: 0 } };
  }
}

// ===========================================================================
// Live mic (admin side)
// ===========================================================================

export type LivePeer = { display_uuid: string; display_id: string; state: string; online?: boolean };

type PeerRuntime = { pc: RTCPeerConnection; offeredAt: number; reported: string | null };

const CONNECT_TIMEOUT_MS = 15000;

/**
 * Runs a live mic session from the admin browser: one WebRTC connection per
 * display, offers/answers exchanged through the API, a 1s check-in that keeps
 * the session alive, and per-display connection state for the UI.
 */
export function useLiveBroadcast() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [peers, setPeers] = useState<LivePeer[]>([]);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [startedAt, setStartedAt] = useState(0);

  const runtimesRef = useRef<Map<string, PeerRuntime>>(new Map());
  const iceRef = useRef<IceServer[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<string | null>(null);
  const level = useLevelMeter(stream && !muted ? stream : null);

  const cleanup = useCallback(() => {
    runtimesRef.current.forEach((r) => r.pc.close());
    runtimesRef.current = new Map();
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    sessionRef.current = null;
    setStream(null);
    setSessionId(null);
    setPeers([]);
    setMuted(false);
  }, []);

  /** Creates (or recreates) the connection and offer for one display. */
  const offerTo = useCallback(async (displayUuid: string) => {
    const id = sessionRef.current;
    const mic = streamRef.current;
    if (!id || !mic) return null;

    const existing = runtimesRef.current.get(displayUuid);
    if (existing) existing.pc.close();

    const pc = new RTCPeerConnection({ iceServers: iceRef.current });
    mic.getAudioTracks().forEach((track) => pc.addTrack(track, mic));
    const runtime: PeerRuntime = { pc, offeredAt: Date.now(), reported: null };
    runtimesRef.current.set(displayUuid, runtime);

    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    return { display_uuid: displayUuid, sdp: (pc.localDescription && pc.localDescription.sdp) || offer.sdp || '' };
  }, []);

  const start = useCallback(async (nextTitle: string, target: string) => {
    setError('');
    setStarting(true);
    let mic: MediaStream;
    try {
      mic = await getMicrophone();
    } catch (err: any) {
      setError(err.message);
      setStarting(false);
      return false;
    }

    const { data, error: apiError } = await api<{ id: string; iceServers: IceServer[]; peers: LivePeer[] }>('POST', '/api/admin/audio/live', { title: nextTitle, target });
    if (!data) {
      mic.getTracks().forEach((t) => t.stop());
      setError(apiError ? apiError.message : 'Could not start the live mic.');
      setStarting(false);
      return false;
    }

    iceRef.current = data.iceServers;
    streamRef.current = mic;
    sessionRef.current = data.id;
    setStream(mic);
    setSessionId(data.id);
    setTitle(nextTitle);
    setPeers(data.peers);
    setStartedAt(Date.now());

    const offers = (await Promise.all(data.peers.map((p) => offerTo(p.display_uuid)))).filter(Boolean) as { display_uuid: string; sdp: string }[];
    if (offers.length > 0) await api('POST', '/api/admin/audio/live/' + data.id + '/offers', { offers });
    setStarting(false);
    return true;
  }, [offerTo]);

  const stop = useCallback(async () => {
    const id = sessionRef.current;
    cleanup();
    if (id) await api('POST', '/api/admin/audio/' + id + '/stop');
  }, [cleanup]);

  const toggleMute = useCallback(() => {
    const mic = streamRef.current;
    if (!mic) return;
    const next = !muted;
    mic.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  }, [muted]);

  // Check-in loop: keeps the session alive, applies answers, offers to late
  // joiners and re-joiners, and reports connection results.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    const tick = async () => {
      const { data, error: apiError } = await api<{ peers: (LivePeer & { answer_sdp: string | null })[] }>('GET', '/api/admin/audio/live/' + sessionId);
      if (cancelled) return;
      if (apiError && apiError.status === 410) {
        setError('The live session was ended.');
        cleanup();
        return;
      }
      if (!data) return;

      const seen = new Set<string>();
      const unique = data.peers.filter((p) => (seen.has(p.display_uuid) ? false : (seen.add(p.display_uuid), true)));

      const newOffers: { display_uuid: string; sdp: string }[] = [];
      const reports: { display_uuid: string; state: string }[] = [];

      for (const peer of unique) {
        const runtime = runtimesRef.current.get(peer.display_uuid);

        if (peer.state === 'pending') {
          const offer = await offerTo(peer.display_uuid);
          if (offer) newOffers.push(offer);
          continue;
        }

        if (!runtime) continue;
        const pc = runtime.pc;

        if (peer.answer_sdp && pc.signalingState === 'have-local-offer') {
          try {
            await pc.setRemoteDescription({ type: 'answer', sdp: peer.answer_sdp });
          } catch {
            runtime.reported = 'failed';
            reports.push({ display_uuid: peer.display_uuid, state: 'failed' });
          }
        }

        const connected = pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
        const failed =
          pc.connectionState === 'failed' ||
          pc.iceConnectionState === 'failed' ||
          (!connected && Date.now() - runtime.offeredAt > CONNECT_TIMEOUT_MS);

        if (connected && runtime.reported !== 'connected') {
          runtime.reported = 'connected';
          reports.push({ display_uuid: peer.display_uuid, state: 'connected' });
        } else if (failed && runtime.reported !== 'failed' && !connected) {
          runtime.reported = 'failed';
          reports.push({ display_uuid: peer.display_uuid, state: 'failed' });
        }
      }

      if (newOffers.length > 0) await api('POST', '/api/admin/audio/live/' + sessionId + '/offers', { offers: newOffers });
      if (reports.length > 0) await api('PATCH', '/api/admin/audio/live/' + sessionId + '/peers', { updates: reports });

      setPeers(
        unique.map((p) => {
          const runtime = runtimesRef.current.get(p.display_uuid);
          return { ...p, state: runtime && runtime.reported ? runtime.reported : p.state };
        })
      );
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionId, offerTo, cleanup]);

  // Leaving the page ends the session for everyone.
  useEffect(() => {
    const onUnload = () => {
      const id = sessionRef.current;
      if (id) navigator.sendBeacon && navigator.sendBeacon('/api/admin/audio/' + id + '/stop');
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      onUnload();
      runtimesRef.current.forEach((r) => r.pc.close());
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return { sessionId, title, peers, level, muted, starting, error, startedAt, start, stop, toggleMute, clearError: () => setError('') };
}

// ===========================================================================
// Display side
// ===========================================================================

const PLAYED_KEY = 'yhack26.playedClips';

function readPlayed(): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(PLAYED_KEY) || '[]');
  } catch {
    return [];
  }
}

function markPlayed(id: string) {
  try {
    const list = readPlayed().filter((x) => x !== id);
    list.push(id);
    window.localStorage.setItem(PLAYED_KEY, JSON.stringify(list.slice(-50)));
  } catch {
    // ignore
  }
}

type AudioCheck = {
  clip: { id: string; title: string; url: string; duration_seconds: number; sent_at: string } | null;
  live: { id: string; title: string; state: string; offer_sdp: string | null; ice_servers: IceServer[] } | null;
};

export type DisplayAudioState = {
  /** What is audible right now. */
  playing: { kind: 'clip' | 'live'; title: string } | null;
  /** An announcement this screen can't play because sound is locked. */
  blocked: { kind: 'clip' | 'live'; title: string } | null;
};

/**
 * Plays audio broadcasts on a paired display. Browsers only allow sound after
 * someone has interacted with the page, so `soundUnlocked` gates playback;
 * a clip that arrives while locked waits (until it expires) rather than being
 * silently marked as heard.
 */
export function useDisplayAudio(paired: boolean, soundUnlocked: boolean): DisplayAudioState {
  const [check, setCheck] = useState<AudioCheck>({ clip: null, live: null });
  const [playing, setPlaying] = useState<DisplayAudioState['playing']>(null);

  const clipAudioRef = useRef<HTMLAudioElement | null>(null);
  const clipIdRef = useRef<string | null>(null);
  const liveAudioRef = useRef<HTMLAudioElement | null>(null);
  const pcRef = useRef<{ broadcastId: string; offer: string; pc: RTCPeerConnection } | null>(null);
  const rejoinAtRef = useRef<Record<string, number>>({});
  const rejoinRef = useRef<string | null>(null);

  // ---------------------------------------------------------------- polling
  useEffect(() => {
    if (!paired) return;
    let cancelled = false;
    const poll = async () => {
      const rejoin = rejoinRef.current;
      rejoinRef.current = null;
      const { data } = await api<AudioCheck>('POST', '/api/display/audio', rejoin ? { rejoin } : {});
      if (!cancelled && data) setCheck(data);
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [paired]);

  // ---------------------------------------------------------------- live mic
  const closeLive = useCallback(() => {
    if (pcRef.current) pcRef.current.pc.close();
    pcRef.current = null;
    if (liveAudioRef.current) {
      liveAudioRef.current.pause();
      liveAudioRef.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    const live = check.live;
    if (!live) {
      if (pcRef.current) closeLive();
      return;
    }

    const current = pcRef.current;
    if (live.offer_sdp && (!current || current.broadcastId !== live.id || current.offer !== live.offer_sdp)) {
      closeLive();
      const pc = new RTCPeerConnection({ iceServers: live.ice_servers });
      pcRef.current = { broadcastId: live.id, offer: live.offer_sdp, pc };
      pc.ontrack = (event) => {
        if (!liveAudioRef.current) liveAudioRef.current = new Audio();
        liveAudioRef.current.srcObject = event.streams[0] || new MediaStream([event.track]);
        liveAudioRef.current.play().catch(() => undefined);
      };
      (async () => {
        try {
          await pc.setRemoteDescription({ type: 'offer', sdp: live.offer_sdp as string });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await waitForIceGathering(pc);
          await api('POST', '/api/display/audio/answer', { broadcast_id: live.id, sdp: (pc.localDescription && pc.localDescription.sdp) || answer.sdp });
        } catch {
          closeLive();
        }
      })();
      return;
    }

    // A session is on air but this screen has no connection to it (it reloaded,
    // or its connection failed): ask for a fresh offer, at most every 10s.
    const connectionDead = !current || current.broadcastId !== live.id || current.pc.connectionState === 'failed' || current.pc.connectionState === 'closed';
    if (!live.offer_sdp && live.state !== 'pending' && connectionDead) {
      const last = rejoinAtRef.current[live.id] || 0;
      if (Date.now() - last > 10000) {
        rejoinAtRef.current[live.id] = Date.now();
        rejoinRef.current = live.id;
      }
    }
  }, [check.live, closeLive]);

  useEffect(() => {
    if (liveAudioRef.current) liveAudioRef.current.muted = !soundUnlocked;
    if (soundUnlocked && liveAudioRef.current && liveAudioRef.current.srcObject) liveAudioRef.current.play().catch(() => undefined);
  }, [soundUnlocked, check.live]);

  // ---------------------------------------------------------------- clips
  const stopClip = useCallback(() => {
    if (clipAudioRef.current) {
      clipAudioRef.current.pause();
      clipAudioRef.current.src = '';
    }
    clipAudioRef.current = null;
    clipIdRef.current = null;
  }, []);

  useEffect(() => {
    const clip = check.clip;
    const liveActive = Boolean(check.live && pcRef.current);

    // Cancelled or expired while playing → stop.
    if (clipIdRef.current && (!clip || clip.id !== clipIdRef.current)) stopClip();

    if (!clip || !soundUnlocked || liveActive) return;
    if (clipIdRef.current === clip.id) return;
    if (readPlayed().indexOf(clip.id) !== -1) return;

    const audio = new Audio(clip.url);
    clipAudioRef.current = audio;
    clipIdRef.current = clip.id;
    audio.onended = () => {
      markPlayed(clip.id);
      stopClip();
      setPlaying(null);
    };
    audio.onerror = () => {
      stopClip();
      setPlaying(null);
    };
    audio
      .play()
      .then(() => {
        markPlayed(clip.id);
        setPlaying({ kind: 'clip', title: clip.title });
      })
      .catch(() => {
        // Autoplay refused after all — leave it unplayed so it retries.
        stopClip();
      });
  }, [check.clip, check.live, soundUnlocked, stopClip]);

  // A live mic interrupts a clip.
  useEffect(() => {
    if (check.live && clipIdRef.current) {
      stopClip();
      setPlaying(null);
    }
  }, [check.live, stopClip]);

  useEffect(() => () => {
    stopClip();
    closeLive();
  }, [stopClip, closeLive]);

  // ---------------------------------------------------------------- summary
  const liveOnAir = check.live;
  const clipWaiting = check.clip && readPlayed().indexOf(check.clip.id) === -1 ? check.clip : null;

  let state: DisplayAudioState = { playing: null, blocked: null };
  if (liveOnAir) {
    state = soundUnlocked ? { playing: { kind: 'live', title: liveOnAir.title }, blocked: null } : { playing: null, blocked: { kind: 'live', title: liveOnAir.title } };
  } else if (playing) {
    state = { playing, blocked: null };
  } else if (clipWaiting && !soundUnlocked) {
    state = { playing: null, blocked: { kind: 'clip', title: clipWaiting.title } };
  }
  return state;
}
