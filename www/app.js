'use strict';

const APP_VERSION = '3.05';

let ALL = [];
let BASE = [];
let EXTRA = { delete: [], overrides: [], recipes: [] };
let cats = [];
let catCount = {};
// state.cats = liste des catégories cochées dans le filtre (vide = toutes) ; state.fav = filtre favoris.
let state = { q:'', cats:[], fav:false, ing:null, diet:null };
const favs = new Set(JSON.parse(localStorage.getItem('recetteFavs') || '[]'));
let edits = JSON.parse(localStorage.getItem('recetteEdits') || '{}');
let imports = JSON.parse(localStorage.getItem('recetteImports') || '[]');
const deleted = new Set(JSON.parse(localStorage.getItem('recetteDeleted') || '[]'));
function saveEdits(){ localStorage.setItem('recetteEdits', JSON.stringify(edits)); }
function saveImports(){ localStorage.setItem('recetteImports', JSON.stringify(imports)); }
function saveDeleted(){ localStorage.setItem('recetteDeleted', JSON.stringify([...deleted])); }
function applyPatch(r, patch){
  if (!patch) return r;
  const delta = {};
  for (const [k, v] of Object.entries(patch)){
    if (Array.isArray(v) ? v.length > 0 : (v !== '' && v !== null && v !== undefined)) delta[k] = v;
  }
  return Object.keys(delta).length ? Object.assign({}, r, delta) : r;
}
function mergeEdits(){
  const base = BASE.filter(r=> !deleted.has(String(r.id))).map(r => applyPatch(r, edits[r.id]));
  const imp  = imports.filter(r=> !deleted.has(String(r.id))).map(r => applyPatch(r, edits[r.id]));
  return [...base, ...imp];
}
function refreshAll(){ ALL = mergeEdits(); buildIngredientIndex(); buildCats(); renderDaily(); renderCellarHome(); renderGrid(); }

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

const _nc = new Map();
const norm = (s)=>{
  const k = s==null?'':String(s);
  if(_nc.has(k)) return _nc.get(k);
  const v = k.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  _nc.set(k,v); return v;
};
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
  6:['courgette','aubergine','tomate','concombre','poivron','haricot vert','petit pois','feve','artichaut','asperge','blette','betterave','carotte','fenouil','radis','laitue','salade','epinard','oignon','ail','echalote','fraise','cerise','abricot','framboise','groseille','melon','peche','nectarine','rhubarbe','cassis','myrtille'],
  7:['courgette','aubergine','tomate','concombre','poivron','haricot vert','mais','fenouil','betterave','carotte','radis','laitue','salade','oignon','ail','fraise','cerise','abricot','framboise','groseille','melon','peche','nectarine','prune','mure','myrtille','cassis','pasteque','figue'],
  8:['courgette','aubergine','tomate','concombre','poivron','haricot vert','mais','fenouil','betterave','carotte','radis','brocoli','laitue','salade','oignon','ail','peche','nectarine','prune','mirabelle','figue','raisin','melon','pasteque','framboise','mure','myrtille','abricot','pomme','poire'],
  9:['courgette','aubergine','tomate','poivron','haricot vert','mais','brocoli','chou','fenouil','betterave','carotte','radis','blette','epinard','courge','potiron','oignon','ail','raisin','figue','prune','mirabelle','pomme','poire','peche','framboise','noisette','mure'],
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
  for (const k of kws){
    // Tolère les pluriels (« tomates », « haricots verts ») et « chou-fleur » / « chou fleur ».
    const re = new RegExp('\\b' + k.split(/[\s-]+/).map(w => w + '[sx]?').join('[\\s-]+') + '\\b');
    if (re.test(text) && !hits.includes(k)) hits.push(k);
  }
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
/* ---------- filtres diététiques (Santé) ---------- */
const SANTE_SUBS = new Set(['sansgluten','proteines','antiinflamm','vegetarien','vegan','keto','rapide']);

const _GLUTEN_KWS = ['pates','spaghetti','tagliatelle','linguine','penne','fusilli','macaroni','lasagne','semoule','boulgour','couscous','chapelure','biscottes','biscuit','epeautre','seigle','pain','ble','orge','avoine'];
const _GLUTEN_SAFE_FARINE = ['riz','mais','sarrasin','coco','pois','chataigne','manioc','quinoa','teff','sorgho','lupin','lentille','feve','potiron'];

const _PROTEIN_KWS = ['poulet','dinde','boeuf','veau','porc','agneau','canard','lapin','jambon','oeuf','saumon','thon','cabillaud','dorade','sardine','crevette','moule','langoustine','tofu','lentille','pois chiche','fromage','fromage blanc','quinoa','edamame','tempeh','seitan'];

const _ANTIINFL_STRONG = ['curcuma','gingembre','saumon','sardine','maquereau','noix','amande','avocat','epinard','brocoli','myrtille','cerise','framboise','baie'];
const _ANTIINFL_SUPPORT = ['ail','oignon','tomate','citron','olive','thym','romarin','cumin','cannelle'];

const _MEAT_KWS = ['poulet','dinde','boeuf','veau','porc','agneau','canard','lapin','jambon','lardons','saucisse','chorizo','merguez','steak','viande','foie','rognon','magret','pigeon','pintade','caille','perdreau'];
const _FISH_KWS = ['thon','saumon','cabillaud','sardine','maquereau','anchois','crevette','moule','palourde','homard','crabe','poisson','lotte','langoustine','seiche','poulpe','calamar','merlu','daurade','dorade'];

const _KETO_INCLUDE = ['avocat','oeuf','fromage','amande','noix','saumon','boeuf','poulet','agneau','porc','canard','lardons','beurre','creme','parmesan','gruyere'];
const _KETO_EXCLUDE = ['pates','pain','riz','pomme de terre','farine','sucre','cereale','mais','haricot','lentille','pois chiche','biscuit','couscous','semoule','boulgour','miel','sirop','banane','dattes'];

function dietFilter(r){
  if (!state.diet) return true;
  const hasKw = kw => matchKw(r, kw);
  if (state.diet === 'sansgluten'){
    if (_GLUTEN_KWS.some(hasKw)) return false;
    const ings = (r.ing||[]).map(i => flat(i));
    if (ings.some(i => i.includes('farine') && !_GLUTEN_SAFE_FARINE.some(sf => i.includes(sf)))) return false;
    return true;
  }
  if (state.diet === 'proteines') return _PROTEIN_KWS.some(hasKw);
  if (state.diet === 'antiinflamm') return _ANTIINFL_STRONG.some(hasKw) || _ANTIINFL_SUPPORT.filter(hasKw).length >= 3;
  if (state.diet === 'vegetarien') return !_MEAT_KWS.some(hasKw) && !_FISH_KWS.some(hasKw);
  if (state.diet === 'vegan'){
    const animal = [..._MEAT_KWS, ..._FISH_KWS, 'oeuf','lait','creme','beurre','fromage','yaourt','miel','parmesan','emmental','gruyere','ricotta','mozzarella','mascarpone'];
    return !animal.some(hasKw);
  }
  if (state.diet === 'keto') return _KETO_INCLUDE.some(hasKw) && !_KETO_EXCLUDE.some(hasKw);
  if (state.diet === 'rapide') return !!(r.min && r.min <= 30);
  return true;
}

