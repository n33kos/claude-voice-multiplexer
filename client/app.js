const BAR_COUNT = 9;
let room = null;
let audioContext = null;
let outputAnalyser = null;
let inputAnalyser = null;
let animFrameId = null;
let agentHasConnected = false;
let agentIsConnected = false;
let agentIsSpeaking = false;
let agentParticipantSid = null;
let agentSpeakDebounce = null;
const SPEAK_DEBOUNCE_MS = 800;

// Initialize visualizer bars
const vizEl = document.getElementById('visualizer');
for (let i = 0; i < BAR_COUNT; i++) {
  const bar = document.createElement('div');
  bar.className = 'bar idle';
  bar.style.height = '14px';
  vizEl.appendChild(bar);
}
const bars = vizEl.querySelectorAll('.bar');

// --- Audio chime system ---

function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') audioContext.resume();
  return audioContext;
}

function playChime(type) {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    if (type === 'listening') {
      playTone(ctx, 660, now, 0.12, 0.15);
      playTone(ctx, 880, now + 0.14, 0.12, 0.15);
    } else if (type === 'thinking') {
      playTone(ctx, 550, now, 0.15, 0.1);
      playTone(ctx, 440, now + 0.12, 0.2, 0.08);
    }
  } catch (e) {
    console.warn('Chime failed:', e);
  }
}

function playTone(ctx, freq, startTime, duration, volume) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(volume, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.01);
}

// --- UI helpers ---

function setStatus(text, type = '') {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = 'status ' + type;
}

function showView(view) {
  document.getElementById('login-view').classList.toggle('hidden', view !== 'login');
  document.getElementById('connected-view').classList.toggle('hidden', view !== 'connected');
}

function setMode(mode) {
  const dot = document.getElementById('mic-dot');
  const label = document.getElementById('mic-label');
  dot.classList.remove('recording', 'agent');
  bars.forEach(b => b.classList.remove('input', 'output', 'thinking', 'idle'));

  if (mode === 'recording') {
    dot.classList.add('recording');
    label.textContent = 'Recording';
    bars.forEach(b => b.classList.add('input'));
    setupMicAnalyser();
  } else if (mode === 'agent-speaking') {
    dot.classList.add('agent');
    label.textContent = 'Agent speaking';
    bars.forEach(b => b.classList.add('output'));
    if (outputAnalyser) startVisualizer('output');
  } else if (mode === 'thinking') {
    label.textContent = 'Processing...';
    startThinkingAnimation();
  } else if (mode === 'idle') {
    label.textContent = 'Microphone on';
    bars.forEach(b => b.classList.add('idle'));
    stopVisualizer();
  } else {
    label.textContent = 'Microphone off';
    bars.forEach(b => b.classList.add('idle'));
    stopVisualizer();
  }
}

// --- Connection ---

async function connect() {
  const password = document.getElementById('password').value;
  if (!password) { setStatus('Enter a password', 'error'); return; }

  const btn = document.getElementById('connect-btn');
  btn.disabled = true;
  setStatus('Connecting...', 'connecting');

  try {
    const roomName = 'voice_relay';
    const identity = 'phone_' + Math.floor(Math.random() * 10000);
    const tokenUrl = `/token?password=${encodeURIComponent(password)}&room=${roomName}&identity=${identity}`;

    const resp = await fetch(tokenUrl);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Connection failed' }));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }

    const { token, serverUrl } = await resp.json();

    room = new LivekitClient.Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Agent publishes audio track
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === LivekitClient.Track.Kind.Audio) {
        const el = track.attach();
        document.body.appendChild(el);
        setupOutputAnalyser(track);
      }
    });

    // Agent audio track removed
    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach(el => el.remove());
    });

    // Active speakers changed — debounced to prevent rapid mode flipping
    let agentRawSpeaking = false;

    room.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (!agentIsConnected) return;

      agentRawSpeaking = speakers.some(p => p.sid === agentParticipantSid);

      if (agentRawSpeaking) {
        if (agentSpeakDebounce) { clearTimeout(agentSpeakDebounce); agentSpeakDebounce = null; }

        if (!agentIsSpeaking) {
          agentIsSpeaking = true;
          setMode('agent-speaking');
          startVisualizer('output');
          setStatus('Agent speaking', 'connected');
        }
      } else {
        if (agentIsSpeaking && !agentSpeakDebounce) {
          agentSpeakDebounce = setTimeout(() => {
            agentSpeakDebounce = null;
            if (!agentRawSpeaking && agentIsSpeaking) {
              agentIsSpeaking = false;
              playChime('listening');
              setMode('recording');
              setStatus('Your turn — speak now', 'connected');
            }
          }, SPEAK_DEBOUNCE_MS);
        }
      }
    });

    // Agent joins the room
    room.on(LivekitClient.RoomEvent.ParticipantConnected, (participant) => {
      agentHasConnected = true;
      agentIsConnected = true;
      agentParticipantSid = participant.sid;
      setStatus('Agent joined', 'connected');
    });

    // Agent leaves the room
    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
      agentIsConnected = false;
      agentIsSpeaking = false;
      agentParticipantSid = null;
      if (agentSpeakDebounce) { clearTimeout(agentSpeakDebounce); agentSpeakDebounce = null; }

      if (agentHasConnected) {
        playChime('thinking');
        setMode('thinking');
        setStatus('Thinking...', 'thinking');
      } else {
        setMode('idle');
        setStatus('Waiting for agent...', 'connecting');
      }
    });

    // Room disconnected
    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      handleDisconnect();
    });

    await room.connect(serverUrl, token);
    await room.localParticipant.setMicrophoneEnabled(true);

    setMode('idle');
    showView('connected');
    setStatus('Connected — waiting for agent...', 'connecting');
    getAudioContext();

  } catch (err) {
    console.error('Connection error:', err);
    setStatus(err.message, 'error');
    btn.disabled = false;
  }
}

