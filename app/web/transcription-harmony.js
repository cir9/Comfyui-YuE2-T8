/* Palette and chromatic stripes match the read-only LivelyBeachTown reference.
   Its manually authored key map is NOT reused: these degrees use model keys. */
(function (root) {
  'use strict';
  const colors = ['#ff5252', '#ffb142', '#ffda79', '#33d9b2', '#34ace0', '#706fd3', '#ff52a5'];
  const degrees = ['1', 'b2', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7'];
  const steps = [0, 2, 4, 5, 7, 9, 11];
  const mod = n => (n % 12 + 12) % 12;
  function interval(degree) {
    const match = /^([b#]*)([1-9]|1[0-3])$/.exec(degree);
    if (!match) return null;
    return mod(steps[(Number(match[2]) - 1) % 7] + [...match[1]].reduce((v, c) => v + (c === '#' ? 1 : -1), 0));
  }
  function pitchClass(name) {
    const match = /^([A-G])([b#]*)$/.exec(name || '');
    return match ? mod({C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11}[match[1]] +
      [...match[2]].reduce((v, c) => v + (c === '#' ? 1 : -1), 0)) : null;
  }
  function degreePalette(degree) {
    const pc = interval(degree), d = pc === null ? '' : degrees[pc];
    if (!d) return {a: '#687283', b: '#687283', striped: false};
    const i = Number(d.slice(-1)) - 1, main = colors[i];
    return d.includes('#') ? {a: main, b: colors[(i + 1) % 7], striped: true} :
      d.includes('b') ? {a: colors[(i + 6) % 7], b: main, striped: true} : {a: main, b: main, striped: false};
  }
  function degreeStyle(degree) {
    const {a, b, striped} = degreePalette(degree);
    return striped ? `border:4px solid transparent;background:linear-gradient(#2c2c34,#2c2c34) padding-box,repeating-linear-gradient(45deg,${a},${a} 4px,${b} 4px,${b} 8px) border-box;color:#fff;` :
      `border:4px solid ${a};background:#2c2c34;color:#fff;`;
  }
  function reading(label, key) {
    const match = /^([A-G][b#]*)(?::([^/]*))?(?:\/(.+))?$/.exec(label);
    if (!match) return {symbol: label === 'N' ? 'N.C.' : label, numeric: '—', colorDegree: ''};
    const tonic = pitchClass((key || '').split(':')[0]), rootPC = pitchClass(match[1]);
    const bassInterval = match[3] ? interval(match[3]) : null;
    const bassPC = match[3] ? (bassInterval === null ? pitchClass(match[3]) : mod(rootPC + bassInterval)) : null;
    const suffix = (match[2] || 'maj').replace(/^minmaj/, 'mM').replace(/^maj(?=\d)/, 'M').replace(/^maj$/, '').replace(/^min/, 'm');
    const bassName = bassPC === null ? '' : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][bassPC];
    const symbol = match[1] + suffix + (match[3] ? '/' + (bassName || match[3]) : '');
    if (tonic === null) return {symbol, numeric: '调性未知', colorDegree: ''};
    const rootDegree = degrees[mod(rootPC - tonic)], bassDegree = bassPC === null ? null : degrees[mod(bassPC - tonic)];
    return {symbol, numeric: rootDegree + suffix + (bassDegree ? '/' + bassDegree : ''), colorDegree: bassDegree || rootDegree};
  }
  function chordPitches(chord, notes) {
    // Use the model's exported voicing, including its inversion/bass. MIDI tick
    // rounding can offset starts slightly, so sample the interval midpoint.
    const t = (chord.start + chord.end) / 2;
    return [...new Set(notes.filter(n => n.start <= t && n.end > t).map(n => n.pitch))].sort((a, b) => a - b);
  }
  const api = {colors, degreePalette, degreeStyle, reading, chordPitches};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SSHarmony = api;
})(typeof window === 'undefined' ? this : window);