function checkDiet(r, diet){
  const hasKw = kw => matchKw(r, kw);
  if (diet === 'sansgluten'){
    if (_GLUTEN_KWS.some(hasKw)) return false;
    const ings = (r.ing||[]).map(i => flat(i));
    return !ings.some(i => i.includes('farine') && !_GLUTEN_SAFE_FARINE.some(sf => i.includes(sf)));
  }
  if (diet === 'proteines') return _PROTEIN_KWS.some(hasKw);
  if (diet === 'antiinflamm') return _ANTIINFL_STRONG.some(hasKw) || _ANTIINFL_SUPPORT.filter(hasKw).length >= 3;
  if (diet === 'vegetarien') return !_MEAT_KWS.some(hasKw) && !_FISH_KWS.some(hasKw);
  if (diet === 'vegan') return ![..._MEAT_KWS,..._FISH_KWS,'oeuf','lait','creme','beurre','fromage','yaourt','miel','parmesan','emmental','gruyere','ricotta','mozzarella','mascarpone'].some(hasKw);
  if (diet === 'keto') return _KETO_INCLUDE.some(hasKw) && !_KETO_EXCLUDE.some(hasKw);
  if (diet === 'rapide') return !!(r.min && r.min <= 30);
  return false;
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
    if (!dietFilter(r)) return false;
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
const GRID_PG = 48;
let _gList = [], _gPage = 0, _gObs = null;

function renderGrid(){
  if(appMode === 'cocktails') return;
  _gList = filtered(); _gPage = 0;
  const _dietLabel = {sansgluten:'sans gluten',proteines:'riches en protéines',antiinflamm:'anti-inflammatoires',vegetarien:'végétariennes',vegan:'vegan',keto:'keto',rapide:'rapides (≤30 min)'}[state.diet] || '';
  elStatus.textContent = `${_gList.length} recette${_gList.length>1?'s':''}`
    + (_dietLabel ? ` ${_dietLabel}` : '')
    + (state.fav?' en favoris':'');
  if(_gObs){ _gObs.disconnect(); _gObs=null; }
  elGrid.innerHTML = '';
  updateGridFold();
  if(!elGrid.hidden) _gridAppendPage();
  window.scrollTo({top:0});
}
/* Accueil sans recherche ni filtre : la liste complète est repliée derrière
   « Toutes les recettes » (fermée à chaque ouverture de l'app). Dès qu'on
   cherche ou filtre, ou dans les autres onglets, les résultats s'affichent. */
let gridOpen = false;
function gridFoldable(){
  return appMode === 'recipes' && !state.q && !state.cats.length && !state.fav && !state.ing && !state.diet;
}
function updateGridFold(){
  const btn = document.getElementById('all-toggle');
  const fold = gridFoldable();
  btn.hidden = !fold;
  elStatus.hidden = fold;
  elGrid.hidden = fold && !gridOpen;
  if (fold){
    btn.innerHTML = `📚 Toutes les recettes <span class="all-count">${_gList.length}</span><span class="all-chev">${gridOpen ? '▴' : '▾'}</span>`;
    btn.setAttribute('aria-expanded', String(gridOpen));
  }
}
function toggleAllRecipes(){
  gridOpen = !gridOpen;
  updateGridFold();
  if (gridOpen && !elGrid.children.length) _gridAppendPage();
}
function _gridAppendPage(){
  if(_gObs){ _gObs.disconnect(); _gObs=null; }
  const slice = _gList.slice(_gPage*GRID_PG, (_gPage+1)*GRID_PG);
  if(!slice.length) return;
  const frag = document.createDocumentFragment();
  slice.forEach(r=>{ const d=document.createElement('div'); d.innerHTML=card(r); const c=d.firstElementChild; c.addEventListener('click',()=>openDetail(c.dataset.id)); frag.appendChild(c); });
  elGrid.appendChild(frag);
  _gPage++;
  if(_gPage*GRID_PG < _gList.length){
    const s=document.createElement('div'); s.id='grid-sentinel'; s.style.cssText='grid-column:1/-1;height:1px';
    elGrid.appendChild(s);
    _gObs=new IntersectionObserver(es=>{ if(es[0].isIntersecting) _gridAppendPage(); },{rootMargin:'300px'});
    _gObs.observe(s);
  }
}

/* ---------- fiche ---------- */
function splitSteps(txt){
  if (Array.isArray(txt)) return txt.map(s=>s.trim()).filter(Boolean);
  let parts = (txt||'').split(/\r?\n+/).map(s=>s.trim()).filter(Boolean);
  if (parts.length<2){
    parts = (txt||'').split(/(?<=[.!?])\s+(?=[A-ZÀ-ÝÉÈ0-9])/).map(s=>s.trim()).filter(Boolean);
  }
  return parts;
}
function trackView(id){
  try {
    const hist = JSON.parse(localStorage.getItem('recetteHistory')||'[]');
    hist.push({id:String(id), ts:Date.now()});
    if(hist.length>600) hist.splice(0, hist.length-600);
    localStorage.setItem('recetteHistory', JSON.stringify(hist));
  } catch(e){}
}
function getHabitScores(){
  try {
    const hist = JSON.parse(localStorage.getItem('recetteHistory')||'[]');
    const now = Date.now(); const dow = new Date().getDay(); const mon = new Date().getMonth();
    const scores = {};
    for(const {id, ts} of hist){
      const age = (now-ts)/(86400000);
      const d = new Date(ts);
      let w = age < 7 ? 4 : age < 30 ? 2 : 1;
      if(d.getDay()===dow) w += 2;
      if(d.getMonth()===mon) w += 1;
      scores[id] = (scores[id]||0) + w;
    }
    return scores;
  } catch(e){ return {}; }
}
function openDetail(id){
  const r = ALL.find(x=>String(x.id)===String(id)); if(!r) return;
  trackView(id);
  const isFav = favs.has(r.id);
  const hero = r.img
    ? `<img src="${esc(r.img)}" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=ph>🍲</div>'">`
    : `<div class="ph">🍲</div>`;
  const catLabel = catList(r).length ? `${esc(catList(r).join(' · '))} ✏️` : '+ Catégorie';
  const _dietTags = [
    ['sansgluten','🌾','Sans gluten'], ['proteines','💪','Protéines'],
    ['antiinflamm','🌿','Anti-inflam.'], ['vegetarien','🥦','Végétarien'],
    ['vegan','🌱','Vegan'], ['keto','🥑','Keto'],
    ['rapide','⚡','≤30 min'],
  ].filter(([key])=> checkDiet(r, key)).map(([,ico,lbl])=> `<span class="tag tag-diet">${ico} ${lbl}</span>`);
  const tags = [
    `<button class="tag cat tag-cat-btn" title="${catList(r).length?'Modifier les catégories':'Ajouter une catégorie'}">${catLabel}</button>`,
    r.area?`<span class="tag">📍 ${esc(r.area)}</span>`:'',
    r.min?`<span class="tag">⏱️ ${r.min} min</span>`:'',
    r.serv?`<span class="tag">🍽️ ${r.serv} pers.</span>`:'',
    ..._dietTags,
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
  const _pairRaw = r.pair || null;
  const _pairIds = _pairRaw ? (Array.isArray(_pairRaw) ? _pairRaw : [_pairRaw]) : [];
  const _pairs = _pairIds.map(pid=>ALL.find(x=>String(x.id)===String(pid))).filter(Boolean);
  let variantTabs = '';
  if (_pairs.length > 0) {
    const _lbl = (rec) => {
      const c = rec ? (rec.cat||'') : '';
      if (c.includes('Thermomix')) return '⚙️ Thermomix';
      if (c.includes('Airfryer')) return '🌪️ Airfryer';
      return '🥄 Maison';
    };
    const curLbl = _lbl(r);
    const isSpecial = curLbl !== '🥄 Maison';
    const tabList = [];
    if (!isSpecial) {
      tabList.push({id: r.id, label: '🥄 Maison', active: true});
      _pairs.forEach(p => tabList.push({id: p.id, label: _lbl(p), active: false}));
    } else {
      _pairs.forEach(p => tabList.push({id: p.id, label: _lbl(p), active: false}));
      tabList.push({id: r.id, label: curLbl, active: true});
      tabList.sort((a,b) => a.label==='🥄 Maison'?-1:b.label==='🥄 Maison'?1:0);
      tabList.forEach(t => { t.active = (t.id===r.id); });
    }
    variantTabs = `<div class="d-variant-tabs">
  ${tabList.map(t=>`<button class="d-variant-tab${t.active?' active':''}" data-vid="${t.id}">${t.label}</button>`).join('\n  ')}
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
  if (window._wlAcquire) window._wlAcquire();
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
function closeDetail(){ elDetail.hidden=true; document.body.style.overflow=''; renderChips(); renderGrid(); if(window._wlDrop) window._wlDrop(); }

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
  if (window._wlAcquire) window._wlAcquire();
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
  if (window._wlDrop) window._wlDrop();
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
            <input id="e-img" type="text" placeholder="ou coller une URL…" value="${v(r.img)}" class="e-photo-url">
            <input id="e-img-data" type="hidden" value="">
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
      document.getElementById('e-img-data').value = dataUrl;
      document.getElementById('e-img').value = '';
      document.getElementById('e-photo-thumb').innerHTML = `<img src="${dataUrl}">`;
      toast('Photo ajoutée ✓');
    } catch(err){ toast('Erreur : '+err.message); }
    e.target.value = '';
  });
  document.getElementById('e-img').addEventListener('input', (e)=>{
    document.getElementById('e-img-data').value = '';
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
    img: (ev('e-img-data').trim() || ev('e-img').trim()), url: ev('e-url').trim(), vid: ev('e-vid').trim(),
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
  pizza:           { subs: ['garnies','pates_pizza'] },
  regions:         { subs: ['corse','espagne','portugal','italie','grece','france','japon','asie','maghreb','allemagne','gb','australie','bresil','argentine','af','arabe','bulgarie','hongrie','roumanie','paysbas','belgique'] },
  ustensiles:      { subs: ['airfryer','thermomix'] },
  aperitif:        { subs: ['tartinades','wraps','bouchees','brochettes','paninis','samoussas'] },
  oeufs:           { subs: ['omelettes','cocottes','preparations'] },
  boissons:        { subs: ['smoothies','milkshakes','mocktails'] },
  accompagnements: { subs: ['sauces','marinades'] },
  sante:           { subs: ['sansgluten','proteines','antiinflamm','vegetarien','vegan','keto','rapide'] },
};
const SUB_TAB_LABELS = {
  corse:'🏝️ Corse', espagne:'🇪🇸 Espagne', portugal:'🇵🇹 Portugal',
  italie:'🇮🇹 Italie', grece:'🇬🇷 Grèce', france:'🇫🇷 France',
  japon:'🇯🇵 Japon', asie:'🍜 Asie', maghreb:'🫖 Maghreb',
  allemagne:'🇩🇪 Allemagne', gb:'🇬🇧 Grande-Bretagne', australie:'🇦🇺 Australie',
  bresil:'🇧🇷 Brésil', argentine:'🇦🇷 Argentine', af:'🌍 Afrique',
  arabe:'🌙 Monde arabe', bulgarie:'🇧🇬 Bulgarie', hongrie:'🇭🇺 Hongrie', roumanie:'🇷🇴 Roumanie', paysbas:'🇳🇱 Pays-Bas', belgique:'🇧🇪 Belgique',
  garnies:'🍕 Garnitures', pates_pizza:'🍞 Pâtes',
  airfryer:'🌪️ Airfryer', thermomix:'⚙️ Thermomix',
  tartinades:'🥖 Tartinades', wraps:'🌮 Wraps', bouchees:'🫓 Bouchées', brochettes:'🍢 Brochettes', paninis:'🥪 Paninis', samoussas:'🔺 Samoussas',
  omelettes:'🍳 Omelettes', cocottes:'🥚 Cocottes', preparations:'🍳 Préparations',
  smoothies:'🧉 Smoothies', milkshakes:'🥤 Milkshakes', mocktails:'🍹 Sans alcool',
  sauces:'🥣 Sauces', marinades:'🌿 Marinades',
  sansgluten:'🌾 Sans gluten', proteines:'💪 Protéines', antiinflamm:'🌿 Anti-inflam.',
  vegetarien:'🥦 Végétarien', vegan:'🌱 Vegan', keto:'🥑 Keto', rapide:'⚡ ≤30 min',
};
const MODE_CAT = {
  garnies: 'Pizza', pates_pizza: 'Pâte à Pizza',
  airfryer: 'Airfryer', thermomix: 'Thermomix',
  corse: 'Corse', espagne: 'Espagne', portugal: 'Portugal',
  italie: 'Italie', grece: 'Grèce', france: 'France',
  japon: 'Japon', asie: 'Asie', maghreb: 'Maghreb',
  allemagne: 'Allemagne', gb: 'Grande-Bretagne', australie: 'Australie',
  bresil: 'Brésil', argentine: 'Argentine', af: 'Afrique', monde: 'Monde',
  arabe: 'Monde arabe', bulgarie: 'Bulgarie', hongrie: 'Hongrie', roumanie: 'Roumanie', paysbas: 'Pays-Bas', belgique: 'Belgique',
  sauces: 'Sauce', tartinades: 'Tartinade', techniques: 'Technique',
  wraps: 'Wrap', milkshakes: 'Milkshake', smoothies: 'Smoothie', marinades: 'Marinade',
  bouchees: 'Bouchée', brochettes: 'Brochette', omelettes: 'Omelette', cocottes: 'Cocotte',
  mocktails: 'Cocktail sans alcool', preparations: 'Préparation Oeuf',
  paninis: 'Panini', samoussas: 'Samoussa',
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
  const isDiet = SANTE_SUBS.has(leaf);
  if (!isDiet) state.diet = null;
  elCocktailGrid.hidden = !isCocktails;
  document.getElementById('grid').hidden = isCocktails;
  document.getElementById('status').hidden = isCocktails;
  if (isCocktails){
    document.getElementById('all-toggle').hidden = true;
    elSearch.hidden = true;
    document.getElementById('cats').hidden = true;
    document.getElementById('daily').hidden = true;
    document.getElementById('cellar-home').hidden = true;
    loadCocktails();
  } else if (isDiet){
    state.cats = [];
    state.diet = leaf;
    document.getElementById('cats').hidden = true;
    document.getElementById('daily').hidden = true;
    document.getElementById('cellar-home').hidden = true;
    elSearch.hidden = false;
    renderGrid();
  } else if (MODE_CAT[leaf]){
    state.cats = [MODE_CAT[leaf]];
    document.getElementById('cats').hidden = true;
    document.getElementById('daily').hidden = true;
    document.getElementById('cellar-home').hidden = true;
    elSearch.hidden = false;
    renderGrid();
  } else if (leaf === 'recipes'){
    state.cats = [];
    document.getElementById('cats').hidden = false;
    document.getElementById('daily').hidden = false;
    document.getElementById('cellar-home').hidden = false;
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

/* ---------- frigo / congélateur / cellier : analyse photo → suggestions ---------- */
const FTABS = ['frigo', 'congelateur', 'cellier'];
const FTAB_EMOJIS = { frigo: '🧊', congelateur: '❄️', cellier: '🥫' };
let storageIngs = Object.fromEntries(FTABS.map(t => [t, JSON.parse(localStorage.getItem('frigoIngs_' + t) || '[]')]));
let activeFTab = 'frigo';

function saveStorageIngs(tab){ localStorage.setItem('frigoIngs_' + tab, JSON.stringify(storageIngs[tab])); }
function getAllStorageIngs(){ return FTABS.flatMap(t => storageIngs[t]); }

/* Photos des produits : URL Open Food Facts ou vignette de la photo prise,
   indexées par nom normalisé. '' = déjà cherché, pas de photo trouvée. */
let stockImgs = JSON.parse(localStorage.getItem('stockImgs') || '{}');
function saveStockImgs(){ try { localStorage.setItem('stockImgs', JSON.stringify(stockImgs)); } catch(e){} }
function setStockImg(name, img){ stockImgs[norm(name)] = img; saveStockImgs(); }
function getStockImg(name){ return stockImgs[norm(name)] || ''; }

// Réduit une photo en petite vignette JPEG (quelques Ko) stockable localement.
function imageThumb(file, size = 160){
  return createImageBitmap(file).then(bmp => {
    const k = size / Math.max(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * Math.min(1, k)); c.height = Math.round(bmp.height * Math.min(1, k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.72);
  });
}

// Produits ajoutés à la main ou par analyse photo : on cherche une photo par nom sur Open Food Facts.
const _imgQueue = [];
let _imgBusy = false;
function queueStockImg(name){
  const n = norm(name);
  if (n in stockImgs || _imgQueue.some(x => norm(x) === n) || !navigator.onLine) return;
  _imgQueue.push(name);
  pumpStockImgs();
}
async function pumpStockImgs(){
  if (_imgBusy) return;
  _imgBusy = true;
  while (_imgQueue.length){
    const name = _imgQueue.shift();
    let img = '';
    try {
      const r = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(name)}&search_simple=1&action=process&json=1&page_size=3&fields=image_front_small_url&lc=fr&cc=fr`);
      if (!r.ok) continue; // erreur serveur : on retentera plus tard
      const d = await r.json();
      img = (d.products || []).map(p => p.image_front_small_url).find(Boolean) || '';
    } catch(e){ continue; }
    if (!(norm(name) in stockImgs)) setStockImg(name, img);
    if (img) FTABS.forEach(t => { if (storageIngs[t].some(x => norm(x) === norm(name))) renderFrigoIngs(t); });
  }
  _imgBusy = false;
}