// --- Audio analysers ---

function setupOutputAnalyser(track) {
  try {
    const ctx = getAudioContext();
    const stream = new MediaStream([track.mediaStreamTrack]);
    const source = ctx.createMediaStreamSource(stream);
    outputAnalyser = ctx.createAnalyser();
    outputAnalyser.fftSize = 64;
    source.connect(outputAnalyser);
  } catch (e) {
    console.warn('Output analyser setup failed:', e);
  }
}

function setupMicAnalyser() {
  try {
    if (!room || !room.localParticipant) return;
    const micPub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
    if (!micPub || !micPub.track) return;

    const stream = new MediaStream([micPub.track.mediaStreamTrack]);
    const ctx = getAudioContext();
    const source = ctx.createMediaStreamSource(stream);
    inputAnalyser = ctx.createAnalyser();
    inputAnalyser.fftSize = 64;
    source.connect(inputAnalyser);
    startVisualizer('input');
  } catch (e) {
    console.warn('Mic analyser setup failed:', e);
  }
}

// --- Visualizer ---

function startVisualizer(mode) {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }

  const activeAnalyser = mode === 'input' ? inputAnalyser : outputAnalyser;
  if (!activeAnalyser) return;

  activeAnalyser.fftSize = 256;
  const freqData = new Uint8Array(activeAnalyser.frequencyBinCount);

  function animate() {
    activeAnalyser.getByteFrequencyData(freqData);

    const voiceEnd = 60;
    const binsPer = Math.floor(voiceEnd / BAR_COUNT);

    for (let i = 0; i < BAR_COUNT; i++) {
      let sum = 0;
      const start = i * binsPer + 1;
      for (let j = start; j < start + binsPer; j++) {
        sum += freqData[j];
      }
      const avg = sum / binsPer / 255;
      const boosted = Math.min(1, avg * 2);

      const center = (BAR_COUNT - 1) / 2;
      const dist = Math.abs(i - center) / center;
      const weight = 1 - dist * 0.2;

      const height = Math.max(14, boosted * weight * 100);
      bars[i].style.height = height + 'px';
    }
    animFrameId = requestAnimationFrame(animate);
  }
  animate();
}

function startThinkingAnimation() {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  bars.forEach(b => { b.classList.remove('input', 'output', 'idle'); b.classList.add('thinking'); });

  function animate() {
    const t = performance.now() / 1000;
    for (let i = 0; i < BAR_COUNT; i++) {
      const phase = (i / BAR_COUNT) * Math.PI * 2;
      const wave = Math.sin(t * 2.5 - phase);
      const height = 16 + (wave + 1) * 0.5 * 40;
      bars[i].style.height = height + 'px';
    }
    animFrameId = requestAnimationFrame(animate);
  }
  animate();
}

function stopVisualizer() {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  bars.forEach(bar => {
    bar.style.height = '14px';
    bar.classList.remove('input', 'output', 'thinking');
    bar.classList.add('idle');
  });
}

// --- Disconnect ---

async function disconnect() {
  if (room) await room.disconnect();
  handleDisconnect();
}

function handleDisconnect() {
  stopVisualizer();
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    outputAnalyser = null;
    inputAnalyser = null;
  }
  room = null;
  agentHasConnected = false;
  agentIsConnected = false;
  agentIsSpeaking = false;
  agentParticipantSid = null;

  setMode('off');
  document.getElementById('connect-btn').disabled = false;
  document.querySelectorAll('audio').forEach(el => el.remove());
  showView('login');
  setStatus('Disconnected', '');
}

document.getElementById('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connect();
});
