'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {requestJson, errorMessage} from '@/lib/api-client';
import {recordingToWav} from '@/lib/audio';
import {advanceVad, initialVadState, VOICE_MIN_SPEECH_MS, VOICE_SAMPLE_MS, type VadState} from '@/lib/continuous-voice-vad';
import {completeVoiceGroup, nextEndDrainAction, parseVoiceGroupPartId, remainingVoiceTurnQuietMs, voiceGroupPartId, voiceTurnNeedsContinuation} from '@/lib/continuous-voice-drain';
import {clearPendingVoice, listPendingVoice, pendingVoiceKey, removePendingVoice, savePendingVoice, type PendingVoiceTurn} from '@/lib/continuous-voice-recovery';

export type ContinuousVoiceStatus = 'idle' | 'connecting' | 'listening' | 'muted' | 'error';

type Options = {
  scope?: string;
  onFinalUtterance: (text: string, turnId: string) => void | Promise<void>;
  onError?: (message: string) => void;
};

type Clip = {id: string; blob: Blob};
type TurnPart = {text?: string; blob?: Blob};
type PendingTurn = {id: string; texts: string[]; parts: TurnPart[]; timer: ReturnType<typeof setTimeout> | null};
type Segment = {
  recorder: MediaRecorder;
  chunks: Blob[];
  bytes: number;
  speechMs: number;
  discard: boolean;
};
type Session = {
  scope: string;
  closed: boolean;
  ending: boolean;
  muted: boolean;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  monitor: GainNode;
  samples: Float32Array<ArrayBuffer>;
  timer: ReturnType<typeof setInterval> | null;
  vad: VadState;
  segment: Segment | null;
  stopping: boolean;
  queue: Clip[];
  processing: boolean;
  request: AbortController | null;
  version: number;
  delivered: Set<string>;
  pendingTurn: PendingTurn | null;
  blocked: boolean;
  lastVoiceAt: number;
  delivering: boolean;
  saving: number;
  drainPromise: Promise<void>;
  resolveDrain: () => void;
};

const MAX_RECORDED_BYTES = 5_500_000;
const MAX_WAITING_CLIPS = 4;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') return '麦克风权限未开启。请在浏览器地址栏允许麦克风，然后重试。';
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') return '没有找到可用的麦克风，请连接设备后重试。';
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') return '麦克风正被其他应用占用，请关闭占用后重试。';
  }
  return '无法启用麦克风：' + errorMessage(error);
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('录音读取失败，请重试。'));
    reader.readAsDataURL(blob);
  });
}

