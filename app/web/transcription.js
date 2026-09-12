/* SheetSage2 inspection. All coordinates and playback use original seconds. */
(() => {
  'use strict';
  const el = id => document.getElementById(`ss-${id}`);
  const audio = el('audio');
  const state = {job: null, data: null, wave: null, start: 0, span: 20, low: 40, high: 88,
    selected: null, hits: [], load: 0, busy: false, frame: 0, dirty: true};
  const colors = ['#bd477c', '#547ceb', '#b98830'];
  const names = ['人声旋律', '器乐旋律', '和弦配音'];
  const left = 62;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const clock = t => `${String(Math.floor(Math.max(0, t) / 60)).padStart(2, '0')}:${(Math.max(0, t) % 60).toFixed(1).padStart(4, '0')}`;
  const pitchName = pitch => `${['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][pitch % 12]}${Math.floor(pitch / 12) - 1}`;
  const sourceURL = filename => audioUrl(state.job.id, `artifacts/transcription/${filename}`);
  const status = message => { el('status').textContent = message; };
  const at = (rows, t) => rows.find(row => row.start <= t && t < row.end);
  const noteInfo = note => `${names[note.track]} · ${pitchName(note.pitch)} (MIDI ${note.pitch})\n${note.start.toFixed(3)} – ${note.end.toFixed(3)} 秒 · 时长 ${(note.end - note.start).toFixed(3)} 秒`;
  let synth, scheduled = new Set(), previousTime = -1, scheduler, previewTicket = 0, chordView = '';
  let selectedChord = null;

  async function initSynth() {
    if (!synth) synth = new SSAudio.TranscriptionSynth(new (window.AudioContext || window.webkitAudioContext)());
    await synth.resume();
    synth.volume(Number(el('synth-volume').value));
    if (!scheduler) scheduler = setInterval(audioTick, 25);
  }
  function silence() {
    synth?.stop('transport'); scheduled.clear(); previousTime = -1;
  }
  function stopPreview() { ++previewTicket; synth?.stop('preview'); }
  async function audition(pitches, duration = .8, chord = false) {
    stopPreview(); const ticket = previewTicket;
    if (!pitches.length) return;
    try {
      await initSynth();
      if (ticket !== previewTicket) return;
      pitches.forEach(p => synth.strike(p, synth.context.currentTime + .01, clamp(duration, .35, 1.6), chord, 'preview'));
    } catch (error) { status(`合成试听失败：${error.message}`); }
  }
  function playbackNotes() {
    if (!state.data) return [];
    const notes = state.data.notes.filter(n => el(n.track === 0 ? 'vocal' : 'ins').checked);
    // The harmony track participates in transcription playback independently
    // of whether its voicing is drawn on the roll.
    return [...notes, ...(el('harmony').checked ? state.data.chord_notes.map(n => ({...n, track: 2})) : [])];
  }
  function scheduleAudio(t) {
    if (!synth || synth.context.state !== 'running' || audio.paused || audio.seeking || audio.readyState < 3 || el('listen').value === 'original') return;
    if (previousTime >= 0 && (t < previousTime - .02 || t - previousTime > .5)) silence();
    previousTime = t;
    const rate = audio.playbackRate;
    const loopEnd = el('loop').checked ? loopRange()[1] : state.data.duration;
    SSAudio.dueNotes(playbackNotes(), t, rate, loopEnd, scheduled).forEach(n =>
      synth.strike(n.pitch, synth.context.currentTime + n.delay, n.duration, n.track === 2));
  }
  function audioTick() {
    try {
      if (state.data && !audio.paused && el('loop').checked && audio.currentTime >= loopRange()[1]) seek(loopRange()[0]);
      if (state.data) scheduleAudio(audio.currentTime);
      const peak = synth?.peak() || 0;
      el('level').value = peak;
      el('level').dataset.maxPeak = String(synth?.maxPeak || 0);
      el('synth-state').textContent = !synth ? '未启用' : synth.context.state !== 'running' ? '音频挂起 · 点击试音' : peak > .0005 ? 'MIDI 发声中' : 'MIDI 就绪';
    } catch (error) { silence(); audio.pause(); status(`合成播放失败：${error.message}`); }
  }
  function updateMix() {
    audio.muted = el('listen').value === 'notes';
    audio.volume = Number(el('volume').value);
    synth?.volume(Number(el('synth-volume').value));
  }
  async function playPause() {
    if (!state.data) return;
    if (!audio.paused) { audio.pause(); return; }
    try {
      if (el('listen').value !== 'original') await initSynth();
      if (audio.currentTime >= state.data.duration - .05) audio.currentTime = 0;
      if (el('loop').checked) {
        const [a, b] = loopRange();
        if (audio.currentTime < a || audio.currentTime >= b) audio.currentTime = a;
      }
      stopPreview(); selectedChord = null; updateMix(); await audio.play();
    } catch (error) { status(`无法播放：${error.message}`); }
  }
  function loopRange() {
    const end = state.data?.duration || 1;
    const a = clamp(Number(el('loop-a').value) || 0, 0, Math.max(0, end - .1));
    const b = clamp(Number(el('loop-b').value) || end, a + .1, end);
    return [a, b];
  }
  function seek(t, follow = true) {
    if (!state.data) return;
    silence();
    selectedChord = null;
    audio.currentTime = clamp(t, 0, state.data.duration);
    if (follow && (t < state.start || t > state.start + state.span)) setStart(t - state.span * .15);
    state.dirty = true; updatePosition();
  }
  function setStart(t) { state.start = clamp(t, 0, Math.max(0, (state.data?.duration || 0) - state.span)); state.dirty = true; }
  function visibleNotes() {
    if (!state.data) return [];
    const notes = state.data.notes.filter(n => el(n.track === 0 ? 'vocal' : 'ins').checked);
    if (el('chord-notes').checked) notes.push(...state.data.chord_notes.map(n => ({...n, track: 2})));
    return notes;
  }
  function fitPitch() {
    const notes = visibleNotes();
    const pitches = notes.map(n => n.pitch);
    state.low = pitches.length ? clamp(Math.min(...pitches) - 3, 0, 114) : 48;
    state.high = pitches.length ? clamp(Math.max(...pitches) + 3, state.low + 12, 127) : 84;
    state.dirty = true;
  }
  function surface(id, height) {
    const canvas = el(id), width = Math.round(canvas.getBoundingClientRect().width);
    if (!width) return null;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
    return {ctx, width, height, inner: width - left};
  }
  function waveform(ctx, width, y, height, start, span, offset = left, opacity = 1) {
    if (!state.wave?.peaks.length) return;
    const {peaks, step} = state.wave;
    ctx.save(); ctx.globalAlpha = opacity; ctx.strokeStyle = '#849bbd'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = offset; x < width; x++) {
      const t = start + (x - offset) / (width - offset) * span;
      const a = Math.floor(t / step), b = Math.min(peaks.length, Math.max(a + 1, Math.ceil((t + span / (width - offset)) / step)));
      let low = 0, high = 0;
      for (let i = Math.max(0, a); i < b; i++) { low = Math.min(low, peaks[i][0]); high = Math.max(high, peaks[i][1]); }
      ctx.moveTo(x + .5, y + height / 2 - high * height / 2); ctx.lineTo(x + .5, y + height / 2 - low * height / 2);
    }
    ctx.stroke(); ctx.restore();
  }
  function cursor(ctx, x, height) {
    if (x < left) return;
    ctx.strokeStyle = '#da4f73'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    ctx.fillStyle = '#da4f73'; ctx.beginPath(); ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 6); ctx.fill();
  }
  function drawOverview() {
    const view = surface('overview', 82); if (!view || !state.data) return;
    const {ctx, width, height} = view, duration = state.data.duration;
    waveform(ctx, width, 4, 62, 0, duration, 0, .75);
    state.data.structures.forEach((section, i) => {
      const x = section.start / duration * width, w = (section.end - section.start) / duration * width;
      ctx.fillStyle = ['#597dff24', '#c7428028', '#bd9b4626'][i % 3]; ctx.fillRect(x, 62, w, 20);
      if (w > 36) { ctx.fillStyle = '#576780'; ctx.fillText(section.label, x + 4, 76, w - 6); }
    });
    const x = state.start / duration * width, w = Math.min(state.span, duration) / duration * width;
    ctx.fillStyle = '#597dff0d'; ctx.fillRect(x, 0, w, height);
    ctx.strokeStyle = '#597dff'; ctx.lineWidth = 1; ctx.strokeRect(x + .5, .5, Math.max(0, w - 1), height - 1);
    const playX = audio.currentTime / duration * width;
    ctx.strokeStyle = '#d44b72'; ctx.beginPath(); ctx.moveTo(playX, 0); ctx.lineTo(playX, height); ctx.stroke();
  }
  function drawLanes() {
    const view = surface('lanes', 90); if (!view || !state.data) return;
    const {ctx, width, inner} = view;
    const x = t => left + (t - state.start) / state.span * inner;
    ctx.fillStyle = '#f4f7fc'; ctx.fillRect(0, 0, width, 90);
    ctx.fillStyle = '#74829a'; ['秒', '调性', '段落'].forEach((label, i) => ctx.fillText(label, 12, 18 + i * 30));
    ctx.save(); ctx.beginPath(); ctx.rect(left, 0, inner, 90); ctx.clip();
    const step = state.span <= 10 ? 1 : state.span <= 30 ? 2 : state.span <= 60 ? 5 : 10;
    for (let t = Math.ceil(state.start / step) * step; t <= state.start + state.span; t += step) {
      ctx.fillStyle = '#71809a'; ctx.fillText(clock(t), x(t) + 4, 18);
    }
    [[state.data.keys, 30, '#e9eefb', '#526a96'], [state.data.structures, 60, '#f1eaf3', '#927197']].forEach(([rows, y, fill, ink]) => {
      rows.filter(r => r.end > state.start && r.start < state.start + state.span).forEach(row => {
        const a = Math.max(left, x(row.start)), b = Math.min(width, x(row.end));
        ctx.fillStyle = at([row], audio.currentTime) ? ink + '32' : fill;
        ctx.fillRect(a, y + 2, Math.max(1, b - a - 1), 26);
        ctx.fillStyle = ink;
        if (b - a > 22) ctx.fillText(row.label, a + 4, y + 19, b - a - 6);
      });
    });
    cursor(ctx, x(audio.currentTime), 90); ctx.restore();
  }
  function chordReading(chord) { return SSHarmony.reading(chord.label, at(state.data.keys, chord.start + .0001)?.label); }
  function auditionChord(chord) {
    selectedChord = chord; state.dirty = true; updatePosition();
    const pitches = SSHarmony.chordPitches(chord, state.data.chord_notes);
    if (!pitches.length) { stopPreview(); status(`${chord.label} · 此区间没有可试听的和弦配音`); return; }
    el('note-detail').textContent = `${chordReading(chord).symbol} · ${pitches.map(pitchName).join(' / ')}\n${chord.start.toFixed(3)} – ${chord.end.toFixed(3)} 秒 · 单击试听，双击定位`;
    audition(pitches, chord.end - chord.start, true);
  }
  function drawChords() {
    const signature = `${state.job.id}:${state.start}:${state.span}`;
    if (signature === chordView) return;
    chordView = signature;
    el('chords').replaceChildren();
    state.data.chords.forEach((chord, i) => {
      if (chord.end <= state.start || chord.start >= state.start + state.span) return;
      const read = chordReading(chord), button = document.createElement('button');
      const a = Math.max(state.start, chord.start), b = Math.min(state.start + state.span, chord.end);
      button.type = 'button'; button.className = 'ss-chord-button'; button.dataset.index = i;
      button.style.cssText = SSHarmony.degreeStyle(read.colorDegree);
      button.style.left = `${(a - state.start) / state.span * 100}%`;
      button.style.width = `${(b - a) / state.span * 100}%`;
      const symbol = document.createElement('span'), degree = document.createElement('strong');
      symbol.textContent = read.symbol; degree.textContent = read.numeric; button.append(symbol, degree);
      button.title = `${read.symbol} · ${read.numeric} · ${chord.start.toFixed(2)}–${chord.end.toFixed(2)} 秒\n原始标注 ${chord.label} · 单击试听，双击定位`;
      button.setAttribute('aria-label', button.title);
      button.onclick = () => auditionChord(chord);
      button.ondblclick = () => seek(chord.start);
      el('chords').append(button);
    });
  }
  function drawRoll() {
    const height = Number(el('height').value), view = surface('roll', height);
    if (!view || !state.data) return;
    const {ctx, width, inner} = view, count = state.high - state.low + 1, rowHeight = height / count;
    const x = t => left + (t - state.start) / state.span * inner;
    state.hits = [];
    for (let pitch = state.low; pitch <= state.high; pitch++) {
      const y = (state.high - pitch) * rowHeight, black = [1, 3, 6, 8, 10].includes(pitch % 12);
      ctx.fillStyle = black ? '#f0f3f9' : '#fcfdff'; ctx.fillRect(left, y, inner, rowHeight);
      ctx.fillStyle = black ? '#d4dbe7' : '#ffffff'; ctx.fillRect(0, y, left - 1, rowHeight);
      ctx.fillStyle = '#8290a6';
      if (pitch % 12 === 0 || rowHeight >= 13) ctx.fillText(pitchName(pitch), 10, y + Math.min(rowHeight - 2, 12));
      ctx.strokeStyle = pitch % 12 === 0 ? '#c8d2e2' : '#e6ebf3';
      ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(width, y + .5); ctx.stroke();
    }
    ctx.save(); ctx.beginPath(); ctx.rect(left, 0, inner, height); ctx.clip();
    if (el('wave').checked) waveform(ctx, width, 0, height, state.start, state.span, left, .2);
    if (el('beats').checked) state.data.beats.forEach(beat => {
      if (beat.time < state.start || beat.time > state.start + state.span) return;
      ctx.strokeStyle = beat.beat === 1 ? '#a6b4cc' : '#d8e0ec'; ctx.lineWidth = beat.beat === 1 ? 1 : .6;
      ctx.beginPath(); ctx.moveTo(x(beat.time), 0); ctx.lineTo(x(beat.time), height); ctx.stroke();
    });
    visibleNotes().sort((a, b) => b.track - a.track).forEach(note => {
      if (note.end <= state.start || note.start >= state.start + state.span || note.pitch < state.low || note.pitch > state.high) return;
      const a = Math.max(left, x(note.start)), b = Math.min(width, x(note.end));
      const y = (state.high - note.pitch) * rowHeight + 1, h = Math.max(2, rowHeight - 2);
      const active = note.start <= audio.currentTime && note.end > audio.currentTime;
      ctx.globalAlpha = note.track === 2 ? .35 : active ? 1 : .8; ctx.fillStyle = colors[note.track];
      ctx.fillRect(a, y, Math.max(2, b - a - 1), h); ctx.globalAlpha = 1;
      if (active || (state.selected?.start === note.start && state.selected?.pitch === note.pitch && state.selected?.track === note.track)) {
        ctx.strokeStyle = active ? '#152945' : '#713658'; ctx.lineWidth = 1.3; ctx.strokeRect(a, y, Math.max(2, b - a - 1), h);
      }
      if (h > 12 && b - a > 25) { ctx.fillStyle = note.track === 2 ? '#654916' : '#fff'; ctx.fillText(pitchName(note.pitch), a + 3, y + 11, b - a - 4); }
      state.hits.push({x: a, y, width: Math.max(3, b - a), height: h, note});
    });
    cursor(ctx, x(audio.currentTime), height); ctx.restore();
  }
  function updatePosition() {
    if (!state.data) return;
    const t = audio.currentTime;
    el('clock').textContent = `${clock(t)} / ${clock(state.data.duration)}`;
    el('seek').value = t;
    const active = at(state.data.chords, t), chord = selectedChord || active;
    const key = at(state.data.keys, chord?.start ?? t), section = at(state.data.structures, t);
    const read = chord ? chordReading(chord) : null;
    el('chord-caption').textContent = selectedChord ? '所选和弦 · 单击试听' : '当前和弦 · 单击试听';
    el('current-chord').textContent = read ? `${read.symbol} · ${read.numeric}` : '—';
    el('current-chord').style.cssText = SSHarmony.degreeStyle(read?.colorDegree || '');
    el('current-chord').disabled = !chord;
    el('current-chord').onclick = () => { if (chord) auditionChord(chord); };
    el('current-key').textContent = [key?.label, section?.label].filter(Boolean).join(' · ');
    el('chords').querySelectorAll('button').forEach(button => {
      const row = state.data.chords[Number(button.dataset.index)];
      button.classList.toggle('playing', row === active && !audio.paused);
      button.classList.toggle('selected', row === selectedChord);
      button.setAttribute('aria-pressed', String(row === selectedChord));
    });
  }
  function draw() { drawOverview(); drawLanes(); drawChords(); drawRoll(); updatePosition(); state.dirty = false; }
  function frame(now) {
    if (state.data && document.getElementById('transcription').classList.contains('active')) {
      if (!audio.paused) {
        if (!scheduler && el('loop').checked && audio.currentTime >= loopRange()[1]) seek(loopRange()[0]);
        if (el('follow').checked && (audio.currentTime >= state.start + state.span || audio.currentTime < state.start)) setStart(audio.currentTime - state.span * .1);
      }
      if (state.dirty || (!audio.paused && now - state.frame > 32)) { draw(); state.frame = now; }
    }
    requestAnimationFrame(frame);
  }

  async function fetchJSON(url) { const response = await fetch(url); if (!response.ok) throw new Error(`文件读取失败：HTTP ${response.status}`); return response.json(); }
  async function loadJob(id) {
    const ticket = ++state.load;
    audio.pause(); silence(); stopPreview(); status('正在加载原曲与转谱时间轴…');
    try {
      const job = await api(`/api/jobs/${id}`);
      if (!job.result?.timeline) throw new Error('这条旧记录尚无卷帘数据。请在“完整转谱”中重新提交原曲。');
      const base = `artifacts/transcription/`;
      const [data, wave] = await Promise.all([fetchJSON(audioUrl(id, base + 'timeline.json')), fetchJSON(audioUrl(id, base + 'waveform.json'))]);
      if (ticket !== state.load) return;
      if (data.schema !== 1 || !Number.isFinite(data.duration) || data.duration <= 0) throw new Error('不支持的转谱时间轴');
      state.job = job; state.data = data; state.wave = wave; state.start = 0; state.selected = null;
      selectedChord = null; chordView = '';
      state.span = Number(el('span').value);
      savedValue('transcription-job', id);
      el('workbench').classList.remove('hidden'); el('history').value = id;
      el('title').textContent = job.result.source_name || data.source_name;
      el('facts').replaceChildren(...[`${data.duration.toFixed(1)} 秒`, `${data.notes.length} 个音符`, `${data.chords.filter(c => !['N', 'X', '?'].includes(c.label)).length} 段和弦`, `${data.measures.length} 小节`].map(text => {
        const item = document.createElement('span'); item.textContent = text; return item;
      }));
      el('abc').value = job.result.abc || '';
      el('to-plan').disabled = !job.result.abc;
      el('to-cover').disabled = !job.result.melody_abc_path && !job.result.melody_only;
      el('seek').max = data.duration; el('seek').value = 0;
      el('loop-a').max = Math.max(0, data.duration - .1); el('loop-b').max = data.duration;
      el('loop-a').value = 0; el('loop-b').value = Math.min(20, data.duration).toFixed(1); el('loop').checked = false;
      audio.src = sourceURL(data.audio); audio.load(); audio.playbackRate = Number(el('rate').value); updateMix();
      el('report').textContent = JSON.stringify({config: data.config, warnings: data.warnings, diagnostics: data.diagnostics, abc_error: data.abc_error}, null, 2);
      el('note-detail').textContent = '单击音符或和弦试听，双击定位。滚轮平移，Ctrl + 滚轮缩放。';
      downloads(); fitPitch(); draw();
      status(data.abc_error ? `预测完成，ABC 整理失败：${data.abc_error}。可继续检查音符及原始标注。` : '已载入完整转谱 · 原曲、波形与预测共享秒级时间轴');
      el('result').replaceChildren();
    } catch (error) { if (ticket === state.load) status(error.message); }
  }
  function downloads() {
    const files = [['transcription.mid', '完整 MIDI'], ['melody_vocal.mid', '人声 MIDI'], ['melody_instrumental.mid', '器乐 MIDI'], ['chords.mid', '和弦 MIDI'], ['events.json', '原始事件'], ['chord.lab', '和弦标注'], ['timeline.json', '时间轴 JSON']];
    if (state.job.result.abc) files.unshift(['score.abc', '完整 ABC']);
    if (state.job.result.melody_abc_path) files.splice(1, 0, ['score.melody.abc', '旋律 ABC']);
    el('downloads').replaceChildren(...files.map(([file, text]) => {
      const anchor = document.createElement('a'); anchor.className = 'ghost'; anchor.textContent = text; anchor.href = sourceURL(file); anchor.download = file; return anchor;
    }));
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost'; button.textContent = '导出全部文件';
    button.onclick = () => exportJob(state.job.id); el('downloads').append(button);
  }
  async function refreshHistory(auto = false) {
    try {
      const {jobs} = await api('/api/jobs?limit=100');
      const rows = jobs.filter(j => j.kind === 'transcribe' && j.status === 'complete');
      const selected = state.job?.id || savedValue('transcription-job');
      el('history').replaceChildren(new Option('选择已完成的转谱', ''), ...rows.map(j => new Option(`${new Date(j.created_at * 1000).toLocaleString()} · ${j.result?.source_name || j.id}${j.result?.timeline ? '' : '（旧记录）'}`, j.id)));
      el('history').value = selected || '';
      if (auto && !state.data && !state.busy) {
        const candidate = rows.find(j => j.id === selected && j.result?.timeline) || rows.find(j => j.result?.timeline);
        if (candidate) await loadJob(candidate.id);
      }
      const running = jobs.find(j => j.kind === 'transcribe' && j.result_panel === 'transcription' && !TERMINAL.has(j.status));
      if (running && !state.busy) {
        state.busy = true; bindButton(el('submit'), running); status(`正在恢复任务 ${running.id} 的进度…`);
        waitForJob(running.id, el('result')).then(async job => { await refreshHistory(); await loadJob(job.id); }).catch(error => status(error.message)).finally(() => { state.busy = false; });
      }
    } catch (error) { status(`记录读取失败：${error.message}`); }
  }
  el('form').onsubmit = async event => {
    event.preventDefault(); if (state.busy) return;
    const file = el('file').files[0]; if (!file) return;
    const maximum = el('max-seconds').value;
    if (maximum && (!Number.isFinite(Number(maximum)) || Number(maximum) <= 0)) { status('请输入大于 0 的分析秒数。'); return; }
    state.busy = true; setSubmitting(el('submit')); status('正在上传原曲…');
    try {
      const upload = await api(`/api/uploads?filename=${encodeURIComponent(file.name)}`, {method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: file});
      status('正在完整识别旋律、和弦、节拍、调性与段落。进度可在任务中心查看。');
      const request = {source_path: upload.path, source_name: file.name, melody_only: false, workbench: true, dtype: el('dtype').value, preset: el('preset').value};
      if (maximum) request.max_seconds = Number(maximum);
      const job = await submit('transcribe', request, el('result'), el('submit'));
      await refreshHistory(); await loadJob(job.id);
    } catch (error) { status(error.message); el('result').innerHTML = failureMarkup(error); }
    finally { state.busy = false; restoreButton(el('submit')); }
  };
  el('history').onchange = () => { if (el('history').value) loadJob(el('history').value); };
  el('refresh').onclick = () => refreshHistory(true);
  window.openTranscription = async id => { document.querySelector('.tab[data-tab="transcription"]').click(); await refreshHistory(); await loadJob(id); };
  el('play').onclick = playPause;
  el('stop').onclick = () => { audio.pause(); stopPreview(); seek(0); setStart(0); };
  el('test-tone').onclick = () => audition([60, 64, 67], .8, true);
  el('seek').oninput = () => seek(Number(el('seek').value));
  el('rate').onchange = () => { silence(); audio.playbackRate = Number(el('rate').value); };
  el('listen').onchange = async () => {
    silence(); updateMix();
    if (el('listen').value !== 'original') { try { await initSynth(); } catch (error) { status(error.message); audio.pause(); } }
  };
  el('volume').oninput = updateMix; el('synth-volume').oninput = updateMix;
  ['play', 'pause', 'ended', 'seeking', 'seeked', 'loadedmetadata', 'timeupdate', 'waiting', 'playing'].forEach(name => audio.addEventListener(name, () => {
    if (['pause', 'ended', 'seeking', 'waiting'].includes(name)) silence();
    if (name === 'ended' && el('loop').checked) { seek(loopRange()[0]); audio.play().catch(error => status(error.message)); }
    el('play').textContent = audio.paused ? '播放' : '暂停'; state.dirty = true;
  }));
  audio.addEventListener('error', () => { status('原曲试听文件无法播放，请检查文件是否仍然存在。'); silence(); });
  el('span').onchange = () => { state.span = Number(el('span').value); setStart(state.start); };
  el('height').oninput = () => { el('roll').style.height = `${el('height').value}px`; state.dirty = true; };
  el('prev').onclick = () => setStart(state.start - state.span * .8);
  el('next').onclick = () => setStart(state.start + state.span * .8);
  el('fit').onclick = fitPitch;
  ['vocal', 'ins', 'harmony', 'chord-notes', 'wave', 'beats', 'follow'].forEach(id => { el(id).onchange = () => { state.dirty = true; if (['vocal', 'ins', 'harmony', 'chord-notes'].includes(id)) { silence(); fitPitch(); } }; });
  ['loop-a', 'loop-b', 'loop'].forEach(id => { el(id).onchange = () => { if (!state.data) return; const [a, b] = loopRange(); el('loop-a').value = a.toFixed(1); el('loop-b').value = b.toFixed(1); silence(); }; });
  el('loop-window').onclick = () => { if (!state.data) return; el('loop-a').value = state.start.toFixed(1); el('loop-b').value = Math.min(state.data.duration, state.start + state.span).toFixed(1); el('loop').checked = true; seek(state.start); };
  el('overview').onclick = event => { if (!state.data) return; const rect = el('overview').getBoundingClientRect(); const t = (event.clientX - rect.left) / rect.width * state.data.duration; setStart(t - state.span / 2); seek(t, false); };
  el('lanes').onclick = event => { if (!state.data) return; const rect = el('lanes').getBoundingClientRect(); if (event.clientX - rect.left < left) return; seek(state.start + (event.clientX - rect.left - left) / (rect.width - left) * state.span, false); };
  function hit(event) {
    const rect = el('roll').getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    return [...state.hits].reverse().find(h => x >= h.x && x <= h.x + h.width && y >= h.y && y <= h.y + h.height)?.note;
  }
  el('roll').onclick = async event => {
    if (!state.data) return;
    const note = hit(event);
    if (note) {
      state.selected = note; el('note-detail').textContent = noteInfo(note); state.dirty = true;
      await audition([note.pitch], note.end - note.start, note.track === 2);
    } else {
      const rect = el('roll').getBoundingClientRect();
      if (event.clientX - rect.left >= left) seek(state.start + (event.clientX - rect.left - left) / (rect.width - left) * state.span, false);
    }
  };
  el('roll').ondblclick = event => { const note = hit(event); if (note) seek(note.start, false); };
  el('roll').onpointermove = event => {
    const note = hit(event), tip = el('tooltip'); tip.hidden = !note;
    if (!note) return;
    tip.textContent = noteInfo(note);
    const rect = el('roll').parentElement.getBoundingClientRect();
    tip.style.left = `${clamp(event.clientX - rect.left + 12, 0, Math.max(0, rect.width - 265))}px`;
    tip.style.top = `${clamp(event.clientY - rect.top - 65, 0, rect.height - 70)}px`;
  };
  el('roll').onpointerleave = () => { el('tooltip').hidden = true; };
  el('roll').addEventListener('wheel', event => {
    if (!state.data) return; event.preventDefault();
    if (event.ctrlKey) {
      const spans = [5, 10, 20, 40, 80], index = spans.indexOf(state.span);
      state.span = spans[clamp(index + (event.deltaY > 0 ? 1 : -1), 0, spans.length - 1)]; el('span').value = state.span;
    }
    setStart(state.start + (event.ctrlKey ? 0 : Math.sign(event.deltaY || event.deltaX) * state.span * .1));
  }, {passive: false});
  ['roll', 'lanes', 'overview'].forEach(id => el(id).onkeydown = event => {
    if (event.code === 'Space') { event.preventDefault(); playPause(); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek(audio.currentTime + (event.key === 'ArrowLeft' ? -1 : 1)); }
  });
  el('to-cover').onclick = async () => {
    if (!state.job) return;
    try {
      const response = await fetch(sourceURL(state.job.result.melody_only ? 'score.abc' : 'score.melody.abc'));
      if (!response.ok) throw new Error('旋律 ABC 读取失败');
      const abc = await response.text();
      if (document.getElementById('cover-abc').value.trim() && !confirm('用这份转谱替换当前旋律重制草稿中的 ABC？')) return;
      document.getElementById('cover-abc').value = abc; document.getElementById('cover-review').classList.remove('hidden');
      window.assistantDraftChanged?.('cover'); document.querySelector('.tab[data-tab="cover"]').click();
    } catch (error) { status(error.message); }
  };
  el('to-plan').onclick = () => {
    if (!state.job?.result.abc) return;
    if (document.getElementById('plan-abc').value.trim() && !confirm('用完整转谱替换当前乐谱计划草稿中的 ABC？')) return;
    document.getElementById('plan-abc').value = state.job.result.abc;
    document.getElementById('plan-abc').disabled = false;
    document.getElementById('plan-exact').checked = false; document.getElementById('plan-exact').disabled = true;
    document.querySelector('#plan-form [name=cot]').value = 'full';
    planState = {source: 'imported_abc', request: {cot: 'full'}};
    document.getElementById('plan-workbench').classList.remove('hidden'); document.getElementById('plan-badge').textContent = '完整转谱';
    window.assistantDraftChanged?.('plan'); document.querySelector('.tab[data-tab="plan"]').click();
  };
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
    if (tab.dataset.tab !== 'transcription') { audio.pause(); stopPreview(); }
    else { state.dirty = true; refreshHistory(!state.data); }
  }));
  new ResizeObserver(() => { state.dirty = true; }).observe(el('workbench'));
  ['1', '2', '3', '4', '5', '6', '7', '#4', 'b7'].forEach(degree => {
    const badge = document.createElement('span'); badge.textContent = degree; badge.style.cssText = SSHarmony.degreeStyle(degree); el('degree-legend').append(badge);
  });
  window.addEventListener('pagehide', () => { audio.pause(); silence(); stopPreview(); clearInterval(scheduler); scheduler = null; });
  refreshHistory(true); requestAnimationFrame(frame);
})();