// Corrige le nom d'un produit (ex. mauvais nom renvoyé par Open Food Facts) :
// la photo suit, et le carnet des codes-barres retient le nouveau nom.
function renameStockItem(tab, idx){
  const old = storageIngs[tab][idx];
  if (old == null) return;
  const v = (prompt('Nom du produit', old) || '').trim();
  if (!v || v === old) return;
  storageIngs[tab][idx] = v;
  saveStorageIngs(tab);
  const img = stockImgs[norm(old)];
  if (img && !getStockImg(v)) setStockImg(v, img);
  let changed = false;
  for (const code in barcodeBook){
    if (norm(barcodeBook[code].name) === norm(old)){ barcodeBook[code].name = v; changed = true; }
  }
  if (changed){ try { localStorage.setItem('barcodeBook', JSON.stringify(barcodeBook)); } catch(e){} }
  renderFrigoIngs(tab);
  renderFrigoSuggestions();
}

let _photoTarget = null;
function pickStockPhoto(name){
  _photoTarget = name;
  let inp = document.getElementById('stock-photo-input');
  if (!inp){
    inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.setAttribute('capture', 'environment');
    inp.id = 'stock-photo-input'; inp.className = 'frigo-file-hidden';
    inp.addEventListener('change', async ()=>{
      const f = inp.files?.[0]; inp.value = '';
      if (!f || !_photoTarget) return;
      try { setStockImg(_photoTarget, await imageThumb(f)); renderFrigoIngs(activeFTab); }
      catch(e){ toast('Photo illisible'); }
    });
    document.body.appendChild(inp);
  }
  inp.click();
}


function openFrigo(){
  const el = document.getElementById('frigo');
  el.hidden = false;
  const keyField = document.getElementById('frigo-api-key');
  if (keyField) keyField.value = localStorage.getItem('frigoApiKey') || '';
  const settings = document.getElementById('frigo-settings');
  if (settings) settings.open = !localStorage.getItem('frigoApiKey');
  switchFrigoTab(activeFTab);
  renderFrigoSuggestions();
}

function closeFrigo(){ document.getElementById('frigo').hidden = true; renderCellarHome(); }

function switchFrigoTab(tab){
  activeFTab = tab;
  document.querySelectorAll('.frigo-tab').forEach(b => b.classList.toggle('active', b.dataset.ftab === tab));
  FTABS.forEach(t => {
    const pane = document.getElementById('ftab-' + t);
    if (pane) pane.hidden = t !== tab;
  });
  renderFrigoIngs(tab);
}

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
  const done = ()=>{ btn.disabled = false; btn.textContent = 'Vérifier les mises à jour'; };
  if (typeof window.checkAppUpdate !== 'function'){ status.textContent = '⚠ Module de mise à jour absent'; return; }
  btn.disabled = true; btn.textContent = '⏳ Vérification…'; status.textContent = '';
  window.checkAppUpdate(true).then(res => {
    done();
    if (!res) status.textContent = '⚠ Impossible de vérifier (réseau ?)';
    else if (!res.newer) status.textContent = '✓ Déjà à jour (v' + APP_VERSION + ')';
    else { status.textContent = '🔄 Version v' + res.latest + ' disponible — voir le bandeau en bas'; closeSettings(); }
  }).catch(() => { done(); status.textContent = '⚠ Erreur réseau'; });
}

function renderFrigoIngs(tab){
  if (!tab) tab = activeFTab;
  const el = document.getElementById('frigo-ings-' + tab);
  if (!el) return;
  const ings = storageIngs[tab] || [];
  if (!ings.length){ el.hidden = true; return; }
  const emoji = FTAB_EMOJIS[tab];
  el.hidden = false;
  el.innerHTML = `<div class="frigo-ings-title">${emoji} ${ings.length} article${ings.length>1?'s':''} :</div>
    <div class="stock-cards">
      ${ings.map((ing, i) => {
        const img = getStockImg(ing);
        return `<div class="stock-card">
          <button class="stock-card-img" data-idx="${i}" title="Changer la photo">${img
            ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${emoji}'))">`
            : emoji}</button>
          <button class="stock-card-name" data-idx="${i}" title="Renommer">${esc(ing)} ✎</button>
          <button class="stock-card-del" data-idx="${i}" aria-label="Retirer">✕</button>
        </div>`;
      }).join('')}
    </div>
    <p class="stock-hint">Touche une photo pour la remplacer par la tienne.</p>`;
  el.querySelectorAll('.stock-card-del').forEach(btn => {
    btn.addEventListener('click', ()=>{
      storageIngs[tab].splice(parseInt(btn.dataset.idx), 1);
      saveStorageIngs(tab);
      renderFrigoIngs(tab);
      renderFrigoSuggestions();
    });
  });
  el.querySelectorAll('.stock-card-name').forEach(btn => {
    btn.addEventListener('click', ()=> renameStockItem(tab, parseInt(btn.dataset.idx)));
  });
  el.querySelectorAll('.stock-card-img').forEach(btn => {
    btn.addEventListener('click', ()=> pickStockPhoto(ings[parseInt(btn.dataset.idx)]));
  });
  ings.forEach(queueStockImg);
}

/* Appariement stock ↔ recettes : on réduit chaque produit à 1-2 mots-clés
   (« Lentilles vertes du Puy Bio - Carrefour » → lentille, verte) puis on mesure
   quelle part des ingrédients de chaque recette est couverte par les stocks. */
const STOCK_STOP = new Set(('de du des la le les un une et en au aux a d l avec sans pour sur par ou '+
  'bio nature naturel naturelle extra fin fins fine fines classique original originale qualite premium superieur superieure '+
  'boite boites conserve conserves bocal bocaux sachet sachets paquet pack lot format familial maxi mini '+
  'france francais francaise origine marque repere gr kg cl ml litre litres '+
  'carrefour auchan leclerc lidl casino intermarche monoprix franprix systeme reflets panzani barilla lustucru '+
  'bonduelle cassegrain daucy heinz amora maille lesieur puget knorr maggi vahine ancel francine saupiquet connetable').split(' '));
// Mots qui ne suffisent pas seuls : il faut aussi le 2ᵉ mot-clé.
// Formes (« pulpe de mangue » ≠ « pulpe de tomates ») et noms ambigus
// (« pois chiches » ≠ « petits pois », « pomme de terre » ≠ « pomme »).
const STOCK_GENERIC = new Set(['sauce','jus','creme','poudre','sirop','bouillon','puree','confiture','soupe','pate','huile','vinaigre','fromage','lait',
  'pulpe','couli','concentre','compote','nectar','gelee','fond','fumet','cube','flocon','farine','graine','feuille','eau','boisson','yaourt','preparation','melange',
  'filet','dos','steak','morceau','tranche','rondelle','coeur','brisure','haricot','pois','petit','pomme','noix','chou','fruit','cuisse','blanc','aile']);
const LINE_STOP = new Set(['de','du','des','la','le','les','un','une','et','en','au','aux','ou','pour','avec','cuillere','cuilleres','soupe','cafe','pincee','pincees','gousse','gousses','tranche','tranches','boite','boites','sachet','sachets','verre','verres','bouquet','brin','brins','feuille','feuilles']);

