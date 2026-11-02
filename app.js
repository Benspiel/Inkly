/* Inkly – Text in eine Goodnotes-Datei verwandeln.
 *
 * Grundlage (siehe goodnotes.txt): Eine echte, aus Goodnotes exportierte .goodnotes-Datei
 * dient als Hülle. Eingebaute Vorlagen kommen aus templates.js (window.GOODI_TEMPLATES).
 *
 * Zwei Ausgabearten:
 *  - "ink": Die Zeichen der Handschrift-Schrift werden skelettiert und als echte
 *    Goodnotes-Stiftstriche in notes/<ID> geschrieben – radierbar, auswählbar, umfärbbar.
 *    Die Papier-PDF der Vorlage bleibt unverändert.
 *  - "pdf": Der Text wird als Bild in die PDF-Anlage (attachments/<ID>) eingebettet.
 *
 * In beiden Fällen werden die UUID-Bezeichner konsistent neu vergeben (gleiche Länge, daher
 * bleiben die Protobuf-Längenpräfixe gültig), damit jeder Export ein eigenes Notizbuch ist.
 *
 * Strichformat (aus Testdateien ermittelt): notes/<ID> ist eine Folge von Protobuf-Datensätzen
 * mit Längenpräfix, je Strich ein Kopf- und ein Inhaltsdatensatz. Die Punktdaten liegen
 * LZ4-komprimiert im Apple-Rahmen ("bv41" … "bv4$") in einem "tpl"-Block mit dem Schema
 * vuA(v)A(S(uu))A(S(uuuu))vA(f): Version, Breite, Segmenttypen, Startpunkt, quadratische
 * Segmente (Kontrollpunkt + Endpunkt), Endkennung, Druckwerte. Koordinaten in Goodnotes-
 * Einheiten = PDF-Punkte × 11/6, Ursprung oben links.
 */
