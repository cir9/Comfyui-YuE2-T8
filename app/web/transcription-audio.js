/* Local keyboard synthesis; no soundfont download or MIDI device required. */
(function (root) {
  'use strict';
  class TranscriptionSynth {
    constructor(context) {
      this.context = context;
      this.output = context.createGain();
      this.output.gain.value = .65;
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.output.connect(this.analyser);
      this.analyser.connect(context.destination);
      this.samples = new Float32Array(this.analyser.fftSize);
      this.voices = new Set();
      this.maxPeak = 0;
    }
    async resume() {
      if (this.context.state !== 'running') await this.context.resume();
      if (this.context.state !== 'running') throw new Error('浏览器未启用音频，请再次点击播放或试音');
    }
    volume(value) { this.output.gain.setTargetAtTime(value, this.context.currentTime, .02); }
    strike(pitch, when, duration, chord = false, group = 'transport') {
      if (!Number.isFinite(pitch) || pitch < 0 || pitch > 127 || !Number.isFinite(duration)) return;
      const ctx = this.context;
      when = Math.max(ctx.currentTime, when);
      const held = Math.max(.03, duration), level = chord ? .065 : .19;
      const oscillator = ctx.createOscillator(), gain = ctx.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
      oscillator.connect(gain); gain.connect(this.output);
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(level, when + .006);
      gain.gain.exponentialRampToValueAtTime(level * .35, when + Math.min(.16, held));
      gain.gain.setValueAtTime(level * .35, when + held);
      gain.gain.exponentialRampToValueAtTime(.0001, when + held + .09);
      const voice = {oscillator, gain, group};
      this.voices.add(voice);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this.voices.delete(voice); };
      oscillator.start(when); oscillator.stop(when + held + .1);
    }
    stop(group) {
      for (const voice of this.voices) if (!group || voice.group === group) {
        try { voice.oscillator.stop(); } catch { /* already ended */ }
        voice.oscillator.disconnect(); voice.gain.disconnect(); this.voices.delete(voice);
      }
    }
    peak() {
      this.analyser.getFloatTimeDomainData(this.samples);
      let peak = 0;
      for (const sample of this.samples) peak = Math.max(peak, Math.abs(sample));
      this.maxPeak = Math.max(this.maxPeak, peak);
      return peak;
    }
  }
  // Pure scheduling makes rate/seek/loop semantics independently testable.
  function dueNotes(notes, time, rate, end, scheduled) {
    const due = [];
    for (const n of notes) {
      const key = `${n.track}:${n.start}:${n.end}:${n.pitch}`;
      if (n.end <= time || n.start >= Math.min(time + .15 * rate, end) || scheduled.has(key)) continue;
      scheduled.add(key);
      due.push({...n, delay: Math.max(0, (n.start - time) / rate),
        duration: (Math.min(n.end, end) - Math.max(time, n.start)) / rate});
    }
    return due;
  }
  const api = {TranscriptionSynth, dueNotes};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SSAudio = api;
})(typeof window === 'undefined' ? this : window);