// « pâtes » (pâtes alimentaires) ≠ « pâte » (feuilletée, brisée…) : on ne singularise pas ce mot.
function stockStem(w){ return w !== 'pates' && w.length > 4 && /[sx]$/.test(w) ? w.slice(0, -1) : w; }
function stockTokens(s, stop){
  return norm(s).replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(w => w.length >= 3 && !/^\d/.test(w) && !stop.has(w)).map(stockStem);
}
function stockKeys(name){ return stockTokens(name, STOCK_STOP).slice(0, 2); }
function lineHasProduct(lineSet, keys){
  if (!keys.length || !lineSet.has(keys[0])) return false;
  return keys.length === 1 || lineSet.has(keys[1]) || !STOCK_GENERIC.has(keys[0]);
}
// Sel, poivre, eau… : supposés toujours disponibles, n'entrent pas dans la couverture.
function isStapleLine(line){ return /\b(sel|poivre|eau)\b/.test(norm(line)) && norm(line).split(/\s+/).length <= 6; }
function cleanIngLine(line){
  return String(line).replace(/^[\d\s.,/½¼¾⅓⅔-]+/, '')
    .replace(/^(g|kg|mg|ml|cl|dl|l|grammes?|c\.?\s?[aà]\s?[sc]\.?|cuill?\w*( à \w+)?|pinc\w*|gousses?|tranches?|bo[iî]tes?|sachets?|verres?|brins?|feuilles?)\s+/i, '')
    .replace(/^(de |d'|d’)/i, '').trim();
}
const _recipeLineCache = new WeakMap();
function recipeLines(r){
  let v = _recipeLineCache.get(r);
  if (!v){
    v = (r.ing || []).filter(l => l && l.trim() && !isStapleLine(l))
      .map(l => ({ raw: l, set: new Set(stockTokens(l, LINE_STOP)) }))
      .filter(x => x.set.size);
    _recipeLineCache.set(r, v);
  }
  return v;
}

let frigoSugFilter = 'all';

function matchFrigoRecipes(filter = frigoSugFilter, limit = 40){
  const have = FTABS.flatMap(t => storageIngs[t].map(name => ({ name, tab: t, keys: stockKeys(name) })))
    .filter(p => p.keys.length);
  if (!have.length) return [];
  const out = [];
  for (const r of ALL){
    const lines = recipeLines(r);
    if (!lines.length) continue;
    const used = new Map();
    let covered = 0;
    const missing = [];
    for (const ln of lines){
      const hit = have.find(p => lineHasProduct(ln.set, p.keys));
      if (hit){ covered++; used.set(hit.name, hit.tab); }
      else missing.push(cleanIngLine(ln.raw));
    }
    if (!covered) continue;
    // Filtre : la recette doit utiliser au moins un produit de ce stock.
    if (filter !== 'all' && ![...used.values()].includes(filter)) continue;
    out.push({ r, covered, total: lines.length, pct: covered / lines.length, matched: [...used.keys()], missing });
  }
  return out.sort((a, b) => b.pct - a.pct || b.covered - a.covered || a.r.t.localeCompare(b.r.t)).slice(0, limit);
}

function renderFrigoSuggestions(){
  const el = document.getElementById('frigo-grid');
  if (!el) return;
  if (!getAllStorageIngs().length){ el.hidden = true; return; }
  el.hidden = false;
  const counts = { all: getAllStorageIngs().length };
  FTABS.forEach(t => counts[t] = storageIngs[t].length);
  if (frigoSugFilter !== 'all' && !counts[frigoSugFilter]) frigoSugFilter = 'all';
  const matches = matchFrigoRecipes();
  const filterLabel = { all: '🍽️ Tout', frigo: '🧊 Frigo', congelateur: '❄️ Congélo', cellier: '🥫 Cellier' };
  const filters = ['all', ...FTABS].filter(f => counts[f])
    .map(f => `<button class="frigo-sfilter${f===frigoSugFilter?' active':''}" data-sf="${f}">${filterLabel[f]}</button>`).join('');
  const tier = (pct)=> pct >= 0.6 ? 'high' : pct >= 0.3 ? 'mid' : 'low';
  el.innerHTML = `<div class="frigo-suggestions-title">Recettes à faire avec ${frigoSugFilter==='all' ? 'mes stocks' : 'mon ' + filterLabel[frigoSugFilter].slice(3).toLowerCase()}</div>
    <div class="frigo-sfilters">${filters}</div>
    ${matches.length ? `<div class="frigo-sub">${matches.length} recette${matches.length>1?'s':''}, classées par ingrédients déjà en stock</div>
    <div class="frigo-rcards">
      ${matches.map(({r, matched, covered, total, pct, missing}) => {
        const img = r.img
          ? `<img class="thumb" src="${esc(r.img)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.parentElement.innerHTML='<div class=ph>🍲</div>'">`
          : `<div class="ph">🍲</div>`;
        const t = tier(pct);
        const badges = matched.slice(0,3).map(m=>`<span class="frigo-badge">${esc(m)}</span>`).join('');
        const more = matched.length>3 ? `<span class="frigo-badge">+${matched.length-3}</span>` : '';
        const miss = missing.length
          ? `<div class="frigo-missing">Manque : ${esc(missing.slice(0,3).join(', '))}${missing.length>3?'…':''}</div>`
          : `<div class="frigo-missing ok">✓ Tout est en stock</div>`;
        return `<div class="rcard" data-id="${esc(String(r.id))}" style="cursor:pointer">
          ${img}
          <div class="info">
            <div class="rt">${esc(r.t)}</div>
            <div class="panier-score">
              <div class="panier-score-bar"><div class="panier-score-fill ${t}" style="width:${Math.round(pct*100)}%"></div></div>
              <span class="panier-score-label ${t}">${covered}/${total}</span>
            </div>
            <div class="frigo-badges">${badges}${more}</div>
            ${miss}
          </div>
        </div>`;
      }).join('')}
    </div>` : '<p class="frigo-sub">Aucune recette de l\'application ne correspond à ces produits.</p>'}`;
  el.querySelectorAll('.frigo-sfilter').forEach(b => b.addEventListener('click', ()=>{
    frigoSugFilter = b.dataset.sf; renderFrigoSuggestions();
  }));
  el.querySelectorAll('.rcard').forEach(card => {
    card.addEventListener('click', ()=>{
      closeFrigo();
      openDetail(card.dataset.id);
    });
  });
}

/* Accueil : recettes de saison qui utilisent les produits du cellier. */
const HOME_SEASON_SKIP = new Set(['oignon','ail','echalote','citron','carotte']);
function renderCellarHome(){
  const el = document.getElementById('cellar-home');
  if (!el) return;
  const m = monthNow();
  if (!storageIngs.cellier.length){
    el.innerHTML = `<button class="cellar-cta" id="cellar-cta">🥫 Scanne ton cellier pour voir des recettes de saison adaptées →</button>`;
    el.querySelector('#cellar-cta').addEventListener('click', ()=>{ activeFTab = 'cellier'; openFrigo(); });
    return;
  }
  const cellarSet = new Set(storageIngs.cellier.map(norm));
  const picks = matchFrigoRecipes('cellier', Infinity)
    .map(x => {
      // Oignon, ail… sont « de saison » toute l'année : ils ne suffisent pas à inspirer une recette.
      const hits = seasonalHits(x.r, m).filter(h => !HOME_SEASON_SKIP.has(h));
      const fromCellar = x.matched.filter(n => cellarSet.has(norm(n)));
      return { ...x, hits, fromCellar, score: fromCellar.length * 2 + Math.min(hits.length, 3) + x.pct };
    })
    .filter(x => x.hits.length && x.fromCellar.length)
    .sort((a, b) => b.score - a.score || a.r.t.localeCompare(b.r.t))
    .slice(0, 12);
  if (!picks.length){ el.innerHTML = ''; return; }
  el.innerHTML =
    `<div class="feed-label">🌿 De saison + mon cellier · ${MONTHS[m-1]} <span class="feed-count">${picks.length}</span></div>` +
    '<div class="feed-strip">' +
    picks.map(({ r, hits, fromCellar }) => {
      const img = r.img
        ? `<img src="${esc(r.img)}" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=feed-ph>🍲</div>'" loading="lazy">`
        : '<div class="feed-ph">🍲</div>';
      return `<div class="feed-card cellar-card" data-id="${esc(String(r.id))}">${img}<div class="feed-info">
        <div class="feed-t">${esc(r.t)}</div>
        <div class="cellar-tags">${hits.slice(0,2).map(h=>`<span class="cellar-tag season">🌿 ${esc(cap(h))}</span>`).join('')}${fromCellar.slice(0,2).map(n=>`<span class="cellar-tag">🥫 ${esc(n)}</span>`).join('')}</div>
      </div></div>`;
    }).join('') +
    '</div>';
  el.querySelectorAll('.feed-card').forEach(c => c.addEventListener('click', () => openDetail(c.dataset.id)));
}

/* ---------- scan code-barres ---------- */
let scanTargetTab = 'cellier';

/* Scan en continu : la caméra reste ouverte, chaque code-barres lu est
   recherché sur Open Food Facts et ajouté directement au stock choisi. */
const BARCODE_FORMATS = ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','itf'];
let liveScan = null;
function canLiveScan(){ return 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia; }

function stopLiveScan(){
  if (!liveScan) return;
  clearInterval(liveScan.timer);
  liveScan.stream?.getTracks().forEach(t => t.stop());
  liveScan = null;
}

function addStockItem(name, tab, img){
  const n = norm(name);
  if (img) setStockImg(name, img);
  if (storageIngs[tab].some(x => norm(x) === n)) return false;
  storageIngs[tab].push(name);
  saveStorageIngs(tab);
  return true;
}

async function startLiveScan(){
  const body = document.getElementById('scan-body');
  const titleEl = document.getElementById('scan-title');
  if (!body) return;
  stopLiveScan();
  if (titleEl) titleEl.textContent = 'Scan en continu';
  body.innerHTML = `
    <div class="scan-live"><video id="scan-video" playsinline muted autoplay></video><div class="scan-live-frame"></div></div>
    <p class="scan-info" id="scan-live-msg">Vise les codes-barres un par un…</p>
    <div class="scan-tab-sel">
      ${FTABS.map(t=>`<button class="scan-tab-btn${t===scanTargetTab?' active':''}" data-stab="${t}">${FTAB_EMOJIS[t]} ${t==='frigo'?'Frigo':t==='congelateur'?'Congélo':'Cellier'}</button>`).join('')}
    </div>
    <div id="scan-live-list" class="frigo-chips"></div>
    <button class="scan-add-btn" id="scan-live-done">✓ Terminer et voir les recettes</button>`;
  body.querySelectorAll('.scan-tab-btn').forEach(b => b.addEventListener('click', ()=>{
    scanTargetTab = b.dataset.stab;
    body.querySelectorAll('.scan-tab-btn').forEach(x => x.classList.toggle('active', x === b));
  }));
  body.querySelector('#scan-live-done').addEventListener('click', ()=>{
    const tab = scanTargetTab;
    closeScanOverlay();
    frigoSugFilter = tab;
    switchFrigoTab(tab);
    renderFrigoSuggestions();
    document.getElementById('frigo-grid')?.scrollIntoView({ behavior: 'smooth' });
  });
  const msg = body.querySelector('#scan-live-msg');
  const list = body.querySelector('#scan-live-list');
  const video = body.querySelector('#scan-video');
  const session = { stream: null, timer: 0, busy: false, seen: new Set() };
  liveScan = session;
  try {
    session.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch(e){
    if (liveScan === session) liveScan = null;
    msg.textContent = '⚠ Caméra inaccessible (' + (e.message || e.name) + '). Utilise le mode photo.';
    return;
  }
  if (liveScan !== session){ session.stream.getTracks().forEach(t => t.stop()); return; }
  video.srcObject = session.stream;
  try { await video.play(); } catch(e){}
  const det = new BarcodeDetector({ formats: BARCODE_FORMATS });

  function addChip(label, cls){
    const c = document.createElement('span');
    c.className = 'frigo-chip ' + (cls || '');
    c.textContent = label;
    list.prepend(c);
    return c;
  }

  session.timer = setInterval(async ()=>{
    if (session.busy || liveScan !== session || video.readyState < 2) return;
    session.busy = true;
    try {
      const codes = await det.detect(video);
      const code = codes.map(c => c.rawValue).find(v => v && !session.seen.has(v));
      if (!code) return;
      session.seen.add(code);
      navigator.vibrate?.(60);
      const tab = scanTargetTab;
      msg.textContent = `Code ${code} — recherche…`;
      const prod = await lookupBarcode(code);
      if (liveScan !== session) return;
      const name = prod?.name;
      if (name){
        const added = addStockItem(name, tab, prod.img);
        addChip(`${FTAB_EMOJIS[tab]} ${name}${added ? '' : ' (déjà là)'}`);
        msg.textContent = `✓ ${name}${prod.known ? ' (déjà connu)' : ''}`;
      } else {
        const chip = addChip(`❓ ${code} — toucher pour nommer`, 'unknown');
        chip.addEventListener('click', ()=>{
          const v = (prompt('Nom du produit ?') || '').trim();
          if (!v) return;
          rememberBarcode(code, v, '');
          addStockItem(v, tab);
          chip.textContent = `${FTAB_EMOJIS[tab]} ${v}`;
          chip.classList.remove('unknown');
          renderFrigoIngs(tab);
          renderFrigoSuggestions();
        });
        msg.textContent = 'Produit inconnu d\'Open Food Facts — touche la pastille pour le nommer.';
      }
      renderFrigoIngs(tab);
      renderFrigoSuggestions();
    } catch(e){ /* image illisible : on réessaie au tick suivant */ }
    finally { session.busy = false; }
  }, 400);
}


function openScanOverlay(tab){
  scanTargetTab = tab || activeFTab;
  const el = document.getElementById('scan-overlay');
  if (el) { el.hidden = false; setScanState('init'); }
}

function closeScanOverlay(){
  stopLiveScan();
  const el = document.getElementById('scan-overlay');
  if (el) el.hidden = true;
}

function setScanState(state, data){
  data = data || {};
  const body = document.getElementById('scan-body');
  const titleEl = document.getElementById('scan-title');
  if (!body) return;
  stopLiveScan();

  if (state === 'init'){
    if (titleEl) titleEl.textContent = 'Scanner un produit';
    body.innerHTML = `
      <p class="scan-info">Scanne tes produits pour les ajouter au stock : les recettes adaptées s'affichent ensuite.</p>
      ${canLiveScan() ? '<button class="frigo-capture-btn" id="scan-live-btn">🎥 Scan en continu</button>' : ''}
      <label class="${canLiveScan() ? 'frigo-scan-btn' : 'frigo-capture-btn'}" for="scan-barcode-photo">📷 Une photo du code-barres ou de l'étiquette</label>
      <input type="file" id="scan-barcode-photo" class="frigo-file-hidden" accept="image/*" capture="environment" />
      <div class="scan-or">— ou saisir manuellement —</div>
      <div class="frigo-manual-row">
        <input id="scan-manual-inp" class="frigo-manual-input" type="text" placeholder="Nom du produit…" autocomplete="off" autocapitalize="sentences" />
        <button id="scan-manual-add" class="frigo-manual-add">+</button>
      </div>`;
    body.querySelector('#scan-barcode-photo').addEventListener('change', handleScanCapture);
    body.querySelector('#scan-live-btn')?.addEventListener('click', startLiveScan);
    const inp = body.querySelector('#scan-manual-inp');
    const btn = body.querySelector('#scan-manual-add');
    function doManual(){ const v=inp.value.trim(); if(v) confirmAddProduct(v, scanTargetTab); }
    btn.addEventListener('click', doManual);
    inp.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); doManual(); } });
    return;
  }

  if (state === 'loading'){
    if (titleEl) titleEl.textContent = 'Scanner un produit';
    body.innerHTML = `<div class="frigo-loading"><div class="imp-spinner"></div> ${esc(data.message || 'Analyse…')}</div>`;
    return;
  }

  if (state === 'confirm'){
    if (titleEl) titleEl.textContent = data.source === 'openfoodfacts' ? '✓ Produit trouvé' : '✓ Produit identifié';
    body.innerHTML = `
      ${data.img ? `<img class="scan-product-img" src="${esc(data.img)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      ${data.barcode ? `<p class="scan-barcode-code">Code-barres : ${esc(data.barcode)}</p>` : ''}
      ${!data.name ? '<p class="scan-info">Produit non reconnu — saisir le nom :</p>' : ''}
      <label class="scan-label-sm">Nom du produit</label>
      <input id="scan-product-name" class="frigo-manual-input" type="text" value="${esc(data.name || '')}" autocapitalize="sentences" />
      <label class="scan-label-sm">Ajouter au stock</label>
      <div class="scan-tab-sel">
        ${FTABS.map(t=>`<button class="scan-tab-btn${t===scanTargetTab?' active':''}" data-stab="${t}">${FTAB_EMOJIS[t]} ${t==='frigo'?'Frigo':t==='congelateur'?'Congélo':'Cellier'}</button>`).join('')}
      </div>
      <button class="scan-add-btn" id="scan-add-btn">✓ Ajouter au stock</button>`;
    body.querySelectorAll('.scan-tab-btn').forEach(b=>{
      b.addEventListener('click', ()=>{
        scanTargetTab = b.dataset.stab;
        body.querySelectorAll('.scan-tab-btn').forEach(x=>x.classList.toggle('active', x===b));
      });
    });
    body.querySelector('#scan-add-btn').addEventListener('click', ()=>{
      const name = body.querySelector('#scan-product-name').value.trim();
      if (name){ rememberBarcode(data.barcode, name, data.img); confirmAddProduct(name, scanTargetTab, data.img); }
    });
    body.querySelector('#scan-product-name').addEventListener('keydown', e=>{
      if(e.key==='Enter'){ e.preventDefault(); const v=e.target.value.trim(); if(v){ rememberBarcode(data.barcode, v, data.img); confirmAddProduct(v, scanTargetTab, data.img); } }
    });
    setTimeout(()=>{ const inp=body.querySelector('#scan-product-name'); if(inp&&!data.name) inp.focus(); }, 80);
    return;
  }

  if (state === 'error'){
    if (titleEl) titleEl.textContent = '⚠ Problème';
    body.innerHTML = `
      <p class="frigo-note" style="color:#f0a090">${esc(data.message)}</p>
      <div class="scan-or">Saisir manuellement :</div>
      <div class="frigo-manual-row">
        <input id="scan-manual-inp" class="frigo-manual-input" type="text" placeholder="Nom du produit…" autocomplete="off" autocapitalize="sentences" />
        <button id="scan-manual-add" class="frigo-manual-add">+</button>
      </div>`;
    const inp = body.querySelector('#scan-manual-inp');
    const btn = body.querySelector('#scan-manual-add');
    function doAdd(){ const v=inp.value.trim(); if(v) confirmAddProduct(v, scanTargetTab); }
    btn.addEventListener('click', doAdd);
    inp.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); doAdd(); } });
  }
}

async function handleScanCapture(e){
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';

  setScanState('loading', { message: 'Lecture du code-barres…' });
  try {
    let barcode = null;
    // La photo prise sert de vignette si Open Food Facts n'en fournit pas.
    const photo = await imageThumb(file).catch(()=> '');

    if ('BarcodeDetector' in window){
      try {
        const bitmap = await createImageBitmap(file);
        const det = new BarcodeDetector({ formats: ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','qr_code','data_matrix','itf'] });
        const codes = await det.detect(bitmap);
        if (codes.length) barcode = codes[0].rawValue;
      } catch(_){}
    }

    if (barcode){
      setScanState('loading', { message: `Code ${barcode} — recherche en base…` });
      const prod = await lookupBarcode(barcode);
      if (prod){
        setScanState('confirm', { name: prod.name, img: prod.img || photo, barcode, source: 'openfoodfacts' });
        return;
      }
      setScanState('loading', { message: 'Produit inconnu — analyse de l\'étiquette…' });
    } else {
      setScanState('loading', { message: 'Code-barres non détecté — analyse de l\'image…' });
    }

    const apiKey = localStorage.getItem('frigoApiKey');
    if (!apiKey){
      setScanState('confirm', { name: '', img: photo, barcode, source: 'manual' });
      return;
    }
    const base64 = await fileToBase64(file);
    const names = await analyzeFridgeImage(base64, file.type, 'cellier');
    setScanState('confirm', { name: names[0] || '', img: photo, barcode, source: 'claude' });

  } catch(err){
    setScanState('error', { message: err.message });
  }
}

/* Carnet local des codes-barres déjà scannés : code → { name, img }.
   Évite de réinterroger Open Food Facts, marche hors-ligne et garde
   le nom choisi (ou saisi pour un produit inconnu) pour les prochaines fois. */
let barcodeBook = JSON.parse(localStorage.getItem('barcodeBook') || '{}');
function rememberBarcode(code, name, img){
  if (!code || !name) return;
  barcodeBook[code] = { name, img: img || barcodeBook[code]?.img || '' };
  try { localStorage.setItem('barcodeBook', JSON.stringify(barcodeBook)); } catch(e){}
}

async function lookupBarcode(code){
  if (barcodeBook[code]) return { ...barcodeBook[code], known: true };
  try {
    const r = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}?fields=product_name_fr,product_name,generic_name_fr,generic_name,image_front_small_url,image_small_url`,
      { headers: { 'User-Agent': 'RecettesApp/2.98 (github.com/laurentsar/recettes)' } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    if (d.status !== 1) return null;
    const p = d.product || {};
    const name = (p.product_name_fr || p.product_name || p.generic_name_fr || p.generic_name || '').trim();
    if (!name) return null;
    const img = p.image_front_small_url || p.image_small_url || '';
    rememberBarcode(code, name, img);
    return { name, img };
  } catch(e){ return null; }
}

