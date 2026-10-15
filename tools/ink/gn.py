import zipfile, struct
def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1; r |= (c & 0x7f) << s; s += 7
        if c < 0x80: return r, i
def fields(b):
    """raw protobuf fields: list of (f, wt, value_or_bytes)"""
    i, out = 0, []
    while i < len(b):
        key, i = varint(b, i); f, wt = key >> 3, key & 7
        if wt == 0: v, i = varint(b, i)
        elif wt == 1: v = b[i:i+8]; i += 8
        elif wt == 5: v = b[i:i+4]; i += 4
        elif wt == 2: n, i = varint(b, i); v = b[i:i+n]; i += n
        else: raise ValueError(wt)
        if f == 0 or i > len(b): raise ValueError('bad')
        out.append((f, wt, v))
    return out
def trymsg(b):
    try:
        fs = fields(b); return fs if fs else None
    except Exception: return None
def show(b, ind=0, maxlen=60):
    for f, wt, v in fields(b):
        p = ' ' * ind
        if wt == 0: print(f"{p}{f}: {v}")
        elif wt == 5: print(f"{p}{f}: f32 {struct.unpack('<f', v)[0]:.5g}  (u32 {struct.unpack('<I', v)[0]})")
        elif wt == 1: print(f"{p}{f}: f64 {struct.unpack('<d', v)[0]:.10g}  (u64 {struct.unpack('<Q', v)[0]})")
        else:
            try:
                t = v.decode(); ok = t.isprintable()
            except Exception: ok = False
            sub = None if ok else trymsg(v)
            if ok: print(f"{p}{f}: '{t}'")
            elif sub is not None and len(v) > 0: print(f"{p}{f}: {{"); show(v, ind + 2); print(p + "}")
            else: print(f"{p}{f}: bytes[{len(v)}] {v[:maxlen].hex()}")
def records(b):
    i, out = 0, []
    while i < len(b):
        n, i = varint(b, i); out.append(b[i:i+n]); i += n
    return out
def lz4_block(src):
    dst = bytearray(); i = 0
    while i < len(src):
        tok = src[i]; i += 1; ll = tok >> 4
        if ll == 15:
            while True:
                c = src[i]; i += 1; ll += c
                if c != 255: break
        dst += src[i:i+ll]; i += ll
        if i >= len(src): break
        off = src[i] | (src[i+1] << 8); i += 2; ml = tok & 15
        if ml == 15:
            while True:
                c = src[i]; i += 1; ml += c
                if c != 255: break
        for _ in range(ml + 4): dst.append(dst[-off])
    return bytes(dst)
def bv41(b):
    out = bytearray(); i = 0
    while i < len(b):
        m = b[i:i+4]
        if m == b'bv4$': break
        if m == b'bv41':
            dl, cl = struct.unpack('<II', b[i+4:i+12]); out += lz4_block(b[i+12:i+12+cl]); i += 12 + cl
        elif m == b'bv4-':
            dl, = struct.unpack('<I', b[i+4:i+8]); out += b[i+8:i+8+dl]; i += 8 + dl
        else: raise ValueError(m)
    return bytes(out)
def gnzip(p): return zipfile.ZipFile(p)
def note_bytes(z): return z.read([n for n in z.namelist() if n.startswith('notes/')][0])
