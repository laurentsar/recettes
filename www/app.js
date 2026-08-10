'use strict';

const APP_VERSION = '2.57';

let ALL = [];
let BASE = [];
let EXTRA = { delete: [], overrides: [], recipes: [] };
let cats = [];
let catCount = {};
// state.cats = liste des catégories cochées dans le filtre (vide = toutes) ; state.fav = filtre favoris.
let state = { q:'', cats:[], fav:false, ing:null };
const favs = new Set(JSON.parse(localStorage.getItem('recetteFavs') || '[]'));
let edits = JSON.parse(localStorage.getItem('recetteEdits') || '{}');
let imports = JSON.parse(localStorage.getItem('recetteImports') || '[]');
const deleted = new Set(JSON.parse(localStorage.getItem('recetteDeleted') || '[]'));
function saveEdits(){ localStorage.setItem('recetteEdits', JSON.stringify(edits)); }
function saveImports(){ localStorage.setItem('recetteImports', JSON.stringify(imports)); }
function saveDeleted(){ localStorage.setItem('recetteDeleted', JSON.stringify([...deleted])); }
function mergeEdits(){
  const base = BASE.filter(r=> !deleted.has(String(r.id))).map(r => edits[r.id] ? Object.assign({},r,edits[r.id]) : r);
  const imp  = imports.filter(r=> !deleted.has(String(r.id))).map(r => edits[r.id] ? Object.assign({},r,edits[r.id]) : r);
  return [...base, ...imp];
}
function refreshAll(){ ALL = mergeEdits(); buildIngredientIndex(); buildCats(); renderDaily(); renderFeed(); renderGrid(); }

/* ---------- extra : suppressions + surcharges + recettes custom ---------- */
function applyExtra(recipes, extra){
  const del = new Set((extra.delete || []).map(String));
  let result = recipes.filter(r => !del.has(String(r.id)));
  for (const ov of (extra.overrides || [])){
    const r = result.find(x => String(x.id) === String(ov.id));
    if (r) Object.assign(r, ov);
  }
  const existingIds = new Set(result.map(r => String(r.id)));
  for (const nr of (extra.recipes || [])){
    if (!existingIds.has(String(nr.id))) result.push(nr);
  }
  return result;
}

/* ---------- synchro OTA (pull du recipes.json publié) ---------- */
const REMOTE_URL = 'https://raw.githubusercontent.com/laurentsar/recettes/master/www/data/recipes.json';
let toastTimer;
function toast(msg){ const t=document.getElementById('toast'); if(!t) return; t.textContent=msg; t.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>{t.hidden=true;},3000); }
async function fetchRemoteText(){
  // ?t= + en-têtes no-cache : contourne le cache de CapacitorHttp (sinon réponse périmée)
  try{
    const r = await fetch(REMOTE_URL + '?t=' + Date.now(), {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache, no-store, max-age=0', 'Pragma': 'no-cache' },
    });
    return r.ok ? await r.text() : null;
  } catch(e){ return null; }
}
async function syncRemote(manual){
  const btn=document.getElementById('sync-btn'); if(btn) btn.classList.add('spin');
  const txt = await fetchRemoteText();
  if(btn) btn.classList.remove('spin');
  if(!txt){ if(manual) toast('Hors-ligne — synchro impossible'); return; }
  if(txt === localStorage.getItem('recipesData')){ if(manual) toast('Déjà à jour ✓'); return; }
  let d; try{ d=JSON.parse(txt); }catch(e){ if(manual) toast('Source invalide'); return; }
  if(!d.recipes || !d.recipes.length){ if(manual) toast('Source vide'); return; }
  localStorage.setItem('recipesData', txt);
  BASE = applyExtra(d.recipes, EXTRA); refreshAll();
  toast(`Recettes synchronisées (${BASE.length}) ✓`);
}

/* ---------- récupération photo + titre depuis le lien de la recette ---------- */
function decodeEntities(s){ if(!s) return ''; const t=document.createElement('textarea'); t.innerHTML=s; return t.value; }
async function fetchMetaFromUrl(url){
  try{
    const r = await fetch(url, { cache:'no-store' });
    if(!r.ok) return {};
    const html = await r.text();
    const pick = re => { const m = html.match(re); return m ? m[1] : ''; };
    const img = pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
             || pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
             || pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    let title = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
             || pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
             || pick(/<title[^>]*>([^<]+)<\/title>/i);
    return { img: (img||'').trim(), title: decodeEntities(title).trim() };
  }catch(e){ return {}; }
}
// Récupère, pour les recettes ayant un lien mais SANS photo, l'image og:image et rajuste le titre (og:title).
async function fillFromSources(){
  const targets = ALL.filter(r => r.url && !r.img);
  if(!targets.length){ toast('Aucune photo manquante 🎉'); return; }
  const btn=document.getElementById('photos-btn'); if(btn) btn.classList.add('spin');
  let okImg=0, okTitle=0;
  for(let i=0;i<targets.length;i++){
    const r = targets[i];
    toast(`Récupération… ${i+1}/${targets.length}`);
    const meta = await fetchMetaFromUrl(r.url);
    const patch = {};
    if(meta.img){ patch.img = meta.img; okImg++; }
    if(meta.title && meta.title.length>=3){ patch.t = meta.title; okTitle++; }
    if(Object.keys(patch).length) edits[r.id] = Object.assign({}, edits[r.id]||{}, patch);
  }
  if(btn) btn.classList.remove('spin');
  saveEdits(); refreshAll();
  toast(`✓ ${okImg} photo(s) · ${okTitle} titre(s) mis à jour`);
}

/* ---------- auto-catégorisation par mots-clés ---------- */
// Recherche par MOT ENTIER (gère le pluriel -s, évite "ail" dans "travail"). hay est déjà normalisé.
function hasWord(hay, kw){
  const k = norm(kw).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp('(^|[^a-z0-9])'+k+'s?([^a-z0-9]|$)').test(hay);
}
// Légumes DÉTAILLÉS : catégorie affichée -> variantes/orthographes (cherchées dans les ingrédients).
// NB : aromates/condiments (ail, oignon, échalote, herbes, épices) EXCLUS volontairement
// (présents dans presque toutes les recettes -> ne sont pas des "légumes" structurants).
const VEGGIES = {
  'Carotte':['carotte'], 'Courgette':['courgette'], 'Tomate':['tomate'],
  'Pomme de terre':['pomme de terre','patate'], 'Poireau':['poireau'], 'Aubergine':['aubergine'],
  'Champignon':['champignon','cepe','girolle'],
  'Brocoli':['brocoli'], 'Chou-fleur':['chou-fleur','chou fleur'], 'Chou':['chou','chou rouge','chou vert'],
  'Épinard':['epinard'], 'Haricot vert':['haricot vert'], 'Petit pois':['petit pois','petits pois'],
  'Courge':['courge','potiron','butternut','potimarron'], 'Concombre':['concombre'],
  'Céleri':['celeri'], 'Fenouil':['fenouil'], 'Artichaut':['artichaut'],
  'Asperge':['asperge'], 'Betterave':['betterave'], 'Navet':['navet'],
  'Radis':['radis'], 'Endive':['endive'], 'Blette':['blette','bette'],
  'Avocat':['avocat'], 'Salade verte':['laitue','roquette','mache','batavia','scarole'],
  'Lentille':['lentille'], 'Pois chiche':['pois chiche'],
};
// Viandes DÉTAILLÉES par type (pas de tag « Viande » générique).
const MEATS = {
  'Bœuf':['boeuf','bœuf','steak','entrecote','bavette','rumsteck','paleron','bourguignon','tournedos','viande hachee','steak hache'],
  'Veau':['veau','blanquette','osso buco'],
  'Porc':['porc','echine','filet mignon','rouelle','cote de porc','travers de porc','palette','roti de porc'],
  'Agneau':['agneau','gigot','mouton'],
  'Poulet':['poulet','blanc de poulet','cuisse de poulet','aiguillette'],
  'Dinde':['dinde','escalope de dinde'],
  'Canard':['canard','magret'],
  'Lapin':['lapin'],
  'Charcuterie':['lardon','jambon','bacon','saucisse','chorizo','merguez','saucisson','boudin','chipolata','pancetta','speck'],
};
// Poisson & fruits de mer DÉTAILLÉS (+ « Poisson » en repli si générique sans espèce précise).
const SEAFOOD = {
  'Saumon':['saumon'], 'Thon':['thon'], 'Cabillaud':['cabillaud','morue'], 'Truite':['truite'],
  'Dorade':['dorade'], 'Colin':['colin','lieu noir','merlu'], 'Sardine':['sardine'], 'Maquereau':['maquereau'],
  'Crevette':['crevette','gambas'], 'Huître':['huitre'], 'Crabe':['crabe'],
  'Saint-Jacques':['saint-jacques','saint jacques','noix de saint'], 'Calamar':['calamar','encornet','seiche'],
};
// Sous-catégories DESSERT.
const CHOCO_KW = ['chocolat','cacao','choco','ganache','praline','nutella'];
const FRUITS = {
  'Pomme':['pomme'], 'Poire':['poire'], 'Banane':['banane'], 'Fraise':['fraise'], 'Framboise':['framboise'],
  'Pêche':['peche'], 'Abricot':['abricot'], 'Citron':['citron'], 'Orange':['orange'], 'Mangue':['mangue'],
  'Ananas':['ananas'], 'Cerise':['cerise'], 'Myrtille':['myrtille'], 'Kiwi':['kiwi'], 'Melon':['melon'],
  'Rhubarbe':['rhubarbe'], 'Coco':['coco','noix de coco'], 'Prune':['prune','mirabelle'], 'Figue':['figue'],
};
const DESSERT_KW = ['chocolat','sucre','gateau','patisserie','biscuit','gaufre','mousse','flan','glace','caramel',
  'vanille','meringue','tiramisu','fondant','brownie','cookie','madeleine','clafoutis','compote','confiture',
  'miel','chantilly','beignet','panna cotta','crumble','sucre glace','tarte sucree','entremet'];
const ENTREE_KW = ['salade','soupe','veloute','potage','verrine','tartare','terrine','gaspacho','bruschetta','carpaccio','tapas','houmous','guacamole'];
// Ustensiles (détectés dans titre/préparation/catégorie).
const USTENSILES = {
  'Airfryer':['airfryer','air fryer','friteuse a air','ninja foodi'],
  'Thermomix':['thermomix','varoma'],
};

// Arbre d'affichage du menu catégories (les feuilles = noms produits par autoCategorize).
const TAXONOMY = {
  'Entrée': null,
  'Plat': {
    'Viande': Object.keys(MEATS),
    'Poisson': Object.keys(SEAFOOD),
    'Légumes': Object.keys(VEGGIES),
  },
  'Dessert': { 'Chocolat': null, 'Fruits': Object.keys(FRUITS) },
  'Ustensile': Object.keys(USTENSILES),
};