function fileToBase64(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function confirmAddProduct(name, tab, img){
  addStockItem(name, tab, img);
  renderFrigoIngs(tab);
  renderFrigoSuggestions();
  switchFrigoTab(tab);
  closeScanOverlay();
  toast(`${FTAB_EMOJIS[tab]} « ${esc(name)} » ajouté`);
}

async function handleFrigoCapture(e){
  const file = e.target.files?.[0];
  if (!file) return;
  const tab = e.target.dataset.ftab || 'frigo';
  const statusEl = document.getElementById('frigo-status-' + tab);
  if (statusEl) statusEl.innerHTML = '<div class="frigo-loading"><div class="imp-spinner"></div> Analyse en cours…</div>';
  try {
    const base64 = await new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = ()=> resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const ingredients = await analyzeFridgeImage(base64, file.type, tab);
    if (statusEl) statusEl.innerHTML = '';
    if (!ingredients.length){
      if (statusEl) statusEl.innerHTML = '<p class="frigo-note">Aucun produit détecté — réessaie avec une photo plus nette.</p>';
      return;
    }
    for (const ing of ingredients){
      const n = norm(ing);
      if (!storageIngs[tab].some(x=> norm(x)===n)) storageIngs[tab].push(ing);
    }
    saveStorageIngs(tab);
    renderFrigoIngs(tab);
    renderFrigoSuggestions();
  } catch(err){
    if (statusEl) statusEl.innerHTML = `<p class="frigo-note" style="color:#f0a090">Erreur : ${esc(err.message)}</p>`;
  }
  e.target.value = '';
}

const FRIGO_PROMPTS = {
  frigo: 'Liste les ingrédients alimentaires visibles dans cette photo du réfrigérateur. Réponds UNIQUEMENT avec un tableau JSON d\'ingrédients en français minuscules, sans explication ni markdown. Exemple: ["tomate","fromage","oeuf","lait","carotte"]. Maximum 20 ingrédients.',
  congelateur: 'Liste les aliments surgelés visibles dans cette photo du congélateur. Réponds UNIQUEMENT avec un tableau JSON en français minuscules, sans explication ni markdown. Exemple: ["épinards surgelés","poisson pané","petits pois"]. Maximum 20 produits.',
  cellier: 'Liste les produits alimentaires visibles dans cette photo (conserves, boîtes, bocaux, pâtes, riz, légumineuses, épices, huiles, condiments, farines…). Réponds UNIQUEMENT avec un tableau JSON en français minuscules, sans explication ni markdown. Exemple: ["tomates pelées","lentilles","huile d\'olive","pâtes"]. Maximum 25 produits.',
};

async function analyzeFridgeImage(base64, mimeType, tab){
  const apiKey = localStorage.getItem('frigoApiKey');
  if (!apiKey) throw new Error('Clé API manquante — renseigne-la dans les paramètres ⚙️');
  const prompt = FRIGO_PROMPTS[tab] || FRIGO_PROMPTS.frigo;
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
          { type: 'text', text: prompt }
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

/* ---------- panier du producteur ---------- */
let panierVegs = JSON.parse(localStorage.getItem('panierVegs') || '[]');
function savePanierVegs(){ localStorage.setItem('panierVegs', JSON.stringify(panierVegs)); }

function openPanier(){
  document.getElementById('panier').hidden = false;
  document.body.style.overflow = 'hidden';
  renderPanierChips();
  renderPanierGrid();
  const inp = document.getElementById('panier-input');
  if (inp) setTimeout(()=> inp.focus(), 80);
}
function closePanier(){ document.getElementById('panier').hidden = true; document.body.style.overflow = ''; }

function updatePanierBtn(){
  const btn = document.getElementById('panier-btn');
  if (btn) btn.classList.toggle('has-veg', panierVegs.length > 0);
}

function addPanierVeg(){
  const inp = document.getElementById('panier-input');
  if (!inp) return;
  const raw = inp.value.trim();
  if (!raw) return;
  // support multiple comma-separated entries
  const items = raw.split(/[,;]+/).map(s=> s.trim()).filter(Boolean);
  let added = false;
  for (const item of items){
    const n = norm(item);
    if (!panierVegs.some(v=> norm(v)===n)){ panierVegs.push(item); added = true; }
  }
  if (added){ savePanierVegs(); updatePanierBtn(); renderPanierChips(); renderPanierGrid(); }
  inp.value = '';
  inp.focus();
}

function removePanierVeg(idx){
  panierVegs.splice(idx, 1);
  savePanierVegs(); updatePanierBtn(); renderPanierChips(); renderPanierGrid();
}

function renderPanierChips(){
  const el = document.getElementById('panier-chips');
  if (!el) return;
  el.innerHTML = panierVegs.map((v, i)=>
    `<button class="panier-chip" data-pidx="${i}">🥦 ${esc(v)} <span class="panier-chip-x">✕</span></button>`
  ).join('');
  el.querySelectorAll('.panier-chip').forEach(btn=>{
    btn.addEventListener('click', ()=> removePanierVeg(parseInt(btn.dataset.pidx)));
  });
}

const PANIER_SEASONS = {
  '🌱 Printemps': ['asperge','artichaut','petit pois','épinard','radis','blette','laitue','fève','oignon nouveau'],
  '🌞 Été':       ['tomate','courgette','aubergine','poivron','concombre','haricot vert','maïs','fenouil','betterave'],
  '🍂 Automne':   ['courge','potiron','champignon','poireau','chou-fleur','brocoli','navet','panais','châtaigne'],
  '❄️ Hiver':     ['carotte','pomme de terre','céleri','chou','endive','navet','topinambour','mâche','poireau'],
};
function addPanierSeason(label){
  const veg = PANIER_SEASONS[label] || [];
  let added = false;
  for(const v of veg){ const n=norm(v); if(!panierVegs.some(x=>norm(x)===n)){ panierVegs.push(v); added=true; } }
  if(added){ savePanierVegs(); updatePanierBtn(); renderPanierChips(); renderPanierGrid(); }
}

function vegWords(v){ return norm(v).split(/\s+/).filter(w=>w.length>=4); }

function scorePanier(r, vegWordsList){
  const corpus = norm((r.ing||[]).join(' ') + ' ' + (r.t||''));
  const matched = panierVegs.filter((_,i)=> vegWordsList[i].some(w=> corpus.includes(w)));
  return { matched, pct: matched.length / panierVegs.length };
}

function renderPanierGrid(){
  const el = document.getElementById('panier-grid');
  if (!el) return;
  if (!panierVegs.length){
    el.innerHTML = '<div class="panier-empty">Ajoute des légumes de ton panier ci-dessus pour voir les recettes adaptées.<br><br>🥕 carotte · 🥦 brocoli · 🍅 tomate …</div>';
    return;
  }
  const vegWordsList = panierVegs.map(v=> vegWords(v));
  const scored = ALL
    .map(r=>{ const s = scorePanier(r, vegWordsList); return { r, ...s }; })
    .filter(x=> x.matched.length > 0)
    .sort((a,b)=> b.pct - a.pct || b.matched.length - a.matched.length);
  if (!scored.length){
    el.innerHTML = '<div class="panier-empty">Aucune recette trouvée avec ces légumes.<br>Essaie des noms plus génériques (ex : "tomate" plutôt que "tomates cerises").</div>';
    return;
  }
  const tier = (pct)=> pct >= 0.5 ? 'high' : pct >= 0.25 ? 'mid' : 'low';
  el.innerHTML = `
    <div class="panier-results-header">${scored.length} recette${scored.length>1?'s':''} trouvée${scored.length>1?'s':''}</div>
    <div class="panier-rcards">${scored.map(({r, matched, pct})=>{
      const img = r.img
        ? `<img class="thumb" src="${esc(r.img)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.parentElement.innerHTML='<div class=ph>🍲</div>'">`
        : `<div class="ph">🍲</div>`;
      const t = tier(pct);
      const pctPx = Math.round(pct*100);
      const badges = matched.slice(0,4).map(m=> `<span class="panier-veg-badge">${esc(m)}</span>`).join('');
      const more = matched.length > 4 ? `<span class="panier-veg-badge">+${matched.length-4}</span>` : '';
      return `<div class="panier-rcard" data-pid="${esc(String(r.id))}">
        ${img}
        <div class="info">
          <div class="rt">${esc(r.t)}</div>
          <div class="panier-score">
            <div class="panier-score-bar"><div class="panier-score-fill ${t}" style="width:${pctPx}%"></div></div>
            <span class="panier-score-label ${t}">${matched.length}/${panierVegs.length} · ${pctPx}%</span>
          </div>
          <div class="panier-veg-badges">${badges}${more}</div>
        </div>
      </div>`;
    }).join('')}</div>`;
  el.querySelectorAll('.panier-rcard').forEach(card=>{
    card.addEventListener('click', ()=>{ closePanier(); openDetail(card.dataset.pid); });
  });
}

/* ---------- planning semaine ---------- */
let mealPlan = JSON.parse(localStorage.getItem('mealPlan') || '{}');
let planChecked = JSON.parse(localStorage.getItem('planChecked') || '{}');
let planWeekOffset = 0;
let planPickerSlot = null;
let _planTab = 'week';
function saveMealPlan(){ localStorage.setItem('mealPlan', JSON.stringify(mealPlan)); }
function savePlanChecked(){ localStorage.setItem('planChecked', JSON.stringify(planChecked)); }

function getMondayOfWeek(offset){
  const now = new Date();
  const day = now.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff + offset * 7);
}
function dateKey(d){ return d.toISOString().slice(0,10); }

function openPlan(){
  planWeekOffset = 0;
  _planTab = 'week';
  document.getElementById('plan').hidden = false;
  switchPlanTab('week');
}
function closePlan(){ document.getElementById('plan').hidden = true; }

function switchPlanTab(tab){
  _planTab = tab;
  document.querySelectorAll('.plan-tab').forEach(b=> b.classList.toggle('active', b.dataset.ptab === tab));
  document.getElementById('plan-week-pane').hidden = tab !== 'week';
  document.getElementById('plan-courses-pane').hidden = tab !== 'courses';
  if (tab === 'week') renderPlanWeek(); else renderPlanCourses();
}

const PLAN_SHORT = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];