/** Automatic turn-taking over the existing ASR endpoint. This is segmented ASR, not low-latency Realtime. */
export function useContinuousVoice({scope, onFinalUtterance, onError}: Options) {
  const [status, setStatus] = useState<ContinuousVoiceStatus>('idle');
  const [error, setError] = useState('');
  const [partial, setPartial] = useState('');
  const unsentForReviewRef = useRef('');
  const [muted, setMuted] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const sessionRef = useRef<Session | null>(null);
  const sequence = useRef(0);
  const startingRef = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  const finalCallback = useRef(onFinalUtterance);
  const errorCallback = useRef(onError);
  const shutdownRef = useRef<(message?: string) => void>(() => {});
  const memoryPending = useRef<PendingVoiceTurn[]>([]);
  const retryController = useRef<AbortController | null>(null);
  const retryPromise = useRef<Promise<void> | null>(null);
  const activeScope = useRef(scope);

  const pendingItems = useCallback(async (forScope: string) => {
    let stored: PendingVoiceTurn[] = [];
    try { stored = await listPendingVoice(forScope); } catch { /* Keep in-memory recovery available. */ }
    const merged = new Map(stored.map(item => [item.key, item]));
    for (const item of memoryPending.current) if (item.scope === forScope) merged.set(item.key, item);
    return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, []);

  const refreshPending = useCallback(async (forScope: string) => {
    const items = await pendingItems(forScope);
    if (mounted.current && activeScope.current === forScope) setPendingCount(items.length);
  }, [pendingItems]);

  useEffect(() => {
    finalCallback.current = onFinalUtterance;
    errorCallback.current = onError;
  }, [onFinalUtterance, onError]);

  function report(message: string) {
    if (!mounted.current) return;
    setError(message);
    try { errorCallback.current?.(message); } catch { /* UI callbacks must not keep capture alive. */ }
  }

  function updatePartial(value: string) {
    if (mounted.current) setPartial(value);
  }

  async function holdForRetry(session: Session, id: string, value: {blob?: Blob; text?: string}): Promise<boolean> {
    session.saving++;
    const item: PendingVoiceTurn = {key: pendingVoiceKey(session.scope, id), scope: session.scope, id, blob: value.blob, text: value.text, size: value.blob?.size || 0, createdAt: new Date().toISOString()};
    memoryPending.current = [...memoryPending.current.filter(old => old.key !== item.key), item];
    if (mounted.current && activeScope.current === item.scope) setPendingCount(count => Math.max(count, memoryPending.current.filter(old => old.scope === item.scope).length));
    try {
      if (!session.scope) return false;
      await savePendingVoice(item);
      await refreshPending(session.scope);
      return true;
    } catch {
      await refreshPending(session.scope);
      return false;
    } finally {
      session.saving--;
      finishEnding(session);
    }
  }

  async function transcribeBlob(blob: Blob, signal: AbortSignal): Promise<string> {
    const wav = await recordingToWav(blob);
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    const audio = await blobDataUrl(wav);
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    const result = await requestJson<{text: string}>('/api/qwen/asr', {audio}, {signal, retries: 0, timeoutMs: 45000});
    const text = result.text?.trim();
    if (!text) throw new Error('没有识别到清晰语音，请再说一次。');
    return text;
  }

  function releaseCapture(session: Session) {
    if (session.timer) { clearInterval(session.timer); session.timer = null; }
    session.stream.getTracks().forEach(track => { track.onended = null; track.onmute = null; track.stop(); });
    session.source.disconnect();
    session.analyser.disconnect();
    session.monitor.disconnect();
    void session.context.close().catch(() => {});
  }

  function shutdown(message?: string) {
    sequence.current++;
    startingRef.current = null;
    retryController.current?.abort();
    const session = sessionRef.current;
    const unsent = session?.pendingTurn?.texts.join(' ').trim();
    sessionRef.current = null;
    if (session) {
      session.closed = true;
      session.version++;
      session.request?.abort();
      session.queue.length = 0;
      if (session.pendingTurn?.timer) clearTimeout(session.pendingTurn.timer);
      session.pendingTurn = null;
      if (session.segment) {
        session.segment.discard = true;
        const recorder = session.segment.recorder;
        session.segment = null;
        if (recorder.state !== 'inactive') {
          try { recorder.stop(); } catch { /* Track may already be gone. */ }
        }
      }
      releaseCapture(session);
      session.resolveDrain();
    }
    if (mounted.current) {
      if (unsent && !session?.blocked) { updatePartial(unsent); unsentForReviewRef.current = unsent; }
      else if (session?.blocked) updatePartial('');
      setMuted(false);
      setStatus(message ? 'error' : 'idle');
      if (message) report(message);
      else setError('');
    }
  }

  function stopSegment(session: Session, speechMs: number, discard = false) {
    const segment = session.segment;
    if (!segment) return;
    segment.speechMs = speechMs;
    segment.discard = discard;
    session.segment = null;
    session.stopping = true;
    if (segment.recorder.state !== 'inactive') {
      try { segment.recorder.stop(); } catch {
        session.stopping = false;
        if (session.ending) {
          const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
          void holdForRetry(session, id, {blob: new Blob(segment.chunks, {type: segment.recorder.mimeType.split(';')[0] || 'audio/webm'})}).then(saved => report(saved ? '末句录音未能完整结束，已暂存在此工作区，可重试或下载。' : '末句录音未能完整结束，仅在当前页面暂存，请先下载。'));
        }
      }
    }
  }

  function finishEnding(session: Session) {
    const action = nextEndDrainAction({ending: session.ending, closed: session.closed, recording: !!session.segment, recorderStopping: session.stopping, recognizing: session.processing, queuedClips: session.queue.length, delivering: session.delivering, saving: session.saving, pendingText: !!session.pendingTurn});
    if (action === 'deliver') { void (session.blocked ? persistBlocked(session) : deliverPending(session)); return; }
    if (action !== 'finish') return;
    session.closed = true;
    if (sessionRef.current === session) sessionRef.current = null;
    session.resolveDrain();
  }

  async function persistBlocked(session: Session) {
    if (session.closed || sessionRef.current !== session) return;
    const pending = session.pendingTurn;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    updatePartial('');
    unsentForReviewRef.current = '';
    session.pendingTurn = null;
    session.delivering = true;
    try {
      // Keep every recognized fragment and failed recording in order. A retry
      // must reconstruct the WHOLE turn; submitting only the surviving words
      // would silently change the user's instruction.
      const count = pending.parts.length;
      const saved = await Promise.all(pending.parts.map((part, index) =>
        holdForRetry(session, voiceGroupPartId(pending.id, count, index), part)));
      report(saved.every(Boolean)
        ? '有一段语音没有识别清楚，整句话已暂存；重试成功后才会一起提交。'
        : '有一段语音没有识别清楚，整句话仅在当前页面暂存；请先下载，再刷新。');
    } finally {
      session.delivering = false;
      finishEnding(session);
    }
  }

  async function deliverPending(session: Session) {
    if (session.closed || sessionRef.current !== session) return;
    if (!session.ending && (session.blocked || session.vad.speaking || session.vad.consecutiveVoice || session.segment || session.stopping || session.processing || session.queue.length)) {
      armPending(session);
      return;
    }
    const pending = session.pendingTurn;
    if (!pending) return;
    const text = pending.texts.join(' ').trim();
    if (voiceTurnNeedsContinuation(text)) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = null;
      updatePartial(text);
      if (session.ending) {
        unsentForReviewRef.current = text;
        session.pendingTurn = null;
        report('最后一句听起来还没说完，已留在界面，请核对后再发送。');
        finishEnding(session);
      }
      return;
    }
    if (pending.timer) clearTimeout(pending.timer);
    session.pendingTurn = null;
    session.delivering = true;
    try {
      await finalCallback.current(text, pending.id);
      updatePartial('');
      unsentForReviewRef.current = '';
    } catch (cause) {
      if (!session.closed) {
        const saved = await holdForRetry(session, pending.id, {text});
        updatePartial(saved ? '' : text);
        unsentForReviewRef.current = saved ? '' : text;
        report((saved ? '识别文字已暂存在此工作区，可重试或下载：' : '识别文字仅在当前页面暂存，请先下载：') + errorMessage(cause));
      }
    } finally {
      session.delivering = false;
      finishEnding(session);
    }
  }

  function armPending(session: Session) {
    const pending = session.pendingTurn;
    if (session.closed) return;
    if (session.ending) { finishEnding(session); return; }
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    if (session.blocked || session.vad.speaking || session.vad.consecutiveVoice || session.segment || session.stopping || session.processing || session.queue.length) return;
    const delay = remainingVoiceTurnQuietMs(pending.texts.join(' '), session.lastVoiceAt, performance.now());
    if (!Number.isFinite(delay)) return;
    pending.timer = setTimeout(() => { void deliverPending(session); }, delay);
  }

  function stageFinal(session: Session, text: string, id: string) {
    if (session.delivered.has(id)) return;
    session.delivered.add(id);
    if (session.pendingTurn) {
      session.pendingTurn.texts.push(text);
      session.pendingTurn.parts.push({text});
    } else session.pendingTurn = {id, texts: [text], parts: [{text}], timer: null};
    updatePartial(session.pendingTurn.texts.join(' ').trim());
    armPending(session);
  }

  function stageFailed(session: Session, clip: Clip) {
    if (!session.pendingTurn) session.pendingTurn = {id: clip.id, texts: [], parts: [], timer: null};
    session.pendingTurn.parts.push({blob: clip.blob});
    session.blocked = true;
    updatePartial('');
    unsentForReviewRef.current = '';
    if (session.pendingTurn.timer) clearTimeout(session.pendingTurn.timer);
    session.pendingTurn.timer = null;
    if (!session.ending) {
      session.ending = true;
      const spokenMs = session.vad.speaking ? Math.max(VOICE_MIN_SPEECH_MS, session.vad.lastVoiceAt - session.vad.startedAt) : 0;
      if (session.segment) stopSegment(session, spokenMs, !session.vad.speaking);
      releaseCapture(session);
      if (mounted.current) { setMuted(false); setStatus('error'); }
    }
    report('一段语音未能识别，已停止通话并保留整句话；暂不会执行残缺指令。');
  }

  async function processQueue(session: Session) {
    if (session.processing || session.closed) return;
    session.processing = true;
    try {
      while (!session.closed && session.queue.length) {
        const clip = session.queue.shift()!;
        const version = session.version;
        const controller = new AbortController();
        session.request = controller;
        try {
          const text = await transcribeBlob(clip.blob, controller.signal);
          if (session.closed || version !== session.version || session.delivered.has(clip.id)) continue;
          stageFinal(session, text, clip.id);
        } catch (cause) {
          if (!session.closed && version === session.version && !controller.signal.aborted) {
            stageFailed(session, clip);
            report('语音识别未完成，整句话暂不执行：' + errorMessage(cause));
          }
        } finally {
          if (session.request === controller) session.request = null;
          armPending(session);
        }
      }
    } finally {
      session.processing = false;
      if (!session.closed && session.queue.length) void processQueue(session);
      else armPending(session);
      finishEnding(session);
    }
  }

  function startSegment(session: Session) {
    if (session.closed || session.ending || session.muted || session.segment || session.stopping) return;
    try {
      const mimeType = MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(session.stream, mimeType ? {mimeType} : undefined);
      const segment: Segment = {recorder, chunks: [], bytes: 0, speechMs: 0, discard: false};
      session.segment = segment;
      recorder.ondataavailable = event => {
        if (session.closed || !event.data.size) return;
        segment.chunks.push(event.data);
        segment.bytes += event.data.size;
        if (segment.bytes > MAX_RECORDED_BYTES && session.segment === segment) {
          session.vad = initialVadState(session.vad.noiseFloor);
          stopSegment(session, 0, true);
          report('这句话的录音过大，已跳过。请分成较短的句子再说。');
        }
      };
      recorder.onerror = () => shutdown('录音被中断，连续语音已结束。请重新开始。');
      recorder.onstop = () => {
        session.stopping = false;
        if (session.segment === segment) session.segment = null;
        if (session.closed) return;
        if (segment.discard) { armPending(session); return; }
        const blob = new Blob(segment.chunks, {type: recorder.mimeType.split(';')[0] || 'audio/webm'});
        if (segment.speechMs >= VOICE_MIN_SPEECH_MS && blob.size >= 500) {
          if (session.queue.length >= MAX_WAITING_CLIPS) {
            shutdown('语音识别暂时跟不上说话速度，连续语音已结束。请稍后重新开始。');
            return;
          }
          const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
          session.queue.push({id, blob});
          void processQueue(session);
        }
        if (session.vad.speaking && !session.ending) startSegment(session);
        armPending(session);
        finishEnding(session);
      };
      recorder.start(250);
    } catch (cause) {
      session.segment = null;
      shutdown('无法开始录音：' + errorMessage(cause));
    }
  }

  function sample(session: Session) {
    if (session.closed || session.ending || session.muted || sessionRef.current !== session) return;
    session.analyser.getFloatTimeDomainData(session.samples);
    let power = 0;
    for (let i = 0; i < session.samples.length; i++) power += session.samples[i] * session.samples[i];
    const rms = Math.sqrt(power / session.samples.length);
    const wasCandidate = session.vad.consecutiveVoice > 0;
    const result = advanceVad(session.vad, rms, performance.now());
    session.vad = result.state;
    if (result.state.speaking && result.state.lastVoiceAt) session.lastVoiceAt = result.state.lastVoiceAt;
    if (result.state.consecutiveVoice && session.pendingTurn?.timer) {
      clearTimeout(session.pendingTurn.timer);
      session.pendingTurn.timer = null;
    }
    if (wasCandidate && !result.state.consecutiveVoice && !result.state.speaking && result.event === 'none') armPending(session);
    if (result.event === 'start') {
      if (session.pendingTurn?.timer) clearTimeout(session.pendingTurn.timer);
      if (session.pendingTurn) session.pendingTurn.timer = null;
      startSegment(session);
    }
    else if (result.event === 'finish' || result.event === 'limit') stopSegment(session, result.speechMs);
  }

  async function begin(): Promise<boolean> {
    const token = ++sequence.current;
    unsentForReviewRef.current = '';
    if (mounted.current) { setError(''); setStatus('connecting'); setMuted(false); }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      if (token === sequence.current) shutdown('当前浏览器不支持连续录音，请使用新版浏览器或直接输入。');
      return false;
    }
    const AudioCtor = window.AudioContext || (window as typeof window & {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
    if (!AudioCtor) {
      if (token === sequence.current) shutdown('当前浏览器不支持音频分析，请使用新版浏览器或直接输入。');
      return false;
    }
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}, video: false});
      } catch (cause) {
        if (!(cause instanceof DOMException) || !['OverconstrainedError', 'TypeError'].includes(cause.name)) throw cause;
        stream = await navigator.mediaDevices.getUserMedia({audio: true, video: false});
      }
      if (token !== sequence.current || !mounted.current) { stream.getTracks().forEach(track => track.stop()); return false; }
      context = new AudioCtor();
      await context.resume();
      if (token !== sequence.current || !mounted.current) { stream.getTracks().forEach(track => track.stop()); await context.close(); return false; }
      if (context.state !== 'running') throw new Error('浏览器没有启动音频分析。请再点击一次开始。');
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.35;
      source.connect(analyser);
      const monitor = context.createGain();
      monitor.gain.value = 0;
      analyser.connect(monitor);
      monitor.connect(context.destination);
      let resolveDrain!: () => void;
      const drainPromise = new Promise<void>(resolve => { resolveDrain = resolve; });
      const session: Session = {scope: scope || '', closed: false, ending: false, muted: false, stream, context, source, analyser, monitor, samples: new Float32Array(new ArrayBuffer(analyser.fftSize * 4)), timer: null, vad: initialVadState(), segment: null, stopping: false, queue: [], processing: false, request: null, version: 0, delivered: new Set(), pendingTurn: null, blocked: false, lastVoiceAt: 0, delivering: false, saving: 0, drainPromise, resolveDrain};
      sessionRef.current = session;
      stream.getAudioTracks().forEach(track => {
        track.onended = () => { if (sessionRef.current === session) shutdown('麦克风连接已断开，连续语音已结束。'); };
        track.onmute = () => { if (sessionRef.current === session && !session.muted) shutdown('麦克风输入已中断，连续语音已结束。'); };
      });
      session.timer = setInterval(() => sample(session), VOICE_SAMPLE_MS);
      setStatus('listening');
      return true;
    } catch (cause) {
      stream?.getTracks().forEach(track => track.stop());
      if (context) void context.close().catch(() => {});
      if (token === sequence.current) shutdown(microphoneError(cause));
      return false;
    }
  }

  function start(): Promise<boolean> {
    if (startingRef.current) return startingRef.current;
    const existing = sessionRef.current;
    if (existing && !existing.ending && !existing.closed) return Promise.resolve(true);
    const waitToken = sequence.current;
    const wait = existing?.ending ? existing.drainPromise : retryPromise.current || Promise.resolve();
    const pending = wait.then(() => mounted.current && waitToken === sequence.current ? begin() : false);
    startingRef.current = pending;
    void pending.finally(() => { if (startingRef.current === pending) startingRef.current = null; });
    return pending;
  }

  function end(): Promise<void> {
    const session = sessionRef.current;
    if (!session) { if (startingRef.current) shutdown(); return Promise.resolve(); }
    if (session.ending || session.closed) { sequence.current++; startingRef.current = null; return session.drainPromise; }
    session.ending = true;
    sequence.current++;
    const spokenMs = session.vad.speaking ? Math.max(VOICE_MIN_SPEECH_MS, session.vad.lastVoiceAt - session.vad.startedAt) : 0;
    if (session.segment) stopSegment(session, spokenMs, !session.vad.speaking);
    releaseCapture(session);
    setMuted(false);
    setStatus('idle');
    finishEnding(session);
    return session.drainPromise;
  }

  function mute(next?: boolean) {
    const session = sessionRef.current;
    if (!session || session.closed || session.ending) return;
    const shouldMute = next ?? !session.muted;
    if (session.muted === shouldMute) return;
    session.muted = shouldMute;
    session.stream.getAudioTracks().forEach(track => { track.enabled = !session.muted; });
    session.vad = initialVadState(session.vad.noiseFloor);
    if (session.muted) stopSegment(session, 0, true);
    if (session.muted) armPending(session);
    setMuted(session.muted);
    setStatus(session.muted ? 'muted' : 'listening');
  }

  function interrupt() {
    const session = sessionRef.current;
    if (!session || session.closed || session.ending) return;
    session.version++;
    session.request?.abort();
    session.queue.length = 0;
    if (session.pendingTurn?.timer) clearTimeout(session.pendingTurn.timer);
    session.pendingTurn = null;
    updatePartial('');
    unsentForReviewRef.current = '';
    session.vad = initialVadState(session.vad.noiseFloor);
    stopSegment(session, 0, true);
    setError('');
  }

  function retryPending(): Promise<void> {
    if (retryPromise.current) return retryPromise.current;
    const forScope = scope || '';
    if (!forScope) { report('尚无工作区，无法安全重试语音暂存。'); return Promise.resolve(); }
    if (sessionRef.current) { report('请先结束当前通话并等待识别完成，再重试暂存语音。'); return Promise.resolve(); }
    const controller = new AbortController();
    retryController.current = controller;
    const run = (async () => {
      const items = await pendingItems(forScope);
      const handledGroups = new Set<string>();
      for (const item of items) {
        if (controller.signal.aborted || activeScope.current !== forScope) break;
        const groupPart = parseVoiceGroupPartId(item.id);
        if (groupPart) {
          if (handledGroups.has(groupPart.groupId)) continue;
          handledGroups.add(groupPart.groupId);
          const group = items.filter(candidate => parseVoiceGroupPartId(candidate.id)?.groupId === groupPart.groupId)
            .sort((a, b) => parseVoiceGroupPartId(a.id)!.index - parseVoiceGroupPartId(b.id)!.index);
          const complete = completeVoiceGroup(group.map(part => part.id));
          if (!complete && !group.some(part => part.delivered)) {
            report('这段语音暂存不完整，不能提交残缺指令；请先下载留存并重新说完整。');
            continue;
          }
          try {
            if (!group.some(part => part.delivered)) {
              const texts: string[] = [];
              for (const part of group) {
                if (controller.signal.aborted || activeScope.current !== forScope) break;
                const text = part.text || (part.blob ? await transcribeBlob(part.blob, controller.signal) : '');
                if (!text) throw new Error('整句中有一段语音仍未识别成功。');
                if (!part.text) {
                  const recognized = {...part, text};
                  memoryPending.current = [...memoryPending.current.filter(old => old.key !== part.key), recognized];
                  try { await savePendingVoice(recognized); } catch { /* Keep the words in this page. */ }
                }
                texts.push(text);
              }
              if (controller.signal.aborted || activeScope.current !== forScope) break;
              if (texts.length !== group.length) throw new Error('整句语音尚未全部识别。');
              const combined = texts.join(' ').trim();
              if (voiceTurnNeedsContinuation(combined)) throw new Error('整句听起来仍未说完，请下载核对后重新说完整。');
              await finalCallback.current(combined, groupPart.groupId);
              for (const part of group) {
                const delivered = {...part, blob: undefined, size: 0, delivered: true};
                memoryPending.current = [...memoryPending.current.filter(old => old.key !== part.key), delivered];
                try { await savePendingVoice(delivered); } catch { /* Keep the receipt in this page. */ }
              }
            }
            for (const part of group) {
              await removePendingVoice(forScope, part.id);
              memoryPending.current = memoryPending.current.filter(old => old.key !== part.key);
            }
            await refreshPending(forScope);
          } catch (cause) {
            if (controller.signal.aborted) break;
            report('整句语音仍未能提交，所有片段均已保留供重试或下载：' + errorMessage(cause));
            await refreshPending(forScope);
          }
          continue;
        }
        let text = item.text;
        try {
          if (!item.delivered) {
            if (!text && item.blob) text = await transcribeBlob(item.blob, controller.signal);
            if (!text) throw new Error('暂存内容为空，无法重试。');
            if (voiceTurnNeedsContinuation(text)) throw new Error('这句话听起来仍未说完，请下载核对后重新说完整。');
            if (controller.signal.aborted || activeScope.current !== forScope) break;
            await finalCallback.current(text, item.id);
            const delivered = {...item, text, blob: undefined, size: 0, delivered: true};
            memoryPending.current = [...memoryPending.current.filter(old => old.key !== item.key), delivered];
            try { await savePendingVoice(delivered); } catch { /* The in-page receipt still prevents a duplicate retry. */ }
          }
          await removePendingVoice(forScope, item.id);
          memoryPending.current = memoryPending.current.filter(old => old.key !== item.key);
          await refreshPending(forScope);
        } catch (cause) {
          if (controller.signal.aborted) break;
          if (text && !item.text && !memoryPending.current.some(old => old.key === item.key && old.delivered)) {
            const completed = {...item, text, blob: undefined, size: 0};
            memoryPending.current = [...memoryPending.current.filter(old => old.key !== item.key), completed];
            try { await savePendingVoice(completed); } catch { /* Keep the text in this page. */ }
          }
          report((memoryPending.current.some(old => old.key === item.key && old.delivered) ? '文字已提交，但清理暂存失败；重试只会清理暂存：' : '这条暂存语音仍未能提交，请稍后重试或下载：') + errorMessage(cause));
          await refreshPending(forScope);
        }
      }
    })().finally(() => {
      if (retryController.current === controller) retryController.current = null;
      retryPromise.current = null;
    });
    retryPromise.current = run;
    return run;
  }

  async function downloadPending(): Promise<void> {
    const forScope = scope || '';
    const items = await pendingItems(forScope);
    if (!items.length) { report('当前没有待下载的语音暂存。'); return; }
    for (const item of items) {
      const name = `连续语音暂存-${item.createdAt.slice(0, 10)}-${item.id.replace(/[^a-z0-9-]/giu, '-').slice(-48)}`;
      const download = (blob: Blob, extension: string) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name + extension;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      if (item.blob) download(item.blob, item.blob.type.includes('mp4') ? '.mp4' : item.blob.type.includes('ogg') ? '.ogg' : '.webm');
      if (item.text || !item.blob) download(new Blob([item.text || ''], {type: 'text/plain;charset=utf-8'}), '.txt');
    }
  }

  async function discardPending(): Promise<void> {
    const forScope = scope || '';
    if (sessionRef.current || retryPromise.current) { report('请先结束当前语音处理，再清理暂存。'); return; }
    if (forScope) await clearPendingVoice(forScope);
    memoryPending.current = memoryPending.current.filter(item => item.scope !== forScope);
    if (mounted.current && activeScope.current === forScope) { setPendingCount(0); setError(''); }
  }

  useEffect(() => { shutdownRef.current = shutdown; });

  useEffect(() => {
    if (activeScope.current !== scope) {
      retryController.current?.abort();
      if (sessionRef.current || startingRef.current) shutdownRef.current();
    }
    activeScope.current = scope;
    if (scope) void refreshPending(scope);
    else queueMicrotask(() => { if (mounted.current && activeScope.current === scope) setPendingCount(0); });
  }, [scope, refreshPending]);

  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.visibilityState === 'hidden' && (sessionRef.current || startingRef.current)) shutdownRef.current('页面切换后连续语音已结束，请返回页面重新开始。'); };
    const pagehide = () => { if (sessionRef.current || startingRef.current) shutdownRef.current(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', pagehide);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', pagehide);
      shutdownRef.current();
    };
  }, []);

  return {status, partial, getUnsentText: () => unsentForReviewRef.current, error, start, end, mute, interrupt, muted, active: status === 'connecting' || status === 'listening' || status === 'muted', pendingCount, retryPending, downloadPending, discardPending};
}