function autoCategorize(){
  let added=0, touched=0;
  ALL.forEach(r=>{
    const ingHay  = norm((r.ing||[]).join('  '));                            // légumes : ingrédients seulement (précis)
    const fullHay = norm([r.t||'', (r.ing||[]).join('  '), r.steps||''].join('  '));
    const have = new Set(catList(r).map(c=>c.toLowerCase()));
    const toAdd = [];
    const push = c => { if(!have.has(c.toLowerCase())){ toAdd.push(c); have.add(c.toLowerCase()); } };
    // Légumes : feuille précise (Carotte…) + parent « Légumes »
    let anyVeg=false;
    const ingHayChou = ingHay.replace(/chou(\s|-)?fleur/g,' '); // « chou » ne doit pas matcher « chou-fleur »
    for (const [veg, kws] of Object.entries(VEGGIES)){
      const hay = veg==='Chou' ? ingHayChou : ingHay;
      if (kws.some(k=> hasWord(hay,k))){ push(veg); anyVeg=true; }
    }
    if (anyVeg) push('Légumes');
    // Viande : feuille (Poulet…) + parent « Viande »
    let anyMeat=false;
    for (const [m, kws] of Object.entries(MEATS)) if (kws.some(k=> hasWord(fullHay,k))){ push(m); anyMeat=true; }
    if (anyMeat) push('Viande');
    // Poisson : feuille (Saumon…) + parent « Poisson » (repli si espèce non précisée)
    let anySea=false;
    for (const [f, kws] of Object.entries(SEAFOOD)) if (kws.some(k=> hasWord(fullHay,k))){ push(f); anySea=true; }
    if (anySea || hasWord(fullHay,'poisson') || hasWord(fullHay,'fruits de mer')) push('Poisson');
    // Ustensiles (Airfryer / Thermomix / Four)
    for (const [u, kws] of Object.entries(USTENSILES)) if (kws.some(k=> hasWord(fullHay,k))) push(u);
    // Type de plat (un seul : Dessert > Entrée > Plat par défaut)
    let course = null;
    if (!['dessert','entrée','entree','plat'].some(c=> have.has(c))){
      course = 'Plat';
      if (DESSERT_KW.some(k=> hasWord(fullHay,k))) course='Dessert';
      else if (ENTREE_KW.some(k=> hasWord(fullHay,k))) course='Entrée';
      push(course);
    }
    // Sous-catégories Dessert : Chocolat + Fruits (feuille + parent)
    const isDessert = course==='Dessert' || have.has('dessert');
    if (isDessert){
      if (CHOCO_KW.some(k=> hasWord(fullHay,k))) push('Chocolat');
      let anyFruit=false;
      for (const [fr, kws] of Object.entries(FRUITS)) if (kws.some(k=> hasWord(fullHay,k))){ push(fr); anyFruit=true; }
      if (anyFruit) push('Fruits');
    }
    if (toAdd.length){
      const merged = catList(r).concat(toAdd);
      const seen=new Set(); const out=[];
      merged.forEach(c=>{ const k=c.toLowerCase(); if(!seen.has(k)){ seen.add(k); out.push(c); } });
      edits[r.id] = Object.assign({}, edits[r.id]||{}, { cat: out.join(', ') });
      added += toAdd.length; touched++;
    }
  });
  saveEdits(); refreshAll();
  toast(touched ? `🏷️ ${added} catégorie(s) ajoutée(s) · ${touched} recette(s)` : 'Aucune nouvelle catégorie');
}

const $ = (s)=>document.querySelector(s);
const elGrid=$('#grid'), elCats=$('#cats'), elStatus=$('#status'), elSearch=$('#search'),
      elDetail=$('#detail'), elSub=$('#hero-sub'), elCook=$('#cook'), elImport=$('#import');