function renderPlanWeek(){
  const pane = document.getElementById('plan-week-pane');
  if (!pane) return;
  const mon = getMondayOfWeek(planWeekOffset);
  const end = new Date(mon); end.setDate(mon.getDate() + 6);
  const fmt = d => d.toLocaleDateString('fr-FR', {day:'numeric', month:'short'});
  document.getElementById('plan-week-label').textContent = `${fmt(mon)} – ${fmt(end)}`;
  const todayKey = dateKey(new Date());
  let html = '<div class="plan-grid">';
  for (let i = 0; i < 7; i++){
    const d = new Date(mon); d.setDate(mon.getDate() + i);
    const dk = dateKey(d);
    const slots = mealPlan[dk] || {};
    html += `<div class="plan-day${dk===todayKey?' today':''}">
      <div class="plan-day-name">${PLAN_SHORT[i]} <span class="plan-day-num">${d.getDate()}</span></div>
      <div class="plan-slots">
        ${planSlotHtml(dk,'lunch',slots.lunch,'🍽️')}
        ${planSlotHtml(dk,'dinner',slots.dinner,'🌙')}
      </div>
    </div>`;
  }
  html += '</div>';
  pane.innerHTML = html;
  pane.querySelectorAll('.plan-add-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> openPlanPicker(btn.dataset.date, btn.dataset.meal));
  });
  pane.querySelectorAll('.plan-slot-clear').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const {date, meal} = btn.dataset;
      if (!mealPlan[date]) return;
      delete mealPlan[date][meal];
      if (!mealPlan[date].lunch && !mealPlan[date].dinner) delete mealPlan[date];
      saveMealPlan(); renderPlanWeek();
    });
  });
  pane.querySelectorAll('.plan-slot-recipe').forEach(card=>{
    card.addEventListener('click', ()=>{ closePlan(); openDetail(card.dataset.rid); });
  });
}

function planSlotHtml(date, meal, rid, emoji){
  if (rid){
    const r = ALL.find(x=> String(x.id) === rid);
    if (r){
      const imgHtml = r.img
        ? `<div class="plan-slot-img"><img src="${esc(r.img)}" referrerpolicy="no-referrer" loading="lazy"></div>`
        : '';
      return `<div class="plan-slot plan-slot--filled plan-slot-recipe" data-rid="${esc(rid)}">
        <div class="plan-slot-emoji">${emoji}</div>
        ${imgHtml}
        <div class="plan-slot-name">${esc(r.t)}</div>
        <button class="plan-slot-clear" data-date="${esc(date)}" data-meal="${meal}" aria-label="Supprimer">×</button>
      </div>`;
    }
  }
  return `<button class="plan-slot plan-slot--empty plan-add-btn" data-date="${esc(date)}" data-meal="${meal}">
    <span class="plan-slot-emoji">${emoji}</span>
    <span class="plan-slot-plus">+</span>
  </button>`;
}

function renderPlanCourses(){
  const pane = document.getElementById('plan-courses-pane');
  if (!pane) return;
  const mon = getMondayOfWeek(planWeekOffset);
  const assigned = [];
  for (let i = 0; i < 7; i++){
    const d = new Date(mon); d.setDate(mon.getDate() + i);
    const dk = dateKey(d);
    const slots = mealPlan[dk] || {};
    for (const meal of ['lunch','dinner']){
      if (slots[meal]){
        const r = ALL.find(x=> String(x.id) === slots[meal]);
        if (r) assigned.push({r, day: PLAN_SHORT[i], meal, dk});
      }
    }
  }
  if (!assigned.length){
    pane.innerHTML = '<div class="plan-empty">Assigne des recettes dans l\'onglet 📅 Semaine pour voir la liste de courses.</div>';
    return;
  }
  const weekKey = `w${planWeekOffset}_${dateKey(mon)}`;
  const checked = planChecked[weekKey] || {};
  const byRecipe = assigned.map(({r, day, meal})=>{
    const icon = meal === 'lunch' ? '🍽️' : '🌙';
    const ings = (r.ing||[]).map((ing, i)=>{
      const ck = `${r.id}_${i}`;
      return `<li class="plan-ing-item${checked[ck]?' done':''}" data-ck="${esc(ck)}"><span class="plan-ing-check"></span><span>${esc(ing)}</span></li>`;
    }).join('');
    return `<div class="plan-ing-section">
      <div class="plan-ing-title">${icon} ${esc(day)} — ${esc(r.t)}</div>
      <ul class="plan-ing-list">${ings}</ul>
    </div>`;
  }).join('');
  pane.innerHTML = `<div class="plan-courses-body">
    <div class="plan-courses-actions">
      <button class="plan-copy-btn" id="plan-copy-btn">📋 Copier</button>
      <button class="plan-uncheck-btn" id="plan-uncheck-btn">↺ Tout décocher</button>
    </div>
    ${byRecipe}
  </div>`;
  pane.querySelectorAll('.plan-ing-item').forEach(li=>{
    li.addEventListener('click', ()=>{
      const ck = li.dataset.ck;
      if (!planChecked[weekKey]) planChecked[weekKey] = {};
      if (planChecked[weekKey][ck]) delete planChecked[weekKey][ck];
      else planChecked[weekKey][ck] = 1;
      savePlanChecked();
      li.classList.toggle('done', !!planChecked[weekKey][ck]);
    });
  });
  document.getElementById('plan-copy-btn').addEventListener('click', ()=>{
    const text = assigned.map(({r, day, meal})=>{
      const label = meal === 'lunch' ? 'Midi' : 'Soir';
      const ings = (r.ing||[]).map(i=> `  - ${i}`).join('\n');
      return `${day} ${label} — ${r.t}\n${ings}`;
    }).join('\n\n');
    navigator.clipboard.writeText(text).then(()=> toast('Liste copiée ✓')).catch(()=> toast('Copie impossible'));
  });
  document.getElementById('plan-uncheck-btn').addEventListener('click', ()=>{
    delete planChecked[weekKey]; savePlanChecked(); renderPlanCourses();
  });
}

function openPlanPicker(date, meal){
  planPickerSlot = {date, meal};
  const el = document.getElementById('plan-picker');
  if (!el) return;
  el.hidden = false;
  document.getElementById('plan-picker-search').value = '';
  renderPlanPicker('');
}
function closePlanPicker(){
  planPickerSlot = null;
  const el = document.getElementById('plan-picker');
  if (el) el.hidden = true;
}
function renderPlanPicker(q){
  const grid = document.getElementById('plan-picker-grid');
  if (!grid) return;
  const lq = q.trim().toLowerCase();
  const list = lq
    ? ALL.filter(r=> (r.t||'').toLowerCase().includes(lq) || (r.ing||[]).some(i=> i.toLowerCase().includes(lq)))
    : ALL;
  grid.innerHTML = list.slice(0, 80).map(r=>{
    const img = r.img
      ? `<img src="${esc(r.img)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.parentNode.innerHTML='<div class=ph>🍲</div>'">`
      : `<div class="ph">🍲</div>`;
    return `<div class="plan-pick-card" data-pid="${esc(String(r.id))}">${img}<div class="plan-pick-name">${esc(r.t)}</div></div>`;
  }).join('');
  grid.querySelectorAll('.plan-pick-card').forEach(card=>{
    card.addEventListener('click', ()=>{
      if (!planPickerSlot) return;
      const {date, meal} = planPickerSlot;
      if (!mealPlan[date]) mealPlan[date] = {};
      mealPlan[date][meal] = card.dataset.pid;
      saveMealPlan(); closePlanPicker(); renderPlanWeek();
    });
  });
}

/* ---------- batch cooking ---------- */
let batchSel = new Set(JSON.parse(localStorage.getItem('batchSelection') || '[]'));
function saveBatchSel(){ localStorage.setItem('batchSelection', JSON.stringify([...batchSel])); }
let _batchTab = 'sel';

function openBatch(){
  document.getElementById('batch').hidden = false;
  document.body.style.overflow = 'hidden';
  _batchTab = 'sel';
  _batchApplyTab();
  renderBatchSel();
}
function closeBatch(){ document.getElementById('batch').hidden = true; document.body.style.overflow = ''; }

function _batchApplyTab(){
  document.querySelectorAll('.batch-tab').forEach(b=> b.classList.toggle('active', b.dataset.btab === _batchTab));
  document.getElementById('batch-sel-pane').hidden     = _batchTab !== 'sel';
  document.getElementById('batch-courses-pane').hidden = _batchTab !== 'courses';
  document.getElementById('batch-cuisson-pane').hidden = _batchTab !== 'cuisson';
}

function switchBatchTab(tab){
  _batchTab = tab;
  _batchApplyTab();
  if (tab === 'courses') renderBatchCourses();
  else if (tab === 'cuisson') renderBatchCuisson();
  else renderBatchSel();
}

function updateBatchBtn(){
  const btn = document.getElementById('batch-btn');
  if (btn) btn.classList.toggle('has-sel', batchSel.size > 0);
}

