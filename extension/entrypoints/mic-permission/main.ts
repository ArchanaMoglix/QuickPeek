const button = document.getElementById('allow') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLParagraphElement;
const test = document.getElementById('test') as HTMLDivElement;
const device = document.getElementById('device') as HTMLParagraphElement;
const level = document.getElementById('level') as HTMLDivElement;
const hint = document.getElementById('hint') as HTMLParagraphElement;

// Mic ki live awaaz dikhao, taaki pata chale Chrome tak awaaz pahunch rahi hai ya nahi
function showLevel(stream: MediaStream) {
  const track = stream.getAudioTracks()[0];
  device.textContent = `Chrome is using: ${track?.label || 'unknown microphone'}`;
  test.hidden = false;

  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  let heard = false;

  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    const pct = Math.min(100, (peak / 128) * 300);
    level.style.width = `${pct}%`;
    if (pct > 15 && !heard) {
      heard = true;
      hint.textContent = '✅ Chrome can hear you. You can close this tab and use the mic in Quick Peek.';
    }
    requestAnimationFrame(tick);
  };
  tick();
}

async function requestMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    status.textContent = '✅ Microphone allowed.';
    button.hidden = true;
    showLevel(stream);
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    status.textContent =
      name === 'NotFoundError'
        ? '❌ No microphone found. Plug one in (on Mac, also allow Chrome in System Settings → Privacy & Security → Microphone).'
        : `❌ Microphone was blocked (${name || 'unknown error'}). Click the icon in the address bar to allow it, then try again.`;
  }
}

button.addEventListener('click', requestMic);
requestMic();