const norm = (s)=> (s||'').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
const esc = (s)=> (s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function saveFavs(){ localStorage.setItem('recetteFavs', JSON.stringify([...favs])); }

/* ---------- produits de saison (France, par mois) ---------- */
const MONTHS = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const SEASON = {
  1:['poireau','carotte','chou','chou-fleur','brocoli','navet','betterave','panais','endive','mache','epinard','courge','potiron','butternut','topinambour','oignon','echalote','pomme','poire','orange','clementine','mandarine','kiwi','citron'],
  2:['poireau','carotte','chou','chou-fleur','endive','mache','epinard','betterave','navet','panais','topinambour','courge','oignon','echalote','pomme','poire','orange','clementine','kiwi','citron'],
  3:['poireau','carotte','chou','chou-fleur','brocoli','epinard','blette','betterave','navet','endive','radis','oignon','echalote','pomme','poire','kiwi','citron','orange'],
  4:['asperge','radis','epinard','blette','carotte','chou','navet','oignon','laitue','salade','petit pois','artichaut','rhubarbe','pomme','kiwi','citron'],
  5:['asperge','radis','epinard','blette','courgette','concombre','petit pois','feve','artichaut','navet','carotte','oignon','laitue','salade','fraise','rhubarbe','cerise'],
  6:['courgette','aubergine','tomate','concombre','poivron','haricot','petit pois','feve','artichaut','asperge','blette','betterave','carotte','fenouil','radis','laitue','salade','epinard','oignon','ail','echalote','fraise','cerise','abricot','framboise','groseille','melon','peche','nectarine','rhubarbe','cassis','myrtille'],
  7:['courgette','aubergine','tomate','concombre','poivron','haricot','mais','fenouil','betterave','carotte','radis','laitue','salade','oignon','ail','fraise','cerise','abricot','framboise','groseille','melon','peche','nectarine','prune','mure','myrtille','cassis','pasteque','figue'],
  8:['courgette','aubergine','tomate','concombre','poivron','haricot','mais','fenouil','betterave','carotte','radis','brocoli','laitue','salade','oignon','ail','peche','nectarine','prune','mirabelle','figue','raisin','melon','pasteque','framboise','mure','myrtille','abricot','pomme','poire'],
  9:['courgette','aubergine','tomate','poivron','haricot','mais','brocoli','chou','fenouil','betterave','carotte','radis','blette','epinard','courge','potiron','oignon','ail','raisin','figue','prune','mirabelle','pomme','poire','peche','framboise','noisette','mure'],
  10:['courge','potiron','butternut','citrouille','brocoli','chou','chou-fleur','poireau','carotte','betterave','navet','panais','epinard','blette','champignon','oignon','ail','pomme','poire','raisin','coing','chataigne','noix','kiwi','figue'],
  11:['courge','potiron','butternut','poireau','carotte','chou','chou-fleur','brocoli','navet','panais','betterave','endive','mache','epinard','topinambour','champignon','oignon','echalote','pomme','poire','clementine','mandarine','orange','kiwi','coing','chataigne','noix'],
  12:['poireau','carotte','chou','chou-fleur','endive','mache','betterave','navet','panais','courge','potiron','butternut','topinambour','champignon','oignon','echalote','ail','pomme','poire','orange','clementine','mandarine','kiwi','citron'],
};
const monthNow = ()=> new Date().getMonth()+1;
const cap = (s)=> s ? s[0].toUpperCase()+s.slice(1) : s;
function seasonalHits(r, m){
  const kws = SEASON[m] || [];
  const text = norm((r.ing||[]).join(' ') + ' ' + (r.t||''));
  const hits = [];
  for (const k of kws){ if (text.includes(k) && !hits.includes(k)) hits.push(k); }
  return hits;
}
function todayKey(){ const d=new Date(); return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate(); }
function pickDaily(){
  const m = monthNow();
  const scored = ALL.map(r=>({r, hits: seasonalHits(r,m)})).filter(x=>x.hits.length>0)
    .sort((a,b)=> b.hits.length - a.hits.length);
  const pool = scored.slice(0, 30);
  if (!pool.length) return null;
  return pool[ todayKey() % pool.length ];
}
/* ---------- fil de nouveautés (RSS-like) ---------- */
function renderFeed(){
  const el = document.getElementById('feed');
  if (!el) return;
  const extras = (EXTRA && EXTRA.recipes) ? EXTRA.recipes : [];
  if (!extras.length){ el.innerHTML = ''; return; }
  const recent = extras.slice(-8).reverse();
  el.innerHTML =
    `<div class="feed-label">📡 Récemment ajoutés <span class="feed-count">${extras.length}</span></div>` +
    '<div class="feed-strip">' +
    recent.map(r => {
      const img = r.img
        ? `<img src="${esc(r.img)}" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=feed-ph>🍲</div>'" loading="lazy">`
        : '<div class="feed-ph">🍲</div>';
      const cat = (r.cat || '').split(',')[0].trim();
      return `<div class="feed-card" data-id="${esc(r.id)}">${img}<div class="feed-info"><div class="feed-t">${esc(r.t)}</div>${cat?`<div class="feed-cat">${esc(cat)}</div>`:''}</div></div>`;
    }).join('') +
    '</div>';
  el.querySelectorAll('.feed-card').forEach(c => c.addEventListener('click', () => openDetail(c.dataset.id)));
}

function renderDaily(){
  const el = $('#daily'); if(!el) return;
  const pick = pickDaily();
  if (!pick){ el.innerHTML=''; return; }
  const { r, hits } = pick; const m = monthNow();
  const img = r.img
    ? `<div class="d-banner-img"><img src="${esc(r.img)}" referrerpolicy="no-referrer" onerror="this.parentElement.outerHTML='<div class=ph>🍲</div>'"></div>`
    : `<div class="ph">🍲</div>`;
  const chips = hits.slice(0,6).map(h=>`<span class="schip">🌿 ${esc(cap(h))}</span>`).join('');
  el.innerHTML = `<div class="daily" data-id="${esc(r.id)}">
    ${img}
    <div class="d-banner-info">
      <div class="d-banner-k">🥗 Suggestion du jour · de saison (${MONTHS[m-1]})</div>
      <div class="d-banner-t">${esc(r.t)}</div>
      <div class="schips">${chips}</div>
    </div></div>`;
  el.querySelector('.daily').addEventListener('click', ()=> openDetail(r.id));
}

/* ---------- ingrédients ---------- */
const INGR = [
'tomate','courgette','aubergine','poivron','concombre','oignon','ail','echalote','carotte','pomme de terre','pommes de terre','patate','poireau','courge','potiron','butternut','citrouille','brocoli','chou-fleur','chou','epinard','blette','salade','laitue','endive','radis','navet','betterave','panais','celeri','fenouil','artichaut','asperge','haricot','petit pois','feve','lentille','pois chiche','mais','champignon','olive','avocat','cornichon','piment','gingembre',
'pomme','poire','banane','orange','citron','pamplemousse','fraise','framboise','cerise','abricot','peche','nectarine','prune','raisin','melon','pasteque','ananas','mangue','kiwi','figue','coing','rhubarbe','myrtille','cassis','groseille','mure','datte','pruneau','noix de coco',
'poulet','dinde','canard','boeuf','veau','porc','agneau','mouton','lapin','jambon','lardon','lard','bacon','saucisse','chorizo','merguez','steak','escalope','magret','gigot','viande hachee',
'saumon','thon','cabillaud','morue','colin','dorade','truite','sardine','maquereau','crevette','gambas','moule','huitre','calamar','poulpe','crabe','homard','saint-jacques','surimi','anchois',
'oeuf','lait','creme','creme fraiche','beurre','fromage','gruyere','emmental','parmesan','mozzarella','feta','chevre','ricotta','mascarpone','comte','cheddar','yaourt','fromage blanc','lait de coco',
'riz','pates','spaghetti','semoule','boulgour','quinoa','farine','pain','polenta','gnocchi','couscous','nouilles','sucre','miel','chocolat','cacao','vanille','levure','maizena','sel','poivre','huile','huile d olive','vinaigre','moutarde','sauce soja','mayonnaise','ketchup','bouillon','concentre de tomate',
'persil','coriandre','basilic','menthe','thym','romarin','laurier','ciboulette','estragon','aneth','origan','curcuma','cumin','paprika','curry','cannelle','muscade','girofle','safran','herbes de provence',
'noix','noisette','amande','pistache','cacahuete','pignon','sesame',
];
const flat = (s)=> norm(s).replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
function ensureIW(r){ if(!r._il){ r._il = flat((r.ing||[]).join(' ')); r._iw = r._il.split(' ').filter(Boolean); } }
function matchKw(r, kw){
  ensureIW(r);
  if (kw.indexOf(' ')>=0 || kw.indexOf('-')>=0){ return (' '+r._il+' ').indexOf(' '+flat(kw)+' ')>=0; }
  return r._iw.some(w => w===kw || w===kw+'s' || w===kw+'x' || (kw.length>=4 && w.startsWith(kw)));
}
let ingIndex = [];
function buildIngredientIndex(){
  ingIndex = INGR.map(kw=>({kw, n: ALL.reduce((a,r)=> a + (matchKw(r,kw)?1:0), 0)}))
    .filter(x=>x.n>0)
    .sort((a,b)=> b.n - a.n || a.kw.localeCompare(b.kw));
}

/* ---------- filtres ---------- */
function filtered(){
  const q = norm(state.q.trim());
  return ALL.filter(r=>{
    if (state.fav && !favs.has(r.id)) return false;
    if (state.cats.length){ const cl = catList(r); if(!state.cats.some(c=> cl.includes(c))) return false; }
    if (state.ing && !matchKw(r, state.ing)) return false;
    if (!q) return true;
    if (norm(r.t).includes(q)) return true;
    if (norm(r.cat).includes(q)) return true;
    return r.ing.some(i=> norm(i).includes(q));
  });
}

/* ---------- catégories ---------- */
// Catégories masquées partout (filtre, fiches, comptage) — comparées via norm().
const EXCLUDED_CATS = new Set(['poivron','gateau','wok','gateau au chocolat','tajine','sandwich','moule','four']);
// Une recette peut avoir plusieurs catégories, stockées dans r.cat séparées par des virgules.
function catList(r){
  return String((r && r.cat) || '').split(',').map(s=>s.trim()).filter(Boolean)
    .filter(c=> !EXCLUDED_CATS.has(norm(c)));
}
function buildCats(){
  catCount={};
  ALL.forEach(r=>{ const cs=catList(r); (cs.length?cs:['Sans catégorie']).forEach(c=> catCount[c]=(catCount[c]||0)+1); });
  cats = Object.keys(catCount).sort((a,b)=> catCount[b]-catCount[a] || a.localeCompare(b));
  renderChips();
}
let catExpanded = new Set();
function renderChips(){
  const ingLabel = state.ing ? `🥕 ${cap(state.ing)} ✕` : '🥕 Ingrédient';
  const nSel = state.cats.length + (state.fav ? 1 : 0);
  const catLabel = nSel ? `🏷️ ${nSel} sélection${nSel>1?'s':''}` : '🏷️ Catégories';
  elCats.innerHTML = `
    <button class="chip ing-chip ${state.ing?'active':''}" id="ing-filter-btn">${esc(ingLabel)}</button>
    <div class="cat-multi">
      <button class="chip ${nSel?'active':''}" id="cat-btn">${esc(catLabel)} ▾</button>
      <div class="cat-panel" id="cat-panel" hidden></div>
    </div>`;
  const panel = document.getElementById('cat-panel');
  document.getElementById('cat-btn').addEventListener('click', (e)=>{ e.stopPropagation(); panel.hidden = !panel.hidden; if(!panel.hidden) fillCatPanel(panel); });
  panel.addEventListener('click', e=> e.stopPropagation());
  document.getElementById('ing-filter-btn').addEventListener('click', ()=>{
    if (state.ing){ state.ing=null; renderChips(); renderGrid(); } else openIngPick();
  });
}
// compte total d'un nœud (lui + descendants) — sert juste à masquer les nœuds vides.
function catTotal(name, val){
  let t = catCount[name]||0;
  if (Array.isArray(val)) val.forEach(l=> t+=catCount[l]||0);
  else if (val && typeof val==='object') Object.entries(val).forEach(([k,v])=> t+=catTotal(k,v));
  return t;
}
// Liste à plat des sous-catégories (descendants) d'un nœud de la TAXONOMY.
function catDescendants(name){
  const collect = (v)=>{
    if (Array.isArray(v)) return v.slice();
    if (v && typeof v==='object') return Object.entries(v).flatMap(([k,cv])=> [k, ...collect(cv)]);
    return [];
  };
  const find = (v)=>{
    if (v && typeof v==='object' && !Array.isArray(v)){
      for (const [k,cv] of Object.entries(v)){ if(k===name) return cv; const r=find(cv); if(r!==undefined) return r; }
    }
    return undefined;
  };
  const sub = find(TAXONOMY);
  return sub===undefined ? [] : collect(sub);
}
function catNodeHtml(name, val, depth){
  if (catTotal(name,val) === 0) return '';
  let children = [];
  if (Array.isArray(val)) children = val.map(l=>[l,null]);
  else if (val && typeof val==='object') children = Object.entries(val);
  const hasKids = children.length>0;
  const open = catExpanded.has(name);
  const own = catCount[name]||0;
  const tog = hasKids ? `<button class="cattog" data-node="${esc(name)}">${open?'▾':'▸'}</button>` : `<span class="cattog sp"></span>`;
  // Nœud sans tag propre mais avec enfants = en-tête de groupe (non cochable).
  const label = own>0 || !hasKids
    ? `<label class="catopt"><input type="checkbox" class="catopt-c" value="${esc(name)}"${state.cats.includes(name)?' checked':''}><span>${esc(name)}</span><span class="catn">(${own})</span></label>`
    : `<span class="catopt cathead">${esc(name)}</span>`;
  let html = `<div class="catrow" style="padding-left:${depth*14}px">${tog}${label}</div>`;
  if (hasKids && open) for (const [cn,cv] of children) html += catNodeHtml(cn,cv,depth+1);
  return html;
}
function fillCatPanel(panel){
  let html = `<button class="cat-clear" id="cat-clear">Tout afficher</button>`;
  if (favs.size) html += `<div class="catrow"><span class="cattog sp"></span><label class="catopt"><input type="checkbox" id="catopt-fav"${state.fav?' checked':''}><span>❤️ Favoris</span><span class="catn">(${favs.size})</span></label></div>`;
  for (const [top, val] of Object.entries(TAXONOMY)) html += catNodeHtml(top, val, 0);
  panel.innerHTML = html;
  panel.querySelectorAll('.cattog[data-node]').forEach(b=> b.addEventListener('click', ()=>{
    const n=b.dataset.node; catExpanded.has(n) ? catExpanded.delete(n) : catExpanded.add(n); fillCatPanel(panel);
  }));
  const favBox = panel.querySelector('#catopt-fav');
  if (favBox) favBox.addEventListener('change', e=>{ state.fav=e.target.checked; renderGrid(); refreshCatLabel(); });
  // bascule individuelle (préserve les sélections des nœuds repliés)
  panel.querySelectorAll('.catopt-c').forEach(box=> box.addEventListener('change', ()=>{
    const v=box.value;
    if (box.checked){
      if(!state.cats.includes(v)) state.cats.push(v);
      // cocher un parent -> décocher ses sous-catégories (redondantes)
      const desc = catDescendants(v);
      if (desc.length) state.cats = state.cats.filter(x=> !desc.includes(x));
    } else state.cats = state.cats.filter(x=>x!==v);
    fillCatPanel(panel); renderGrid(); refreshCatLabel();
  }));
  const clr = panel.querySelector('#cat-clear');
  if (clr) clr.addEventListener('click', ()=>{ state.cats=[]; state.fav=false; fillCatPanel(panel); renderGrid(); refreshCatLabel(); });
}
// Met juste à jour le libellé du bouton catégories (sans reconstruire le panneau ouvert).
function refreshCatLabel(){
  const btn = document.getElementById('cat-btn'); if(!btn) return;
  const nSel = state.cats.length + (state.fav ? 1 : 0);
  btn.textContent = (nSel ? `🏷️ ${nSel} sélection${nSel>1?'s':''}` : '🏷️ Catégories') + ' ▾';
  btn.classList.toggle('active', !!nSel);
}
// Ferme le panneau catégories si on clique ailleurs.
document.addEventListener('click', ()=>{ const p=document.getElementById('cat-panel'); if(p && !p.hidden) p.hidden = true; });

// Arbre de catégories réutilisable pour ATTRIBUER (fiche + édition) — même logique que le filtre.
// selected/expand = Set mutés ; showAll=true affiche tout l'arbre (même catégories à 0). Renvoie la fn render.
function mountCatTree(container, selected, expand, showAll){
  function nodeHtml(name, val, depth){
    if (!showAll && catTotal(name,val)===0) return '';
    let children=[];
    if (Array.isArray(val)) children=val.map(l=>[l,null]);
    else if (val && typeof val==='object') children=Object.entries(val);
    const hasKids=children.length>0, open=expand.has(name), own=catCount[name]||0;
    const tog = hasKids ? `<button class="cattog" data-node="${esc(name)}">${open?'▾':'▸'}</button>` : `<span class="cattog sp"></span>`;
    const selectable = showAll || own>0 || !hasKids;
    const cnt = showAll ? '' : `<span class="catn">(${own})</span>`;
    const label = selectable
      ? `<label class="catopt"><input type="checkbox" class="catopt-c" value="${esc(name)}"${selected.has(name)?' checked':''}><span>${esc(name)}</span>${cnt}</label>`
      : `<span class="catopt cathead">${esc(name)}</span>`;
    let html = `<div class="catrow" style="padding-left:${depth*14}px">${tog}${label}</div>`;
    if (hasKids && open) for (const [cn,cv] of children) html += nodeHtml(cn,cv,depth+1);
    return html;
  }
  function render(){
    let html=''; for (const [t,v] of Object.entries(TAXONOMY)) html += nodeHtml(t,v,0);
    container.innerHTML = html;
    container.querySelectorAll('.cattog[data-node]').forEach(b=> b.addEventListener('click', ()=>{
      const n=b.dataset.node; expand.has(n)?expand.delete(n):expand.add(n); render();
    }));
    container.querySelectorAll('.catopt-c').forEach(box=> box.addEventListener('change', ()=>{
      if (box.checked){
        selected.add(box.value);
        catDescendants(box.value).forEach(d=> selected.delete(d)); // parent coché -> sous-catégories décochées
      } else selected.delete(box.value);
      render();
    }));
  }
  render();
  return render;
}

/* ---------- sélecteur d'ingrédient ---------- */
function openIngPick(){
  const el = document.getElementById('ingpick');
  el.innerHTML = `
    <div class="edit-head"><button class="ip-close">← Fermer</button><h2>Choisir un ingrédient</h2><span style="width:70px"></span></div>
    <div class="ip-search"><input id="ip-q" type="search" placeholder="Filtrer les ingrédients…" autocomplete="off"></div>
    <div class="ip-list" id="ip-list"></div>`;
  el.hidden = false; document.body.style.overflow='hidden';
  const list = document.getElementById('ip-list');
  const draw = (q='')=>{
    const nq = norm(q);
    const items = ingIndex.filter(x=> !nq || norm(x.kw).includes(nq));
    list.innerHTML = items.length ? items.map(x=>
      `<button class="iprow" data-kw="${esc(x.kw)}"><span>${esc(cap(x.kw))}</span><span class="ipn">${x.n}</span></button>`).join('')
      : '<div class="status">Aucun ingrédient</div>';
    list.querySelectorAll('.iprow').forEach(b=> b.addEventListener('click', ()=>{
      state.ing = b.dataset.kw; state.cats = []; state.fav = false;
      closeIngPick(); renderChips(); renderGrid();
    }));
  };
  draw();
  document.getElementById('ip-q').addEventListener('input', e=> draw(e.target.value));
  el.querySelector('.ip-close').addEventListener('click', closeIngPick);
}
function closeIngPick(){ document.getElementById('ingpick').hidden = true; document.body.style.overflow=''; }

/* ---------- ajustement rapide de catégorie ---------- */
function openCatPick(id){
  const r = ALL.find(x=>String(x.id)===String(id)); if(!r) return;
  const el = document.getElementById('catpick');
  const selected = new Set(catList(r));
  const expand = new Set(['Plat','Dessert','Ustensile']);
  el.innerHTML = `
    <div class="cpm-backdrop"></div>
    <div class="cpm-box">
      <div class="cpm-title">Catégories de « ${esc(r.t)} »</div>
      <div class="cpm-list cat-tree" id="cpm-tree"></div>
      <input id="cpm-new" type="text" placeholder="Ajouter (plusieurs séparées par des virgules)…" autocomplete="off">
      <div class="cpm-btns">
        <button class="cpm-cancel">Annuler</button>
        <button class="cpm-save">Enregistrer</button>
      </div>
    </div>`;
  el.hidden = false;
  mountCatTree(document.getElementById('cpm-tree'), selected, expand, true);
  el.querySelector('.cpm-cancel').addEventListener('click', closeCatPick);
  el.querySelector('.cpm-backdrop').addEventListener('click', closeCatPick);
  el.querySelector('.cpm-save').addEventListener('click', ()=>{
    const typed = (document.getElementById('cpm-new').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    const seen = new Set(); const out = [];
    [...selected, ...typed].forEach(c=>{ const k=c.toLowerCase(); if(!seen.has(k)){ seen.add(k); out.push(c); } });
    edits[id] = Object.assign({}, edits[id]||{}, { cat: out.join(', ') });
    saveEdits(); refreshAll(); closeCatPick(); openDetail(id);
  });
}
function closeCatPick(){ document.getElementById('catpick').hidden = true; }

/* ---------- grille ---------- */
function card(r){
  const fav = favs.has(r.id) ? 'fav-badge' : '';
  const img = r.img
    ? `<img class="thumb" src="${esc(r.img)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=ph>🍽️</div>'">`
    : `<div class="ph">🍽️</div>`;
  const meta = [r.min? '⏱️ '+r.min+' min':'', r.serv? '🍽️ '+r.serv : '', catList(r).join(', ')].filter(Boolean).slice(0,2).join(' · ');
  return `<div class="rcard ${fav}" data-id="${esc(r.id)}">${img}
    <div class="info"><div class="rt">${esc(r.t)}</div><div class="meta">${esc(meta)}</div></div></div>`;
}
function renderGrid(){
  if(appMode === 'cocktails') return;
  const list = filtered();
  elStatus.textContent = `${list.length} recette${list.length>1?'s':''}` + (state.fav?' en favoris':'');
  elGrid.innerHTML = list.map(card).join('');
  elGrid.querySelectorAll('.rcard').forEach(c=> c.addEventListener('click',()=> openDetail(c.dataset.id)));
  window.scrollTo({top:0});
}

/* ---------- fiche ---------- */
function splitSteps(txt){
  let parts = (txt||'').split(/\r?\n+/).map(s=>s.trim()).filter(Boolean);
  if (parts.length<2){
    parts = (txt||'').split(/(?<=[.!?])\s+(?=[A-ZÀ-ÝÉÈ0-9])/).map(s=>s.trim()).filter(Boolean);
  }
  return parts;
}
function openDetail(id){
  const r = ALL.find(x=>String(x.id)===String(id)); if(!r) return;
  const isFav = favs.has(r.id);
  const hero = r.img
    ? `<img src="${esc(r.img)}" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=ph>🍲</div>'">`
    : `<div class="ph">🍲</div>`;
  const catLabel = catList(r).length ? `${esc(catList(r).join(' · '))} ✏️` : '+ Catégorie';
  const tags = [
    `<button class="tag cat tag-cat-btn" title="${catList(r).length?'Modifier les catégories':'Ajouter une catégorie'}">${catLabel}</button>`,
    r.area?`<span class="tag">📍 ${esc(r.area)}</span>`:'',
    r.min?`<span class="tag">⏱️ ${r.min} min</span>`:'',
    r.serv?`<span class="tag">🍽️ ${r.serv} pers.</span>`:'',
  ].join('');
  const sk = SEASON[monthNow()] || [];
  const ing = r.ing.length ? `<div class="d-sec">Ingrédients</div><ul class="ing">${
    r.ing.map((i,k)=>{ const s = sk.some(w=> norm(i).includes(w));
      return `<li data-k="${k}" class="${s?'season':''}"><span class="box"></span><span>${esc(i)}</span>${s?'<span class="leaf">🌿</span>':''}</li>`;
    }).join('')}</ul>` : '';
  const steps = splitSteps(r.steps);
  const stepsHtml = steps.length ? `<div class="d-sec">Préparation</div><ol class="steps">${
    steps.map(s=>`<li>${esc(s)}</li>`).join('')}</ol>` : '';
  const hasIng = (r.ing||[]).length > 0;
  const cookBtn = (steps.length || hasIng) ? `<div class="d-cook-row">
    ${hasIng ? `<button class="d-ing-btn">📋 Ingrédients</button>` : ''}
    ${steps.length ? `<button class="d-cook-btn">🍳 Réaliser</button>` : ''}
  </div>` : '';
  const links = [
    r.url?`<a class="src" href="${esc(r.url)}" target="_blank" rel="noopener">🔗 Source</a>`:'',
    r.vid?`<a href="${esc(r.vid)}" target="_blank" rel="noopener">▶️ Vidéo</a>`:'',
  ].filter(Boolean).join('');
  const pairId = r.pair || null;
  const pair = pairId ? ALL.find(x=>String(x.id)===String(pairId)) : null;
  let variantTabs = '';
  if (pair) {
    const isTmx = r.cat && r.cat.includes('Thermomix');
    const isAF  = r.cat && r.cat.includes('Airfryer');
    const pIsTmx = pair.cat && pair.cat.includes('Thermomix');
    const isSpecial = isTmx || isAF;
    const specLabel = (isTmx || pIsTmx) ? '⚙️ Thermomix' : '🌪️ Airfryer';
    const specId = isSpecial ? r.id : pairId;
    const manId  = isSpecial ? pairId : r.id;
    variantTabs = `<div class="d-variant-tabs">
    <button class="d-variant-tab${!isSpecial?' active':''}" data-vid="${manId}">🥄 Maison</button>
    <button class="d-variant-tab${isSpecial?' active':''}" data-vid="${specId}">${specLabel}</button>
  </div>`;
  }
  elDetail.innerHTML = `
    <button class="d-back" aria-label="Retour">←</button>
    <button class="d-edit" aria-label="Éditer">✏️</button>
    <button class="d-fav" aria-label="Favori">${isFav?'❤️':'🤍'}</button>
    <div class="d-scroll">
      <div class="d-hero">${hero}</div>
      <div class="d-body">
        ${variantTabs}
        <div class="d-title">${esc(r.t)}</div>
        <div class="d-meta">${tags}</div>
        ${r.desc?`<div class="desc">${esc(r.desc)}</div>`:''}
        ${ing}${stepsHtml}${cookBtn}
        ${links?`<div class="d-links">${links}</div>`:''}
      </div>
    </div>`;
  elDetail.hidden = false;
  document.body.style.overflow='hidden';
  elDetail.querySelector('.d-back').addEventListener('click', closeDetail);
  const cookBtnEl = elDetail.querySelector('.d-cook-btn');
  if (cookBtnEl) cookBtnEl.addEventListener('click', ()=> openCook(r.id));
  const ingBtnEl = elDetail.querySelector('.d-ing-btn');
  if (ingBtnEl) ingBtnEl.addEventListener('click', ()=> openCook(r.id, 'ings'));
  elDetail.querySelector('.d-fav').addEventListener('click', (e)=>{
    if (favs.has(r.id)) favs.delete(r.id); else favs.add(r.id);
    saveFavs(); e.currentTarget.textContent = favs.has(r.id)?'❤️':'🤍';
  });
  elDetail.querySelector('.d-edit').addEventListener('click', ()=> openEdit(r.id));
  elDetail.querySelectorAll('.ing li').forEach(li=> li.addEventListener('click',()=> li.classList.toggle('done')));
  elDetail.querySelector('.tag-cat-btn').addEventListener('click', ()=> openCatPick(r.id));
  elDetail.querySelectorAll('.d-variant-tab').forEach(btn=>{
    btn.addEventListener('click', ()=>{ if(!btn.classList.contains('active')) openDetail(btn.dataset.vid); });
  });
}
function closeDetail(){ elDetail.hidden=true; document.body.style.overflow=''; renderChips(); renderGrid(); }

/* ---------- mode cuisine pas-à-pas ---------- */
let cookRecipe = null;
let cookStep = 0;
let cookSteps = [];
let cookIngMap = [];
const cookSynth = window.speechSynthesis || null;
let cookRecog = null;
let cookMicActive = false;
let cookTtsBusy = false;
let cookRecogGen = 0; // chaque session a un numéro unique ; les callbacks périmés sont ignorés

const ING_QTY_RE = /^([\d.,/½¼¾\s]+(?:g|kg|ml|cl|l|c\.\s*à\s*[sct]\.?|cuill?[eè]res?\s+à\s+[sc]\.?|tasse|verre|bouquet|botte|tranches?|gousses?|pincées?|branches?|filet|boîtes?|sachets?|paquets?|morceaux?|unités?|poignées?)s?\.?\s+)(.+)/i;
const ING_NUM_RE = /^(\d[\d\s]*(?:\/\d+)?)\s+(.+)/;

function buildIngMap(ings){
  const out = [];
  for (const item of ings){
    const m = item.trim().match(ING_QTY_RE) || item.trim().match(ING_NUM_RE);
    if (!m) continue;
    const qty = m[1].trim();
    const name = m[2].trim().replace(/^(de\s+la\s+|d[e']\s*|du\s+|des\s+|les?\s+|l[a']\s+)/i,'').trim();
    if (name.length < 3) continue;
    out.push({ qty, name });
  }
  return out.sort((a,b) => b.name.length - a.name.length);
}

function enrichStep(rawStep, ingMap){
  if (!ingMap.length) return esc(rawStep);
  const lower = rawStep.toLowerCase();
  const usedRanges = [];
  const hits = [];
  for (const { qty, name } of ingMap){
    const nl = name.toLowerCase();
    for (const v of [nl, nl+'s', nl+'x']){
      const idx = lower.indexOf(v);
      if (idx === -1) continue;
      if (usedRanges.some(([s,e]) => idx < e && idx + v.length > s)) continue;
      hits.push({ start:idx, end:idx+v.length, qty });
      usedRanges.push([idx, idx+v.length]);
      break;
    }
  }
  if (!hits.length) return esc(rawStep);
  hits.sort((a,b) => a.start - b.start);
  let result = '', pos = 0;
  for (const { start, end, qty } of hits){
    result += esc(rawStep.slice(pos, start));
    result += `<strong>${esc(rawStep.slice(start,end))}</strong><span class="cook-step-qty"> [${esc(qty)}]</span>`;
    pos = end;
  }
  return result + esc(rawStep.slice(pos));
}

function cookIngListHtml(r){
  const sk = SEASON[monthNow()] || [];
  return (r.ing||[]).map((item,k)=>{
    const s = sk.some(w=>norm(item).includes(w));
    const qm = item.match(ING_QTY_RE) || item.match(ING_NUM_RE);
    const txt = qm ? `<strong class="cook-qty">${esc(qm[1].trim())}</strong> ${esc(qm[2].trim())}` : esc(item);
    return `<li data-k="${k}" class="${s?'season':''}"><span class="box"></span><span>${txt}</span>${s?'<span class="leaf">🌿</span>':''}</li>`;
  }).join('');
}

function openCook(id, initialTab='steps'){
  const r = ALL.find(x=>String(x.id)===String(id)); if(!r) return;
  cookRecipe = r;
  cookSteps = splitSteps(r.steps);
  if(initialTab==='steps' && !cookSteps.length){ toast('Aucune étape de préparation'); return; }
  cookStep = 0;
  cookIngMap = buildIngMap(r.ing||[]);
  const ingList = cookIngListHtml(r);
  const hasSteps = cookSteps.length > 0;
  elCook.innerHTML = `
    <div class="cook-head">
      <button class="cook-quit" aria-label="Quitter">←</button>
      <span class="cook-title">${esc(r.t)}</span>
      <button id="cook-mic" class="cook-mic" aria-label="Contrôle vocal">🎤</button>
    </div>
    <div class="cook-tabs">
      <button class="cook-tab ${hasSteps && initialTab==='steps'?'active':''}" data-tab="steps"${!hasSteps?' disabled':''}>📝 Étapes${hasSteps?'':' —'}</button>
      <button class="cook-tab ${!hasSteps || initialTab==='ings'?'active':''}" data-tab="ings">📋 Ingrédients</button>
    </div>
    <div id="cook-steps-pane" ${!hasSteps || initialTab==='ings'?'hidden':''}>
      <div class="cook-progress"><div id="cook-progress-bar" class="cook-progress-bar"></div></div>
      <div class="cook-counter" id="cook-counter"></div>
      <div class="cook-body"><div id="cook-step-text" class="cook-step"></div></div>
      <div class="cook-hint">🎤 Dire : « suivant » · « précédent » · « répéter » · « ingrédients »</div>
      <div class="cook-nav">
        <button id="cook-prev" class="cook-prev">← Précédent</button>
        <button id="cook-next" class="cook-next">Suivant →</button>
      </div>
    </div>
    <div id="cook-ings-pane" class="cook-ings-pane" ${hasSteps && initialTab==='steps'?'hidden':''}>
      <div class="cook-ing-body">
        ${ingList ? `<ul class="ing">${ingList}</ul>` : '<p style="padding:20px;text-align:center;color:var(--muted)">Aucun ingrédient</p>'}
      </div>
    </div>`;
  elCook.hidden = false;
  document.body.style.overflow = 'hidden';
  elCook.querySelectorAll('.cook-tab:not([disabled])').forEach(btn => {
    btn.addEventListener('click', ()=> switchCookTab(btn.dataset.tab));
  });
  if(hasSteps && initialTab==='steps'){ renderCookStep(); speakCookStep(); }
  elCook.querySelector('.cook-quit').addEventListener('click', closeCook);
  document.getElementById('cook-mic').addEventListener('click', toggleCookMic);
  const prevBtn = document.getElementById('cook-prev');
  if(prevBtn){
    prevBtn.addEventListener('click', cookGoPrev);
    document.getElementById('cook-next').addEventListener('click', cookGoNext);
  }
  document.getElementById('cook-ings-pane').querySelectorAll('.ing li').forEach(li => {
    li.addEventListener('click', ()=> li.classList.toggle('done'));
  });
}

function switchCookTab(tab){
  elCook.querySelectorAll('.cook-tab').forEach(b=> b.classList.toggle('active', b.dataset.tab===tab));
  const sp = document.getElementById('cook-steps-pane');
  const ip = document.getElementById('cook-ings-pane');
  if(sp) sp.hidden = tab !== 'steps';
  if(ip) ip.hidden = tab !== 'ings';
}

function closeCook(){
  stopCookMic();
  stopCookSpeech();
  elCook.hidden = true;
}

function renderCookStep(){
  const total = cookSteps.length;
  document.getElementById('cook-counter').textContent = `Étape ${cookStep+1} / ${total}`;
  document.getElementById('cook-progress-bar').style.width = Math.round(((cookStep+1)/total)*100)+'%';
  document.getElementById('cook-step-text').innerHTML = enrichStep(cookSteps[cookStep], cookIngMap);
  document.getElementById('cook-prev').disabled = cookStep === 0;
  document.getElementById('cook-next').textContent = cookStep === total-1 ? '✓ Terminer' : 'Suivant →';
}

function cookGoNext(){
  if(cookStep < cookSteps.length-1){ cookStep++; renderCookStep(); speakCookStep(); }
  else{ closeCook(); toast('Bonne dégustation ! 🎉'); }
}
function cookGoPrev(){
  if(cookStep > 0){ cookStep--; renderCookStep(); speakCookStep(); }
}

function speakCookStep(){
  if(!cookSynth) return;
  stopCookSpeech();
  const utt = new SpeechSynthesisUtterance(cookSteps[cookStep]);
  utt.lang = 'fr-FR';
  utt.rate = 0.9;
  if(cookMicActive){
    cookTtsBusy = true;
    cookRecogGen++; // invalide les callbacks de l'ancienne session avant d'aborter
    if(cookRecog){ try{ cookRecog.abort(); }catch(e){} cookRecog = null; }
    const done = ()=>{ cookTtsBusy = false; if(cookMicActive) setTimeout(startCookMic, 350); };
    utt.onend = done;
    utt.onerror = done;
  }
  cookSynth.speak(utt);
}
function stopCookSpeech(){ if(cookSynth) cookSynth.cancel(); }

function toggleCookMic(){ cookMicActive ? stopCookMic() : startCookMic(); }

function startCookMic(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR){ toast('Reconnaissance vocale non disponible'); return; }
  const gen = ++cookRecogGen; // identifiant unique de cette session
  if(cookRecog){ try{ cookRecog.abort(); }catch(e){} cookRecog = null; }
  const recog = new SR();
  recog.lang = 'fr-FR';
  recog.continuous = true;
  recog.interimResults = false;
  recog.onresult = (e)=>{
    if(gen !== cookRecogGen) return; // session périmée, ignorer
    const t = e.results[e.results.length-1][0].transcript.trim().toLowerCase();
    handleVoiceCmd(t);
  };
  recog.onerror = (ev)=>{
    if(gen !== cookRecogGen) return;
    if(ev.error==='not-allowed'||ev.error==='service-not-allowed'){
      stopCookMic(); toast('Micro non autorisé');
    } else if(cookMicActive && !cookTtsBusy){
      setTimeout(startCookMic, 600);
    }
  };
  recog.onend = ()=>{
    if(gen !== cookRecogGen) return; // une nouvelle session a déjà pris le relais
    if(cookMicActive && !cookTtsBusy) setTimeout(startCookMic, 100);
  };
  try{ recog.start(); } catch(e){
    if(gen !== cookRecogGen) return;
    if(cookMicActive && !cookTtsBusy) setTimeout(startCookMic, 600);
  }
  cookRecog = recog;
  cookMicActive = true;
  const btn = document.getElementById('cook-mic');
  if(btn) btn.classList.add('active');
}

function stopCookMic(){
  cookMicActive = false;
  cookTtsBusy = false;
  cookRecogGen++; // invalide tous les callbacks en attente d'un coup
  stopCookSpeech();
  if(cookRecog){ try{ cookRecog.abort(); }catch(e){} cookRecog = null; }
  const btn = document.getElementById('cook-mic');
  if(btn) btn.classList.remove('active');
}

let _voiceTs = 0;
function handleVoiceCmd(txt){
  const now = Date.now();
  if(now - _voiceTs < 1200) return; // debounce
  _voiceTs = now;
  if(/suivant|prochain|suite/.test(txt)) cookGoNext();
  else if(/pr[eé]c[eé]dent|retour|avant|reculer/.test(txt)) cookGoPrev();
  else if(/r[eé]p[eé]ter|relire|encore|lire/.test(txt)) speakCookStep();
  else if(/ingr[eé]dient/.test(txt)) switchCookTab('ings');
  else if(/terminer|quitter|stop|fermer|fin/.test(txt)) closeCook();
  else if(/d[eé]but|recommencer|premi/.test(txt)){ cookStep=0; renderCookStep(); speakCookStep(); }
}


/* ---------- compression photo ---------- */
function compressImage(file, maxPx=800, quality=0.72){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = ()=>{
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('Image invalide')); };
    img.src = url;
  });
}