function renderBatchSel(){
  const pane = document.getElementById('batch-sel-pane');
  if (!pane) return;
  if (!ALL.length){ pane.innerHTML = '<div class="batch-empty">Aucune recette chargée.</div>'; return; }
  const q = norm((document.getElementById('batch-search')?.value||'').trim());
  const list = q ? ALL.filter(r=> norm(r.t).includes(q) || norm(r.cat).includes(q)) : ALL;
  const selCount = batchSel.size;
  // Preserve scroll position
  const scrollTop = pane.scrollTop;
  pane.innerHTML = `<div class="batch-sel-header">${selCount > 0 ? `<span class="batch-sel-count">${selCount} sélectionnée${selCount>1?'s':''}</span>` : `<span style="color:var(--muted);font-size:.85em">${list.length} recettes</span>`}</div><div class="batch-sel-grid">${
    list.map(r=>{
      const isSel = batchSel.has(String(r.id));
      const img = r.img
        ? `<img class="thumb" src="${esc(r.img)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.parentElement.innerHTML='<div class=ph>🍲</div>'">`
        : `<div class="ph">🍲</div>`;
      return `<div class="batch-rcard-wrap">
        <div class="batch-rcard${isSel?' sel':''}" data-bid="${esc(String(r.id))}">
          ${img}
          <div class="info">
            <div class="rt">${esc(r.t)}</div>
            ${r.min?`<div class="meta">⏱️ ${r.min} min</div>`:''}
          </div>
        </div>
        <div class="batch-chk">✓</div>
      </div>`;
    }).join('')
  }</div>`;
  pane.scrollTop = scrollTop;
  pane.querySelectorAll('.batch-rcard').forEach(card=>{
    card.addEventListener('click', ()=>{
      const bid = card.dataset.bid;
      if (batchSel.has(bid)) batchSel.delete(bid); else batchSel.add(bid);
      saveBatchSel(); updateBatchBtn();
      card.classList.toggle('sel', batchSel.has(bid));
      const chk = card.parentElement.querySelector('.batch-chk');
      if (chk) chk.style.opacity = batchSel.has(bid) ? '1' : '0';
      // update header count without full re-render
      const hdr = pane.querySelector('.batch-sel-header');
      if(hdr){ const n=batchSel.size; hdr.innerHTML = n>0 ? `<span class="batch-sel-count">${n} sélectionnée${n>1?'s':''}</span>` : `<span style="color:var(--muted);font-size:.85em">${list.length} recettes</span>`; }
    });
  });
}

function renderBatchCourses(){
  const pane = document.getElementById('batch-courses-pane');
  if (!pane) return;
  if (!batchSel.size){
    pane.innerHTML = '<div class="batch-empty">Sélectionne des recettes dans l\'onglet 📋 Sélection pour voir la liste de courses.</div>';
    return;
  }
  const selected = [...batchSel].map(id=> ALL.find(r=> String(r.id)===id)).filter(Boolean);
  let totalIngs = 0;
  const byRecipeHtml = selected.map(r=>{
    const ings = r.ing || [];
    totalIngs += ings.length;
    const ingsHtml = ings.map(i=>`<li data-k="${esc(i)}"><span class="box"></span><span>${esc(i)}</span></li>`).join('');
    return `<div class="batch-ing-section">
      <div class="batch-ing-title">${esc(r.t)}${r.min?` <span style="font-weight:400;font-size:.85em;color:var(--muted)">⏱️ ${r.min} min</span>`:''}${r.serv?` <span style="font-weight:400;font-size:.85em;color:var(--muted)">· 🍽️ ${r.serv} pers.</span>`:''}</div>
      <ul class="ing" style="margin:0">${ingsHtml}</ul>
    </div>`;
  }).join('');
  pane.innerHTML = `<div class="batch-body">
    <p style="color:var(--muted);font-size:.85em;margin:0 0 16px">${selected.length} recette${selected.length>1?'s':''} · ${totalIngs} ingrédient${totalIngs>1?'s':''} au total</p>
    ${byRecipeHtml}
  </div>`;
  pane.querySelectorAll('.ing li').forEach(li=> li.addEventListener('click', ()=> li.classList.toggle('done')));
}

function renderBatchCuisson(){
  const pane = document.getElementById('batch-cuisson-pane');
  if (!pane) return;
  if (!batchSel.size){
    pane.innerHTML = '<div class="batch-empty">Sélectionne des recettes dans l\'onglet 📋 Sélection pour organiser la cuisson.</div>';
    return;
  }
  const selected = [...batchSel].map(id=> ALL.find(r=> String(r.id)===id)).filter(Boolean);
  selected.sort((a,b)=> (a.min||0) - (b.min||0));
  const html = selected.map((r, i)=>{
    const steps = splitSteps(r.steps);
    return `<div class="batch-cook-card">
      <div class="batch-cook-card-title">
        <span class="batch-cook-order">${i+1}</span>
        <span>${esc(r.t)}</span>
      </div>
      ${(r.min||r.serv)?`<div class="batch-cook-meta">${r.min?'⏱️ '+r.min+' min':''}${r.serv?' · 🍽️ '+r.serv+' pers.':''}</div>`:''}
      ${steps.length
        ? `<button class="batch-cook-start" data-bid="${esc(String(r.id))}">🍳 Lancer la cuisson guidée</button>`
        : '<p style="color:var(--muted);font-size:.85em;margin:0">Aucune étape de préparation</p>'}
    </div>`;
  }).join('');
  pane.innerHTML = `<div class="batch-body">${html}</div>`;
  pane.querySelectorAll('.batch-cook-start').forEach(btn=>{
    btn.addEventListener('click', ()=>{ closeBatch(); openCook(btn.dataset.bid); });
  });
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
  renderCellarHome();
  renderGrid();
  document.getElementById('sync-btn').addEventListener('click', ()=> syncRemote(true));
  document.getElementById('import-btn').addEventListener('click', openImport);
  document.getElementById('photos-btn').addEventListener('click', fillFromSources);
  // More menu
  const moreBtn = document.getElementById('more-btn');
  const moreMenu = document.getElementById('more-menu');
  if(moreBtn && moreMenu){
    moreBtn.addEventListener('click', (e)=>{ e.stopPropagation(); moreMenu.hidden = !moreMenu.hidden; });
    document.addEventListener('click', ()=>{ if(moreMenu) moreMenu.hidden=true; });
    moreMenu.addEventListener('click', ()=>{ moreMenu.hidden=true; });
  }
  document.getElementById('wizard-btn').addEventListener('click', ()=>{ document.getElementById('more-menu').hidden=true; openWizard(); });
  document.getElementById('wizard-close-btn').addEventListener('click', closeWizard);
  document.getElementById('wz-prev').addEventListener('click', wizardPrev);
  document.getElementById('wz-next').addEventListener('click', wizardNext);
  document.getElementById('frigo-btn').addEventListener('click', openFrigo);
  document.getElementById('frigo-back').addEventListener('click', closeFrigo);
  document.getElementById('panier-btn').addEventListener('click', openPanier);
  document.getElementById('panier-back').addEventListener('click', closePanier);
  document.getElementById('panier-clear').addEventListener('click', ()=>{
    panierVegs = []; savePanierVegs(); updatePanierBtn(); renderPanierChips(); renderPanierGrid();
  });
  document.getElementById('panier-add').addEventListener('click', addPanierVeg);
  document.getElementById('panier-input').addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); addPanierVeg(); } });
  document.querySelectorAll('.panier-season-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> addPanierSeason(btn.dataset.season));
  });
  updatePanierBtn();
  document.getElementById('plan-btn').addEventListener('click', openPlan);
  document.getElementById('plan-back').addEventListener('click', closePlan);
  document.getElementById('plan-prev').addEventListener('click', ()=>{
    planWeekOffset--; if(_planTab==='week') renderPlanWeek(); else renderPlanCourses();
  });
  document.getElementById('plan-next').addEventListener('click', ()=>{
    planWeekOffset++; if(_planTab==='week') renderPlanWeek(); else renderPlanCourses();
  });
  document.querySelectorAll('.plan-tab').forEach(btn=>{
    btn.addEventListener('click', ()=> switchPlanTab(btn.dataset.ptab));
  });
  document.getElementById('plan-picker-close').addEventListener('click', closePlanPicker);
  document.getElementById('plan-picker-search').addEventListener('input', (e)=> renderPlanPicker(e.target.value));
  document.getElementById('batch-btn').addEventListener('click', openBatch);
  document.getElementById('batch-back').addEventListener('click', closeBatch);
  document.getElementById('batch-clear').addEventListener('click', ()=>{
    batchSel.clear(); saveBatchSel(); updateBatchBtn(); renderBatchSel();
  });
  document.querySelectorAll('.batch-tab').forEach(btn=>{
    btn.addEventListener('click', ()=> switchBatchTab(btn.dataset.btab));
  });
  document.getElementById('batch-search').addEventListener('input', ()=> renderBatchSel());
  updateBatchBtn();
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-back').addEventListener('click', closeSettings);
  document.getElementById('check-update-btn').addEventListener('click', checkUpdateNow);
  document.getElementById('all-toggle').addEventListener('click', toggleAllRecipes);
  document.getElementById('frigo-api-save').addEventListener('click', ()=>{
    const key = document.getElementById('frigo-api-key').value.trim();
    if (key) localStorage.setItem('frigoApiKey', key);
    else localStorage.removeItem('frigoApiKey');
    toast('Clé API sauvegardée ✓');
  });
  document.querySelectorAll('.frigo-tab').forEach(btn=>{
    btn.addEventListener('click', ()=> switchFrigoTab(btn.dataset.ftab));
  });
  document.querySelectorAll('.frigo-scan-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> openScanOverlay(btn.dataset.ftab));
  });
  document.getElementById('scan-close').addEventListener('click', closeScanOverlay);
  document.getElementById('scan-overlay').addEventListener('click', e=>{ if(e.target===e.currentTarget) closeScanOverlay(); });
  ['frigo','congelateur','cellier'].forEach(tab=>{
    const fileInput = document.getElementById('frigo-file-' + tab);
    if (fileInput) fileInput.addEventListener('change', handleFrigoCapture);
    const addBtn = document.querySelector(`.frigo-manual-add[data-ftab="${tab}"]`);
    const manualInput = document.querySelector(`.frigo-manual-input[data-ftab="${tab}"]`);
    function addManualIng(){
      if (!manualInput) return;
      const raw = manualInput.value.trim();
      if (!raw) return;
      const items = raw.split(/[,;]+/).map(s=>s.trim()).filter(Boolean);
      for (const item of items){
        const n = norm(item);
        if (!storageIngs[tab].some(x=>norm(x)===n)) storageIngs[tab].push(item);
      }
      saveStorageIngs(tab);
      manualInput.value = '';
      renderFrigoIngs(tab);
      renderFrigoSuggestions();
    }
    if (addBtn) addBtn.addEventListener('click', addManualIng);
    if (manualInput) manualInput.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); addManualIng(); } });
  });
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
    else if(!document.getElementById('plan-picker').hidden) closePlanPicker();
    else if(!document.getElementById('plan').hidden) closePlan();
    else if(!document.getElementById('batch').hidden) closeBatch();
    else if(!document.getElementById('panier').hidden) closePanier();
    else if(!elDetail.hidden) closeDetail();
  });
  setupAndroidBack();
  setupWakeLock();
  if ('serviceWorker' in navigator){ try{ navigator.serviceWorker.register('sw.js'); }catch(e){} }
}
/* ========== WIZARD SUGGESTIONS ========== */
const WZ_BASIC = new Set(['oignon','ail','echalote','radis','laitue','salade','sel','poivre']);
const WZ_TYPE_NORMS = {
  entree:   ['entree','soupe','salade','quiche','terrine','veloute','gaspacho','tarte salee'],
  plat:     ['plat','viande','poisson','volaille','legume','riz','pates','tajine','gratin','ragout','curry','wok','vegetarien','vegan','risotto','couscous','poele','fricassee','saumon','poulet','boeuf'],
  dessert:  ['dessert','patisserie','gateau','glace','mousse','biscuit','cake','crepe','tarte','confiture'],
  aperitif: ['aperitif','tapas','bouchee','brochette','tartinade','wrap','panini','samoussa','canape','rillette'],
};
const WZ_RED_MEAT = ['boeuf','veau','porc','agneau','mouton','steak','merguez'];
const WZ_STEPS_DEF = [
  { title:'Type de plat',           sub:'Plusieurs choix possibles' },
  { title:'Régime alimentaire',     sub:'Un seul choix' },
  { title:'Temps disponible',       sub:'Un seul choix' },
  { title:'Légumes & fruits',       sub:'Ceux que tu as (facultatif)' },
  { title:'Complexité',             sub:'Un seul choix' },
];
let wizSt = { step:0, types:new Set(), regime:'', temps:'', saison:new Set(), complexite:'' };

function openWizard(){
  wizSt = { step:0, types:new Set(), regime:'', temps:'', saison:new Set(), complexite:'' };
  document.getElementById('wizard').hidden = false;
  wzRender();
}
function closeWizard(){
  document.getElementById('wizard').hidden = true;
}
function wizardPrev(){
  if(wizSt.step === 0){ closeWizard(); return; }
  wizSt.step--;
  wzRender();
}
function wizardNext(){
  if(wizSt.step === 0 && wizSt.types.size === 0) return;
  wizSt.step++;
  wzRender();
}

