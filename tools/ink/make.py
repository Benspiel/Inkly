"""Prototyp: echte Goodnotes-Striche in eine leere Vorlage schreiben."""
import sys, struct, zipfile, uuid, random, re, math, io; sys.path.insert(0, '.')
from gn import *

SCALE = 11 / 6          # Goodnotes-Einheiten pro PDF-Punkt (Seite 1091.35 x 1543.5)
SCHEMA = b'vuA(v)A(S(uu))A(S(uuuu))vA(f)'
KEEP = {'5A53E89E-F4C2-4548-8DD3-E9DF9FB4592E'}

def enc_varint(n):
    out = bytearray()
    while True:
        b = n & 0x7f; n >>= 7
        if n: out.append(b | 0x80)
        else: out.append(b); return bytes(out)
def fv(f, n): return enc_varint(f << 3) + enc_varint(n)
def fb(f, b): return enc_varint((f << 3) | 2) + enc_varint(len(b)) + b
def ff(f, x): return enc_varint((f << 3) | 5) + struct.pack('<f', x)

def lz4_literals(raw):
    n = len(raw); tok = min(n, 15) << 4; out = bytearray([tok])
    if n >= 15:
        r = n - 15
        while r >= 255: out.append(255); r -= 255
        out.append(r)
    return bytes(out) + raw
def bv41(raw):
    blk = lz4_literals(raw)
    return b'bv41' + struct.pack('<II', len(raw), len(blk)) + blk + b'bv4$'

def stroke_blob(pts, width, smooth=True):
    """pts: Liste (x, y) in Goodnotes-Einheiten -> tpl-Blob mit quadratischen Segmenten."""
    if len(pts) == 1: pts = pts * 2
    segs = []
    last = len(pts) - 1
    for i in range(1, len(pts)):
        if smooth and i < last:
            c = pts[i]; end = ((pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2)
        elif smooth:
            c = end = pts[i]
        else:  # gerade Strecke: Kontrollpunkt in der Mitte
            a, end = pts[i - 1], pts[i]; c = ((a[0] + end[0]) / 2, (a[1] + end[1]) / 2)
        segs.append((c[0], c[1], end[0], end[1]))
    n = len(segs) + 1
    data = struct.pack('<Hf', 2, width)
    data += struct.pack('<I', n) + struct.pack('<%dH' % n, 0, *([1] * (n - 1)))
    data += struct.pack('<I', 1) + struct.pack('<ff', *pts[0])
    data += struct.pack('<I', len(segs)) + b''.join(struct.pack('<4f', *s) for s in segs)
    data += struct.pack('<H', 1) + struct.pack('<I', 0)
    head_len = 8 + len(SCHEMA) + 1
    return b'tpl\0' + struct.pack('<I', head_len + len(data)) + SCHEMA + b'\0' + data

def stroke_records(pts, width, rgba, author, seq, order, smooth=True):
    sid = str(uuid.uuid4()).upper().encode()
    rep = random.getrandbits(32)
    clock = fv(1, 1) + fv(2, rep)
    hdr = fb(1, sid) + fb(2, clock) + fv(8, author) + fv(9, seq) + fv(14, 5381) + fv(16, 24)
    color = b''.join(ff(i + 1, c) for i, c in enumerate(rgba) if c != 0)
    body = (fb(1, sid) + fb(2, bv41(stroke_blob(pts, width, smooth))) + fb(4, color) + fb(6, b'')
            + fb(7, fb(1, (fv(1, order) if order else b'') + fv(2, random.getrandbits(32))))
            + fb(9, b'') + fb(15, clock) + fb(20, b'') + fv(21, 24))
    rec_body = fb(7, body)
    return enc_varint(len(hdr)) + hdr + enc_varint(len(rec_body)) + rec_body

def author_of(z):
    for r in records(z.read('index.events.pb')):
        for f, wt, v in fields(r):
            if wt == 2 and f >= 10:
                for f2, wt2, v2 in fields(v):
                    if f2 == 13 and wt2 == 0: return v2
    raise SystemExit('author id nicht gefunden')

def remapper():
    stems = {}
    def rep(m):
        u = m.group(0).decode()
        if u in KEEP: return m.group(0)
        st = u[:-4]
        stems.setdefault(st, str(uuid.uuid4()).upper()[:-4])
        return (stems[st] + u[-4:]).encode()
    return lambda b: re.sub(rb'[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}', rep, b)

def build(template, out, strokes, extra_events=b''):
    z = zipfile.ZipFile(template)
    author = author_of(z)
    note_name = [n for n in z.namelist() if n.startswith('notes/')][0]
    notes = b''.join(stroke_records(st[0], st[1], st[2], author, 1000 + i, i, st[3] if len(st) > 3 else True) for i, st in enumerate(strokes))
    rm = remapper()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as o:
        for n in z.namelist():
            d = z.read(n)
            if n == note_name: d = notes
            if n == 'index.events.pb': d = d + extra_events
            if n.endswith('.pb') or n.startswith(('notes/', 'search/')): d = rm(d)
            o.writestr(rm(n.encode()).decode(), d)
    return notes

# ---- Testinhalt (in PDF-Punkten, dann skaliert) ----
def P(pts): return [(x * SCALE, y * SCALE) for x, y in pts]
BLACK, BLUE, RED = (0, 0, 0, 1), (0.11, 0.25, 0.62, 1), (0.86, 0.15, 0.15, 1)
strokes = []
# Rahmen
strokes.append((P([(60, 60), (535, 60), (535, 780), (60, 780), (60, 60)]), 2.598, BLACK, False))
# "HI" in blau, dick
strokes.append((P([(100, 120), (100, 220)]), 6.0, BLUE, False))
strokes.append((P([(160, 120), (160, 220)]), 6.0, BLUE, False))
strokes.append((P([(100, 170), (160, 170)]), 6.0, BLUE, False))
strokes.append((P([(200, 120), (200, 220)]), 6.0, BLUE, False))
# Welle in rot
strokes.append((P([(100 + t * 4, 300 + 25 * math.sin(t / 3)) for t in range(0, 100)]), 2.598, RED))
# Spirale schwarz
strokes.append((P([(300 + math.cos(a / 8) * a / 1.3, 520 + math.sin(a / 8) * a / 1.3) for a in range(0, 160)]), 2.598, BLACK))
# Punkt
strokes.append((P([(450, 150)]), 8.0, RED))

if __name__ == '__main__':
    tpl, ecken = sys.argv[1], sys.argv[2]
    build(tpl, 'Striche_Test_A.goodnotes', strokes)
    # Variante B: zusaetzlich die "Seite bearbeitet"-Ereignisse (105/104) aus ecken.goodnotes uebernehmen
    ev = records(zipfile.ZipFile(ecken).read('index.events.pb'))
    def top(r): return [f for f, wt, v in fields(r)][-1]
    extra = b''.join(enc_varint(len(r)) + r for r in ev[7:9])
    assert [top(r) for r in ev[7:9]] == [105, 104], [top(r) for r in ev[7:9]]
    build(tpl, 'Striche_Test_B.goodnotes', strokes, extra)
    print('ok')