/* ---------- édition ---------- */
const elEdit = $('#edit');
let editCatSel = new Set();   // sélection de catégories de l'éditeur (persiste hors DOM)
const ev = (id)=>{ const e=document.getElementById(id); return e ? e.value : ''; };
function field(label, inner){ return `<label class="ef"><span>${label}</span>${inner}</label>`; }
function openEdit(id){
  const r = ALL.find(x=>String(x.id)===String(id)); if(!r) return;
  const v = (s)=> esc(s==null ? '' : String(s));
  elEdit.innerHTML = `
    <div class="edit-head">
      <button class="e-cancel">← Annuler</button>
      <h2>Éditer la recette</h2>
      <button class="e-save">Enregistrer</button>
    </div>
    <div class="edit-body">
      ${field('Titre', `<input id="e-t" value="${v(r.t)}">`)}
      ${field('Catégories', `<div class="e-cats cat-tree" id="e-cats"></div><input id="e-cat-new" autocomplete="off" placeholder="Ajouter de nouvelles (séparées par des virgules)…">`)}
      <div class="ef-row">${field('Durée (min)', `<input id="e-min" type="number" min="0" value="${v(r.min)}">`)}${field('Portions', `<input id="e-serv" type="number" min="0" value="${v(r.serv)}">`)}</div>
      <label class="ef"><span>Photo</span>
        <div class="e-photo-row">
          <div class="e-photo-thumb" id="e-photo-thumb">
            ${r.img ? `<img src="${v(r.img)}" referrerpolicy="no-referrer" onerror="this.parentElement.innerHTML='<div class=e-photo-ph>🍲</div>'">` : '<div class="e-photo-ph">🍲</div>'}
          </div>
          <div class="e-photo-side">
            <label class="e-photo-btn" for="e-photo-input">📷 Prendre / Galerie</label>
            <input type="file" id="e-photo-input" class="frigo-file-hidden" accept="image/*">
            <input id="e-img" type="url" placeholder="ou coller une URL…" value="${v(r.img)}" class="e-photo-url">
          </div>
        </div>
      </label>
      <div class="ef-row">${field('Source (URL)', `<input id="e-url" value="${v(r.url)}">`)}${field('Vidéo (URL)', `<input id="e-vid" value="${v(r.vid)}">`)}</div>
      ${field('Description', `<textarea id="e-desc" rows="2">${v(r.desc)}</textarea>`)}
      ${field('Ingrédients (un par ligne)', `<textarea id="e-ing" rows="9">${v((r.ing||[]).join('\n'))}</textarea>`)}
      ${field('Préparation', `<textarea id="e-steps" rows="10">${v(r.steps)}</textarea>`)}
      ${edits[id] ? `<button class="e-reset">↺ Rétablir la version d'origine</button>` : ''}
      <button class="e-delete" id="e-delete-btn">🗑️ Supprimer cette recette</button>
    </div>`;
  elEdit.hidden = false; document.body.style.overflow='hidden';
  editCatSel = new Set(catList(r));
  mountCatTree(document.getElementById('e-cats'), editCatSel, new Set(['Plat','Dessert','Ustensile']), true);
  elEdit.querySelector('.e-cancel').addEventListener('click', closeEdit);
  elEdit.querySelector('.e-save').addEventListener('click', ()=> saveEdit(id));
  const rb = elEdit.querySelector('.e-reset'); if (rb) rb.addEventListener('click', ()=> resetEdit(id));
  document.getElementById('e-photo-input').addEventListener('change', async (e)=>{
    const file = e.target.files?.[0]; if(!file) return;
    try{
      toast('Compression…');
      const dataUrl = await compressImage(file);
      document.getElementById('e-img').value = dataUrl;
      document.getElementById('e-photo-thumb').innerHTML = `<img src="${dataUrl}">`;
      toast('Photo ajoutée ✓');
    } catch(err){ toast('Erreur : '+err.message); }
    e.target.value = '';
  });
  document.getElementById('e-img').addEventListener('change', (e)=>{
    const url = e.target.value.trim();
    const th = document.getElementById('e-photo-thumb');
    th.innerHTML = url
      ? `<img src="${esc(url)}" referrerpolicy="no-referrer" onerror="this.parentElement.innerHTML='<div class=e-photo-ph>🍲</div>'">`
      : '<div class="e-photo-ph">🍲</div>';
  });
  const db = document.getElementById('e-delete-btn');
  db.addEventListener('click', ()=>{
    if(_deleteConfirmTimer){
      clearTimeout(_deleteConfirmTimer);
      _deleteConfirmTimer = null;
      db.textContent = '🗑️ Supprimer cette recette';
      db.classList.remove('e-delete-confirm');
      deleteRecipe(id);
    } else {
      db.textContent = '⚠️ Appuie encore pour confirmer';
      db.classList.add('e-delete-confirm');
      _deleteConfirmTimer = setTimeout(()=>{
        _deleteConfirmTimer = null;
        db.textContent = '🗑️ Supprimer cette recette';
        db.classList.remove('e-delete-confirm');
      }, 3000);
    }
  });
}
function closeEdit(){ elEdit.hidden = true; }
function saveEdit(id){
  const ing = ev('e-ing').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  // Catégories : arbre (editCatSel) + nouvelles saisies (virgules), dédupliquées.
  const typed = (ev('e-cat-new')||'').split(',').map(s=>s.trim()).filter(Boolean);
  const seen = new Set(); const catsOut = [];
  [...editCatSel, ...typed].forEach(c=>{ const k=c.toLowerCase(); if(!seen.has(k)){ seen.add(k); catsOut.push(c); } });
  edits[id] = {
    t: ev('e-t').trim(), cat: catsOut.join(', '),
    min: parseInt(ev('e-min'),10)||0, serv: parseInt(ev('e-serv'),10)||0,
    img: ev('e-img').trim(), url: ev('e-url').trim(), vid: ev('e-vid').trim(),
    desc: ev('e-desc').trim(), ing, steps: ev('e-steps').trim(),
  };
  saveEdits(); refreshAll();
  elEdit.hidden = true; openDetail(id);
}
function resetEdit(id){
  if (!confirm("Rétablir la version d'origine de cette recette ?")) return;
  delete edits[id]; saveEdits(); refreshAll();
  elEdit.hidden = true; openDetail(id);
}

let _deleteConfirmTimer = null;
function deleteRecipe(id){
  const sid = String(id);
  const impIdx = imports.findIndex(r=> String(r.id)===sid);
  if(impIdx !== -1){ imports.splice(impIdx, 1); saveImports(); }
  else { deleted.add(sid); saveDeleted(); }
  if(edits[sid]){ delete edits[sid]; saveEdits(); }
  favs.delete(sid); saveFavs();
  elEdit.hidden = true;
  refreshAll();
  toast('Recette supprimée 🗑️');
}

/* ---------- import de recettes ---------- */
function openImport(){
  renderImportPanel();
  elImport.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeImport(){ elImport.hidden = true; document.body.style.overflow = ''; }

function renderImportPanel(){
  elImport.innerHTML = `
    <div class="edit-head">
      <button class="imp-close">← Fermer</button>
      <h2>Importer une recette</h2>
      <span style="width:80px"></span>
    </div>
    <div class="imp-tabs">
      <button class="imp-tab active" data-tab="url">🌐 Site</button>
      <button class="imp-tab" data-tab="video">📹 Vidéo</button>
      <button class="imp-tab" data-tab="file">📁 Fichier</button>
      <button class="imp-tab" data-tab="text">📝 Texte</button>
    </div>
    <div class="imp-body">
      <div id="imp-tab-url" class="imp-pane">
        <label class="ef"><span>URL du site recette</span>
          <input id="imp-url" type="url" placeholder="https://www.marmiton.org/…" autocomplete="off"></label>
        <button class="imp-go" id="imp-url-btn">Extraire la recette</button>
        <div class="imp-note">Compatible avec Marmiton, 750g, AllRecipes, Cuisineaz…</div>
      </div>
      <div id="imp-tab-video" class="imp-pane" hidden>
        <label class="ef"><span>URL de la vidéo YouTube</span>
          <input id="imp-yt" type="url" placeholder="https://www.youtube.com/watch?v=…" autocomplete="off"></label>
        <button class="imp-go" id="imp-yt-btn">Extraire depuis YouTube</button>
        <div class="imp-note">Titre et description de la vidéo</div>
      </div>
      <div id="imp-tab-file" class="imp-pane" hidden>
        <input id="imp-file" type="file" accept=".txt,.md,.json,.pdf,image/*" style="display:none">
        <div class="imp-drop" id="imp-drop">
          <div class="imp-drop-icon">📁</div>
          <div>Appuyer pour choisir un fichier</div>
          <div class="imp-note">TXT · MD · JSON · PDF · JPG · PNG · WEBP</div>
        </div>
      </div>
      <div id="imp-tab-text" class="imp-pane" hidden>
        <label class="ef"><span>Coller le texte de la recette</span>
          <textarea id="imp-text" rows="10" placeholder="Titre\n\nIngrédients :\n– 200g de farine\n– 2 œufs\n\nPréparation :\n1. Mélanger…"></textarea></label>
        <button class="imp-go" id="imp-text-btn">Analyser le texte</button>
      </div>
    </div>
    <div id="imp-result" hidden></div>`;

  elImport.querySelector('.imp-close').addEventListener('click', closeImport);
  elImport.querySelectorAll('.imp-tab').forEach(tab=>{
    tab.addEventListener('click', ()=>{
      elImport.querySelectorAll('.imp-tab').forEach(t=>t.classList.remove('active'));
      elImport.querySelectorAll('.imp-pane').forEach(p=>{ p.hidden=true; });
      tab.classList.add('active');
      document.getElementById('imp-tab-'+tab.dataset.tab).hidden = false;
      document.getElementById('imp-result').hidden = true;
    });
  });
  document.getElementById('imp-url-btn').addEventListener('click', ()=>{
    const u = document.getElementById('imp-url').value.trim(); if(u) doImportUrl(u);
  });
  document.getElementById('imp-yt-btn').addEventListener('click', ()=>{
    const u = document.getElementById('imp-yt').value.trim(); if(u) doImportYoutube(u);
  });
  const fileInput = document.getElementById('imp-file');
  document.getElementById('imp-drop').addEventListener('click', ()=> fileInput.click());
  fileInput.addEventListener('change', e=>{ if(e.target.files[0]) doImportFile(e.target.files[0]); });
  // drag & drop
  const drop = document.getElementById('imp-drop');
  drop.addEventListener('dragover', e=>{ e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', ()=> drop.classList.remove('drag'));
  drop.addEventListener('drop', e=>{ e.preventDefault(); drop.classList.remove('drag'); if(e.dataTransfer.files[0]) doImportFile(e.dataTransfer.files[0]); });
  document.getElementById('imp-text-btn').addEventListener('click', ()=>{
    const t = document.getElementById('imp-text').value.trim();
    if(t) showImportPreview(parseRecipeText(t));
  });
}

function impStatus(html){ const el=document.getElementById('imp-result'); el.hidden=false; el.innerHTML=html; }
function impLoading(msg){ impStatus(`<div class="imp-loading"><span class="imp-spinner"></span>${esc(msg)}</div>`); }
function impError(msg){ impStatus(`<div class="imp-error">⚠️ ${esc(msg)}</div>`); }

/* -- chargement lazy de scripts externes -- */
function loadScript(src){
  return new Promise((res,rej)=>{
    if(document.querySelector(`script[src="${src}"]`)){ res(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = ()=> rej(new Error('Impossible de charger '+src));
    document.head.appendChild(s);
  });
}

/* -- import URL (proxy CORS + JSON-LD) -- */
async function doImportUrl(url){
  impLoading('Récupération de la page…');
  try{
    const proxy = 'https://api.allorigins.win/get?url='+encodeURIComponent(url);
    const res = await fetch(proxy); if(!res.ok) throw new Error('Erreur réseau');
    const html = (await res.json()).contents;
    const data = parseJsonLdRecipe(html) || parseOgMeta(html);
    if(!data) throw new Error('Aucune recette trouvée. Copiez le texte et utilisez l\'onglet Texte.');
    data.url = url;
    showImportPreview(data);
  }catch(e){ impError(e.message||'Impossible de récupérer la page'); }
}

function parseJsonLdRecipe(html){
  for(const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{
      const obj = JSON.parse(m[1]);
      const found = findSchema(obj,'Recipe');
      if(found.length) return jsonLdToRecipe(found[0]);
    }catch(e){}
  }
  return null;
}
function findSchema(obj, type){
  if(!obj) return [];
  if(Array.isArray(obj)) return obj.flatMap(o=>findSchema(o,type));
  const t = obj['@type'];
  if(t===type||(Array.isArray(t)&&t.includes(type))) return [obj];
  if(obj['@graph']) return findSchema(obj['@graph'],type);
  return [];
}
function jsonLdToRecipe(r){
  const str = s=> typeof s==='string'?s:s?.text||s?.name||'';
  const ing = (r.recipeIngredient||[]).map(i=>'– '+String(i).trim());
  const stepsRaw = r.recipeInstructions||'';
  const steps = Array.isArray(stepsRaw)
    ? stepsRaw.map(str).filter(Boolean).join('\n')
    : String(stepsRaw);
  let min=0;
  const pt = r.totalTime||r.cookTime||'';
  if(pt){ const m=pt.match(/PT(?:(\d+)H)?(?:(\d+)M)?/); if(m) min=(+m[1]||0)*60+(+m[2]||0); }
  let serv=0;
  if(r.recipeYield){ const m=String(r.recipeYield).match(/\d+/); if(m) serv=+m[0]; }
  let img='';
  if(r.image){ img=typeof r.image==='string'?r.image:r.image?.url||r.image?.[0]?.url||r.image?.[0]||''; }
  const cat = Array.isArray(r.recipeCategory)?r.recipeCategory[0]:r.recipeCategory||'';
  return { t:r.name||'', desc:r.description||'', ing, steps, min, serv, cat, img };
}
function parseOgMeta(html){
  const get = k=>{
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]+content=["']([^"']+)["']`,'i'))
           || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${k}["']`,'i'));
    return m?m[1]:'';
  };
  const t = get('og:title')||get('twitter:title'); if(!t) return null;
  return { t, desc:get('og:description')||get('twitter:description'), img:get('og:image')||'', ing:[], steps:'' };
}

