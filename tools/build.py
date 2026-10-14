import sys, json, unicodedata, re, os, subprocess
sys.path.insert(0, os.path.dirname(__file__))
from emojimap import DISH, ING
def norm(s):
    s=unicodedata.normalize('NFD',(s or '').lower().replace('œ','oe').replace('æ','ae')).encode('ascii','ignore').decode()
    s=re.sub(r'[^a-z0-9]+',' ',s)
    return ' '+' '.join(w[:-1] if len(w)>3 and w[-1] in 'sx' else w for w in s.split())+' '
NK=lambda k: norm(k).strip()
def find_dish(r):
    t=norm(r['t']); c=norm(r.get('cat'))
    for src in (t,c):
        for kws,em in DISH:
            if any(' '+NK(k)+' ' in src or (len(NK(k))>4 and NK(k) in src) for k in kws): return em
    return '🍽️'
def find_ings(r, main):
    txt=norm(' '.join(r.get('ing') or [])+' '+r['t'])
    out=[]
    for k,em in ING:
        if ' '+NK(k)+' ' in txt and em!=main and em not in out: out.append(em)
        if len(out)==2: break
    return out
def load():
    b=json.load(open('/home/user/recettes/www/data/recipes.json'))['recipes']; e=json.load(open('/home/user/recettes/www/data/recipes-extra.json'))
    d={str(x) for x in e['delete']}; res=[r for r in b if str(r['id']) not in d]; ids={str(r['id']) for r in res}
    res+=[r for r in e['recipes'] if str(r['id']) not in ids]
    return [r for r in res if not (r.get('img') or '').strip()]
if __name__=='__main__':
    no=load(); plan=[]
    for r in no:
        m=find_dish(r); plan.append({'id':str(r['id']),'t':r['t'],'dish':m,'ings':find_ings(r,m)})
    json.dump(plan,open('plan.json','w'),ensure_ascii=False,indent=0)
    print(len(plan), sum(1 for p in plan if p['dish']=='🍽️'),'génériques')
    print([p['t'] for p in plan if p['dish']=='🍽️'])