function wzSeasonItems(){
  return (SEASON[monthNow()]||[]).filter(k=> !WZ_BASIC.has(k)).slice(0,18);
}
function wzStepsCount(r){
  return Array.isArray(r.steps) ? r.steps.length : splitSteps(r.steps).length;
}

function wzRender(){
  const s = wizSt.step;
  const total = WZ_STEPS_DEF.length;
  document.getElementById('wizard-title').textContent = s < total ? WZ_STEPS_DEF[s].title : '✨ Suggestions';
  // Progress dots
  const prog = document.getElementById('wizard-prog');
  prog.innerHTML = Array.from({length:total},(_,i)=>`<span class="wz-dot${i===s?' active':i<s?' done':''}"></span>`).join('');
  // Footer
  const prevBtn = document.getElementById('wz-prev');
  const nextBtn = document.getElementById('wz-next');
  const footer  = document.getElementById('wizard-footer');
  if(s >= total){ footer.hidden=true; } else {
    footer.hidden = false;
    prevBtn.textContent  = s===0 ? '✕ Fermer' : '← Précédent';
    nextBtn.textContent  = s===total-1 ? '✨ Voir les recettes' : 'Suivant →';
    nextBtn.disabled     = s===0 && wizSt.types.size===0;
  }
  // Body
  const body = document.getElementById('wizard-body');
  if(s === total){ wzRenderResults(body); return; }
  const def = WZ_STEPS_DEF[s];
  let html = `<div class="wz-question">${esc(def.title)}</div><div class="wz-sub">${esc(def.sub)}</div>`;
  if(s===0){
    html += wzOptsHtml([
      {val:'entree',   label:'🥗 Entrée / Soupe'},
      {val:'plat',     label:'🍽️ Plat principal'},
      {val:'dessert',  label:'🍰 Dessert'},
      {val:'aperitif', label:'🥂 Apéritif / Snack'},
    ], wizSt.types);
  } else if(s===1){
    html += wzOptsHtml([
      {val:'tout',           label:'🍖 Tout (avec viande)'},
      {val:'sansvianderge',  label:'🐟 Sans viande rouge (poisson OK)'},
      {val:'pescatarien',    label:'🦐 Sans viande (crevettes & poisson OK)'},
      {val:'vegan',          label:'🌱 Vegan'},
    ], new Set([wizSt.regime]));
  } else if(s===2){
    html += wzOptsHtml([
      {val:'rapide', label:'⚡ Rapide — ≤ 30 min'},
      {val:'moyen',  label:'🕐 Moyen — ≤ 60 min'},
      {val:'all',    label:'🍳 Peu importe'},
    ], new Set([wizSt.temps]));
  } else if(s===3){
    const items = wzSeasonItems();
    const MNAMES=['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
    html += `<div class="wz-saison-note">🌿 De saison en ${MNAMES[monthNow()-1]} — sélectionne ce que tu as :</div>`;
    html += '<div class="wz-chips">';
    items.forEach(k=>{ const a=wizSt.saison.has(k)?' active':''; html+=`<button class="wz-chip${a}" data-kw="${k}">${esc(cap(k))}</button>`; });
    html += '</div><div class="wz-skip-note">Passe si tu n\'as pas de préférence.</div>';
  } else if(s===4){
    html += wzOptsHtml([
      {val:'simple',  label:'😊 Simple — peu d\'étapes'},
      {val:'normal',  label:'🧑‍🍳 Intermédiaire'},
      {val:'complexe',label:'👨‍🍳 Complexe / Technique'},
      {val:'all',     label:'🎲 Peu importe'},
    ], new Set([wizSt.complexite]));
  }
  body.innerHTML = html;
  // Bind wz-opt
  body.querySelectorAll('.wz-opt').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const val = btn.dataset.val;
      if(s===0){ if(wizSt.types.has(val)) wizSt.types.delete(val); else wizSt.types.add(val); wzRender(); }
      else if(s===1){ wizSt.regime=val; setTimeout(wizardNext,120); }
      else if(s===2){ wizSt.temps=val; setTimeout(wizardNext,120); }
      else if(s===4){ wizSt.complexite=val; setTimeout(wizardNext,120); }
    });
  });
  // Bind wz-chip
  body.querySelectorAll('.wz-chip').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const kw=btn.dataset.kw;
      if(wizSt.saison.has(kw)) wizSt.saison.delete(kw); else wizSt.saison.add(kw);
      wzRender();
    });
  });
}

function wzOptsHtml(opts, selected){
  return '<div class="wz-options">' + opts.map(o=>`<button class="wz-opt${selected.has(o.val)?' active':''}" data-val="${o.val}">${esc(o.label)}</button>`).join('') + '</div>';
}

function wzScore(r, habitScores){
  let score = 0;
  // Type (hard)
  if(wizSt.types.size>0){
    const catN = norm(r.cat||'');
    let ok=false;
    for(const t of wizSt.types){ if(WZ_TYPE_NORMS[t]&&WZ_TYPE_NORMS[t].some(kw=>catN.includes(kw))){ ok=true; break; } }
    if(!ok) return -1;
    score += 100;
  }
  // Régime (hard)
  if(wizSt.regime && wizSt.regime!=='tout'){
    const hasKw = kw=>matchKw(r,kw);
    if(wizSt.regime==='sansvianderge'){ if(WZ_RED_MEAT.some(hasKw)) return -1; }
    else if(wizSt.regime==='pescatarien'){ if(_MEAT_KWS.some(hasKw)) return -1; }
    else if(wizSt.regime==='vegan'){ if(!checkDiet(r,'vegan')) return -1; }
    score += 80;
  }
  // Temps (hard)
  if(wizSt.temps==='rapide'){ if(!r.min||r.min>30) return -1; score+=60; }
  else if(wizSt.temps==='moyen'){ if(r.min&&r.min>60) return -1; score+=50; }
  // Saison (soft)
  if(wizSt.saison.size>0){ for(const kw of wizSt.saison) if(matchKw(r,kw)) score+=25; }
  // Complexité (soft)
  const sc=wzStepsCount(r); const ic=(r.ing||[]).length;
  if(wizSt.complexite==='simple'){ score += (sc<=4&&ic<=9)?60:(sc<=5||ic<=10)?30:-10; }
  else if(wizSt.complexite==='normal'){ score += (sc>=4&&sc<=7)?60:20; }
  else if(wizSt.complexite==='complexe'){ score += (sc>=7||ic>=12)?60:sc>=5?30:0; }
  // Habitudes (soft)
  score += Math.min((habitScores[String(r.id)]||0)*5, 40);
  return score;
}

function wzRenderResults(body){
  const habitScores = getHabitScores();
  const scored = ALL
    .map(r=>({r, score: wzScore(r, habitScores) + Math.random()*4}))
    .filter(x=>x.score>=0)
    .sort((a,b)=>b.score-a.score);
  const results = scored.slice(0,10);

  // Habitudes : top 5 most viewed
  const topHabits = Object.entries(habitScores)
    .sort((a,b)=>b[1]-a[1]).slice(0,5)
    .map(([id])=>ALL.find(x=>String(x.id)===String(id))).filter(Boolean);

  let html = '';
  if(topHabits.length){
    html += '<div class="wz-habit-section">';
    html += '<div class="wz-habit-title">🔁 Tes habitudes</div>';
    html += '<div class="wz-habit-strip">';
    topHabits.forEach(r=>{
      const img = r.img
        ? `<img src="${esc(r.img)}" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=wz-hph>🍽️</div>'">`
        : '<div class="wz-hph">🍽️</div>';
      html += `<div class="wz-habit-card" data-id="${esc(r.id)}">${img}<div class="wz-habit-name">${esc(r.t)}</div></div>`;
    });
    html += '</div></div>';
  }

  if(!results.length){
    html += '<div class="wz-empty">😕 Aucune recette ne correspond à tous tes critères.<br>Essaie d\'élargir tes choix !</div>';
  } else {
    html += `<div class="wz-result-label">${results.length} recette${results.length>1?'s':''} sélectionnée${results.length>1?'s':''}</div>`;
    html += '<div class="wz-result-grid">';
    results.forEach(({r})=>{
      const img = r.img
        ? `<img class="wz-thumb" src="${esc(r.img)}" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=wz-ph>🍽️</div>'">`
        : '<div class="wz-ph">🍽️</div>';
      const meta = [r.min?'⏱️ '+r.min+' min':'', r.serv?'🍽️ '+r.serv+' pers.':''].filter(Boolean).join(' · ');
      const hab = (habitScores[String(r.id)]||0)>3 ? '<span class="wz-badge">🔁 Habituel</span>' : '';
      html += `<div class="wz-rcard" data-id="${esc(r.id)}">${img}<div class="wz-rinfo"><div class="wz-rt">${esc(r.t)}${hab}</div><div class="wz-rmeta">${esc(meta||catList(r).slice(0,2).join(' · '))}</div></div></div>`;
    });
    html += '</div>';
  }
  html += '<button class="wz-restart" id="wz-restart-btn">🔄 Recommencer</button>';
  body.innerHTML = html;

  body.querySelectorAll('.wz-rcard,.wz-habit-card').forEach(c=>{
    c.addEventListener('click',()=>{ closeWizard(); openDetail(c.dataset.id); });
  });
  document.getElementById('wz-restart-btn').addEventListener('click', openWizard);
}

init();

/* ---------- Wake Lock : écran allumé pendant la lecture / cuisson ---------- */
function setupWakeLock(){
  if (!('wakeLock' in navigator)) return;
  let lock = null;
  async function acquire(){
    if (lock) return;
    try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', ()=>{ lock=null; }); } catch(e){}
  }
  function drop(){
    const det = document.getElementById('detail');
    const cok = document.getElementById('cook');
    if ((det && !det.hidden) || (cok && !cok.hidden)) return;
    if (lock){ lock.release(); lock=null; }
  }
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible'){ const det=document.getElementById('detail'); const cok=document.getElementById('cook'); if((det&&!det.hidden)||(cok&&!cok.hidden)) acquire(); } });
  window._wlAcquire = acquire;
  window._wlDrop   = drop;
}

/* ---------- bouton RETOUR Android : ferme l'écran du dessus au lieu de quitter l'appli ---------- */
function setupAndroidBack(){
  // Du plus prioritaire (modale au-dessus) au moins prioritaire (fiche).
  const CLOSERS = [
    ['catpick',      closeCatPick],
    ['ingpick',      closeIngPick],
    ['edit',         closeEdit],
    ['import',       closeImport],
    ['cook',         closeCook],
    ['frigo',        closeFrigo],
    ['settings',     closeSettings],
    ['plan-picker',  closePlanPicker],
    ['plan',         closePlan],
    ['wizard',       closeWizard],
    ['batch',        closeBatch],
    ['panier',       closePanier],
    ['detail',       closeDetail],
  ];
  const isOpen   = id => { const el = document.getElementById(id); return !!el && !el.hidden; };
  const anyOpen  = () => CLOSERS.some(([id]) => isOpen(id));
  const topClose = () => { for (const [id, fn] of CLOSERS) if (isOpen(id)) return fn; return null; };
  const hasTrap  = () => !!(history.state && history.state.alxBack);

  // Bouton RETOUR Android via Capacitor (triggerJSEvent → CustomEvent 'backButton' sur document).
  const handleBack = () => {
    const fn = topClose();
    if (fn) { fn(); if (anyOpen()) history.pushState({ alxBack: 1 }, ''); }
    else if (window.Capacitor) window.Capacitor.toNative('App', 'exitApp', {});
  };
  document.addEventListener('backButton', handleBack);

  // Fallback popstate pour PWA / navigateur web.
  window.addEventListener('popstate', () => {
    const fn = topClose();
    if (fn) fn();
    if (anyOpen()) history.pushState({ alxBack: 1 }, '');
  });

  // Pose un "piège" d'historique dès qu'un overlay s'ouvre ; le consomme quand tout est refermé
  // (ex. via les boutons ← à l'écran), pour rester synchronisé sans toucher aux open/close.
  const mo = new MutationObserver(() => {
    if (anyOpen() && !hasTrap())      history.pushState({ alxBack: 1 }, '');
    else if (!anyOpen() && hasTrap()) history.back();
  });
  CLOSERS.forEach(([id]) => { const el = document.getElementById(id); if (el) mo.observe(el, { attributes: true, attributeFilter: ['hidden'] }); });
}