/* -- import YouTube -- */
async function doImportYoutube(url){
  impLoading('Récupération des infos YouTube…');
  try{
    const oe = await fetch('https://www.youtube.com/oembed?url='+encodeURIComponent(url)+'&format=json');
    if(!oe.ok) throw new Error('Vidéo introuvable ou non publique');
    const meta = await oe.json();
    let desc='', steps='', ing=[];
    try{
      const proxy = 'https://api.allorigins.win/get?url='+encodeURIComponent(url);
      const ph = (await (await fetch(proxy)).json()).contents;
      const dm = ph.match(/"shortDescription":"([\s\S]+?)","isCrawlable"/);
      if(dm) desc = dm[1].replace(/\\n/g,'\n').replace(/\\"/g,'"');
      if(desc){ const p=parseRecipeText(meta.title+'\n\n'+desc); ing=p.ing; steps=p.steps; }
    }catch(e){}
    showImportPreview({ t:meta.title||'', desc, ing, steps, img:meta.thumbnail_url||'', vid:url });
  }catch(e){ impError(e.message||'Impossible de récupérer la vidéo'); }
}

/* -- import fichier -- */
async function doImportFile(file){
  const name = file.name.toLowerCase();
  const type = file.type;
  if(name.endsWith('.json')) return doImportJson(file);
  if(name.endsWith('.pdf')||type==='application/pdf') return doImportPdf(file);
  if(type.startsWith('image/')) return doImportImage(file);
  // texte
  const text = await file.text();
  showImportPreview(parseRecipeText(text));
}

async function doImportJson(file){
  try{
    const obj = JSON.parse(await file.text());
    if(!obj.t && !obj.title){ impError('Format JSON non reconnu'); return; }
    showImportPreview({
      t:obj.t||obj.title||'', cat:obj.cat||obj.category||'',
      desc:obj.desc||obj.description||'', ing:obj.ing||obj.ingredients||[],
      steps:obj.steps||obj.instructions||'', min:obj.min||0, serv:obj.serv||0,
      img:obj.img||'', url:obj.url||'', vid:obj.vid||''
    });
  }catch(e){ impError('Fichier JSON invalide'); }
}

async function doImportPdf(file){
  impLoading('Chargement de PDF.js…');
  try{
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    impLoading('Lecture du PDF…');
    const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = '';
    for(let i=1; i<=Math.min(pdf.numPages,15); i++){
      const page = await pdf.getPage(i);
      const c = await page.getTextContent();
      text += c.items.map(it=>it.str).join(' ')+'\n';
    }
    showImportPreview(parseRecipeText(text));
  }catch(e){ impError('Impossible de lire le PDF : '+(e.message||'')); }
}

async function doImportImage(file){
  impLoading('Chargement de Tesseract OCR (~4 Mo, une seule fois)…');
  try{
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.3/tesseract.min.js');
    impLoading('Reconnaissance de texte… 0%');
    const { data:{ text } } = await Tesseract.recognize(file, 'fra+eng', {
      logger: m=>{
        if(m.status==='recognizing text')
          impLoading(`Reconnaissance de texte… ${Math.round(m.progress*100)}%`);
      }
    });
    showImportPreview(parseRecipeText(text));
  }catch(e){ impError('OCR impossible : '+(e.message||'')); }
}

/* -- parsing texte heuristique -- */
function parseRecipeText(text){
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if(!lines.length) return { t:'', ing:[], steps:'', desc:'' };
  const result = { t:lines[0], ing:[], steps:'', desc:'', min:0, serv:0, cat:'' };
  const ingHead = /ingr[eé]dients?|composition|il\s+vous\s+faut/i;
  const stepHead = /pr[eé]paration|[eé]tapes?|instructions?|m[eé]thode|r[eé]alisation/i;
  const ingPat  = /^\s*[-–•*·]\s*\S|^\d+\s*(g|kg|cl|dl|ml|l|cs?|cc?|cuill?|tasse|verre|pincée|botte|bo[îi]te|sachet|litre|gramme|tranche|filet|bouquet|brin|gousse|cube)\b/i;
  const stepPat = /^\d+[\.\)]\s+\S/;
  let mode = 'auto';
  const ingArr=[], stepArr=[], descArr=[];
  for(const line of lines.slice(1)){
    if(ingHead.test(line)){ mode='ing'; continue; }
    if(stepHead.test(line)){ mode='steps'; continue; }
    if(mode==='ing'||(mode==='auto'&&ingPat.test(line))){
      ingArr.push('– '+line.replace(/^[-–•*·]\s*/,''));
      if(mode==='auto') mode='ing';
    } else if(mode==='steps'||(mode!=='ing'&&stepPat.test(line))){
      stepArr.push(line.replace(/^\d+[\.\)]\s*/,'').trim());
      if(mode==='auto') mode='steps';
    } else if(mode==='ing'&&!ingPat.test(line)&&line.length>40){
      mode='steps'; stepArr.push(line);
    } else {
      descArr.push(line);
    }
  }
  result.ing   = ingArr;
  result.steps = stepArr.join('\n') || descArr.slice(1).join('\n');
  result.desc  = descArr[0] || '';
  return result;
}

