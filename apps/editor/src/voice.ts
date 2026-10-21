// Voice in collaboration: WebRTC between participants of a room or file, audio goes directly,
// the server only relays signals (offer, answer, ICE candidates) to the recipient. The connection
// is initiated by the participant with the smaller id (no crossing offers). STUN / TURN — from the server (/ice,
// MFP_ICE_SERVERS setting); without them voice works on the local network. Whether a participant is speaking —
// by their own microphone level (in presence, for avatar highlighting).

import type { Collab } from './collab.ts';

interface Link {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  /** ICE candidates that arrived before the peer's description. */
  pending: RTCIceCandidateInit[];
}

/** Speech level threshold (RMS) and decay delay, ms. */
const SPEAK_LEVEL = 0.02;
const SPEAK_HOLD = 400;

export class VoiceChat {
  private collab: Collab;
  private stream: MediaStream | null = null;
  private links = new Map<string, Link>();
  private ice: RTCIceServer[] = [];
  private meter: { ctx: AudioContext; timer: ReturnType<typeof setInterval> } | null = null;
  private lastLoud = 0;
  active = false;
  muted = false;
  /** State changed (button, avatars). */
  onChange: (() => void) | null = null;
  onError: ((message: string) => void) | null = null;

  constructor(collab: Collab) {
    this.collab = collab;
    collab.onSignal = (from, msg) => void this.signal(from, msg);
    collab.onPresence.push(() => this.active && this.sync());
  }

  async join() {
    if (this.active) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      this.onError?.('Нет доступа к микрофону');
      return;
    }
    this.ice = await fetch(`${this.collab.httpBase}/ice`)
      .then((r) => (r.ok ? (r.json() as Promise<RTCIceServer[]>) : []))
      .catch(() => []);
    this.active = true;
    this.muted = false;
    this.startMeter();
    this.collab.setVoice('on');
    this.sync();
    this.onChange?.();
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    for (const id of [...this.links.keys()]) this.drop(id);
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    if (this.meter) {
      clearInterval(this.meter.timer);
      void this.meter.ctx.close();
      this.meter = null;
    }
    this.collab.setVoice(null);
    this.onChange?.();
  }

  toggleMute() {
    if (!this.active) return;
    this.muted = !this.muted;
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = !this.muted;
    this.collab.setVoice(this.muted ? 'muted' : 'on');
    this.onChange?.();
  }

  /** Who is in the call (participant ids). */
  get connectedPeers(): string[] {
    return [...this.links].filter(([, l]) => l.pc.connectionState === 'connected').map(([id]) => id);
  }

  /** Reconcile connections with participants in voice: connect new ones, close those who left. */
  private sync() {
    const inVoice = new Set(this.collab.people.filter((p) => p.voice).map((p) => p.id));
    for (const id of [...this.links.keys()]) if (!inVoice.has(id)) this.drop(id);
    for (const id of inVoice) if (!this.links.has(id) && this.collab.me.id < id) void this.offer(id);
  }

  private link(id: string): Link {
    let l = this.links.get(id);
    if (l) return l;
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.dataset.voice = id;
    audio.style.display = 'none';
    document.body.append(audio);
    l = { pc, audio, pending: [] };
    this.links.set(id, l);
    for (const t of this.stream?.getTracks() ?? []) pc.addTrack(t, this.stream!);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.collab.sendSignal(id, { kind: 'ice', candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      // Connection lost — close; we'll reconnect on the next reconcile.
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.drop(id);
        if (this.active) setTimeout(() => this.active && this.sync(), 1000);
      }
      this.onChange?.();
    };
    return l;
  }

  private drop(id: string) {
    const l = this.links.get(id);
    if (!l) return;
    this.links.delete(id);
    l.pc.onconnectionstatechange = null;
    l.pc.close();
    l.audio.srcObject = null;
    l.audio.remove();
    this.onChange?.();
  }

  private async offer(id: string) {
    const { pc } = this.link(id);
    await pc.setLocalDescription(await pc.createOffer());
    this.collab.sendSignal(id, { kind: 'offer', sdp: pc.localDescription?.toJSON() });
  }

  private async signal(from: string, msg: Record<string, unknown>) {
    if (!this.active) return;
    try {
      if (msg.kind === 'offer') {
        // Reconnection from the other side — start over.
        if (this.links.has(from)) this.drop(from);
        const l = this.link(from);
        await l.pc.setRemoteDescription(msg.sdp as RTCSessionDescriptionInit);
        await this.flush(l);
        await l.pc.setLocalDescription(await l.pc.createAnswer());
        this.collab.sendSignal(from, { kind: 'answer', sdp: l.pc.localDescription?.toJSON() });
      } else if (msg.kind === 'answer') {
        const l = this.links.get(from);
        if (!l || l.pc.signalingState !== 'have-local-offer') return;
        await l.pc.setRemoteDescription(msg.sdp as RTCSessionDescriptionInit);
        await this.flush(l);
      } else if (msg.kind === 'ice') {
        const l = this.links.get(from);
        if (!l) return;
        const c = msg.candidate as RTCIceCandidateInit;
        if (l.pc.remoteDescription) await l.pc.addIceCandidate(c).catch(() => {});
        else l.pending.push(c);
      }
    } catch (e) {
      console.warn('Голос: сигнал', e);
    }
  }

  private async flush(l: Link) {
    for (const c of l.pending.splice(0)) await l.pc.addIceCandidate(c).catch(() => {});
  }

  /** Own microphone level: whether speaking (with decay delay). */
  private startMeter() {
    if (!this.stream) return;
    const ctx = new AudioContext();
    // Joining happens on a click (a user gesture): audio can be started.
    void ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(this.stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const loud = !this.muted && Math.sqrt(sum / buf.length) > SPEAK_LEVEL;
      const now = performance.now();
      if (loud) this.lastLoud = now;
      const speaking = now - this.lastLoud < SPEAK_HOLD;
      if (speaking !== this.collab.speaking) {
        this.collab.setVoice(this.muted ? 'muted' : 'on', speaking);
        this.onChange?.();
      }
    }, 100);
    this.meter = { ctx, timer };
  }
}
