import sys, struct; sys.path.insert(0, '.')
from gn import *
from PIL import Image, ImageDraw
def strokes_of(p):
    z = gnzip(p); rs = records(note_bytes(z)); out = []
    for k in range(0, len(rs), 2):
        hdr = dict((f, v) for f, wt, v in fields(rs[k]))
        if 3 in hdr: continue
        body = dict((f, v) for f, wt, v in fields(dict((f, v) for f, wt, v in fields(rs[k+1]))[7]))
        d = bv41(body[2]); assert d[:4] == b'tpl\0' and struct.unpack('<I', d[4:8])[0] == len(d)
        q = d.index(b'\0', 8) + 1
        ver, w = struct.unpack('<Hf', d[q:q+6]); q += 6
        n, = struct.unpack('<I', d[q:q+4]); q += 4 + 2 * n
        m, = struct.unpack('<I', d[q:q+4]); q += 4; start = struct.unpack('<ff', d[q:q+8]); q += 8 * m
        s, = struct.unpack('<I', d[q:q+4]); q += 4
        segs = [struct.unpack('<4f', d[q+16*i:q+16*i+16]) for i in range(s)]; q += 16 * s
        tail = d[q:]
        col = {f: struct.unpack('<f', v)[0] for f, wt, v in fields(body.get(4, b''))}
        rgb = tuple(int(255 * col.get(i, 0)) for i in (1, 2, 3))
        out.append((start, segs, w, rgb, n == s + 1, tail.hex()))
    return out
if __name__ == "__main__":
    for p in sys.argv[1:]:
        st = strokes_of(p)
        print(p.split('/')[-1], "strokes", len(st), "counts ok", all(x[4] for x in st), "tails", {x[5] for x in st})
    im = Image.new('RGB', (546, 772), 'white'); dr = ImageDraw.Draw(im); k = 0.5
    for start, segs, w, rgb, _, _ in strokes_of(sys.argv[1]):
        cur = start
        for cx, cy, x, y in segs:
            pts = [((1-t)**2*cur[0] + 2*(1-t)*t*cx + t*t*x, (1-t)**2*cur[1] + 2*(1-t)*t*cy + t*t*y) for t in [i/8 for i in range(9)]]
            dr.line([(a*k, b*k) for a, b in pts], fill=rgb, width=max(1, int(w*k)))
            cur = (x, y)
    im.save('render_A.png')