/* -- prévisualisation & sauvegarde -- */
function showImportPreview(data){
  const el = document.getElementById('imp-result');
  el.hidden = false;
  el.innerHTML = `
    <div class="imp-preview">
      <div class="imp-ok">✓ Vérifiez et corrigez avant d'importer</div>
      <label class="ef"><span>Titre *</span><input id="ip-t" value="${esc(data.t||'')}"></label>
      <label class="ef"><span>Catégorie</span><input id="ip-cat" value="${esc(data.cat||'')}"></label>
      <label class="ef"><span>Image (URL)</span><input id="ip-img" value="${esc(data.img||'')}"></label>
      <label class="ef"><span>Description</span><textarea id="ip-desc" rows="2">${esc(data.desc||'')}</textarea></label>
      <label class="ef"><span>Ingrédients (un par ligne)</span><textarea id="ip-ing" rows="7">${esc((data.ing||[]).join('\n'))}</textarea></label>
      <label class="ef"><span>Préparation</span><textarea id="ip-steps" rows="9">${esc(data.steps||'')}</textarea></label>
      <button class="imp-save">⬇ Enregistrer comme nouvelle recette</button>
    </div>`;
  el.querySelector('.imp-save').addEventListener('click', ()=> saveImportedRecipe(data.url||'', data.vid||''));
  el.scrollIntoView({ behavior:'smooth' });
}

