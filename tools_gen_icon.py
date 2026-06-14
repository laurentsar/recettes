import struct, zlib, math
def png(path,S):
    BG=(26,18,11); BG2=(36,24,17); PLATE=(58,40,28); FG=(224,122,63); WHITE=(243,233,223)
    px=bytearray()
    cx=cy=S/2
    for y in range(S):
        px.append(0)
        for x in range(S):
            t=y/S
            r=int(BG[0]+(BG2[0]-BG[0])*t); g=int(BG[1]+(BG2[1]-BG[1])*t); b=int(BG[2]+(BG2[2]-BG[2])*t)
            # assiette (cercle) + anneau accent
            d=math.hypot(x-cx,y-cy)
            if d<=0.36*S: r,g,b=PLATE
            if 0.34*S<=d<=0.37*S: r,g,b=FG
            # fourchette (gauche) : manche + 3 dents
            fx=0.40*S
            if abs(x-fx)<0.018*S and 0.40*S<=y<=0.74*S: r,g,b=WHITE
            for tx in (fx-0.05*S,fx,fx+0.05*S):
                if abs(x-tx)<0.013*S and 0.26*S<=y<=0.40*S: r,g,b=WHITE
            if 0.35*S<=y<=0.40*S and fx-0.06*S<=x<=fx+0.06*S: r,g,b=WHITE
            # couteau (droite)
            kx=0.60*S
            if abs(x-kx)<0.02*S and 0.40*S<=y<=0.74*S: r,g,b=WHITE
            if 0.26*S<=y<=0.40*S and kx-0.012*S<=x<=kx+(0.40*S-y)*0.10: r,g,b=WHITE
            px+=bytes((r,g,b))
    raw=bytes(px)
    def ch(t,d): c=struct.pack('>I',len(d))+t+d; return c+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    open(path,'wb').write(b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',S,S,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw,9))+ch(b'IEND',b''))
    print("écrit",path,S)
png('www/img/icon-512.png',512); png('www/img/icon-192.png',192)