(() => {
  "use strict";

  const A4 = [595.28, 841.89];
  const PAGE_W = 1654; // ~200 dpi bei A4-Breite
  const GN_SCALE = 11 / 6; // Goodnotes-Einheiten pro PDF-Punkt
  const STORAGE_KEY = "inkly.template.v1";
  const UUID_RE = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g;
  // In jedem Goodnotes-Export identisch (auch über verschiedene Notizbücher hinweg) –
  // eine feste Kennung, die beim Neuvergeben der IDs unverändert bleiben muss.
  const KEEP_IDS = new Set(["5A53E89E-F4C2-4548-8DD3-E9DF9FB4592E"]);
  const TPL_SCHEMA = "vuA(v)A(S(uu))A(S(uuuu))vA(f)";

  // Maße in PDF-Punkten, gemessen von der Seitenoberkante (aus den Goodnotes-Vorlagen).
  const PAPERS = {
    lined:         { label: "Liniert",     spacing: 25,   first: 49.5, rows: true,  startSlot: 1, font: 0.95 },
    "lined-small": { label: "Eng liniert", spacing: 17.5, first: 50,   rows: true,  startSlot: 1, font: 1.05 },
    grid:          { label: "Kariert",     spacing: 16,   first: 15.5, rows: true,  cols: 15.5, startSlot: 3, font: 1.15 },
    blank:         { label: "Blanko",      spacing: 25,   first: 49.5, rows: false, startSlot: 1, font: 0.95 },
  };
  const LINE_COLOR = "#d0d2d3";
  const LINE_PT = 0.5;

  const state = {
    mode: "ink",
    font: "Caveat",
    weight: 1,        // Strichstärke-Faktor im Tinten-Modus (1 = wie die Schrift)
    paper: "lined",
    ink: "#1d3f9e",
    size: 1,
    jitter: 1,
    custom: null, // eigene Vorlage { name, bytes, pdfPath, pageSize, hasInk }
    builtin: {},  // Cache der eingebauten Vorlagen
    pages: [],    // Vorschau-Canvas je Seite
    inkPages: [], // Striche je Seite (Pixelkoordinaten der Vorschau)
    user: null,   // angemeldetes Appwrite-Konto
    hand: null,   // eigene Handschrift { glyphs: { ch: { adv, strokes: [[x, y], …][] } } } in Geviert-Einheiten
  };

  // Eigene, selbst gezeichnete Handschrift (Profil). Wird statt einer Schriftdatei verwendet.
  const HAND_ID = "__hand__";
  const HAND_W = 0.075;      // Strichbreite in Geviert-Einheiten
  const HAND_SPACE = 0.32;   // Breite eines Leerzeichens
  const HAND_MISSING = 0.45; // Vorschub für nicht gezeichnete Zeichen
  const HAND_ALIAS = { "„": '"', "“": '"', "”": '"', "«": '"', "»": '"', "‚": "'", "‘": "'", "’": "'", "–": "-", "—": "-", "•": "." };
  const isHand = () => state.font === HAND_ID && !!state.hand;
  function handGlyph(ch) {
    const g = state.hand && state.hand.glyphs;
    if (!g) return null;
    if (g[ch]) return g[ch];
    const alt = HAND_ALIAS[ch] || (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase());
    return g[alt] || null;
  }
  const handAdvance = (ch) => (ch.trim() ? (handGlyph(ch) || { adv: HAND_MISSING }).adv : HAND_SPACE);

  const $ = (id) => document.getElementById(id);
  const els = {
    text: $("textInput"),
    preview: $("preview"),
    pageCount: $("pageCount"),
    size: $("sizeInput"),
    sizeVal: $("sizeVal"),
    jitter: $("jitterInput"),
    jitterVal: $("jitterVal"),
    width: $("widthInput"),
    widthVal: $("widthVal"),
    drop: $("dropzone"),
    tplInput: $("templateInput"),
    tplTitle: $("templateTitle"),
    tplInfo: $("templateInfo"),
    tplBadge: $("templateBadge"),
    tplActions: $("templateActions"),
    tplDetails: $("customTemplate"),
    forget: $("forgetTemplate"),
    status: $("statusText"),
    fileName: $("fileName"),
    exportGn: $("exportGn"),
    exportPdf: $("exportPdf"),
    toast: $("toast"),
    fontGrid: $("fontGrid"),
    fontAdd: $("fontAdd"),
    fontInput: $("fontInput"),
    handTile: $("handTile"),
    handLock: $("handLock"),
    handEdit: $("handEdit"),
    accountBtn: $("accountBtn"),
    authDialog: $("authDialog"),
    authForm: $("authForm"),
    authTitle: $("authTitle"),
    authReason: $("authReason"),
    authName: $("authName"),
    authEmail: $("authEmail"),
    authPassword: $("authPassword"),
    authError: $("authError"),
    authSubmit: $("authSubmit"),
    authSwitch: $("authSwitch"),
    authSwitchText: $("authSwitchText"),
    profileDialog: $("profileDialog"),
    profileName: $("profileName"),
    profileEmail: $("profileEmail"),
    profileHand: $("profileHand"),
    profileEditHand: $("profileEditHand"),
    logout: $("logoutBtn"),
    handDialog: $("handDialog"),
    handChar: $("handChar"),
    handProgress: $("handProgress"),
    handPad: $("handPad"),
    handPrev: $("handPrev"),
    handNext: $("handNext"),
    handUndo: $("handUndo"),
    handClear: $("handClear"),
    handStrip: $("handStrip"),
    handSave: $("handSave"),
    handSaveInfo: $("handSaveInfo"),
    verifyDialog: $("verifyDialog"),
    verifyEmail: $("verifyEmail"),
    verifyError: $("verifyError"),
    verifyCheck: $("verifyCheck"),
    verifyResend: $("verifyResend"),
    profileVerified: $("profileVerified"),
  };

  /* ---------- Hilfsfunktionen ---------- */

  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let toastTimer;
  function toast(msg, isError = false) {
    els.toast.textContent = msg;
    els.toast.classList.toggle("error", isError);
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 4500);
  }

  const latin1 = {
    decode: (u8) => {
      let s = "";
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return s;
    },
    encode: (s) => {
      const u8 = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
      return u8;
    },
  };

  const startsWithPdf = (u8) => u8.length > 5 && latin1.decode(u8.subarray(0, 5)) === "%PDF-";

  function readPdfPageSize(u8) {
    const head = latin1.decode(u8.subarray(0, Math.min(u8.length, 200000)));
    const m = head.match(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/);
    if (!m) return A4;
    const w = parseFloat(m[3]) - parseFloat(m[1]);
    const h = parseFloat(m[4]) - parseFloat(m[2]);
    return w > 0 && h > 0 ? [w, h] : A4;
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  const safeName = (s) => (s || "Notiz").trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "Notiz";

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  }

  /* ---------- Protobuf (minimal) ---------- */

  const pb = {
    // Varint aus Number (bis 2^53) oder BigInt
    varint(n) {
      const out = [];
      if (typeof n === "bigint") {
        do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b); } while (n);
      } else {
        do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
      }
      return Uint8Array.from(out);
    },
    concat(parts) {
      const len = parts.reduce((s, p) => s + p.length, 0);
      const out = new Uint8Array(len);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    },
    v: (f, n) => pb.concat([pb.varint(f * 8), pb.varint(n)]),
    bytes: (f, b) => pb.concat([pb.varint(f * 8 + 2), pb.varint(b.length), b]),
    str: (f, s) => pb.bytes(f, new TextEncoder().encode(s)),
    f32(f, x) {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, x, true);
      return pb.concat([pb.varint(f * 8 + 5), b]);
    },
    // Liest Felder einer Nachricht: [{ f, wt, v }]; v ist BigInt (Varint) oder Uint8Array
    fields(b) {
      const out = [];
      let i = 0;
      const rv = () => {
        let r = 0n, s = 0n, c;
        do { c = b[i++]; r |= BigInt(c & 0x7f) << s; s += 7n; } while (c & 0x80);
        return r;
      };
      while (i < b.length) {
        const key = Number(rv());
        const f = key >> 3, wt = key & 7;
        let v;
        if (wt === 0) v = rv();
        else if (wt === 1) { v = b.subarray(i, i + 8); i += 8; }
        else if (wt === 5) { v = b.subarray(i, i + 4); i += 4; }
        else if (wt === 2) { const n = Number(rv()); v = b.subarray(i, i + n); i += n; }
        else throw new Error("wire type " + wt);
        if (!f || i > b.length) throw new Error("kein Protobuf");
        out.push({ f, wt, v });
      }
      return out;
    },
    // Datei aus Datensätzen mit Varint-Längenpräfix
    records(b) {
      const out = [];
      let i = 0;
      while (i < b.length) {
        let n = 0, s = 1, c;
        do { c = b[i++]; n += (c & 0x7f) * s; s *= 128; } while (c & 0x80);
        out.push(b.subarray(i, i + n)); i += n;
      }
      return out;
    },
  };

  /* ---------- Goodnotes-Striche ---------- */

  // LZ4-Block nur aus Literalen (gültig laut LZ4-Spezifikation) im Apple-Rahmen "bv41".
  function bv41(raw) {
    const n = raw.length;
    const head = [Math.min(n, 15) << 4];
    if (n >= 15) { let r = n - 15; while (r >= 255) { head.push(255); r -= 255; } head.push(r); }
    const blk = pb.concat([Uint8Array.from(head), raw]);
    const hdr = new Uint8Array(12);
    hdr.set(latin1.encode("bv41"));
    new DataView(hdr.buffer).setUint32(4, n, true);
    new DataView(hdr.buffer).setUint32(8, blk.length, true);
    return pb.concat([hdr, blk, latin1.encode("bv4$")]);
  }

  // Punktliste (Goodnotes-Einheiten) -> "tpl"-Block mit geraden quadratischen Segmenten.
  function strokeBlob(pts, width) {
    if (pts.length === 1) pts = [pts[0], pts[0]];
    const segs = pts.length - 1;
    const n = segs + 1;
    const schema = latin1.encode(TPL_SCHEMA + "\0");
    const dataLen = 2 + 4 + 4 + 2 * n + 4 + 8 + 4 + 16 * segs + 2 + 4;
    const total = 8 + schema.length + dataLen;
    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    buf.set(latin1.encode("tpl\0"));
    dv.setUint32(4, total, true);
    buf.set(schema, 8);
    let o = 8 + schema.length;
    dv.setUint16(o, 2, true); o += 2;
    dv.setFloat32(o, width, true); o += 4;
    dv.setUint32(o, n, true); o += 4;
    for (let i = 0; i < n; i++) { dv.setUint16(o, i === 0 ? 0 : 1, true); o += 2; }
    dv.setUint32(o, 1, true); o += 4;
    dv.setFloat32(o, pts[0][0], true); dv.setFloat32(o + 4, pts[0][1], true); o += 8;
    dv.setUint32(o, segs, true); o += 4;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      dv.setFloat32(o, (ax + bx) / 2, true); dv.setFloat32(o + 4, (ay + by) / 2, true);
      dv.setFloat32(o + 8, bx, true); dv.setFloat32(o + 12, by, true);
      o += 16;
    }
    dv.setUint16(o, 1, true); o += 2;
    dv.setUint32(o, 0, true);
    return buf;
  }

  const rand32 = () => crypto.getRandomValues(new Uint32Array(1))[0];

  function strokeRecords(stroke, author, seq, order) {
    const sid = newUuid();
    const clock = pb.concat([pb.v(1, 1), pb.v(2, rand32())]);
    const hdr = pb.concat([pb.str(1, sid), pb.bytes(2, clock), pb.v(8, author), pb.v(9, seq), pb.v(14, 5381), pb.v(16, 24)]);
    const color = pb.concat(stroke.rgba.map((c, i) => (c ? pb.f32(i + 1, c) : new Uint8Array(0))));
    const empty = new Uint8Array(0);
    const sortKey = pb.concat([order ? pb.v(1, order) : empty, pb.v(2, rand32())]);
    const body = pb.concat([
      pb.str(1, sid), pb.bytes(2, bv41(strokeBlob(stroke.pts, stroke.width))), pb.bytes(4, color),
      pb.bytes(6, empty), pb.bytes(7, pb.bytes(1, sortKey)), pb.bytes(9, empty),
      pb.bytes(15, clock), pb.bytes(20, empty), pb.v(21, 24),
    ]);
    const rec = pb.bytes(7, body);
    return pb.concat([pb.varint(hdr.length), hdr, pb.varint(rec.length), rec]);
  }

  // Geräte-/Autorenkennung aus dem Ereignisprotokoll der Vorlage (Feld 13 der Ereignisse).
  function authorOf(eventsBytes) {
    for (const r of pb.records(eventsBytes)) {
      for (const top of pb.fields(r)) {
        if (top.wt !== 2 || top.f < 10) continue;
        try {
          const hit = pb.fields(top.v).find((x) => x.f === 13 && x.wt === 0);
          if (hit) return hit.v;
        } catch (_) { /* kein verschachteltes Protobuf */ }
      }
    }
    throw new Error("Autorenkennung in der Vorlage nicht gefunden.");
  }

  /* ---------- Vorlagen ---------- */

  // Prüft eine .goodnotes-Datei und liefert die Infos, die der Export braucht.
  async function inspectTemplate(bytes, name) {
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    if (!names.some((n) => n.endsWith(".pb"))) throw new Error("Keine Goodnotes-Datei: es fehlen die .pb-Indexdateien.");

    const pdfPaths = [];
    for (const n of names.filter((n) => n.startsWith("attachments/"))) {
      if (startsWithPdf(await zip.file(n).async("uint8array"))) pdfPaths.push(n);
    }
    if (pdfPaths.length === 0) throw new Error("In der Vorlage wurde keine PDF-Seitenanlage gefunden.");
    if (pdfPaths.length > 1) throw new Error(`Die Vorlage enthält ${pdfPaths.length} PDF-Anlagen. Bitte ein einseitiges Notizbuch verwenden.`);

    const notePaths = names.filter((n) => n.startsWith("notes/"));
    if (notePaths.length !== 1) throw new Error("Die Vorlage muss genau eine Seite haben.");
    const hasInk = (await zip.file(notePaths[0]).async("uint8array")).length > 0;
    const pdfBytes = await zip.file(pdfPaths[0]).async("uint8array");
    return { name, bytes, pdfPath: pdfPaths[0], notePath: notePaths[0], pageSize: readPdfPageSize(pdfBytes), hasInk };
  }

  async function builtinTemplate(paper) {
    if (!state.builtin[paper]) {
      const src = (window.GOODI_TEMPLATES || {})[paper];
      if (!src) throw new Error("Eingebaute Vorlage fehlt (templates.js nicht geladen).");
      state.builtin[paper] = await inspectTemplate(latin1.encode(atob(src.data)).buffer, src.name);
    }
    return state.builtin[paper];
  }

  const activeTemplate = () => state.custom ? Promise.resolve(state.custom) : builtinTemplate(state.paper);
  const pageSize = () => (state.custom ? state.custom.pageSize : A4);

  /* ---------- Messen ---------- */

  const widthCache = new Map();
  function charWidth(ctx, ch) {
    const key = ctx.font + "|" + ch;
    let w = widthCache.get(key);
    if (w === undefined) { w = ctx.measureText(ch).width; widthCache.set(key, w); }
    return w;
  }

  function fontSpec(px, bold) {
    if (state.font === HAND_ID) return `400 ${px}px "Caveat"`;
    const weight = bold ? ({ Caveat: 600, Kalam: 700 }[state.font] || 400) : 400;
    return `${weight} ${px}px "${state.font}"`;
  }

  /* ---------- Glyphen in Striche umwandeln (Skelettierung) ----------
     Goodnotes-Tinte besteht aus Linien mit einer Breite, nicht aus gefüllten Flächen. Damit die
     Handschrift-Schriften trotzdem als echte Tinte erscheinen, wird jedes Zeichen groß gerendert,
     mit dem Zhang-Suen-Verfahren auf seine Mittellinie ausgedünnt und als Linienzug nachgezeichnet.
     Die Strichbreite kommt aus der Distanztransformation (Abstand der Mittellinie zum Rand). */
  const SKEL_EM = 160;
  const skeletonCache = new Map();

  function glyphSkeleton(bold, ch) {
    if (isHand()) {
      const gl = handGlyph(ch);
      const w = HAND_W * (bold ? 1.35 : 1);
      return { strokes: gl ? gl.strokes.map((pts) => ({ pts, w })) : [] };
    }
    const spec = fontSpec(SKEL_EM, bold);
    const key = spec + "|" + ch;
    if (skeletonCache.has(key)) return skeletonCache.get(key);

    const pad = Math.round(SKEL_EM * 0.35);
    const c = document.createElement("canvas");
    let ctx = c.getContext("2d");
    ctx.font = spec;
    const W = Math.ceil(ctx.measureText(ch).width + 2 * pad), H = Math.ceil(SKEL_EM * 1.8);
    const baseY = Math.round(SKEL_EM * 1.25);
    c.width = W; c.height = H;
    ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.font = spec;
    ctx.fillStyle = "#000";
    ctx.fillText(ch, pad, baseY);
    const rgba = ctx.getImageData(0, 0, W, H).data;
    const img = new Uint8Array(W * H);
    for (let i = 0; i < img.length; i++) img[i] = rgba[i * 4 + 3] > 110 ? 1 : 0;

    // Distanztransformation (Chamfer 3-4); Werte /3 ergeben Pixel
    const dt = new Float32Array(W * H);
    for (let i = 0; i < dt.length; i++) dt[i] = img[i] ? 1e9 : 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (img[i]) dt[i] = Math.min(dt[i], dt[i - 1] + 3, dt[i - W] + 3, dt[i - W - 1] + 4, dt[i - W + 1] + 4);
    }
    for (let y = H - 2; y > 0; y--) for (let x = W - 2; x > 0; x--) {
      const i = y * W + x;
      if (img[i]) dt[i] = Math.min(dt[i], dt[i + 1] + 3, dt[i + W] + 3, dt[i + W + 1] + 4, dt[i + W - 1] + 4);
    }

    // Zhang-Suen-Ausdünnung
    const sk = img.slice();
    const del = [];
    for (let changed = true; changed;) {
      changed = false;
      for (let step = 0; step < 2; step++) {
        del.length = 0;
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (!sk[i]) continue;
          const p2 = sk[i - W], p3 = sk[i - W + 1], p4 = sk[i + 1], p5 = sk[i + W + 1];
          const p6 = sk[i + W], p7 = sk[i + W - 1], p8 = sk[i - 1], p9 = sk[i - W - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (a !== 1) continue;
          if (step === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
          del.push(i);
        }
        for (const i of del) sk[i] = 0;
        if (del.length) changed = true;
      }
    }

    // Nachbarn; diagonale Verbindungen zählen nur, wenn kein gerader Umweg existiert
    const nb = (i) => {
      const out = [];
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) if (sk[i + dx + dy * W]) out.push(i + dx + dy * W);
      for (const [dx, dy] of [[1, -1], [1, 1], [-1, 1], [-1, -1]]) {
        if (sk[i + dx + dy * W] && !sk[i + dx] && !sk[i + dy * W]) out.push(i + dx + dy * W);
      }
      return out;
    };
    const pix = [];
    for (let i = 0; i < sk.length; i++) if (sk[i]) pix.push(i);
    const deg = new Map(pix.map((i) => [i, nb(i).length]));
    const seen = new Set();
    const ek = (a, b) => (a < b ? a * 1e6 + b : b * 1e6 + a);
    const walk = (start, next) => {
      const path = [start, next];
      seen.add(ek(start, next));
      let prev = start, cur = next;
      while (deg.get(cur) === 2) {
        const n = nb(cur).find((q) => q !== prev && !seen.has(ek(cur, q)));
        if (n === undefined) break;
        seen.add(ek(cur, n));
        path.push(n); prev = cur; cur = n;
      }
      return path;
    };
    let paths = [];
    for (const i of pix) {
      if (deg.get(i) === 0) { paths.push([i]); continue; }
      if (deg.get(i) === 2) continue;
      for (const n of nb(i)) if (!seen.has(ek(i, n))) paths.push(walk(i, n));
    }
    for (const i of pix) for (const n of nb(i)) if (!seen.has(ek(i, n))) paths.push(walk(i, n)); // Ringe

    // Kurze Äste (Artefakte an Ecken und Enden) entfernen
    const meanW = pix.length ? pix.reduce((s, i) => s + dt[i], 0) / pix.length / 3 : 1;
    if (paths.length > 1) {
      paths = paths.filter((pa) => {
        if (pa.length === 1) return true;
        const e1 = deg.get(pa[0]) === 1, e2 = deg.get(pa[pa.length - 1]) === 1;
        return !((e1 !== e2) && pa.length < meanW * 1.2);
      });
    }

    // Punkte in Geviert-Einheiten (Ursprung: Schreibposition auf der Grundlinie), vereinfachen, glätten
    const strokes = paths.map((pa) => {
      const w = 2 * pa.reduce((s, i) => s + dt[i], 0) / pa.length / 3 / SKEL_EM;
      let pts = pa.map((i) => [(i % W) - pad, Math.floor(i / W) - baseY]);
      pts = rdp(pts, 0.8);
      if (pts.length > 2) pts = chaikin(pts);
      return { pts: pts.map(([x, y]) => [x / SKEL_EM, y / SKEL_EM]), w };
    });
    const res = { strokes };
    skeletonCache.set(key, res);
    return res;
  }

  // Ramer-Douglas-Peucker-Vereinfachung
  function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
    if (Math.hypot(bx - ax, by - ay) < 1.5) {
      // Geschlossener Ring: am weitesten entfernten Punkt teilen, sonst fällt er zusammen
      let far = 1, best = 0;
      for (let i = 1; i < pts.length - 1; i++) {
        const d = Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
        if (d > best) { best = d; far = i; }
      }
      return rdp(pts.slice(0, far + 1), eps).slice(0, -1).concat(rdp(pts.slice(far), eps));
    }
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let max = 0, idx = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max <= eps) return [pts[0], pts[pts.length - 1]];
    return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
  }

  // Chaikin-Glättung (ein Durchgang), Endpunkte bleiben stehen
  function chaikin(pts) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  // Messschnittstelle: setSize(px, bold) + width(text)
  function makeMeasurer() {
    const ctx = document.createElement("canvas").getContext("2d");
    let size = 1;
    return {
      setSize(px, bold) { size = px; ctx.font = fontSpec(px, bold); },
      width(s) {
        let w = 0;
        if (isHand()) { for (const ch of s) w += handAdvance(ch) * size; return w; }
        for (const ch of s) w += charWidth(ctx, ch);
        return w;
      },
    };
  }

  /* ---------- Layout ---------- */

  // Seitengeometrie in Pixeln: Linien-/Zeilenpositionen, Ränder, Schriftgröße.
  function geometry() {
    const [wPt, hPt] = pageSize();
    const k = PAGE_W / wPt; // px pro pt
    const H = Math.round(hPt * k);
    const p = PAPERS[state.paper];
    // Auf Blanko-Papier verändert die Größe den Zeilenabstand, sonst nur die Schrift.
    const spacing = (p.rows ? p.spacing : p.spacing * state.size) * k;
    const first = p.first * k;
    const sizeF = p.rows ? state.size : 1;
    const base = Math.round(spacing * p.font * sizeF);
    const slotY = (i) => first + i * spacing; // Oberkante der i-ten Linie
    const bottom = 30 * k;
    let slots = 0;
    while (slotY(p.startSlot + slots) <= H - bottom) slots++;
    const left = (p.cols ? p.cols + 2 * p.spacing : 40) * k;
    return {
      k, W: PAGE_W, H, p, spacing, base, left,
      maxW: PAGE_W - left - 30 * k,
      slots,
      baseline: (i) => slotY(p.startSlot + i) - 2 * k,
    };
  }

  /* Text in Zeilen umbrechen und auf Seiten verteilen. Jede Zeile belegt ein oder zwei
     Linien des Papiers (Überschriften auf engem Papier zwei). */
  function layout(m, text, g) {
    const headSlots = g.spacing < 20 * g.k ? 2 : 1;
    const out = []; // { kind, text, indent, size, bold, bullet, slots }
    for (const raw of text.replace(/\r/g, "").split("\n")) {
      let kind = "p", content = raw.trimEnd();
      if (/^#{1,3}\s+/.test(content)) { kind = "h"; content = content.replace(/^#{1,3}\s+/, ""); }
      else if (/^\s*[-*•]\s+/.test(content)) { kind = "li"; content = content.replace(/^\s*[-*•]\s+/, ""); }

      if (!content.trim()) { out.push({ kind: "blank", slots: 1 }); continue; }

      const size = kind === "h" ? g.base * (headSlots === 2 ? 1.7 : 1.3) : g.base;
      const indent = kind === "li" ? g.base * 1.1 : 0;
      const slots = kind === "h" ? headSlots : 1;
      m.setSize(size, kind === "h");

      const avail = g.maxW - indent;
      const words = content.split(/(\s+)/).filter(Boolean);
      let line = "", first = true;
      const flush = () => {
        out.push({ kind, text: line.trim(), indent, size, bold: kind === "h", bullet: kind === "li" && first, slots });
        first = false; line = "";
      };
      for (const word of words) {
        const candidate = line + word;
        if (m.width(candidate.trim()) <= avail || !line.trim()) {
          // Überlange Einzelwörter hart umbrechen
          if (!line.trim() && m.width(word) > avail) {
            let chunk = "";
            for (const ch of word) {
              if (m.width(chunk + ch) > avail) { line = chunk; flush(); chunk = ""; }
              chunk += ch;
            }
            line = chunk;
          } else {
            line = candidate;
          }
        } else {
          flush();
          line = word.trim() ? word : "";
        }
      }
      if (line.trim()) flush();
    }

    // Auf Seiten verteilen; jede Zeile merkt sich ihre (letzte) Linie als Grundlinie.
    const pages = [[]];
    let used = 0;
    for (const l of out) {
      if (used + l.slots > g.slots) { pages.push([]); used = 0; }
      if (l.kind === "blank" && used === 0 && pages.length > 1) continue;
      used += l.slots;
      pages[pages.length - 1].push({ ...l, slot: used - 1 });
    }
    return pages;
  }

  /* ---------- Zeichnen ---------- */

  function drawPaper(ctx, g) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, g.W, g.H);
    const p = g.p;
    if (!p.rows) return;
    const t = Math.max(1, LINE_PT * g.k);
    ctx.fillStyle = LINE_COLOR;
    for (let y = p.first * g.k; y < g.H; y += p.spacing * g.k) ctx.fillRect(0, y, g.W, t);
    if (p.cols) for (let x = p.cols * g.k; x < g.W; x += p.spacing * g.k) ctx.fillRect(x, 0, t, g.H);
  }

  // PDF-Modus: Umrissschrift Zeichen für Zeichen leicht variiert auf die Seite malen.
  function drawOutlineLine(ctx, m, l, x, y, rnd, g) {
    if (isHand()) {
      const strokes = [];
      inkLineStrokes(m, l, x, y, rnd, strokes, g);
      drawInkStrokes(ctx, strokes, g);
      return;
    }
    const j = state.jitter;
    ctx.font = fontSpec(l.size, l.bold);
    const drift = (rnd() - 0.5) * 6 * j;
    const total = m.width(l.text) || 1;
    let cx = x;
    for (const ch of l.text) {
      const w = charWidth(ctx, ch);
      if (ch.trim()) {
        const dy = (rnd() - 0.5) * 5 * j + drift * ((cx - x) / total);
        const rot = (rnd() - 0.5) * 0.09 * j;
        const sc = 1 + (rnd() - 0.5) * 0.06 * j;
        ctx.save();
        ctx.translate(cx, y + dy);
        ctx.rotate(rot);
        ctx.scale(sc, sc);
        ctx.globalAlpha = 0.93 + rnd() * 0.07;
        ctx.fillText(ch, 0, 0);
        // zweiter, leicht versetzter Zug mit geringer Deckkraft (Tinteneffekt)
        ctx.globalAlpha = 0.22;
        ctx.fillText(ch, 0.9, 0.5);
        ctx.restore();
      }
      cx += w + (rnd() - 0.5) * 1.6 * j;
    }
    if (l.bold) {
      ctx.save();
      ctx.lineWidth = Math.max(2, l.size * 0.05);
      ctx.lineCap = "round";
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(x - 4, y + l.size * 0.14);
      ctx.quadraticCurveTo(x + total / 2, y + l.size * 0.14 + (rnd() - 0.5) * 10, x + total + 6, y + l.size * 0.1);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Tinten-Modus: Zeile als Liste von Strichen (Pixelkoordinaten) aufbauen – dieselbe
  // Variation wie im PDF-Modus, nur aus den skelettierten Zeichen statt aus fillText.
  function inkLineStrokes(m, l, x, y, rnd, out, g) {
    const j = state.jitter;
    const toGn = GN_SCALE / g.k; // px -> Goodnotes-Einheiten
    m.setSize(l.size, l.bold);
    const drift = (rnd() - 0.5) * 6 * j;
    const total = m.width(l.text) || 1;
    let pen = x;
    for (const ch of l.text) {
      const adv = m.width(ch);
      if (ch.trim()) {
        const dy = (rnd() - 0.5) * 5 * j + drift * ((pen - x) / total);
        const rot = (rnd() - 0.5) * 0.09 * j;
        const sc = (1 + (rnd() - 0.5) * 0.06 * j) * l.size;
        const cos = Math.cos(rot) * sc, sin = Math.sin(rot) * sc;
        for (const st of glyphSkeleton(l.bold, ch).strokes) {
          out.push({
            pts: st.pts.map(([gx, gy]) => [pen + gx * cos - gy * sin, y + dy + gx * sin + gy * cos]),
            width: st.w * sc * state.weight * toGn,
          });
        }
      }
      pen += adv + (rnd() - 0.5) * 1.6 * j;
    }
    if (l.bold) {
      // Überschrift von Hand unterstreichen
      const uy = y + l.size * 0.14;
      out.push({
        pts: [[x - 4, uy], [x + total / 2, uy + (rnd() - 0.5) * 5], [x + total + 6, uy - l.size * 0.04]],
        width: Math.max(2, l.size * 0.05) * state.weight * toGn,
      });
    }
  }

  function drawInkStrokes(ctx, strokes, g) {
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = state.ink;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const st of strokes) {
      const lw = (st.width / GN_SCALE) * g.k;
      if (st.pts.length === 1) {
        ctx.beginPath();
        ctx.arc(st.pts[0][0], st.pts[0][1], lw / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(st.pts[0][0], st.pts[0][1]);
      for (let i = 1; i < st.pts.length; i++) ctx.lineTo(st.pts[i][0], st.pts[i][1]);
      ctx.stroke();
    }
    ctx.restore();
  }

  function renderPages() {
    const g = geometry();
    const m = makeMeasurer();
    const pages = layout(m, els.text.value, g);
    const ink = state.mode === "ink";
    let seed = 1;
    const inkPages = [];

    const canvases = pages.map((lines, pi) => {
      const c = document.createElement("canvas");
      c.width = g.W; c.height = g.H;
      const ctx = c.getContext("2d");
      drawPaper(ctx, g);
      ctx.textBaseline = "alphabetic";
      const strokes = [];
      for (const l of lines) {
        const rnd = mulberry32(seed++ * 7919 + pi);
        if (l.kind === "blank") continue;
        const x = g.left + l.indent + (rnd() - 0.5) * 6 * state.jitter;
        const y = g.baseline(l.slot);
        if (ink) {
          if (l.bullet) strokes.push({ pts: [[g.left + l.indent * 0.35, y - g.base * 0.22]], width: g.base * 0.16 * GN_SCALE / g.k });
          inkLineStrokes(m, l, x, y, rnd, strokes, g);
        } else {
          ctx.fillStyle = ctx.strokeStyle = state.ink;
          if (l.bullet) {
            ctx.beginPath();
            ctx.arc(g.left + l.indent * 0.35, y - g.base * 0.22, g.base * 0.08, 0, Math.PI * 2);
            ctx.fill();
          }
          drawOutlineLine(ctx, m, l, x, y, rnd, g);
        }
      }
      if (ink) {
        drawInkStrokes(ctx, strokes, g);
        inkPages.push(strokes);
      } else if (pages.length > 1) {
        ctx.fillStyle = state.ink;
        ctx.globalAlpha = 0.5;
        ctx.font = fontSpec(Math.round(g.base * 0.6), false);
        ctx.textAlign = "right";
        ctx.fillText(`${pi + 1}/${pages.length}`, g.W - 30 * g.k, g.H - 12 * g.k);
        ctx.globalAlpha = 1;
        ctx.textAlign = "left";
      }
      return c;
    });
    return { canvases, inkPages, k: g.k };
  }

  let renderTimer, lastK = 1;
  function scheduleRender(delay = 180) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(async () => {
      try { await document.fonts.load(`400 40px "${state.font}"`); await document.fonts.load(fontSpec(40, true)); } catch (_) {}
      const r = renderPages();
      state.pages = r.canvases;
      state.inkPages = r.inkPages;
      lastK = r.k;
      els.preview.replaceChildren(...state.pages);
      const n = state.pages.length;
      els.pageCount.textContent = `${n} Seite${n === 1 ? "" : "n"}`;
    }, delay);
  }

  /* ---------- Eigene Vorlage ---------- */

  async function loadCustomTemplate(bytes, name, persist) {
    state.custom = await inspectTemplate(bytes, name);
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ name, data: btoa(latin1.decode(new Uint8Array(bytes))) }));
      } catch (_) { /* Speicher nicht verfügbar – kein Problem */ }
    }
    updateTemplateUi();
    scheduleRender(0);
  }

  function updateTemplateUi(error) {
    const t = state.custom;
    els.drop.classList.toggle("loaded", !!t);
    els.drop.classList.toggle("error", !!error);
    els.tplActions.hidden = !t;
    let stored = false;
    try { stored = !!localStorage.getItem(STORAGE_KEY); } catch (_) {}
    els.tplBadge.hidden = !(t && stored);
    if (t || error) els.tplDetails.open = true;
    if (error) {
      els.tplTitle.textContent = "Vorlage nicht nutzbar";
      els.tplInfo.textContent = error;
    } else if (t) {
      const [w, h] = t.pageSize;
      els.tplTitle.textContent = t.name;
      els.tplInfo.textContent = `Seite ${Math.round(w)} × ${Math.round(h)} pt` +
        (t.hasInk ? " · enthält bereits Stiftstriche, sie bleiben erhalten." : " · leer, wird statt der eingebauten Vorlage verwendet.");
    } else {
      els.tplTitle.textContent = "Eigene Vorlage auswählen";
      els.tplInfo.innerHTML = "Nur nötig, wenn du ein anderes Format brauchst. Ziehe eine einseitige <b>.goodnotes</b>-Datei hierher.";
    }
    updateStatus();
  }

  function updateStatus() {
    const tpl = state.custom ? `Eigene Vorlage: ${state.custom.name}` : `Vorlage: ${PAPERS[state.paper].label}`;
    els.status.textContent = `${tpl} · ${state.mode === "ink" ? "echte Tinte" : "PDF-Seite"}`;
  }

  async function handleFile(file) {
    if (!file) return;
    try {
      await loadCustomTemplate(await file.arrayBuffer(), file.name, true);
      toast("Eigene Vorlage geladen.");
    } catch (e) {
      state.custom = null;
      updateTemplateUi(e.message || "Datei konnte nicht gelesen werden.");
    }
  }

  /* ---------- Export ---------- */

  const canvasToBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));

  function buildPdf(canvases) {
    const [w, h] = pageSize();
    const orientation = w > h ? "landscape" : "portrait";
    const pdf = new window.jspdf.jsPDF({ unit: "pt", format: [w, h], orientation, compress: true });
    canvases.forEach((c, i) => {
      if (i > 0) pdf.addPage([w, h], orientation);
      pdf.addImage(c.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, w, h, undefined, "FAST");
    });
    return new Uint8Array(pdf.output("arraybuffer"));
  }

  async function buildThumbnail(page, zip) {
    let tw = 320, th = Math.round(320 * page.height / page.width);
    const old = zip.file("thumbnail.jpg");
    if (old) {
      try {
        const bmp = await createImageBitmap(await old.async("blob"));
        tw = bmp.width; th = bmp.height; bmp.close();
      } catch (_) {}
    }
    const c = document.createElement("canvas");
    c.width = tw; c.height = th;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, tw, th);
    const s = Math.min(tw / page.width, th / page.height);
    const dw = page.width * s, dh = page.height * s;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(page, (tw - dw) / 2, (th - dh) / 2, dw, dh);
    return new Uint8Array(await (await canvasToBlob(c, "image/jpeg", 0.85)).arrayBuffer());
  }

  function newUuid() {
    return (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    })).toUpperCase();
  }

  /* Neue IDs vergeben. Goodnotes leitet manche IDs voneinander ab (gleicher Anfang, nur die
     letzten Stellen unterscheiden sich, z. B. …4099 und …4098). Deshalb wird nur der vordere
     Teil ersetzt und die letzten vier Zeichen bleiben stehen, so bleibt diese Beziehung erhalten. */
  function makeRemapper() {
    const stems = new Map();
    return (s) => s.replace(UUID_RE, (u) => {
      if (KEEP_IDS.has(u)) return u;
      const stem = u.slice(0, -4);
      if (!stems.has(stem)) stems.set(stem, newUuid().slice(0, -4));
      return stems.get(stem) + u.slice(-4);
    });
  }

  // Striche einer Seite (Vorschau-Pixel) -> Datensätze für notes/<ID>.
  function inkNoteRecords(strokes, author, k) {
    const f = GN_SCALE / k; // px -> pt -> Goodnotes-Einheiten
    const rgba = [...hexToRgb(state.ink), 1];
    return pb.concat(strokes.map((st, i) => strokeRecords(
      { pts: st.pts.map(([x, y]) => [x * f, y * f]), width: st.width, rgba }, author, 1000 + i, i)));
  }

  // pages: Vorschau-Canvas; inkStrokes: Striche (nur Tinten-Modus, sonst null)
  async function buildGoodnotes(t, pages, inkStrokes) {
    const src = await JSZip.loadAsync(t.bytes); // frische Kopie, Vorlage bleibt unberührt
    const thumb = await buildThumbnail(pages[0], src);
    let pdfBytes = null, notes = null;
    if (inkStrokes) {
      const author = authorOf(await src.file("index.events.pb").async("uint8array"));
      const existing = await src.file(t.notePath).async("uint8array");
      notes = pb.concat([existing, inkNoteRecords(inkStrokes, author, lastK)]);
    } else {
      pdfBytes = buildPdf(pages);
    }
    const remap = makeRemapper();

    const out = new JSZip();
    for (const name of Object.keys(src.files).filter((n) => !src.files[n].dir)) {
      let data;
      if (name === t.pdfPath && pdfBytes) data = pdfBytes;
      else if (name === t.notePath && notes) data = notes;
      else if (name === "thumbnail.jpg") data = thumb;
      else data = await src.file(name).async("uint8array");

      if (name.endsWith(".pb") || name.startsWith("notes/") || name.startsWith("search/")) {
        data = latin1.encode(remap(latin1.decode(data)));
      }
      out.file(remap(name), data, { compression: "DEFLATE", compressionOptions: { level: 6 }, date: new Date(), createFolders: false });
    }
    return out.generateAsync({ type: "blob", mimeType: "application/octet-stream" });
  }

  async function exportGoodnotes() {
    const pages = state.pages;
    if (!pages.length) return;
    const base = safeName(els.fileName.value);
    const ink = state.mode === "ink";

    // Eine Vorlage beschreibt genau eine Seite: im Tinten-Modus immer eine Datei pro Seite.
    let groups = [[0, pages.length]];
    if (pages.length > 1) {
      const split = ink
        ? confirm(`Dein Text hat ${pages.length} Seiten. Es werden ${pages.length} einzelne .goodnotes-Dateien erzeugt (eine pro Seite).`)
        : confirm(
          `Dein Text hat ${pages.length} Seiten, die Goodnotes-Vorlage beschreibt aber nur eine Seite.\n\n` +
          `OK: ${pages.length} einzelne .goodnotes-Dateien erzeugen (empfohlen).\n` +
          `Abbrechen: eine Datei mit allen Seiten in der PDF-Anlage (Goodnotes zeigt evtl. nur Seite 1).`);
      if (ink && !split) return;
      if (split) groups = pages.map((_, i) => [i, i + 1]);
    }

    els.exportGn.disabled = true;
    els.exportGn.textContent = "Erzeuge …";
    try {
      const t = await activeTemplate();
      for (let i = 0; i < groups.length; i++) {
        const [a, b] = groups[i];
        const blob = await buildGoodnotes(t, pages.slice(a, b), ink ? state.inkPages[a] : null);
        const suffix = groups.length > 1 ? ` (${i + 1})` : "";
        download(blob, `${base}${suffix}.goodnotes`);
        if (groups.length > 1) await new Promise((r) => setTimeout(r, 400));
      }
      toast(groups.length > 1 ? `${groups.length} Dateien exportiert.` : "Export fertig – jetzt in Goodnotes öffnen.");
    } catch (e) {
      console.error(e);
      toast("Export fehlgeschlagen: " + (e.message || e), true);
    } finally {
      els.exportGn.disabled = false;
      els.exportGn.textContent = ".goodnotes exportieren";
    }
  }

  function exportPdf() {
    if (!state.pages.length) return;
    download(new Blob([buildPdf(state.pages)], { type: "application/pdf" }), `${safeName(els.fileName.value)}.pdf`);
  }

  /* ---------- Eigene Schriften ----------
     Hochgeladene Schriftdateien werden über die FontFace-API registriert und in IndexedDB
     gespeichert (localStorage wäre für Schriftdateien schnell zu klein). Jede Schrift bekommt
     einen eindeutigen internen Familiennamen, damit sie sich nicht mit Systemschriften mischt. */

  const FONT_DB = "inkly", FONT_STORE = "fonts";
  const FONT_EXT = /\.(ttf|otf|woff2?)$/i;
  const MAX_FONT_BYTES = 10 * 1024 * 1024;

  function fontDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("IndexedDB nicht verfügbar"));
      const req = indexedDB.open(FONT_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(FONT_STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function fontStore(mode, fn) {
    const db = await fontDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FONT_STORE, mode);
      const req = fn(tx.objectStore(FONT_STORE));
      tx.oncomplete = () => { db.close(); resolve(req && req.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  const fontLabel = (fileName) => fileName.replace(FONT_EXT, "").replace(/[-_]+/g, " ").replace(/\s+Regular$/i, "").trim() || "Eigene Schrift";

  async function registerFont(rec) {
    const face = new FontFace(rec.id, rec.data);
    await face.load(); // wirft bei ungültigen Dateien
    document.fonts.add(face);
    return face;
  }

  function addFontButton(rec) {
    const btn = document.createElement("button");
    btn.className = "option-card selectable custom-font";
    btn.dataset.value = rec.id;
    btn.title = rec.name;
    const sample = document.createElement("span");
    sample.className = "font-sample";
    sample.style.fontFamily = `"${rec.id}"`;
    sample.textContent = rec.name;
    const remove = document.createElement("span");
    remove.className = "font-remove";
    remove.dataset.action = "remove-font";
    remove.setAttribute("role", "button");
    remove.setAttribute("aria-label", `${rec.name} entfernen`);
    remove.textContent = "×";
    btn.append(sample, remove);
    els.fontGrid.insertBefore(btn, els.fontAdd);
    return btn;
  }

  function selectFont(value) {
    els.fontGrid.querySelectorAll("[data-value]").forEach((b) => b.classList.toggle("active", b.dataset.value === value));
    state.font = value;
    scheduleRender(0);
  }

  async function addCustomFonts(files) {
    let last = null;
    for (const file of files) {
      if (!FONT_EXT.test(file.name)) { toast(`„${file.name}“ ist keine Schriftdatei (.ttf, .otf, .woff, .woff2).`, true); continue; }
      if (file.size > MAX_FONT_BYTES) { toast(`„${file.name}“ ist zu groß (max. 10 MB).`, true); continue; }
      const rec = { id: "Inkly Custom " + newUuid(), name: fontLabel(file.name), data: await file.arrayBuffer() };
      try {
        await registerFont(rec);
      } catch (_) {
        toast(`„${file.name}“ konnte nicht als Schrift geladen werden.`, true);
        continue;
      }
      try { await fontStore("readwrite", (st) => st.put(rec)); } catch (_) { toast("Schrift geladen, aber konnte nicht dauerhaft gespeichert werden.", true); }
      addFontButton(rec);
      last = rec;
    }
    if (last) { selectFont(last.id); toast(`Schrift „${last.name}“ hinzugefügt.`); }
  }

  async function removeCustomFont(btn) {
    const id = btn.dataset.value;
    try { await fontStore("readwrite", (st) => st.delete(id)); } catch (_) {}
    document.fonts.forEach((f) => { if (f.family.replace(/"/g, "") === id) document.fonts.delete(f); });
    const wasActive = state.font === id;
    btn.remove();
    if (wasActive) selectFont("Caveat");
  }

  async function restoreCustomFonts() {
    let recs = [];
    try { recs = (await fontStore("readonly", (st) => st.getAll())) || []; } catch (_) { return; }
    for (const rec of recs) {
      try { await registerFont(rec); addFontButton(rec); } catch (_) { /* beschädigt – überspringen */ }
    }
  }

  /* ---------- Konto (Appwrite) ----------
     Anmeldung und Profil laufen über Appwrite (Konfiguration in config.js). Die eigene
     Handschrift liegt als JSON in einer Tabellenzeile, deren ID die Benutzer-ID ist und die
     nur der Benutzer selbst lesen und ändern darf. */

  const AW = window.INKLY_APPWRITE || {};
  const aw = (() => {
    if (!window.Appwrite || !AW.endpoint || !AW.projectId) return null;
    const { Client, Account, TablesDB } = window.Appwrite;
    const client = new Client().setEndpoint(AW.endpoint).setProject(AW.projectId);
    return { account: new Account(client), db: new TablesDB(client) };
  })();
  const handRow = () => ({ databaseId: AW.databaseId || "inkly", tableId: AW.tableId || "handwriting", rowId: state.user.$id });

  function authMessage(e) {
    const code = e && e.code, type = (e && e.type) || "";
    if (type === "user_already_exists" || code === 409) return "Zu dieser E-Mail gibt es schon ein Konto. Bitte melde dich an.";
    if (type === "user_invalid_credentials" || code === 401) return "E-Mail oder Passwort ist falsch.";
    if (type === "general_rate_limit_exceeded" || code === 429) return "Zu viele Versuche. Bitte warte kurz.";
    if (type === "user_unauthorized" || code === 403) return "Bitte bestätige zuerst deine E-Mail-Adresse.";
    if (/password/i.test((e && e.message) || "")) return "Das Passwort muss mindestens 8 Zeichen haben und darf nicht zu einfach sein.";
    if (!code) return "Keine Verbindung zum Server. Bist du online?";
    return (e && e.message) || "Unbekannter Fehler.";
  }

  // Gespeicherte Handschrift (ganzzahlig, 1/1000 Geviert) -> Laufzeitformat mit geglätteten Strichen
  function unpackHand(data) {
    const glyphs = {};
    for (const [ch, g] of Object.entries((data && data.glyphs) || {})) {
      glyphs[ch] = {
        adv: g.a / 1000,
        raw: g.s,
        strokes: g.s.map((flat) => {
          let pts = [];
          for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i] / 1000, flat[i + 1] / 1000]);
          if (pts.length > 2) pts = chaikin(chaikin(pts));
          return pts;
        }),
      };
    }
    return { glyphs };
  }

  const isVerified = () => !!(state.user && state.user.emailVerification);

  async function loadHand() {
    state.hand = null;
    if (!aw || !isVerified()) return;
    try {
      const row = await aw.db.getRow(handRow());
      state.hand = unpackHand(JSON.parse(row.glyphs || "{}"));
      if (!Object.keys(state.hand.glyphs).length) state.hand = null;
    } catch (e) {
      if (e && e.code !== 404) toast("Handschrift konnte nicht geladen werden.", true);
    }
  }

  async function saveHand(packed) {
    const { Permission, Role } = window.Appwrite;
    const uid = state.user.$id;
    await aw.db.upsertRow({
      ...handRow(),
      data: { glyphs: JSON.stringify(packed) },
      permissions: [Permission.read(Role.user(uid, "verified")), Permission.update(Role.user(uid, "verified")), Permission.delete(Role.user(uid, "verified"))],
    });
    state.hand = unpackHand(packed);
  }

  function updateAccountUi() {
    const u = state.user;
    els.accountBtn.textContent = u ? (u.name || u.email || "Profil") : "Anmelden";
    els.handLock.hidden = !!(u && state.hand);
    els.handLock.textContent = !u ? "Anmelden" : !isVerified() ? "Bestätigen" : "Neu";
    els.handEdit.hidden = !(u && state.hand);
    if (!isHand() && state.font === HAND_ID) selectFont("Caveat");
  }

  let authRegister = false;
  function openAuth(reason) {
    if (!aw) {
      toast("Die Anmeldung ist noch nicht eingerichtet (Appwrite-Projekt in config.js eintragen).", true);
      return;
    }
    els.authReason.textContent = reason || "Melde dich an, um deine eigene Handschrift in deinem Profil zu speichern.";
    setAuthMode(false);
    els.authError.hidden = true;
    els.authDialog.showModal();
    els.authEmail.focus();
  }
  function setAuthMode(register) {
    authRegister = register;
    els.authTitle.textContent = register ? "Konto erstellen" : "Anmelden";
    els.authSubmit.textContent = register ? "Registrieren" : "Anmelden";
    els.authSwitchText.textContent = register ? "Schon ein Konto?" : "Noch kein Konto?";
    els.authSwitch.textContent = register ? "Anmelden" : "Registrieren";
    els.authPassword.autocomplete = register ? "new-password" : "current-password";
    els.authForm.querySelectorAll("[data-register-only]").forEach((el) => { el.hidden = !register; });
  }

  async function submitAuth(e) {
    e.preventDefault();
    const email = els.authEmail.value.trim(), password = els.authPassword.value;
    els.authSubmit.disabled = true;
    els.authError.hidden = true;
    try {
      if (authRegister) {
        await aw.account.create({ userId: window.Appwrite.ID.unique(), email, password, name: els.authName.value.trim() || undefined });
      }
      await aw.account.createEmailPasswordSession({ email, password });
      state.user = await aw.account.get();
      els.authPassword.value = "";
      els.authDialog.close();
      if (!isVerified()) {
        // Neue Konten bekommen sofort die Mail; bei unbestätigten Anmeldungen nur auf Wunsch erneut
        if (authRegister) await sendVerification(true);
        updateAccountUi();
        openVerify();
        return;
      }
      await loadHand();
      updateAccountUi();
      toast("Angemeldet.");
      if (pendingHand) { pendingHand = false; openHandFlow(); }
    } catch (err) {
      els.authError.textContent = authMessage(err);
      els.authError.hidden = false;
    } finally {
      els.authSubmit.disabled = false;
    }
  }

  /* ---------- E-Mail-Bestätigung ----------
     Nach der Registrierung schickt Appwrite eine Mail mit einem Link zurück auf diese Seite
     (?userId=…&secret=…). Erst danach darf das Konto eine Handschrift speichern – das prüft
     auch der Server, weil die Berechtigungen nur für bestätigte Benutzer gelten. */

  const verifyUrl = () => location.origin + location.pathname;

  async function sendVerification(silent) {
    els.verifyError.hidden = true;
    try {
      await aw.account.createEmailVerification({ url: verifyUrl() });
      if (!silent) toast("Bestätigungs-Mail wurde erneut gesendet.");
      return true;
    } catch (e) {
      els.verifyError.textContent = "Mail konnte nicht gesendet werden: " + authMessage(e);
      els.verifyError.hidden = false;
      return false;
    }
  }

  function openVerify() {
    els.verifyEmail.textContent = (state.user && state.user.email) || "";
    if (!els.verifyDialog.open) els.verifyDialog.showModal();
  }

  async function checkVerified() {
    els.verifyError.hidden = true;
    try { state.user = await aw.account.get(); } catch (_) {}
    if (!isVerified()) {
      els.verifyError.textContent = "Deine E-Mail ist noch nicht bestätigt. Klicke zuerst auf den Link in der Mail.";
      els.verifyError.hidden = false;
      return;
    }
    els.verifyDialog.close();
    await afterVerified();
  }

  async function afterVerified() {
    await loadHand();
    updateAccountUi();
    toast("E-Mail bestätigt – dein Konto ist freigeschaltet.");
    if (pendingHand || !state.hand) { pendingHand = false; openHandFlow(); }
  }

  // Link aus der Bestätigungs-Mail verarbeiten
  async function handleVerifyLink() {
    const q = new URLSearchParams(location.search);
    const userId = q.get("userId"), secret = q.get("secret");
    if (!aw || !userId || !secret) return false;
    history.replaceState(null, "", location.pathname + location.hash);
    try {
      await aw.account.updateEmailVerification({ userId, secret });
    } catch (e) {
      toast("Der Bestätigungslink ist ungültig oder abgelaufen. Fordere im Profil einen neuen an.", true);
      return false;
    }
    try { state.user = await aw.account.get(); } catch (_) { state.user = null; }
    if (state.user) { await afterVerified(); return true; }
    toast("E-Mail bestätigt – du kannst dich jetzt anmelden.");
    return true;
  }

  function openProfile() {
    const u = state.user;
    els.profileName.textContent = u.name || "Ohne Namen";
    els.profileEmail.textContent = u.email || "";
    els.profileVerified.textContent = isVerified() ? "bestätigt" : "nicht bestätigt";
    els.profileVerified.classList.toggle("ok", isVerified());
    const n = state.hand ? Object.keys(state.hand.glyphs).length : 0;
    els.profileHand.textContent = n ? `Deine Handschrift: ${n} von ${HAND_CHARS.length} Zeichen gezeichnet.` : "Du hast noch keine eigene Handschrift.";
    els.profileEditHand.textContent = !isVerified() ? "E-Mail bestätigen" : n ? "Handschrift bearbeiten" : "Handschrift erstellen";
    els.profileDialog.showModal();
  }

  async function logout() {
    try { await aw.account.deleteSession({ sessionId: "current" }); } catch (_) {}
    state.user = null;
    state.hand = null;
    els.profileDialog.close();
    updateAccountUi();
    scheduleRender(0);
    toast("Abgemeldet.");
  }

  /* ---------- Handschrift zeichnen ----------
     Ein Zeichen nach dem anderen wird ins Feld geschrieben. Koordinaten werden direkt in
     Geviert-Einheiten gespeichert (Ursprung: Grundlinie, links), wie die skelettierten
     Schriftzeichen – die Striche sind schon Mittellinien und brauchen keine Skelettierung. */

  const HAND_CHARS = [
    ..."abcdefghijklmnopqrstuvwxyzäöüß",
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ",
    ..."0123456789",
    ...".,:;!?-()\"'/+=&%",
  ];
  // Feldgeometrie relativ zur Feldhöhe: Grundlinie und Geviertgröße
  const PAD_BASE = 0.7, PAD_EM = 0.5;
  let pendingHand = false;
  const pad = { draft: {}, idx: 0, drawing: null };

  function openHandFlow() {
    if (!state.user) { pendingHand = true; openAuth("Für deine eigene Handschrift brauchst du ein Konto – sie wird in deinem Profil gespeichert."); return; }
    if (!isVerified()) { pendingHand = true; openVerify(); return; }
    // Entwurf aus der gespeicherten Handschrift (Rohdaten, ungeglättet) aufbauen
    pad.draft = {};
    if (state.hand) {
      for (const [ch, g] of Object.entries(state.hand.glyphs)) {
        pad.draft[ch] = g.raw.map((flat) => {
          const pts = [];
          for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i] / 1000, flat[i + 1] / 1000]);
          return pts;
        });
      }
    }
    pad.idx = Math.max(0, HAND_CHARS.findIndex((c) => !pad.draft[c]));
    els.handSaveInfo.textContent = "";
    els.handDialog.showModal();
    sizePad();
    updatePad();
  }

  function sizePad() {
    const c = els.handPad, r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
  }

  // Zeichenfeld-Pixel <-> Geviert-Einheiten. Gezeichnet wird ab ~1/4 der Breite.
  const padEm = () => els.handPad.height * PAD_EM;
  const padOrigin = () => [els.handPad.width * 0.3, els.handPad.height * PAD_BASE];

  function drawPad() {
    const c = els.handPad, ctx = c.getContext("2d"), em = padEm(), [ox, oy] = padOrigin();
    ctx.clearRect(0, 0, c.width, c.height);
    const line = (yEm, color, dash) => {
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, em * 0.008); ctx.setLineDash(dash || []);
      ctx.beginPath(); ctx.moveTo(0, oy + yEm * em); ctx.lineTo(c.width, oy + yEm * em); ctx.stroke(); ctx.restore();
    };
    line(-0.72, "#e3e5e6", [em * 0.04, em * 0.04]); // Oberlänge / Großbuchstaben
    line(-0.42, "#d0d2d3", [em * 0.04, em * 0.04]); // x-Höhe
    line(0, "#8c8c8c");                              // Grundlinie
    line(0.28, "#e3e5e6", [em * 0.04, em * 0.04]);  // Unterlänge
    // Vorlage des Zeichens als blasse Hilfe
    const ch = HAND_CHARS[pad.idx];
    const strokes = pad.draft[ch] || [];
    if (!strokes.length) {
      ctx.save(); ctx.fillStyle = "#eef0f2"; ctx.font = `400 ${em}px "Caveat", cursive`;
      ctx.fillText(ch, ox, oy); ctx.restore();
    }
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = state.ink; ctx.lineWidth = HAND_W * em; ctx.lineCap = ctx.lineJoin = "round";
    for (const st of strokes) {
      if (st.length === 1) { ctx.beginPath(); ctx.arc(ox + st[0][0] * em, oy + st[0][1] * em, HAND_W * em / 2, 0, 7); ctx.fill(); continue; }
      ctx.beginPath();
      st.forEach(([x, y], i) => (i ? ctx.lineTo(ox + x * em, oy + y * em) : ctx.moveTo(ox + x * em, oy + y * em)));
      ctx.stroke();
    }
    ctx.restore();
  }

  function updatePad() {
    const ch = HAND_CHARS[pad.idx];
    const done = HAND_CHARS.filter((c) => pad.draft[c] && pad.draft[c].length).length;
    els.handChar.textContent = ch;
    els.handProgress.textContent = `Zeichen ${pad.idx + 1} von ${HAND_CHARS.length} · ${done} gezeichnet`;
    els.handPrev.disabled = pad.idx === 0;
    els.handNext.textContent = pad.idx === HAND_CHARS.length - 1 ? "Fertig" : (pad.draft[ch] && pad.draft[ch].length ? "Weiter ›" : "Überspringen ›");
    els.handStrip.querySelectorAll("button").forEach((b, i) => {
      b.classList.toggle("done", !!(pad.draft[HAND_CHARS[i]] && pad.draft[HAND_CHARS[i]].length));
      b.classList.toggle("current", i === pad.idx);
    });
    const cur = els.handStrip.children[pad.idx];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
    drawPad();
  }

  function padPoint(e) {
    const c = els.handPad, r = c.getBoundingClientRect(), em = padEm(), [ox, oy] = padOrigin();
    const x = (e.clientX - r.left) * (c.width / r.width), y = (e.clientY - r.top) * (c.height / r.height);
    return [(x - ox) / em, (y - oy) / em];
  }

  // Für die Profil-Speicherung: Zeichen links ausrichten, Breite bestimmen, Punkte ausdünnen
  function packHand() {
    const glyphs = {};
    for (const ch of HAND_CHARS) {
      const strokes = (pad.draft[ch] || []).filter((s) => s.length);
      if (!strokes.length) continue;
      let minX = Infinity, maxX = -Infinity;
      for (const s of strokes) for (const [x] of s) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
      const bearing = 0.05;
      const shift = bearing - minX;
      glyphs[ch] = {
        a: Math.round((maxX - minX + 2 * bearing + HAND_W) * 1000),
        s: strokes.map((s) => {
          const pts = s.length > 2 ? rdp(s.map(([x, y]) => [(x + shift) * 1000, y * 1000]), 3) : s.map(([x, y]) => [(x + shift) * 1000, y * 1000]);
          return pts.flatMap(([x, y]) => [Math.round(x), Math.round(y)]);
        }),
      };
    }
    return { v: 1, glyphs };
  }

  async function saveHandFromPad() {
    const packed = packHand();
    if (!Object.keys(packed.glyphs).length) { els.handSaveInfo.textContent = "Zeichne mindestens ein Zeichen."; return; }
    els.handSave.disabled = true;
    els.handSaveInfo.textContent = "Wird gespeichert …";
    try {
      await saveHand(packed);
      els.handDialog.close();
      updateAccountUi();
      selectFont(HAND_ID);
      toast("Deine Handschrift ist im Profil gespeichert.");
    } catch (e) {
      els.handSaveInfo.textContent = "Speichern fehlgeschlagen: " + authMessage(e);
    } finally {
      els.handSave.disabled = false;
    }
  }

  function wireHandPad() {
    HAND_CHARS.forEach((ch, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = ch;
      b.addEventListener("click", () => { pad.idx = i; updatePad(); });
      els.handStrip.append(b);
    });
    const c = els.handPad;
    c.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const ch = HAND_CHARS[pad.idx];
      pad.drawing = [padPoint(e)];
      (pad.draft[ch] = pad.draft[ch] || []).push(pad.drawing);
      drawPad();
    });
    c.addEventListener("pointermove", (e) => {
      if (!pad.drawing) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) {
        const p = padPoint(ev), last = pad.drawing[pad.drawing.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.004) pad.drawing.push(p);
      }
      drawPad();
    });
    const end = () => { if (pad.drawing) { pad.drawing = null; updatePad(); } };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    els.handPrev.addEventListener("click", () => { if (pad.idx > 0) { pad.idx--; updatePad(); } });
    els.handNext.addEventListener("click", () => {
      if (pad.idx < HAND_CHARS.length - 1) { pad.idx++; updatePad(); } else saveHandFromPad();
    });
    els.handUndo.addEventListener("click", () => { const s = pad.draft[HAND_CHARS[pad.idx]]; if (s) s.pop(); updatePad(); });
    els.handClear.addEventListener("click", () => { delete pad.draft[HAND_CHARS[pad.idx]]; updatePad(); });
    els.handSave.addEventListener("click", saveHandFromPad);
    window.addEventListener("resize", () => { if (els.handDialog.open) { sizePad(); drawPad(); } });
  }

  function wireAccount() {
    document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
    els.authDialog.addEventListener("close", () => { if (!state.user) pendingHand = false; });
    els.handDialog.addEventListener("close", () => { if (!isHand() && state.font === HAND_ID) selectFont("Caveat"); });
    els.authForm.addEventListener("submit", submitAuth);
    els.authSwitch.addEventListener("click", () => { setAuthMode(!authRegister); els.authError.hidden = true; });
    els.accountBtn.addEventListener("click", () => (state.user ? openProfile() : openAuth()));
    els.profileEditHand.addEventListener("click", () => { els.profileDialog.close(); openHandFlow(); });
    els.logout.addEventListener("click", logout);
    els.verifyCheck.addEventListener("click", checkVerified);
    els.verifyResend.addEventListener("click", () => sendVerification(false));
    els.verifyDialog.addEventListener("close", () => { if (!isVerified()) pendingHand = false; });
    wireHandPad();
  }

  async function restoreSession() {
    if (!aw) return;
    try { state.user = await aw.account.get(); } catch (_) { state.user = null; }
    if (state.user) await loadHand();
    await handleVerifyLink();
  }

  /* ---------- UI-Verdrahtung ---------- */

  function applyMode() {
    document.querySelectorAll("[data-mode-only]").forEach((el) => { el.hidden = el.dataset.modeOnly !== state.mode; });
    updateStatus();
  }

  document.querySelectorAll("[data-group]").forEach((group) => {
    group.addEventListener("click", (e) => {
      if (e.target.closest('[data-action="edit-hand"]')) { e.preventDefault(); openHandFlow(); return; }
      if (e.target.closest('[data-action="remove-font"]')) {
        e.preventDefault();
        const b = e.target.closest("[data-value]");
        if (b) removeCustomFont(b);
        return;
      }
      const btn = e.target.closest("[data-value]");
      if (!btn) return;
      // Eigene Handschrift: erst anmelden bzw. zeichnen, dann auswählen
      if (btn.dataset.value === HAND_ID && !(state.user && state.hand)) { openHandFlow(); return; }
      group.querySelectorAll("[data-value]").forEach((b) => b.classList.toggle("active", b === btn));
      state[group.dataset.group] = btn.dataset.value;
      if (group.dataset.group === "mode") applyMode();
      updateStatus();
      scheduleRender(0);
    });
  });

  els.text.addEventListener("input", () => scheduleRender());
  els.size.addEventListener("input", () => {
    state.size = parseFloat(els.size.value);
    els.sizeVal.textContent = state.size.toFixed(2).replace(/0$/, "") + "×";
    scheduleRender(60);
  });
  els.jitter.addEventListener("input", () => {
    state.jitter = parseFloat(els.jitter.value);
    els.jitterVal.textContent = state.jitter < 0.4 ? "gering" : state.jitter < 1.4 ? "mittel" : "stark";
    scheduleRender(60);
  });
  els.width.addEventListener("input", () => {
    state.weight = parseFloat(els.width.value);
    els.widthVal.textContent = state.weight < 0.85 ? "dünner" : state.weight <= 1.15 ? "wie die Schrift" : "kräftiger";
    scheduleRender(60);
  });

  els.tplInput.addEventListener("change", () => handleFile(els.tplInput.files[0]));
  ["dragenter", "dragover"].forEach((ev) => els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove("drag"); }));
  els.drop.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));
  els.forget.addEventListener("click", () => {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    state.custom = null;
    els.tplInput.value = "";
    updateTemplateUi();
    scheduleRender(0);
  });

  els.fontInput.addEventListener("change", async () => {
    await addCustomFonts([...els.fontInput.files]);
    els.fontInput.value = "";
  });
  ["dragenter", "dragover"].forEach((ev) => els.fontAdd.addEventListener(ev, (e) => { e.preventDefault(); els.fontAdd.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => els.fontAdd.addEventListener(ev, (e) => { e.preventDefault(); els.fontAdd.classList.remove("drag"); }));
  els.fontAdd.addEventListener("drop", (e) => addCustomFonts([...e.dataTransfer.files]));

  els.exportGn.addEventListener("click", exportGoodnotes);
  els.exportPdf.addEventListener("click", exportPdf);

  applyMode();

  wireAccount();
  updateAccountUi();

  // Gespeicherte eigene Schriften, Anmeldung und Vorlage wiederherstellen
  (async () => {
    await Promise.all([restoreCustomFonts(), restoreSession()]);
    updateAccountUi();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const { name, data } = JSON.parse(raw);
        await loadCustomTemplate(latin1.encode(atob(data)).buffer, name, false);
        return;
      }
    } catch (_) { /* ignorieren */ }
    updateTemplateUi();
    scheduleRender(0);
  })();
})();