function saveImportedRecipe(url='', vid=''){
  const t = document.getElementById('ip-t').value.trim();
  if(!t){ toast('Le titre est obligatoire'); return; }
  const ing = document.getElementById('ip-ing').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const r = {
    id:'imp-'+Date.now(), t,
    cat: document.getElementById('ip-cat').value.trim()||'Importé',
    desc: document.getElementById('ip-desc').value.trim(),
    ing, steps: document.getElementById('ip-steps').value.trim(),
    img: document.getElementById('ip-img').value.trim(),
    min:0, serv:0, url, vid, area:'',
  };
  imports.push(r); saveImports(); refreshAll();
  closeImport();
  toast(`"${t}" importée ✓`);
}

/* ---------- onglet cocktails ---------- */

// Conversion mesures impériales → métriques pour les recettes de cocktails
function convertQty(qty){
  if(!qty) return '';
  function parseFrac(s){
    s = s.trim();
    let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
    if(m) return +m[1] + +m[2] / +m[3];
    m = s.match(/^(\d+)\/(\d+)$/);
    if(m) return +m[1] / +m[2];
    return parseFloat(s) || 0;
  }
  function r5(n){ return Math.round(n * 2) / 2; } // arrondi au 0.5 le plus proche
  qty = qty.replace(/([\d\s/]+)\s*oz\b/gi, (_, v) => r5(parseFrac(v) * 3) + ' cl');
  qty = qty.replace(/([\d\s/]+)\s*tbsp\b/gi, (_, v) => r5(parseFrac(v) * 1.5) + ' cl');
  qty = qty.replace(/([\d\s/]+)\s*tsp\b/gi, (_, v) => Math.round(parseFrac(v) * 5) + ' ml');
  qty = qty.replace(/\bdashes\b/gi, 'traits').replace(/\bdash\b/gi, 'trait');
  qty = qty.replace(/\bsplash(es)?\b/gi, 'giclée');
  return qty.trim();
}

const COCKTAIL_IDS = [
  '11003','178325','17212','11000','11007','17196','17253','11009',
  '17213','17186','17829','11417','11006','11001','11403','17207',
  '12754','13621'
];
let cocktailCache = null; // [{id,name,thumb,category,glass,alcoholic,ings,steps}]
let appMode = 'recipes';
let appSubMode = null;

const elCocktailGrid = document.getElementById('cocktail-grid');
const elCocktailDetail = document.getElementById('cocktail-detail');

const MODE_GROUPS = {
  regions:         { subs: ['corse','espagne','portugal','italie','grece','france','japon','asie','maghreb'] },
  ustensiles:      { subs: ['airfryer','thermomix'] },
  aperitif:        { subs: ['tartinades','wraps'] },
  boissons:        { subs: ['smoothies','milkshakes'] },
  accompagnements: { subs: ['sauces','marinades'] },
};
const SUB_TAB_LABELS = {
  corse:'🏝️ Corse', espagne:'🇪🇸 Espagne', portugal:'🇵🇹 Portugal',
  italie:'🇮🇹 Italie', grece:'🇬🇷 Grèce', france:'🇫🇷 France',
  japon:'🇯🇵 Japon', asie:'🍜 Asie', maghreb:'🫖 Maghreb',
  airfryer:'🌪️ Airfryer', thermomix:'⚙️ Thermomix',
  tartinades:'🥖 Tartinades', wraps:'🌮 Wraps',
  smoothies:'🧉 Smoothies', milkshakes:'🥤 Milkshakes',
  sauces:'🥣 Sauces', marinades:'🌿 Marinades',
};
const MODE_CAT = {
  airfryer: 'Airfryer', thermomix: 'Thermomix',
  corse: 'Corse', espagne: 'Espagne', portugal: 'Portugal',
  italie: 'Italie', grece: 'Grèce', france: 'France',
  japon: 'Japon', asie: 'Asie', maghreb: 'Maghreb',
  sauces: 'Sauce', tartinades: 'Tartinade', techniques: 'Technique',
  wraps: 'Wrap', milkshakes: 'Milkshake', smoothies: 'Smoothie', marinades: 'Marinade',
};

