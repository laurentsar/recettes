import struct, zlib, math, os
def lerp(a,b,t): return int(a+(b-a)*t)
def render(S):
    BG1=(239,138,74); BG2=(184,84,31); POT=(42,28,18); RIM=(243,233,223); STEAM=(255,247,238)
    cx=0.5*S; px=bytearray(); waves=[(0.40,0.0),(0.50,1.6),(0.60,3.1)]
    for y in range(S):
        px.append(0)
        for x in range(S):
            t=y/S; r,g,b=lerp(BG1[0],BG2[0],t),lerp(BG1[1],BG2[1],t),lerp(BG1[2],BG2[2],t)
            fx,fy=x/S,y/S
            if 0.17<=fy<=0.43:
                for (x0,ph) in waves:
                    wx=x0+0.024*math.sin(fy*26+ph)
                    if abs(fx-wx)<0.016*(1.0-(0.43-fy)*0.6): r,g,b=STEAM
            bx0,bx1,by0,by1=0.27*S,0.73*S,0.52*S,0.795*S; rb=0.06*S
            inb=bx0<=x<=bx1 and by0<=y<=by1
            if inb and y>by1-rb:
                if x<bx0+rb and math.hypot(x-(bx0+rb),y-(by1-rb))>rb: inb=False
                if x>bx1-rb and math.hypot(x-(bx1-rb),y-(by1-rb))>rb: inb=False
            for hx in (0.255*S,0.745*S):
                if math.hypot((x-hx)/(0.045*S),(y-0.63*S)/(0.055*S))<=1: inb=True
            if inb: r,g,b=POT
            if math.hypot((x-cx)/(0.265*S),(y-0.515*S)/(0.05*S))<=1: r,g,b=RIM
            if math.hypot((x-cx)/(0.035*S),(y-0.45*S)/(0.04*S))<=1: r,g,b=RIM
            px.extend((r,g,b))
    raw=bytes(px)
    def ch(tp,d): c=struct.pack('>I',len(d))+tp+d; return c+struct.pack('>I',zlib.crc32(tp+d)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',S,S,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw,9))+ch(b'IEND',b'')
def w(path,S):
    os.makedirs(os.path.dirname(path),exist_ok=True); open(path,'wb').write(render(S))
# PWA
w('www/img/icon-512.png',512); w('www/img/icon-192.png',192)
# Android launcher (legacy + round) et foreground (adaptatif)
A='android/app/src/main/res'
leg={'mdpi':48,'hdpi':72,'xhdpi':96,'xxhdpi':144,'xxxhdpi':192}
fg={'mdpi':108,'hdpi':162,'xhdpi':216,'xxhdpi':324,'xxxhdpi':432}
for d,s in leg.items():
    w(f'{A}/mipmap-{d}/ic_launcher.png',s); w(f'{A}/mipmap-{d}/ic_launcher_round.png',s)
for d,s in fg.items():
    w(f'{A}/mipmap-{d}/ic_launcher_foreground.png',s)
print("icônes générées (PWA + Android toutes densités)")
