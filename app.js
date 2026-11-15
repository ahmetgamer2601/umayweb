(function () {
  'use strict';
  const C = window.UmayCore;
  const $ = id => document.getElementById(id);

  const el = {
    video: $('video'), overlay: $('overlay'), idle: $('idle'), say: $('say'), status: $('status'),
    go: $('go'), snap: $('snap'), test: $('test'),
    thr: $('thr'), rep: $('rep'), rate: $('rate'), fps: $('fps'), boxes: $('boxes'), speakOn: $('speakOn'),
    vThr: $('v-thr'), vRep: $('v-rep'), vRate: $('v-rate'), vFps: $('v-fps'),
    sMs: $('s-ms'), sFps: $('s-fps'), sEng: $('s-eng')
  };

  /* ---------- ayarlar ---------- */
  const DEF = { thr: 0.45, rep: 8, rate: 1.0, fps: 4, boxes: true, speakOn: true };
  let S = Object.assign({}, DEF);
  try { Object.assign(S, JSON.parse(localStorage.getItem('umay.settings') || '{}')); } catch (e) {}
  function saveS() { try { localStorage.setItem('umay.settings', JSON.stringify(S)); } catch (e) {} }
  function syncUI() {
    el.thr.value = S.thr; el.rep.value = S.rep; el.rate.value = S.rate; el.fps.value = S.fps;
    el.boxes.checked = S.boxes; el.speakOn.checked = S.speakOn;
    el.vThr.textContent = Math.round(S.thr * 100) + '%'; el.vRep.textContent = S.rep + ' sn';
    el.vRate.textContent = Number(S.rate).toFixed(2) + '×'; el.vFps.textContent = S.fps;
  }
  [['thr', 'range'], ['rep', 'range'], ['rate', 'range'], ['fps', 'range']].forEach(([k]) => {
    el[k].addEventListener('input', () => { S[k] = parseFloat(el[k].value); saveS(); syncUI(); if (speaker) speaker.repeatMs = S.rep * 1000; });
  });
  el.boxes.addEventListener('change', () => { S.boxes = el.boxes.checked; saveS(); if (!S.boxes) clearOverlay(); });
  el.speakOn.addEventListener('change', () => { S.speakOn = el.speakOn.checked; saveS(); });
  syncUI();

  /* ---------- yardımcılar ---------- */
  function setStatus(t, err) { el.status.textContent = t || ''; el.status.classList.toggle('err', !!err); }
  function setSay(t, alert) { el.say.textContent = t; el.say.classList.toggle('alert', !!alert); }
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(src)); document.head.appendChild(s); });
  }

  /* ---------- konuşma ---------- */
  let trVoice = null;
  function pickVoice() {
    if (!('speechSynthesis' in window)) return;
    const vs = speechSynthesis.getVoices();
    trVoice = vs.find(v => /^tr([-_]|$)/i.test(v.lang)) || null;
  }
  if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  let speaking = false;
  function speak(text, urgent) {
    if (!S.speakOn || !('speechSynthesis' in window)) return false;
    if (urgent) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'tr-TR'; if (trVoice) u.voice = trVoice; u.rate = S.rate;
    speaking = true; u.onend = u.onerror = () => { speaking = false; };
    speechSynthesis.speak(u); return true;
  }
  el.test.addEventListener('click', () => {
    pickVoice();
    if (!('speechSynthesis' in window)) { setStatus('Bu tarayıcı sesli okumayı desteklemiyor.', true); return; }
    speechSynthesis.cancel(); speaking = false;
    speak('UMAY hazır. Önünüzde sandalye var.', false);
    setStatus(trVoice ? 'Türkçe ses: ' + trVoice.name : 'Telefonda Türkçe ses bulunamadı; ayarlardan Türkçe ses paketini yükleyin.', !trVoice);
  });

  /* ---------- model ---------- */
  let cfg = null, session = null, grids = null, inputName = 'images', outName = 'output';
  const N = () => cfg.input;
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  let inBuf = null;

  async function loadModel() {
    setStatus('Model yükleniyor…');
    cfg = await (await fetch('config.json', { cache: 'no-cache' })).json();
    const buf = await (await fetch(cfg.model)).arrayBuffer();
    if (window.ort && window.ort.__preset) {            // yalnızca test için
      session = await ort.InferenceSession.create(buf, {});
    } else {
      // Bazı telefonlar büyük wasm sürümlerinde "Out of memory" verir; sırayla daha hafif sürümleri dene.
      const CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@';
      const VARIANTS = [
        { name: '1.20 (wasm)', js: CDN + '1.20.1/dist/ort.wasm.min.js', base: CDN + '1.20.1/dist/' },
        { name: '1.16', js: CDN + '1.16.3/dist/ort.min.js', base: CDN + '1.16.3/dist/' },
        { name: '1.14', js: CDN + '1.14.1/dist/ort.min.js', base: CDN + '1.14.1/dist/' }
      ];
      const errs = [];
      // iOS/Safari: paylaşımlı bellek isteyen yeni sürümler "Out of memory" verir; eski, tek iş parçacıklı sürümle başla.
      if (/iP(hone|ad|od)|Macintosh.*Safari(?!.*Chrome)/.test(navigator.userAgent) && 'ontouchend' in document) VARIANTS.reverse();
      for (const v of VARIANTS) {
        try {
          setStatus('Model yükleniyor… (' + v.name + ')');
          window.ort = undefined; await loadScript(v.js);
          if (!window.ort) throw new Error('kütüphane yüklenemedi');
          ort.env.wasm.wasmPaths = v.base; ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
          session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
          el.sEng.textContent = 'ort ' + v.name; break;
        } catch (e) { errs.push(v.name + ': ' + (e && e.message || e)); session = null; }
      }
      if (!session) throw new Error('Model çalıştırılamadı. ' + errs.join(' | '));
    }
    inputName = session.inputNames ? session.inputNames[0] : 'images';
    outName = session.outputNames ? session.outputNames[0] : 'output';
    work.width = work.height = N();
    inBuf = new Float32Array(3 * N() * N());
    grids = C.makeGrids(N(), cfg.strides);
  }

  function preprocess() {
    const n = N(), vw = el.video.videoWidth, vh = el.video.videoHeight;
    const r = Math.min(n / vw, n / vh), w = Math.round(vw * r), h = Math.round(vh * r);
    wctx.fillStyle = 'rgb(114,114,114)'; wctx.fillRect(0, 0, n, n);
    wctx.drawImage(el.video, 0, 0, w, h);
    const d = wctx.getImageData(0, 0, n, n).data, plane = n * n;
    const bgr = cfg.bgr !== false, k = cfg.scale255 === false ? 1 / 255 : 1;
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      const R = d[p], G = d[p + 1], B = d[p + 2];
      if (bgr) { inBuf[i] = B * k; inBuf[plane + i] = G * k; inBuf[2 * plane + i] = R * k; }
      else { inBuf[i] = R * k; inBuf[plane + i] = G * k; inBuf[2 * plane + i] = B * k; }
    }
    return r;
  }

  async function detect() {
    const r = preprocess();
    const t = new ort.Tensor('float32', inBuf, [1, 3, N(), N()]);
    const res = await session.run({ [inputName]: t });
    const out = res[outName].data;
    let boxes = C.decode(out, grids, cfg.classes.length, Math.min(S.thr, 0.9), cfg.rawDecode !== false);
    boxes = C.nms(boxes, 0.45, 40);
    return C.toFrame(boxes, r, el.video.videoWidth, el.video.videoHeight);
  }

  /* ---------- çizim ---------- */
  const octx = el.overlay.getContext('2d');
  function clearOverlay() { octx.clearRect(0, 0, el.overlay.width, el.overlay.height); }
  function draw(dets) {
    const cw = el.overlay.clientWidth, ch = el.overlay.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (el.overlay.width !== cw * dpr) { el.overlay.width = cw * dpr; el.overlay.height = ch * dpr; }
    octx.setTransform(dpr, 0, 0, dpr, 0, 0); octx.clearRect(0, 0, cw, ch);
    if (!S.boxes) return;
    const vw = el.video.videoWidth, vh = el.video.videoHeight;
    const sc = Math.max(cw / vw, ch / vh), ox = (cw - vw * sc) / 2, oy = (ch - vh * sc) / 2;   // object-fit: cover
    octx.lineWidth = 2; octx.font = '600 13px system-ui,sans-serif'; octx.textBaseline = 'top';
    for (const d of dets) {
      const cl = cfg.classes[d.cls], x = d.x1 * sc + ox, y = d.y1 * sc + oy, w = (d.x2 - d.x1) * sc, h = (d.y2 - d.y1) * sc;
      const col = cl.say ? '#3fd0b4' : '#7d86a8';
      octx.strokeStyle = col; octx.strokeRect(x, y, w, h);
      const label = cl.tr + ' ' + Math.round(d.score * 100);
      const tw = octx.measureText(label).width + 8;
      octx.fillStyle = col; octx.fillRect(x, Math.max(0, y - 18), tw, 18);
      octx.fillStyle = '#04110e'; octx.fillText(label, x + 4, Math.max(0, y - 18) + 2);
    }
  }

  /* ---------- ana döngü ---------- */
  let running = false, stream = null, speaker = null, wakeLock = null, lastDets = [];
  let frames = 0, tFps = 0;
  const NEAR = 0.5;

  async function wake() {
    try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); } } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') wake(); });

  async function start() {
    el.go.disabled = true;
    try {
      // sesi kullanıcı dokunuşuyla "uyandır" (iOS/Android kısıtı)
      if ('speechSynthesis' in window) { pickVoice(); const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); }
      setStatus('Kamera açılıyor…');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Bu tarayıcıda kamera kullanılamıyor. Adres https:// ile başlamalı.');
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      el.video.srcObject = stream; await el.video.play();
      if (!session) await loadModel();
      speaker = new C.Speaker({ repeatMs: S.rep * 1000 });
      running = true; tFps = performance.now(); frames = 0; el.idle.hidden = true; el.snap.disabled = false;
      el.go.textContent = 'Durdur'; el.go.classList.add('stop');
      setStatus(trVoice || !('speechSynthesis' in window) ? 'Çalışıyor' : 'Çalışıyor (Türkçe ses bulunamadı, varsayılan ses kullanılıyor)');
      setSay('Dinleniyor…'); wake(); loop();
      speak('UMAY hazır', true);
    } catch (e) {
      setStatus(friendly(e), true); stop(true);
    } finally { el.go.disabled = false; }
  }
  function friendly(e) {
    const m = (e && (e.name || '')) + ' ' + (e && e.message || e);
    if (/NotAllowed|Permission/i.test(m)) return 'Kamera izni verilmedi. Tarayıcı ayarlarından izin verip tekrar deneyin.';
    if (/NotFound|Devices/i.test(m)) return 'Kamera bulunamadı.';
    if (/NotReadable/i.test(m)) return 'Kamera başka bir uygulama tarafından kullanılıyor.';
    return String(e && e.message || e);
  }
  function stop(keepStatus) {
    running = false;
    if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; el.video.srcObject = null;
    try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null;
    try { speechSynthesis.cancel(); } catch (e) {}
    clearOverlay(); el.idle.hidden = false; el.snap.disabled = true;
    el.go.textContent = 'Başlat'; el.go.classList.remove('stop'); setSay('Durduruldu');
    if (!keepStatus) setStatus('');
  }
  el.go.addEventListener('click', () => { running ? stop() : start(); });

  async function loop() {
    let tickN = 0;
    while (running) {
      const t0 = performance.now();
      try {
        if (el.video.readyState >= 2 && el.video.videoWidth) {
          const dets = await detect(); lastDets = dets;
          const ms = performance.now() - t0;
          draw(dets);
          handleSpeech(dets);
          frames++; tickN++;
          el.sMs.textContent = Math.round(ms) + ' ms';
          const now = performance.now();
          if (now - tFps >= 1000) { el.sFps.textContent = (frames * 1000 / (now - tFps)).toFixed(1) + ' kare/sn'; frames = 0; tFps = now; }
        }
      } catch (e) { setStatus('Algılama hatası: ' + (e.message || e), true); await new Promise(r => setTimeout(r, 800)); }
      const wait = Math.max(0, 1000 / S.fps - (performance.now() - t0));
      await new Promise(r => setTimeout(r, wait));
    }
  }

  function handleSpeech(dets) {
    const now = performance.now();
    const cands = C.candidates(dets, cfg.classes, el.video.videoWidth, el.video.videoHeight, NEAR);
    speaker.repeatMs = S.rep * 1000;
    const ready = speaker.update(cands, now);
    speaker.markNotNear(cands);
    if (!ready.length) { if (!cands.length && !speaking) setSay('Dinleniyor…'); return; }
    const top = ready.slice(0, 2);
    const urgent = top[0].isNear;
    if (speaking && !urgent) return;                  // acil değilse mevcut cümleyi bölme
    const text = top.map(C.phrase).join('. ');
    setSay(text, urgent);
    if (speak(text, urgent) || !S.speakOn) top.forEach(c => speaker.markSaid(c, now));
  }

  /* ---------- fotoğraf kaydet (ince ayar verisi) ---------- */
  el.snap.addEventListener('click', () => {
    if (!running) return;
    const c = document.createElement('canvas'); c.width = el.video.videoWidth; c.height = el.video.videoHeight;
    c.getContext('2d').drawImage(el.video, 0, 0);
    c.toBlob(b => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(b);
      const d = new Date(), p = n => String(n).padStart(2, '0');
      a.download = 'umay_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.jpg';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      setStatus('Fotoğraf kaydedildi');
    }, 'image/jpeg', 0.92);
  });

  window.addEventListener('pagehide', () => { if (running) stop(true); });
  window.__umay = { get lastDets() { return lastDets; } };   // yalnızca test için
})();