function showSubTabs(group){
  const el = document.getElementById('sub-tabs');
  if (!el) return;
  const g = MODE_GROUPS[group];
  if (!g){ el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML = g.subs.map(s =>
    `<button class="sub-tab${appSubMode===s?' active':''}" data-sub="${s}">${SUB_TAB_LABELS[s]||s}</button>`
  ).join('');
  el.hidden = false;
  el.querySelectorAll('.sub-tab').forEach(b => b.addEventListener('click', ()=> switchSubMode(group, b.dataset.sub)));
}

function applyLeafMode(leaf){
  const isCocktails = leaf === 'cocktails';
  elCocktailGrid.hidden = !isCocktails;
  document.getElementById('grid').hidden = isCocktails;
  document.getElementById('status').hidden = isCocktails;
  if (isCocktails){
    elSearch.hidden = true;
    document.getElementById('cats').hidden = true;
    document.getElementById('daily').hidden = true;
    document.getElementById('feed').hidden = true;
    loadCocktails();
  } else if (MODE_CAT[leaf]){
    state.cats = [MODE_CAT[leaf]];
    document.getElementById('cats').hidden = true;
    document.getElementById('daily').hidden = true;
    document.getElementById('feed').hidden = true;
    elSearch.hidden = false;
    renderGrid();
  } else if (leaf === 'recipes'){
    state.cats = [];
    document.getElementById('cats').hidden = false;
    document.getElementById('daily').hidden = false;
    document.getElementById('feed').hidden = false;
    elSearch.hidden = false;
    renderGrid();
  } else {
    renderGrid();
  }
}

function switchSubMode(group, sub){
  appSubMode = sub;
  showSubTabs(group);
  applyLeafMode(sub);
}

function switchMode(mode){
  appMode = mode;
  document.querySelectorAll('.mode-tab').forEach(b=> b.classList.toggle('active', b.dataset.mode===mode));
  const g = MODE_GROUPS[mode];
  if (g){
    const firstSub = g.subs[0];
    appSubMode = firstSub;
    showSubTabs(mode);
    applyLeafMode(firstSub);
  } else {
    appSubMode = null;
    const el = document.getElementById('sub-tabs');
    if (el){ el.hidden = true; el.innerHTML = ''; }
    applyLeafMode(mode);
  }
}

async function loadCocktails(){
  if(cocktailCache){ renderCocktailGrid(); return; }
  elCocktailGrid.innerHTML = '<div class="cktl-loading">🍹 Chargement des cocktails…</div>';
  try {
    const cocktails = await Promise.all(COCKTAIL_IDS.map(async id=>{
      const r = await fetch('https://www.thecocktaildb.com/api/json/v1/1/lookup.php?i='+id);
      const d = await r.json();
      const c = d.drinks[0];
      const ings = [];
      for(let i=1;i<=15;i++){
        const ing = c['strIngredient'+i];
        const qty = c['strMeasure'+i];
        if(ing && ing.trim()) ings.push({ing: ing.trim(), qty: convertQty(qty ? qty.trim() : '')});
      }
      return { id: c.idDrink, name: c.strDrink, thumb: c.strDrinkThumb+'/preview',
        category: c.strCategory, glass: c.strGlass, alcoholic: c.strAlcoholic,
        ings, steps: c.strInstructionsFR || c.strInstructions };
    }));
    cocktailCache = cocktails;
    renderCocktailGrid();
  } catch(e){
    elCocktailGrid.innerHTML = '<div class="cktl-loading">❌ Impossible de charger les cocktails.</div>';
  }
}

function renderCocktailGrid(){
  if(!cocktailCache) return;
  elCocktailGrid.innerHTML = cocktailCache.map(c=>`
    <div class="cktl-card" data-cid="${esc(c.id)}">
      <img src="${esc(c.thumb)}" loading="lazy" alt="${esc(c.name)}">
      <div class="cktl-info">
        <div class="cktl-name">${esc(c.name)}</div>
        <div class="cktl-sub">${esc(c.glass)}</div>
        <span class="cktl-badge">${c.alcoholic==='Alcoholic'?'🍸 Alcool':'🥤 Sans alcool'}</span>
      </div>
    </div>`).join('');
  elCocktailGrid.querySelectorAll('.cktl-card').forEach(card=>{
    card.addEventListener('click', ()=> openCocktailDetail(card.dataset.cid));
  });
}

function openCocktailDetail(id){
  const c = cocktailCache && cocktailCache.find(x=>x.id===id); if(!c) return;
  const ingsHtml = c.ings.map(x=>`<li>${x.qty ? '<strong>'+esc(x.qty)+'</strong> ' : ''}${esc(x.ing)}</li>`).join('');
  const stepsHtml = c.steps ? `<div class="d-sec">Préparation</div><div class="desc">${esc(c.steps)}</div>` : '';
  elCocktailDetail.innerHTML = `
    <button class="d-back" aria-label="Retour aux cocktails">←</button>
    <button class="d-home" aria-label="Menu principal">🍽️</button>
    <div class="d-scroll">
      <div class="d-hero"><img src="${esc(c.thumb.replace('/preview',''))}" referrerpolicy="no-referrer" style="width:100%;max-height:46vh;object-fit:cover;display:block" onerror="this.outerHTML='<div class=ph>🍹</div>'"></div>
      <div class="d-body">
        <div class="d-title">${esc(c.name)}</div>
        <div class="d-meta">
          <span class="tag cat">${esc(c.category)}</span>
          <span class="tag">🥃 ${esc(c.glass)}</span>
          <span class="tag">${c.alcoholic==='Alcoholic'?'🍸 Alcool':'🥤 Sans alcool'}</span>
        </div>
        <div class="d-sec">Ingrédients</div>
        <ul class="cktl-ings">${ingsHtml}</ul>
        ${stepsHtml}
      </div>
    </div>`;
  elCocktailDetail.hidden = false;
  document.body.style.overflow = 'hidden';
  elCocktailDetail.querySelector('.d-back').addEventListener('click', closeCocktailDetail);
  elCocktailDetail.querySelector('.d-home').addEventListener('click', ()=>{ closeCocktailDetail(); switchMode('recipes'); });
}
function closeCocktailDetail(){ elCocktailDetail.hidden=true; document.body.style.overflow=''; window.scrollTo({top:0}); }

/* ---------- frigo : analyse photo → suggestions ---------- */
let frigoIngredients = [];

function openFrigo(){
  const el = document.getElementById('frigo');
  el.hidden = false;
  const keyField = document.getElementById('frigo-api-key');
  if (keyField) keyField.value = localStorage.getItem('frigoApiKey') || '';
  const settings = document.getElementById('frigo-settings');
  if (settings) settings.open = !localStorage.getItem('frigoApiKey');
  renderFrigoIngs();
  renderFrigoSuggestions();
}

function closeFrigo(){ document.getElementById('frigo').hidden = true; }

function openSettings(){
  document.getElementById('settings').hidden = false;
  const vEl = document.getElementById('settings-version');
  if (vEl) vEl.textContent = 'v' + APP_VERSION;
}
function closeSettings(){ document.getElementById('settings').hidden = true; }
function checkUpdateNow(){
  const btn = document.getElementById('check-update-btn');
  const status = document.getElementById('check-update-status');
  if (!btn || !status) return;
  btn.disabled = true; btn.textContent = '⏳ Vérification…'; status.textContent = '';
  const REPO = window.UPDATE_REPO;
  try { localStorage.removeItem('updPoll:' + REPO); } catch(e){}
  fetch('https://github.com/' + REPO + '/releases.atom?_=' + Date.now(), {
    headers: { Accept: 'application/atom+xml, text/xml, */*' }
  }).then(r => r.ok ? r.text() : null).then(xml => {
    btn.disabled = false; btn.textContent = 'Vérifier les mises à jour';
    if (!xml) { status.textContent = '⚠ Impossible de vérifier (réseau ?)'; return; }
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const entry = doc.querySelector('entry');
    const titleEl = entry && entry.querySelector('title');
    if (!titleEl) { status.textContent = '⚠ Format de réponse inattendu'; return; }
    const latest = (titleEl.textContent || '').trim().replace(/^v/, '');
    const cur = String(APP_VERSION).split('.').map(Number);
    const newer = latest.split('.').map(Number).reduce((a, v, i) => a || v - (cur[i] || 0), 0) > 0;
    if (!newer) { status.textContent = '✓ Déjà à jour (v' + APP_VERSION + ')'; return; }
    status.textContent = '🔄 Nouvelle version v' + latest + ' disponible !';
    try { localStorage.setItem('updPoll:' + REPO, '0'); } catch(e){}
    location.reload();
  }).catch(() => {
    btn.disabled = false; btn.textContent = 'Vérifier les mises à jour';
    status.textContent = '⚠ Erreur réseau';
  });
}

function renderFrigoIngs(){
  const el = document.getElementById('frigo-ings');
  if (!el) return;
  if (!frigoIngredients.length){ el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<div class="frigo-ings-title">Ingrédients détectés :</div>
    <div class="frigo-chips">
      ${frigoIngredients.map((ing, i) => `<button class="frigo-chip" data-idx="${i}">🥕 ${esc(ing)} ✕</button>`).join('')}
    </div>`;
  el.querySelectorAll('.frigo-chip').forEach(btn => {
    btn.addEventListener('click', ()=>{
      frigoIngredients.splice(parseInt(btn.dataset.idx), 1);
      renderFrigoIngs();
      renderFrigoSuggestions();
    });
  });
}

function matchFrigoRecipes(){
  if (!frigoIngredients.length) return [];
  const normIngs = frigoIngredients.map(i => norm(i));
  return ALL.map(r => {
    const ingText = norm((r.ing||[]).join(' '));
    const matched = normIngs.filter(ing => ingText.includes(ing) || norm(r.t||'').includes(ing));
    return { r, score: matched.length, matched };
  })
  .filter(x => x.score > 0)
  .sort((a, b) => b.score - a.score || a.r.t.localeCompare(b.r.t))
  .slice(0, 24);
}

function renderFrigoSuggestions(){
  const el = document.getElementById('frigo-grid');
  if (!el) return;
  const matches = matchFrigoRecipes();
  if (!matches.length){ el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<div class="frigo-suggestions-title">${matches.length} recette${matches.length>1?'s':''} avec ces ingrédients</div>
    <div class="frigo-rcards">
      ${matches.map(({r, matched}) => {
        const img = r.img
          ? `<img class="thumb" src="${esc(r.img)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.parentElement.innerHTML='<div class=ph>🍲</div>'">`
          : `<div class="ph">🍲</div>`;
        const badges = matched.slice(0,3).map(m=>`<span class="frigo-badge">${esc(m)}</span>`).join('');
        const more = matched.length>3 ? `<span class="frigo-badge">+${matched.length-3}</span>` : '';
        return `<div class="rcard" data-id="${esc(r.id)}" style="cursor:pointer">
          ${img}
          <div class="info">
            <div class="rt">${esc(r.t)}</div>
            <div class="frigo-badges">${badges}${more}</div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  el.querySelectorAll('.rcard').forEach(card => {
    card.addEventListener('click', ()=>{
      closeFrigo();
      openDetail(card.dataset.id);
    });
  });
}

async function handleFrigoCapture(e){
  const file = e.target.files?.[0];
  if (!file) return;
  const statusEl = document.getElementById('frigo-status');
  if (statusEl) statusEl.innerHTML = '<div class="frigo-loading"><div class="imp-spinner"></div> Analyse en cours…</div>';
  try {
    const base64 = await new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = ()=> resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const ingredients = await analyzeFridgeImage(base64, file.type);
    if (statusEl) statusEl.innerHTML = '';
    if (!ingredients.length){
      if (statusEl) statusEl.innerHTML = '<p class="frigo-note">Aucun ingrédient détecté — réessaie avec une photo plus nette.</p>';
      return;
    }
    for (const ing of ingredients){
      const n = norm(ing);
      if (!frigoIngredients.some(x=> norm(x)===n)) frigoIngredients.push(ing);
    }
    renderFrigoIngs();
    renderFrigoSuggestions();
  } catch(err){
    if (statusEl) statusEl.innerHTML = `<p class="frigo-note" style="color:#f0a090">Erreur : ${esc(err.message)}</p>`;
  }
  e.target.value = '';
}

async function analyzeFridgeImage(base64, mimeType){
  const apiKey = localStorage.getItem('frigoApiKey');
  if (!apiKey) throw new Error('Clé API manquante — renseigne-la dans les paramètres ⚙️');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: 'Liste les ingrédients alimentaires visibles dans cette photo. Réponds UNIQUEMENT avec un tableau JSON d\'ingrédients en français minuscules, sans explication ni markdown. Exemple: ["tomate","fromage","oeuf","lait","carotte"]. Maximum 20 ingrédients.' }
        ]
      }]
    })
  });
  if (!resp.ok){
    const err = await resp.json().catch(()=>({}));
    throw new Error(err.error?.message || `Erreur API (${resp.status})`);
  }
  const data = await resp.json();
  const text = (data.content?.[0]?.text || '').trim();
  const m = text.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try { return JSON.parse(m[0]).filter(x=> typeof x==='string' && x.trim()).map(x=> x.trim().toLowerCase()); }
  catch(e){ return []; }
}

/* ---------- init ---------- */
let searchTimer;
async function init(){
  const [bundled, extraData] = await Promise.all([
    fetch('data/recipes.json').then(r=>r.json()),
    fetch('data/recipes-extra.json').then(r=>r.ok?r.json():{}).catch(()=>({})),
  ]);
  EXTRA = extraData;
  let dataObj = bundled;
  const cachedTxt = localStorage.getItem('recipesData');
  if (cachedTxt){ try{ const c=JSON.parse(cachedTxt); if(c.recipes && c.recipes.length) dataObj=c; }catch(e){} }
  BASE = applyExtra(dataObj.recipes || [], EXTRA);
  ALL = mergeEdits();
  buildIngredientIndex();
  elSub.textContent = `${ALL.length} recettes · v${APP_VERSION}`;
  buildCats();
  renderDaily();
  renderFeed();
  renderGrid();
  document.getElementById('sync-btn').addEventListener('click', ()=> syncRemote(true));
  document.getElementById('import-btn').addEventListener('click', openImport);
  document.getElementById('photos-btn').addEventListener('click', fillFromSources);
  document.getElementById('frigo-btn').addEventListener('click', openFrigo);
  document.getElementById('frigo-back').addEventListener('click', closeFrigo);
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-back').addEventListener('click', closeSettings);
  document.getElementById('check-update-btn').addEventListener('click', checkUpdateNow);
  document.getElementById('frigo-api-save').addEventListener('click', ()=>{
    const key = document.getElementById('frigo-api-key').value.trim();
    if (key) localStorage.setItem('frigoApiKey', key);
    else localStorage.removeItem('frigoApiKey');
    toast('Clé API sauvegardée ✓');
  });
  document.getElementById('frigo-file-input').addEventListener('change', handleFrigoCapture);
  // Liens externes (source, vidéo) -> ouverture dans le navigateur du téléphone.
  document.addEventListener('click', (e)=>{
    const a = e.target.closest && e.target.closest('a[href]');
    if(!a) return;
    const href = a.getAttribute('href') || '';
    if(/^https?:\/\//i.test(href)){
      e.preventDefault();
      window.open(href, '_blank');
    }
  }, true);
  syncRemote(false);
  elSearch.addEventListener('input', ()=>{
    clearTimeout(searchTimer);
    searchTimer = setTimeout(()=>{ state.q = elSearch.value; renderGrid(); }, 180);
  });
  document.querySelectorAll('.mode-tab').forEach(btn=>{
    btn.addEventListener('click', ()=> switchMode(btn.dataset.mode));
  });
  window.addEventListener('keydown', (e)=>{
    if(e.key!=='Escape') return;
    const ip=document.getElementById('ingpick');
    if(!elCocktailDetail.hidden) closeCocktailDetail();
    else if(ip && !ip.hidden) closeIngPick();
    else if(!elEdit.hidden) closeEdit();
    else if(!elCook.hidden) closeCook();
    else if(!elImport.hidden) closeImport();
    else if(!document.getElementById('frigo').hidden) closeFrigo();
    else if(!document.getElementById('settings').hidden) closeSettings();
    else if(!elDetail.hidden) closeDetail();
  });
  setupAndroidBack();
  if ('serviceWorker' in navigator){ try{ navigator.serviceWorker.register('sw.js'); }catch(e){} }
}
init();

/* ---------- bouton RETOUR Android : ferme l'écran du dessus au lieu de quitter l'appli ---------- */
function setupAndroidBack(){
  // Du plus prioritaire (modale au-dessus) au moins prioritaire (fiche).
  const CLOSERS = [
    ['catpick', closeCatPick],
    ['ingpick', closeIngPick],
    ['edit',    closeEdit],
    ['import',  closeImport],
    ['cook',    closeCook],
    ['frigo',    closeFrigo],
    ['settings', closeSettings],
    ['detail',   closeDetail],
  ];
  const isOpen   = id => { const el = document.getElementById(id); return !!el && !el.hidden; };
  const anyOpen  = () => CLOSERS.some(([id]) => isOpen(id));
  const topClose = () => { for (const [id, fn] of CLOSERS) if (isOpen(id)) return fn; return null; };
  const hasTrap  = () => !!(history.state && history.state.alxBack);

  // Bouton/geste RETOUR Android -> popstate : on ferme l'overlay du dessus.
  window.addEventListener('popstate', () => {
    const fn = topClose();
    if (fn) fn();                                       // ferme l'écran visible
    if (anyOpen()) history.pushState({ alxBack: 1 }, ''); // ré-arme pour l'écran suivant
  });

  // Pose un "piège" d'historique dès qu'un overlay s'ouvre ; le consomme quand tout est refermé
  // (ex. via les boutons ← à l'écran), pour rester synchronisé sans toucher aux open/close.
  const mo = new MutationObserver(() => {
    if (anyOpen() && !hasTrap())      history.pushState({ alxBack: 1 }, '');
    else if (!anyOpen() && hasTrap()) history.back();
  });
  CLOSERS.forEach(([id]) => { const el = document.getElementById(id); if (el) mo.observe(el, { attributes: true, attributeFilter: ['hidden'] }); });
}
