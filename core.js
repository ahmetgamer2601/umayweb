/* UMAY çekirdek: ön işleme, çözme (decode), NMS ve konuşma cümlesi mantığı.
   Hem tarayıcıda (window.UmayCore) hem Node'da (testler) çalışır. */
(function (g) {
  'use strict';

  /* YOLOX ham çıktısını çöz: [N, 5+C] → kutular. strides: [8,16,32] */
  function makeGrids(size, strides) {
    const gx = [], gy = [], st = [];
    for (const s of strides) {
      const n = Math.floor(size / s);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { gx.push(x); gy.push(y); st.push(s); }
    }
    return { gx: Int16Array.from(gx), gy: Int16Array.from(gy), st: Int16Array.from(st), n: gx.length };
  }

  /* data: Float32Array [N*(5+C)]; döner: [{x1,y1,x2,y2,score,cls}] (model giriş uzayında, piksel) */
  function decode(data, grids, numClasses, scoreThr, rawDecode) {
    const stride = 5 + numClasses, out = [];
    for (let i = 0; i < grids.n; i++) {
      const o = i * stride, obj = data[o + 4];
      if (obj < scoreThr) continue;            // obj*cls <= obj olduğundan güvenli ön eleme
      let best = -1, bs = 0;
      for (let c = 0; c < numClasses; c++) { const v = data[o + 5 + c]; if (v > bs) { bs = v; best = c; } }
      const score = obj * bs;
      if (score < scoreThr) continue;
      let cx, cy, w, h;
      if (rawDecode) {
        const s = grids.st[i];
        cx = (data[o] + grids.gx[i]) * s; cy = (data[o + 1] + grids.gy[i]) * s;
        w = Math.exp(data[o + 2]) * s;    h = Math.exp(data[o + 3]) * s;
      } else { cx = data[o]; cy = data[o + 1]; w = data[o + 2]; h = data[o + 3]; }
      out.push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, score, cls: best });
    }
    return out;
  }

  function iou(a, b) {
    const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1), x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const ua = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
    return ua > 0 ? inter / ua : 0;
  }

  /* sınıf bazlı NMS */
  function nms(boxes, iouThr, maxOut) {
    boxes.sort((a, b) => b.score - a.score);
    const keep = [];
    for (const b of boxes) {
      let ok = true;
      for (const k of keep) { if (k.cls === b.cls && iou(k, b) > iouThr) { ok = false; break; } }
      if (ok) { keep.push(b); if (keep.length >= (maxOut || 50)) break; }
    }
    return keep;
  }

  /* model uzayından (letterbox) kare uzayına: ölçek r, sol-üst yerleşim */
  function toFrame(boxes, r, fw, fh) {
    return boxes.map(b => ({
      x1: Math.max(0, b.x1 / r), y1: Math.max(0, b.y1 / r),
      x2: Math.min(fw, b.x2 / r), y2: Math.min(fh, b.y2 / r),
      score: b.score, cls: b.cls
    })).filter(b => b.x2 - b.x1 > 2 && b.y2 - b.y1 > 2);
  }

  /* yön ve yakınlık */
  function direction(b, fw) {
    const c = (b.x1 + b.x2) / 2 / fw;
    return c < 0.34 ? 'sol' : c > 0.66 ? 'sag' : 'on';
  }
  function nearness(b, fw, fh) {           // 0..1+ ; büyük = yakın
    const hr = (b.y2 - b.y1) / fh, ar = ((b.x2 - b.x1) * (b.y2 - b.y1)) / (fw * fh);
    return Math.max(hr * 0.8, Math.sqrt(ar));
  }
  const DIR_TR = { sol: 'solunuzda', sag: 'sağınızda', on: 'önünüzde' };

  /* Ham algılamalardan konuşulacak adayları üret.
     classes: [{tr, say, w}]  (w: öncelik çarpanı) */
  function candidates(dets, classes, fw, fh, nearThr) {
    const list = [];
    for (const d of dets) {
      const cl = classes[d.cls]; if (!cl || !cl.say) continue;
      const dir = direction(d, fw), near = nearness(d, fw, fh);
      list.push({
        key: d.cls + ':' + dir, cls: d.cls, dir, near,
        isNear: near >= nearThr,
        prio: (cl.w || 1) * (near + 0.15) * (dir === 'on' ? 1.25 : 1),
        name: cl.tr, score: d.score
      });
    }
    // aynı anahtardan en yakını kalsın
    const best = new Map();
    for (const c of list) { const o = best.get(c.key); if (!o || c.prio > o.prio) best.set(c.key, c); }
    return [...best.values()].sort((a, b) => b.prio - a.prio);
  }

  function phrase(c) {
    const where = DIR_TR[c.dir];
    return (c.isNear ? 'Dikkat, ' + where + ' yakın ' : where + ' ') + c.name + (c.isNear ? '' : ' var');
  }

  /* Konuşma zamanlayıcı: titremeyi önler (2/3 kare), tekrar süresini uygular */
  function Speaker(opts) {
    this.repeatMs = opts.repeatMs; this.hist = new Map(); this.lastSaid = new Map(); this.lastNear = new Map();
  }
  Speaker.prototype.update = function (cands, now) {
    const seenKeys = new Set(cands.map(c => c.key));
    for (const c of cands) {
      const h = this.hist.get(c.key) || [];
      h.push(1); if (h.length > 3) h.shift(); this.hist.set(c.key, h);
    }
    for (const [k, h] of this.hist) { if (!seenKeys.has(k)) { h.push(0); if (h.length > 3) h.shift(); if (h.every(v => !v)) this.hist.delete(k); } }
    const out = [];
    for (const c of cands) {
      const h = this.hist.get(c.key) || [];
      const stable = h.reduce((a, b) => a + b, 0) >= 2;
      if (!stable) continue;
      const last = this.lastSaid.get(c.key) || -1e9;
      const wasNear = this.lastNear.get(c.key) || false;
      const becameNear = c.isNear && !wasNear;
      const rep = c.isNear ? Math.min(this.repeatMs, 3500) : this.repeatMs;
      if (becameNear || now - last >= rep) out.push(c);
    }
    return out;
  };
  Speaker.prototype.markSaid = function (c, now) { this.lastSaid.set(c.key, now); this.lastNear.set(c.key, c.isNear); };
  Speaker.prototype.markNotNear = function (cands) {
    const nearKeys = new Set(cands.filter(c => c.isNear).map(c => c.key));
    for (const k of this.lastNear.keys()) if (!nearKeys.has(k)) this.lastNear.set(k, false);
  };

  g.UmayCore = { makeGrids, decode, iou, nms, toFrame, direction, nearness, candidates, phrase, Speaker };
  if (typeof module !== 'undefined' && module.exports) module.exports = g.UmayCore;
})(typeof window !== 'undefined' ? window : globalThis);
