'use strict';

const APP_VERSION = '4.08';

let ALL = [];
let BASE = [];
let EXTRA = { delete: [], overrides: [], recipes: [] };
let cats = [];
let catCount = {};
// state.cats = liste des catégories cochées dans le filtre (vide = toutes) ; state.fav = filtre favoris.
let state = { q:'', cats:[], fav:false, ing:null, diet:null };
// Tri de la liste par ingrédients déjà en stock (mémorisé).
let stockSort = false;
try { stockSort = localStorage.getItem('stockSort') === '1'; } catch(e){}
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
  const base = BASE.filter(r=> !deleted.has(String(r.id))).map(r => tidyRecipe(applyPatch(r, edits[r.id])));
  const imp  = imports.filter(r=> !deleted.has(String(r.id))).map(r => tidyRecipe(applyPatch(r, edits[r.id])));
  return [...base, ...imp];
}
/* Titres récupérés sur Facebook / blogs : « GROUPE | Fondant chocolat | Facebook »,
   « Poulet au citron | Le Blog de… », emojis et hashtags → « Fondant chocolat ». */
function tidyTitle(t){
  let s = String(t || '').trim();
  if (!s) return s;
  const fb = /\|\s*facebook\s*$/i.test(s);
  s = s.replace(/\s*\|\s*facebook\s*$/i, '');
  if (s.includes(' | ')){
    const parts = s.split(' | ').map(x => x.trim()).filter(Boolean);
    s = fb ? parts[parts.length - 1] : parts[0];
  }
  s = s.replace(/\s+-\s+[^-]*$/, m => /blog|\.com|\.fr|cuisine de|plat et recette/i.test(m) ? '' : m)  // « - Blog de Châtaigne »
       .replace(/[«»]/g, '')
       .replace(/#[\p{L}\d_]+/gu, '')
       .replace(/^[\s«"✓\p{Extended_Pictographic}\uFE0F\u200D]+|[\s»"\p{Extended_Pictographic}\uFE0F\u200D]+$/gu, '')
       .replace(/\s{2,}/g, ' ').trim();
  if (s && s === s.toUpperCase() && /[A-Z]{4}/.test(s)) s = s.toLowerCase();   // TITRE TOUT EN MAJUSCULES
  return s ? s[0].toUpperCase() + s.slice(1) : String(t);
}
function tidyRecipe(r){
  const t = tidyTitle(r.t);
  let out = t === r.t ? r : Object.assign({}, r, { t });
  if (!out.min && (out.steps || out.ing?.length)){
    const est = estimateMin(out);
    if (est) out = Object.assign({}, out, { min: est, minEst: true });
  }
  return out;
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
  'Sous vide':['sous vide','roner'],
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

// Nettoyage des catégories « Poisson » ajoutées à tort par l'ancien classement automatique
// (le mot était cherché aussi dans les étapes : « mode poisson » de l'airfryer…).
// Ancien classement automatique : « Plat » ajouté par défaut et figé sur le téléphone, alors que la
// recette est un dessert, un apéritif, une boisson… On rétablit le type des données.
function fixLocalCourseCats(){
  // Types de plat : si la catégorie enregistrée sur le téléphone en contient un que les données n'ont pas
  // (« Dessert » sur un sirop, « Plat » sur une charlotte), on rétablit le type des données.
  const COURSES = ['Plat','Dessert','Apéritif','Entrée','Boissons','Accompagnement','Sauce','Marinade','Technique','Smoothie','Milkshake','Cocktail sans alcool','Petit-déjeuner'];
  const LEGACY = new Set(['Pain & Brioche']);
  const byId = new Map(BASE.concat(imports).map(r => [String(r.id), r]));
  let n = 0;
  for (const [id, ed] of Object.entries(edits)){
    if (!ed || typeof ed.cat !== 'string') continue;
    const r = byId.get(String(id)); if (!r) continue;
    const base = String(r.cat || '').split(',').map(c => c.trim()).filter(Boolean);
    const cats = ed.cat.split(',').map(c => c.trim()).filter(Boolean);
    if (!base.length) continue;
    const wrong = cats.filter(c => (COURSES.includes(c) && !base.includes(c)) || LEGACY.has(c));
    if (!wrong.length) continue;
    ed.cat = [...new Set(base.concat(cats.filter(c => !wrong.includes(c))))].join(', ');
    n++;
  }
  if (n) saveEdits();
  return n;
}
function fixLocalSeafoodCats(){
  const seaCats = new Set(['poisson', ...Object.keys(SEAFOOD).map(c => c.toLowerCase())]);
  const seaKw = ['poisson','fruits de mer', ...Object.values(SEAFOOD).flat()];
  const byId = new Map(BASE.concat(imports).map(r => [String(r.id), r]));
  let n = 0;
  for (const [id, ed] of Object.entries(edits)){
    if (!ed || typeof ed.cat !== 'string') continue;
    const r = byId.get(String(id)); if (!r) continue;
    const cats = ed.cat.split(',').map(c => c.trim()).filter(Boolean);
    if (!cats.some(c => seaCats.has(c.toLowerCase()))) continue;
    const baseCats = new Set(String(r.cat||'').split(',').map(c => c.trim().toLowerCase()));
    const hay = norm([r.t||'', (r.ing||[]).join('  ')].join('  '));
    if (seaKw.some(k => hasWord(hay, k))) continue;
    const kept = cats.filter(c => !seaCats.has(c.toLowerCase()) || baseCats.has(c.toLowerCase()));
    if (kept.length !== cats.length){ ed.cat = kept.join(', '); n++; }
  }
  if (n) saveEdits();
  return n;
}
function autoCategorize(){
  let added=0, touched=0;
  ALL.forEach(r=>{
    const ingHay  = norm((r.ing||[]).join('  '));
    const fruitHay = stripPdt(norm([r.t||'', (r.ing||[]).join('  ')].join('  ')));                            // légumes : ingrédients seulement (précis)
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
    // (titre + ingrédients seulement : « mode poisson » d'un airfryer dans les étapes ne compte pas)
    const seaHay = norm([r.t||'', (r.ing||[]).join('  ')].join('  '));
    let anySea=false;
    for (const [f, kws] of Object.entries(SEAFOOD)) if (kws.some(k=> hasWord(seaHay,k))){ push(f); anySea=true; }
    if (anySea || hasWord(seaHay,'poisson') || hasWord(seaHay,'fruits de mer')) push('Poisson');
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
      for (const [fr, kws] of Object.entries(FRUITS)) if (kws.some(k=> hasWord(fruitHay,k))){ push(fr); anyFruit=true; }
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
  // « œ »/« æ » ne se décomposent pas en NFD : sans ça, « œuf » ≠ « oeuf » et « bœuf » ≠ « boeuf ».
  const v = k.toLowerCase().replace(/œ/g,'oe').replace(/æ/g,'ae').normalize('NFD').replace(/[̀-ͯ]/g,'');
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
// « pommes de terre » ne doit jamais compter comme « pomme » (le fruit).
const stripPdt = (t)=> t.replace(/pommes?\s+de\s+terres?/g, ' ');
function seasonalHits(r, m){
  return seasonHitsInText((r.ing||[]).join(' ') + ' ' + (r.t||''), SEASON[m] || []);
}
// Mots entiers seulement : « ail » ≠ « volaille », « poire » ≠ « poireau ».
function seasonHitsInText(txt, kws){
  const text = stripPdt(norm(txt));
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
function ensureIW(r){ if(!r._il){ r._il = flat((r.ing||[]).join(' ')); r._iw = r._il.split(' ').filter(Boolean); r._iwf = stripPdt(r._il).split(' ').filter(Boolean); } }
function matchKw(r, kw){
  ensureIW(r);
  if (kw.indexOf(' ')>=0 || kw.indexOf('-')>=0){ return (' '+r._il+' ').indexOf(' '+flat(kw)+' ')>=0; }
  // « pomme » (fruit) : on ignore les « pommes de terre ».
  return (kw === 'pomme' ? r._iwf : r._iw).some(w => w===kw || w===kw+'s' || w===kw+'x' || (kw.length>=4 && w.startsWith(kw)));
}
/* ---------- filtres diététiques (Santé) ---------- */
// Temps de repos lu dans les étapes (frigo, marinade, levée, trempage…) : la durée saisie
// ne compte souvent que la préparation. Temps total = préparation + repos.
const _restCache = new WeakMap();
function restMinutes(r){
  if (_restCache.has(r)) return _restCache.get(r);
  const st = norm(Array.isArray(r.steps) ? r.steps.join(' ') : (r.steps || ''));
  const re = /(refrigerer|refrigerateur|au frais|au froid|frigo|reposer|repos|mariner|marinade|lever|pousser|doubler de volume|congelateur|egoutter|infuser|tremper|dessaler|prendre|figer|refroidi|tiedir|tiedi)[^.]{0,40}?(\d+(?:[.,]\d+)?)\s*(h\b|heures?|min)/g;
  let m, w = 0, coolDone = false; const seen = new Set();
  while ((m = re.exec(st))){
    if (/^(refroidi|tiedi)/.test(m[1])) coolDone = true;
    if (/^(frigo|refrigerateur)/.test(m[1]) && /sort\w*\s+(\w+\s+){0,4}(du|de son|de la)\s*$/.test(st.slice(Math.max(0, m.index - 40), m.index))) continue;  // « sortir du frigo 15 min avant »
    const v = parseFloat(m[2].replace(',', '.')); w += /h/.test(m[3]) ? v * 60 : v; seen.add(m.index + m[0].length);
  }
  // Durée suivie du lieu : « placer 48 h au réfrigérateur », « 2 h au frais ».
  const re2 = /(\d+(?:[.,]\d+)?)\s*(h\b|heures?|min)\s*(?:au |a |de |en )(refrigerateur|frais|frigo|froid|repos|congelateur|refroidissement)/g;
  while ((m = re2.exec(st))){
    const end = m.index + m[1].length + m[0].slice(m[1].length).search(/\S/) + m[2].length;
    if ([...seen].some(e => Math.abs(e - end) <= 1)) continue;
    if (/\d\s*(h|min)\s*(a|-|ou)\s*$/.test(st.slice(Math.max(0, m.index - 12), m.index))) continue;  // « 30 min à 2 h au frais » : déjà compté
    if (m[3] === 'refroidissement') coolDone = true;
    const v = parseFloat(m[1].replace(',', '.')); w += /h/.test(m[2]) ? v * 60 : v;
  }
  // « Laisser refroidir » sans durée : estimation (tiédir ≈ 10 min, refroidir ≈ 15 min,
  // complètement / avant de démouler ou de couper ≈ 30 min, « un peu » ≈ 5 min), une seule fois.
  if (!coolDone){
    const c = st.match(/(laisse[rz]?|faire|attendre que)[^.]{0,30}?(refroidi\w*|tiedi\w*)([^.]{0,40})/);
    if (c) w += /^tiedi/.test(c[2]) ? 10 : /(un peu|quelques minutes|legerement)/.test(c[3]) ? 5
      : /(completement|totalement|entierement|avant de (demouler|couper|trancher|decouper|garnir|glacer|fourrer|servir|deguster))/.test(c[3]) ? 30 : 15;
  }
  if (/(toute la nuit|une nuit|la veille)/.test(st)) w = Math.max(w, 480);
  const v = Math.round(w); _restCache.set(r, v); return v;
}
/* Temps lus dans les étapes : chaque durée (« 20 à 25 min », « 1 h 30 », « une dizaine de minutes »)
   est classée cuisson (cuire, four, mijoter, poêle, air fryer…), repos (cf. restMinutes) ou
   préparation active (pétrir, fouetter…). Sert à afficher Prépa / Cuisson et à estimer le temps
   des recettes importées qui n'en ont pas. */
const _COOK_RE = /(cuire|cuisson|cuit|enfourn|four\b|mijot|frire|friture|frit|rotir|griller|grill|gratin|bouill|ebullition|fremi|poel|dorer|dore|revenir|rissol|saisir|saisi|reduire|reduction|braiser|vapeur|blanchir|air ?fryer|airfryer|friteuse|\baf\b|caramelis|fondre|chauffer|chaud|torrefi|confire|pocher|sauter|varoma|degre|°c)/;
const _REST_RE = /(au froid|yaourtiere|fermentation|etuve|refrigerer|refrigerateur|au frais|frigo|reposer|repos|mariner|marinade|lever|pousser|doubler de volume|congelateur|egoutter|infuser|tremper|dessaler|prendre|figer|refroidir|tiedir|attendre|degorger)/;
const _WORD_DUR = [[/un quart d.heure/g,'15 min'],[/une demi.heure/g,'30 min'],[/trois quarts d.heure/g,'45 min'],[/une heure/g,'1 h'],[/deux heures/g,'2 h'],
  [/une dizaine de minutes/g,'10 min'],[/une quinzaine de minutes/g,'15 min'],[/une vingtaine de minutes/g,'20 min'],[/une trentaine de minutes/g,'30 min'],
  [/quelques minutes/g,'3 min'],[/une minute/g,'1 min'],[/deux minutes/g,'2 min'],[/cinq minutes/g,'5 min'],[/dix minutes/g,'10 min']];
const _timesCache = new WeakMap();
function stepTimes(r){
  if (_timesCache.has(r)) return _timesCache.get(r);
  let txt = norm(stepTexts(r.steps).join('\n'));
  for (const [re, v] of _WORD_DUR) txt = txt.replace(re, v);
  const t = { prep: 0, cook: 0 };
  const DUR = /(\d+(?:[.,]\d+)?)(?:\s*(?:a|-|–|ou)\s*(\d+(?:[.,]\d+)?))?\s*(h\b|heures?\b|min(?:utes?)?\b|mn\b|sec(?:ondes?)?\b|s\b)(?:\s*(\d{1,2})\b(?!\s*(?:min|°|g\b|cl|ml)))?/g;
  for (const sent of txt.split(/[.!?;\n]+/)){
    let m; DUR.lastIndex = 0;
    while ((m = DUR.exec(sent))){
      let v = parseFloat((m[2] || m[1]).replace(',', '.'));
      const u = m[3];
      v = /^h/.test(u) ? v * 60 + (+m[4] || 0) : /^s/.test(u) ? v / 60 : v;
      if (!v || v > 24 * 60) continue;
      const before = sent.slice(Math.max(0, m.index - 45), m.index);
      if (/(\b(19|20)\d{2}|\bat|\ba)\s*$/.test(before) && /^h/.test(u)) continue;  // horodatage (« 2014 at 20 h 06 »), pas une durée
      const after = sent.slice(m.index + m[0].length, m.index + m[0].length + 25);
      if (/^\s*(avant|de) la fin/.test(after)) continue;            // « 5 min avant la fin » : déjà dans la cuisson
      if (_REST_RE.test(before) || _REST_RE.test(after)) continue;   // repos : compté par restMinutes
      if (_COOK_RE.test(before) || _COOK_RE.test(sent)) t.cook += v;
      else if (v <= 30) t.prep += v;                          // au-delà, c'est une attente, pas un geste
    }
  }
  t.cook = Math.round(t.cook); t.prep = Math.round(t.prep);
  _timesCache.set(r, t); return t;
}
// Temps de préparation estimé quand la recette n'en donne pas : durées actives lues + ~1 min 30 par ingrédient.
function estimatePrep(r){
  const n = (r.ing || []).filter(i => !/^[^:]{1,40}:\s*$/.test(String(i).trim())).length;
  return Math.max(5, Math.min(40, Math.round(stepTimes(r).prep + 5 + n * 1.5)));
}
// Temps total estimé (préparation + cuisson), arrondi à 5 min, pour les recettes sans temps.
function estimateMin(r){
  const tot = estimatePrep(r) + stepTimes(r).cook;
  return Math.max(5, Math.round(tot / 5) * 5);
}
// Découpage affiché : cuisson lue dans les étapes, préparation = le reste du temps saisi.
function timeSplit(r){
  if (!r.min) return null;
  const cook = stepTimes(r).cook;
  if (minIsPrep(r)) return { prep: +r.min, cook };
  if (!cook || cook >= +r.min) return null;
  return { prep: +r.min - cook - (restIncluded(r) ? restMinutes(r) : 0), cook };
}
// Temps saisi nettement plus court que la cuisson lue (« 15 min » pour un foie gras qui cuit
// 14 + 10 min au Varoma) : c'est le temps de préparation seul, la cuisson s'y ajoute.
function minIsPrep(r){
  const cook = stepTimes(r).cook;
  return !!r.min && !r.minEst && cook >= 10 && cook > +r.min * 1.15;
}
// Un long repos (levée, nuit au frais…) déjà compris dans le temps saisi : « 3 h 10 » pour un pain
// qui cuit 35 min et lève 1 h 45. On ne l'ajoute pas une seconde fois au total.
function restIncluded(r){
  const rest = restMinutes(r), cook = stepTimes(r).cook;
  return !r.minEst && rest >= 60 && cook > 0 && +r.min - cook - rest >= 5;
}
// Bloc des temps de la fiche : total, puis préparation / cuisson / repos quand on sait les distinguer.
function timesHtml(r){
  if (!r.min) return '';
  const ap = r.minEst ? '≈ ' : '', sp = timeSplit(r), rest = restMinutes(r);
  const cell = (ico, val, lbl, cls='') => `<div class="dt-cell${cls}"><span class="dt-ico">${ico}</span><b>${val}</b><small>${lbl}</small></div>`;
  const cells = [];
  if (sp || rest) cells.push(cell('⏱️', ap + fmtMin(totalMinutes(r)), 'Total', ' dt-total'));
  if (sp){
    cells.push(cell('🔪', ap + fmtMin(sp.prep), 'Préparation'));
    cells.push(cell('🔥', fmtMin(sp.cook), 'Cuisson'));
  } else if (rest) cells.push(cell('🔪', ap + fmtMin(+r.min), 'Prépa + cuisson'));
  else cells.push(cell('⏱️', ap + fmtMin(+r.min), 'Durée', ' dt-total'));
  if (rest) cells.push(cell('💤', fmtMin(rest), 'Repos'));
  const note = r.minEst ? `<div class="dt-note">≈ temps estimé à partir des étapes</div>` : '';
  return `<div class="d-times" style="--n:${cells.length}">${cells.join('')}</div>${note}`;
}
// Temps total = préparation saisie + tout le repos lu dans les étapes.
function extraRest(r){ return r.min && !restIncluded(r) ? restMinutes(r) : 0; }
function totalMinutes(r){ return r.min ? +r.min + extraRest(r) + (minIsPrep(r) ? stepTimes(r).cook : 0) : 0; }
function fmtMin(m){ if (m >= 2880){ let d = Math.floor(m / 1440), h = Math.round((m % 1440) / 60); if (h === 24){ d++; h = 0; } return d + ' j' + (h ? ' ' + h + ' h' : ''); }
  return m >= 60 ? Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + String(m % 60).padStart(2, '0') : '') : m + ' min'; }
const SANTE_SUBS = new Set(['sansgluten','proteines','antiinflamm','vegetarien','vegan','keto','rapide']);

const _GLUTEN_KWS = ['pates','spaghetti','tagliatelle','linguine','penne','fusilli','macaroni','lasagne','semoule','boulgour','couscous','chapelure','biscottes','biscuit','epeautre','seigle','pain','ble','orge','avoine','brick','feuilletee','brisee','sablee','blinis','tortilla','brioche','croissant'];
const _GLUTEN_SAFE_FARINE = ['riz','mais','sarrasin','coco','pois','chataigne','manioc','quinoa','teff','sorgho','lupin','lentille','feve','potiron'];

const _PROTEIN_KWS = ['poulet','dinde','boeuf','veau','porc','agneau','canard','lapin','jambon','oeuf','saumon','thon','cabillaud','dorade','sardine','crevette','moule','langoustine','tofu','lentille','pois chiche','fromage','fromage blanc','quinoa','edamame','tempeh','seitan'];

const _ANTIINFL_STRONG = ['curcuma','gingembre','saumon','sardine','maquereau','noix','amande','avocat','epinard','brocoli','myrtille','cerise','framboise','baie'];
const _ANTIINFL_SUPPORT = ['ail','oignon','tomate','citron','olive','thym','romarin','cumin','cannelle'];

const _MEAT_KWS = ['poulet','dinde','boeuf','veau','porc','agneau','canard','lapin','jambon','lardons','saucisse','chorizo','merguez','steak','viande','foie','rognon','magret','pigeon','pintade','caille','perdreau','pepperoni','salami','bacon','pancetta','coppa','bresaola','prosciutto','saucisson','figatelli','lonzu','andouille','andouillette','boudin','chipolata','mortadelle','rillettes','confit','gesier','cerf','sanglier','chevreuil','oie'];
const _FISH_KWS = ['thon','saumon','cabillaud','sardine','maquereau','anchois','crevette','moule','palourde','homard','crabe','poisson','lotte','langoustine','seiche','poulpe','calamar','merlu','daurade','dorade','colin','truite','bar','sole','surimi','morue','bacalao','hareng','saint-jacques','huitre','encornet','gambas','langouste','oursin','bulot','anguille'];

const _KETO_INCLUDE = ['avocat','oeuf','fromage','amande','noix','saumon','boeuf','poulet','agneau','porc','canard','lardons','beurre','creme','parmesan','gruyere'];
const _KETO_EXCLUDE = ['pates','pain','riz','pomme de terre','pommes de terre','patate','farine','sucre','cereale','mais','haricot','lentille','pois chiche','biscuit','couscous','semoule','boulgour','miel','sirop','banane','dattes','brick','feuilletee','brisee','blinis','tortilla'];

// Portions : un nombre → « N pers. », un texte (« 16 pièces », « 1 bûche ») tel quel.
function servTxt(s){ return /^\d+(\s*[-–à]\s*\d+)?$/.test(String(s).trim()) ? s+' pers.' : s; }

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
  if (state.diet === 'rapide') return !!(r.min && totalMinutes(r) <= 30);
  return true;
}

function checkDiet(r, diet){
  // Sans liste d'ingrédients (guides, fiches techniques…), on ne peut rien affirmer.
  if (diet !== 'rapide' && !(r.ing || []).length) return false;
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
  if (diet === 'rapide') return !!(r.min && totalMinutes(r) <= 30);
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
    <button class="chip quick-chip" id="quick-btn">🔎 Express</button>
    ${state.ing ? `<button class="chip ing-chip active" id="ing-filter-btn">${esc(ingLabel)}</button>` : ''}
    ${stockSort ? `<button class="chip active" id="stock-sort-btn" title="Arrêter le tri par stocks">🧺 Mes stocks ✕</button>` : ''}
    <div class="cat-multi">
      <button class="chip ${nSel?'active':''}" id="cat-btn"${nSel ? '' : ' hidden'}>${esc(catLabel)} ▾</button>
      <div class="cat-panel" id="cat-panel" hidden></div>
    </div>
    ${gridFoldable() ? `<div class="shortcuts">${QK_SHORTCUTS.map((x, i) => `<button class="chip shortcut" data-i="${i}">${x.label}</button>`).join('')}</div>` : ''}`;
  const panel = document.getElementById('cat-panel');
  document.getElementById('cat-btn').addEventListener('click', (e)=>{ e.stopPropagation(); panel.hidden = !panel.hidden; if(!panel.hidden) fillCatPanel(panel); });
  panel.addEventListener('click', e=> e.stopPropagation());
  // Ingrédient et tri par stocks sont dans le menu ⋯ ; ici seulement quand ils sont actifs (✕ pour retirer).
  const ib = document.getElementById('ing-filter-btn');
  if (ib) ib.addEventListener('click', ()=>{ state.ing=null; renderChips(); renderGrid(); });
  const sm = document.getElementById('stock-menu-btn');
  if (sm) sm.textContent = stockSort ? '🧺 Arrêter le tri par stocks' : '🧺 Trier par mes stocks';
  const sb = document.getElementById('stock-sort-btn');
  if (sb) sb.addEventListener('click', toggleStockSort);
  document.getElementById('quick-btn').addEventListener('click', () => openQuick());
  elCats.querySelectorAll('.shortcut').forEach(b => b.addEventListener('click', () => openQuick(QK_SHORTCUTS[+b.dataset.i])));
}
function toggleStockSort(){
  if (!stockSort && !getAllStorageIngs().length){
    toast('🧺 Ajoute d\'abord ce que tu as au frigo, au congélo ou au cellier');
    openFrigo();
    return;
  }
  stockSort = !stockSort;
  try { localStorage.setItem('stockSort', stockSort ? '1' : '0'); } catch(e){}
  renderChips(); renderGrid();
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
/* Une version Thermomix / Airfryer liée à une recette classique de la même liste
   n'apparaît pas en double : on la retrouve dans les onglets de la fiche classique
   (sauf dans les onglets Ustensiles, qui listent toutes les versions). */
const VARIANT_CATS = ['Thermomix','Airfryer'];
function isVariant(r){ const c = catList(r); return VARIANT_CATS.some(v => c.includes(v)); }
function variantBadges(r){
  if (isVariant(r)) return '';
  const g = pairGroup(r).filter(x => x !== r && isVariant(x));
  const k = new Set(g.map(x => catList(x).includes('Thermomix') ? '⚙️ Thermomix' : '🌪️ Airfryer'));
  if (r.af) k.add('🌪️ Airfryer');
  return k.size ? `<div class="vbadges">${[...k].map(b=>`<span>${b}</span>`).join('')}</div>` : '';
}
function collapseVariants(list){
  if (state.cats.some(c => VARIANT_CATS.includes(c) || c === 'Sous vide')) return list;
  const inList = new Set(list.map(r => String(r.id)));
  const hide = new Set();
  ALL.forEach(x => { if (!x.pair) return;
    [].concat(x.pair).forEach(p => {
      const a = ALL.find(y => String(y.id) === String(p)); if (!a) return;
      [[x,a],[a,x]].forEach(([v,c]) => { if (isVariant(v) && !isVariant(c) && inList.has(String(c.id))) hide.add(String(v.id)); });
    });
  });
  return hide.size ? list.filter(r => !hide.has(String(r.id))) : list;
}
function card(r, cov){
  const fav = favs.has(r.id) ? 'fav-badge' : '';
  const img = r.img
    ? `<img class="thumb" src="${esc(r.img)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=ph>🍽️</div>'">`
    : `<div class="ph">🍽️</div>`;
  const meta = [r.min? '⏱️ '+fmtMin(totalMinutes(r)):'', r.serv? '🍽️ '+r.serv : '', catList(r).join(', ')].filter(Boolean).slice(0,2).join(' · ');
  const miss = cov ? cov.total - cov.covered : 0;
  const stock = cov ? `<div class="stock-cov ${miss?'':'ok'}">🧺 ${cov.covered}/${cov.total} en stock · ${miss ? `manque ${miss}` : 'tout y est'}</div>` : '';
  const vars = variantBadges(r);
  return `<div class="rcard ${fav}" data-id="${esc(r.id)}">${img}
    <div class="info"><div class="rt">${esc(r.t)}</div>${vars}<div class="meta">${esc(meta)}</div>${stock}</div></div>`;
}
const GRID_PG = 48;
let _gList = [], _gPage = 0, _gObs = null, _gCov = null;

/* Tri « Mes stocks » : d'abord les recettes où il manque le moins d'ingrédients,
   puis celles qui utilisent le plus de produits en stock ; celles sans aucun
   produit en stock restent ensuite, dans l'ordre habituel. */
function stockRank(a, b){
  return (a.total - a.covered) - (b.total - b.covered) || b.covered - a.covered;
}
function sortByStock(list){
  const have = stockHaveList();
  _gCov = new Map();
  if (!have.length) return list;
  const scored = list.map((r, i) => {
    const c = recipeStockCoverage(r, have);
    if (c && c.covered) _gCov.set(r, c);
    return { r, i, c };
  });
  scored.sort((a, b) => {
    const ca = a.c && a.c.covered ? a.c : null, cb = b.c && b.c.covered ? b.c : null;
    if (!ca || !cb) return (cb ? 1 : 0) - (ca ? 1 : 0) || a.i - b.i;
    return stockRank(ca, cb) || a.i - b.i;
  });
  return scored.map(x => x.r);
}

function renderGrid(){
  if(appMode === 'cocktails') return;
  _gList = collapseVariants(filtered()); _gPage = 0; _gCov = null;
  if (stockSort) _gList = sortByStock(_gList);
  const _dietLabel = {sansgluten:'sans gluten',proteines:'riches en protéines',antiinflamm:'anti-inflammatoires',vegetarien:'végétariennes',vegan:'vegan',keto:'keto',rapide:'rapides (≤30 min)'}[state.diet] || '';
  elStatus.textContent = `${_gList.length} recette${_gList.length>1?'s':''}`
    + (_dietLabel ? ` ${_dietLabel}` : '')
    + (state.fav?' en favoris':'')
    + (_gCov ? ` · ${_gCov.size} avec des produits en stock, en tête` : '');
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
  return appMode === 'recipes' && !state.q && !state.cats.length && !state.fav && !state.ing && !state.diet && !stockSort;
}
function updateGridFold(){
  const btn = document.getElementById('all-toggle');
  const fold = gridFoldable();
  const sc = document.querySelector('#cats .shortcuts'); if (sc) sc.hidden = !fold;
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
  slice.forEach(r=>{ const d=document.createElement('div'); d.innerHTML=card(r, _gCov && _gCov.get(r)); const c=d.firstElementChild; c.addEventListener('click',()=>openDetail(c.dataset.id)); frag.appendChild(c); });
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
/* Étapes découpées en sections : une ligne « FARCE », « 🔥 CUISSON » ou « Pour la sauce : »
   devient un titre (comme pour les ingrédients), et « PÂTE : Mélanger… » donne le titre
   « Pâte » suivi de l'étape « Mélanger… ». Les marqueurs « ÉTAPE 3 » sont retirés. */
const STEP_JUNK_RE = /^(post[ée] dans|merci|cat[ée]gories?|mots?[- ]cl[ée]s|pages?|citation.*|pour lire la suite.*|recette|dede|nb)$/i;
function stepItems(txt){
  const out = []; let last = '';
  const head = h => { h = cap(lowerIfCaps(h.replace(/\s*:\s*$/, '').trim())); if (h && h !== last) out.push({ head: h }); last = h; };
  for (const p of splitSteps(txt)){
    const letters = p.replace(/[^A-Za-zÀ-ÿ]/g, '');
    if (/^(étape|etape|step)\s*\d+\s*:?$/i.test(p)) continue;
    if (p.length <= 45 && letters.length >= 3 && letters === letters.toUpperCase()){ head(p); continue; }
    if (/:$/.test(p) && STEP_JUNK_RE.test(p.replace(/\s*:$/, '').trim())) continue;
    // « Pour la sauce : » est un titre ; « Faites chauffer 50 g d'huile, puis : » reste une étape.
    if (p.length <= 33 && /:$/.test(p) && !/,/.test(p) && !/\d/.test(p.replace(/\([^)]*\)/g, '').replace(/^\d+[.)]\s*/, ''))){ head(p); continue; }
    const m = p.match(/^([^:a-zà-ÿ\d]{3,30}?)\s*:\s+(.+)$/);
    if (m && /[A-ZÀ-Ý]{3}/.test(m[1])){ head(m[1]); out.push({ text: m[2] }); continue; }
    out.push({ text: p });
  }
  return out;
}
function stepTexts(txt){ return stepItems(txt).filter(it => it.text).map(it => it.text); }
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
// Groupe de variantes d'une recette : liens « pair » suivis dans les deux sens.
function pairGroup(r){
  const adj = new Map();
  const link = (a,b) => { a=String(a); b=String(b); if(!adj.has(a)) adj.set(a,new Set()); if(!adj.has(b)) adj.set(b,new Set()); adj.get(a).add(b); adj.get(b).add(a); };
  ALL.forEach(x => { if (x.pair) [].concat(x.pair).forEach(p => link(x.id, p)); });
  const seen = new Set([String(r.id)]), todo = [String(r.id)];
  while (todo.length) { const id = todo.pop(); (adj.get(id)||[]).forEach(n => { if(!seen.has(n)){ seen.add(n); todo.push(n); } }); }
  return [...seen].map(id => ALL.find(x => String(x.id) === id)).filter(Boolean);
}
// Fiche résumée d'une version officielle (nom, note, temps) + lien vers le site du fabricant.
// Étapes officielles Moulinex : récupérées sur l'appareil (CapacitorHttp) et gardées hors-ligne,
// jamais stockées dans le dépôt.
function officialStepsCached(url){
  try { const c = JSON.parse(localStorage.getItem('offSteps')||'{}'); return c[url] || null; } catch(e){ return null; }
}
async function loadOfficialSteps(url){
  if (officialStepsCached(url)) return officialStepsCached(url);
  const res = await fetch(url); if (!res.ok) return null;
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  for (const sc of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let j; try { j = JSON.parse(sc.textContent); } catch(e){ continue; }
    if (!j || j['@type'] !== 'Recipe') continue;
    const steps = [];
    [].concat(j.recipeInstructions||[]).forEach(x => {
      if (typeof x === 'string') steps.push(x);
      else if (x['@type'] === 'HowToSection') (x.itemListElement||[]).forEach(y => steps.push(y.text||''));
      else steps.push(x.text||'');
    });
    const out = steps.map(t => t.replace(/\s+/g,' ').trim()).filter(Boolean);
    if (!out.length) return null;
    try { const c = JSON.parse(localStorage.getItem('offSteps')||'{}'); c[url] = out; localStorage.setItem('offSteps', JSON.stringify(c)); } catch(e){}
    return out;
  }
  return null;
}
// Copie dans l'app de toutes les étapes Moulinex (une fois, en tâche de fond, dès qu'il y a du réseau).
async function prefetchOfficialSteps(){
  const urls = Object.keys((EXTRA && EXTRA.official) || {}).filter(u => u.includes('moulinex.fr') && !officialStepsCached(u));
  for (const u of urls) { try { await loadOfficialSteps(u); } catch(e){} await new Promise(r => setTimeout(r, 400)); }
}
function officialHtml(url, isTmx){
  const m = (EXTRA && EXTRA.official && EXTRA.official[url]) || {};
  const site = isTmx ? 'Cookidoo (Vorwerk)' : 'Moulinex';
  const stars = m.rating ? `<span class="tag">⭐ ${String(m.rating).replace('.',',')}/5${m.n?` · ${m.n} avis`:''}</span>` : '';
  return `<div class="off-card">
    <div class="off-kind">${isTmx?'⚙️ Recette Thermomix officielle':'🌪️ Recette Airfryer officielle'}</div>
    <div class="off-name">${esc(m.name || 'Version officielle')}</div>
    <div class="d-meta">${stars}${m.min?`<span class="tag">⏱️ ${m.min} min</span>`:''}${m.yld?`<span class="tag">🍽️ ${esc(m.yld)}</span>`:''}</div>
    ${(m.ing||[]).length?`<div class="d-sec">Ingrédients</div><ul class="ing">${m.ing.map(x=>`<li><span class="box"></span><span>${esc(x)}</span></li>`).join('')}</ul>`:''}
    ${(()=>{ const ex = officialStepsCached(url); const st = ex || m.steps || [];
      return st.length ? `<div class="d-sec">Préparation</div><ol class="steps off-steps">${st.map(x=>`<li>${esc(x)}</li>`).join('')}</ol>
    <p class="off-note off-src">${ex ? `Étapes officielles ${site}.` : 'Étapes résumées — le texte officiel se charge depuis le site du fabricant dès que tu es connecté.'}</p>` : ''; })()}
    <p class="off-note">Recette publiée par ${site}.${isTmx?' Les étapes guidées (vitesses, temps, températures) sont sur Cookidoo, avec un compte.':''}</p>
    <a class="off-open" href="${esc(url)}" target="_blank" rel="noopener">Ouvrir sur ${isTmx?'Cookidoo':'Moulinex'} ↗</a>
  </div>`;
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
    r.serv?`<span class="tag">🍽️ ${esc(servTxt(r.serv))}</span>`:'',
    ..._dietTags,
  ].join('');
  const sk = SEASON[monthNow()] || [];
  const ing = r.ing.length ? `<div class="d-sec">Ingrédients</div>${stockSummaryHtml(r)}<ul class="ing">${
    ingDisplayItems(r).map((it,k)=>{
      if (it.head) return `<li class="ing-head">${esc(it.head)}</li>`;
      const s = seasonHitsInText(it.text, sk).length > 0;
      return `<li data-k="${k}" class="${s?'season':''}"><span class="box"></span><span>${esc(it.text)}</span>${s?'<span class="leaf">🌿</span>':''}${stockBadgeHtml(stockHitsForLine(it.text))}</li>`;
    }).join('')}</ul>` : '';
  const stepIt = stepItems(r.steps);
  const steps = stepIt.filter(it => it.text);
  const stepsHtml = steps.length ? `<div class="d-sec">Préparation</div><ol class="steps">${
    stepIt.map(it=> it.head ? `<li class="step-head">${esc(it.head)}</li>` : `<li>${esc(it.text)}</li>`).join('')}</ol>` : '';
  const hasIng = (r.ing||[]).length > 0;
  const cookBtn = (steps.length || hasIng) ? `<div class="d-cook-row">
    ${hasIng ? `<button class="d-ing-btn">📋 Ingrédients</button>` : ''}
    ${steps.length ? `<button class="d-cook-btn">🍳 Réaliser</button>` : ''}
  </div>${hasIng ? `<button class="d-done-btn">✅ Je l'ai cuisinée</button>` : ''}` : '';
  const links = [
    r.url?`<a class="src" href="${esc(r.url)}" target="_blank" rel="noopener">🔗 Source</a>`:'',
    r.vid?`<a href="${esc(r.vid)}" target="_blank" rel="noopener">▶️ Vidéo</a>`:'',
  ].filter(Boolean).join('');
  // Onglets de variantes : recettes de l'app liées (pair, dans les deux sens)
  // + versions officielles des fabricants (Cookidoo, Moulinex) — lien seulement, rien n'est recopié.
  const _group = pairGroup(r);
  const _kind = (rec) => {
    const c = rec.cat || '';
    return c.includes('Thermomix') ? 'tmx' : c.includes('Airfryer') ? 'af' : 'home';
  };
  const _ico = {home:'🥄 Classique', tmx:'⚙️ Thermomix', af:'🌪️ Airfryer'};
  const _order = {home:0, tmx:1, tmxo:2, af:3, afo:4};
  const tabList = _group.map(p => ({id: p.id, kind: _kind(p)}));
  const _seen = {};
  tabList.forEach(t => { _seen[t.kind] = (_seen[t.kind]||0) + 1; t.label = _ico[t.kind] + (_seen[t.kind]>1 ? ' '+_seen[t.kind] : ''); });
  const _off = (field) => { const m = _group.find(p => p[field]); return m ? m[field] : null; };
  const offTmx = r.tmx || _off('tmx'), offAf = r.af || _off('af');
  // Une version Thermomix de l'app existe : l'officielle est fusionnée dans son onglet (fiche affichée sous la recette).
  const _hasTmx = tabList.some(t => t.kind === 'tmx');
  if (offTmx && !_hasTmx) tabList.push({off: offTmx, kind: 'tmxo', label: '⚙️ Thermomix officiel'});
  const mergedOff = (offTmx && _hasTmx && _kind(r) === 'tmx') ? `<div class="d-sec">Version officielle Cookidoo</div>${officialHtml(offTmx, true)}` : '';
  if (offAf) tabList.push({off: offAf, kind: 'afo', label: '🌪️ Airfryer officiel'});
  tabList.sort((x,y) => _order[x.kind] - _order[y.kind]);
  const variantTabs = tabList.length > 1 ? `<div class="d-variant-tabs">
  ${tabList.map((t,k)=>`<button class="d-variant-tab${t.id===r.id?' active':''}${t.off?' off':''}" data-k="${k}">${t.label}</button>`).join('\n  ')}
</div>` : '';
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
        ${timesHtml(r)}
        ${r.desc?`<div class="desc">${esc(r.desc)}</div>`:''}
        <div class="d-main">
        ${ing}${stepsHtml}${cookBtn}
        ${links?`<div class="d-links">${links}</div>`:''}
        ${mergedOff}
        </div>
        <div class="d-official" hidden></div>
      </div>
    </div>`;
  elDetail.hidden = false;
  if (window._wlAcquire) window._wlAcquire();
  document.body.style.overflow='hidden';
  elDetail.querySelector('.d-back').addEventListener('click', closeDetail);
  const cookBtnEl = elDetail.querySelector('.d-cook-btn');
  if (cookBtnEl) cookBtnEl.addEventListener('click', ()=> openCook(r.id));
  const doneBtnEl = elDetail.querySelector('.d-done-btn');
  if (doneBtnEl) doneBtnEl.addEventListener('click', ()=> openDeduct(r));
  const ingBtnEl = elDetail.querySelector('.d-ing-btn');
  if (ingBtnEl) ingBtnEl.addEventListener('click', ()=> openCook(r.id, 'ings'));
  elDetail.querySelector('.d-fav').addEventListener('click', (e)=>{
    if (favs.has(r.id)) favs.delete(r.id); else favs.add(r.id);
    saveFavs(); e.currentTarget.textContent = favs.has(r.id)?'❤️':'🤍';
  });
  elDetail.querySelector('.d-edit').addEventListener('click', ()=> openEdit(r.id));
  elDetail.querySelectorAll('.d-main .ing li:not(.ing-head)').forEach(li=> li.addEventListener('click',()=> li.classList.toggle('done')));
  elDetail.querySelector('.tag-cat-btn').addEventListener('click', ()=> openCatPick(r.id));
  elDetail.querySelectorAll('.d-variant-tab').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if (btn.classList.contains('active')) return;
      const t = tabList[+btn.dataset.k];
      if (t.id) { if (t.id === r.id) showMain(); else openDetail(t.id); return; }
      elDetail.querySelectorAll('.d-variant-tab').forEach(b=> b.classList.toggle('active', b===btn));
      const box = elDetail.querySelector('.d-official');
      box.innerHTML = officialHtml(t.off, t.kind === 'tmxo');
      if (t.kind === 'afo' && !officialStepsCached(t.off)) loadOfficialSteps(t.off).then(st => {
        if (!st || box.hidden) return;
        box.innerHTML = officialHtml(t.off, false);
        box.querySelectorAll('.ing li').forEach(li=> li.addEventListener('click',()=> li.classList.toggle('done')));
      }).catch(()=>{});
      box.hidden = false; elDetail.querySelector('.d-main').hidden = true;
      elDetail.querySelector('.d-body').classList.add('show-off');
      box.querySelectorAll('.ing li').forEach(li=> li.addEventListener('click',()=> li.classList.toggle('done')));
    });
  });
  function showMain(){
    elDetail.querySelectorAll('.d-variant-tab').forEach(b=> b.classList.toggle('active', tabList[+b.dataset.k].id === r.id));
    elDetail.querySelector('.d-official').hidden = true; elDetail.querySelector('.d-main').hidden = false;
    elDetail.querySelector('.d-body').classList.remove('show-off');
  }
}
function closeDetail(){ elDetail.hidden=true; document.body.style.overflow=''; renderChips(); renderGrid(); if(window._wlDrop) window._wlDrop(); }

/* ---------- mode cuisine pas-à-pas ---------- */
let cookRecipe = null;
let cookStep = 0;
let cookSteps = [], cookSecs = [];
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

/* Fiche recette : pour chaque ingrédient, le produit en stock correspondant
   et son emplacement (🧊 frigo, ❄️ congélo, 🥫 cellier). */
// Une ligne peut regrouper plusieurs ingrédients (« MARINADE : soja, sucre, ail ») :
// on cherche le produit en stock de chacun, avec le morceau de ligne concerné.
function stockHitsForLine(line){
  if (!line) return [];
  const out = [];
  for (const piece of splitIngLine(line)){
    if (isStapleLine(piece)) continue;
    const toks = stockTokens(piece, LINE_STOP);
    if (!toks.length) continue;
    let hit = null;
    for (const t of FTABS){
      const n = storageIngs[t].find(n => lineHasProduct(toks, n));
      if (n){ hit = { tab: t, name: n, piece }; break; }
    }
    if (hit && !out.some(h => h.name === hit.name)) out.push(hit);
  }
  return out;
}
function stockBadgeHtml(hits){
  return (hits || []).map(hit => `<span class="in-stock stock-${hit.tab}" title="En stock : ${esc(hit.name)}">${FTAB_EMOJIS[hit.tab]} ${esc(hit.name)}</span>`).join('');
}
// Même décompte que l'accueil et le tri « Mes stocks ».
function stockSummaryHtml(r){
  const c = recipeStockCoverage(r, stockHaveList());
  if (!c || !c.covered) return '';
  const per = FTABS.map(t => [t, [...c.used.values()].filter(x => x === t).length]).filter(([,n]) => n);
  const miss = c.total - c.covered;
  return `<div class="stock-summary">🧺 ${c.covered}/${c.total} en stock${miss ? ` · manque ${miss}` : ' · tout y est'} · ${per.map(([t,n]) => `${FTAB_EMOJIS[t]} ${n}`).join('  ')}</div>`;
}

/* Quantités en stock : par produit (nom normalisé) → { q, u, pk? } avec u = 'g', 'ml'
   ou 'pc' (q = total) et pk = contenance d'une boîte (« 3 boîtes de 400 g » →
   {q:1200,u:'g',pk:400}). Déduites quand une recette est marquée comme réalisée. */
let stockQty = JSON.parse(localStorage.getItem('stockQty') || '{}');
function saveStockQty(){ try { localStorage.setItem('stockQty', JSON.stringify(stockQty)); } catch(e){} }
function getStockQty(name){ return stockQty[norm(name)] || null; }
// keepPack : une déduction (« − 200 g ») conserve la contenance des boîtes déjà connue.
function setStockQty(name, qty, keepPack = true){
  const n = norm(name), cur = stockQty[n];
  if (qty){
    const next = { q: qty.q, u: qty.u };
    const pk = qty.pk || (keepPack && cur && cur.pk && cur.u === qty.u ? cur.pk : 0);
    if (pk && qty.u !== 'pc') next.pk = pk;
    stockQty[n] = next;
  } else delete stockQty[n];
  saveStockQty();
}

const QTY_UNITS = {
  g:['g',1], gr:['g',1], gramme:['g',1], grammes:['g',1], kg:['g',1000], kilo:['g',1000], kilos:['g',1000],
  ml:['ml',1], cl:['ml',10], dl:['ml',100], l:['ml',1000], litre:['ml',1000], litres:['ml',1000],
  pc:['pc',1], pcs:['pc',1], piece:['pc',1], pieces:['pc',1], x:['pc',1],
};
function parseNum(s){
  s = String(s).trim().replace(',', '.').replace('½', '.5').replace('¼', '.25').replace('¾', '.75');
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/); if (m) return +m[1] + m[2] / m[3];
  m = s.match(/^(\d+)\/(\d+)$/); if (m) return m[1] / m[2];
  const v = parseFloat(s.replace(/^\./, '0.')); return isNaN(v) ? null : v;
}
// « 500 g de semoule » → {q:500,u:'g'} ; « 4 cuisses » → {q:4,u:'pc'} ; « 2 c. à s. » → {q:2,u:'autre'}
function parseQty(text){
  const t = norm(text).trim();
  const m = t.match(/^(\d+(?:[.,]\d+)?(?:\s+\d+\/\d+|\/\d+)?|[½¼¾])\s*([a-z.]+)?/);
  if (!m) return null;
  const q = parseNum(m[1]); if (q == null || q <= 0) return null;
  const unit = (m[2] || '').replace(/\.$/, '');
  if (!unit) return { q, u: 'pc' };
  if (QTY_UNITS[unit]){ const [u, k] = QTY_UNITS[unit]; return { q: q * k, u }; }
  if (/^(c|cs|cc|cas|cac|cl?s)$/.test(unit) || /^(cuil|tasse|verre|pincee|bouquet|botte|brin|filet|poignee|zeste|trait)/.test(unit)) return { q, u: 'autre' };
  return { q, u: 'pc' }; // « 4 cuisses », « 2 boîtes », « 3 tranches »…
}
// Affichage en boîtes : « 📦 3 × 400 g (1,2 kg) », sinon quantité simple.
function fmtStockQty(x, short){
  if (!x) return '';
  if (!x.pk) return fmtQty(x);
  const n = Math.round(x.q / x.pk * 10) / 10;
  return `📦 ${String(n).replace('.', ',')} × ${fmtQty({ q: x.pk, u: x.u })}${n !== 1 && !short ? ` (${fmtQty(x)})` : ''}`;
}
// Ajoute / retire une boîte (ou une pièce) ; à zéro, propose de retirer le produit du stock.
function stepStock(name, tab, dir){
  const q = getStockQty(name); if (!q) return;
  const step = q.pk || (q.u === 'pc' ? 1 : 0); if (!step) return;
  const v = Math.round((q.q + dir * step) * 10) / 10;
  if (v <= 0){
    if (!confirm(`Plus de « ${name} » : le retirer du stock ?`)) return;
    storageIngs[tab] = storageIngs[tab].filter(n => norm(n) !== norm(name));
    saveStorageIngs(tab); setStockQty(name, null);
  } else setStockQty(name, { q: v, u: q.u });
  renderFrigoIngs(tab); renderFrigoSuggestions();
}
const PACK_RE = '(\\d+(?:[.,]\\d+)?)\\s*(?:x|×|\\*|bo[iî]tes?|paquets?|sachets?|bocaux|bocal|conserves?|briques?|pots?|bouteilles?|canettes?|barquettes?|boc(?:al|aux))\\s*(?:de\\s+|d[\'’]\\s*)?(\\d+(?:[.,]\\d+)?\\s*(?:kg|g|gr|l|cl|ml|dl))';
// « 3 boîtes de 400 g », « 3 x 400 g », « 2 paquets 500g » → {q:1200,u:'g',pk:400} ; sinon parseQty
function parseQtyInput(text){
  const m = String(text).trim().match(new RegExp('^' + PACK_RE + '$', 'i'));
  if (m){
    const n = parseNum(m[1]), one = parseQty(m[2]);
    if (n > 0 && one && one.u !== 'pc' && one.u !== 'autre') return { q: n * one.q, u: one.u, pk: one.q };
  }
  return parseQty(text);
}
function fmtQty(x){
  if (!x) return '';
  const r = v => (Math.round(v * 10) / 10).toString().replace('.', ',');
  if (x.u === 'g') return x.q >= 1000 ? r(x.q / 1000) + ' kg' : r(x.q) + ' g';
  if (x.u === 'ml') return x.q >= 1000 ? r(x.q / 1000) + ' l' : x.q >= 100 && x.q % 10 === 0 ? r(x.q / 10) + ' cl' : r(x.q) + ' ml';
  return '× ' + r(x.q);
}
// « Riz 1 kg », « 1 kg de riz », « 6 oeufs » → { name, qty }
function splitNameQty(raw){
  const s = raw.trim();
  // « thon 3 boîtes de 140 g » / « 3 boîtes de 140 g de thon »
  let pm = s.match(new RegExp('^(.*?\\S)\\s+(' + PACK_RE + ')$', 'i'));
  if (pm && parseQtyInput(pm[2])?.pk) return { name: pm[1], qty: parseQtyInput(pm[2]) };
  pm = s.match(new RegExp('^(' + PACK_RE + ')\\s+(?:de\\s+|d[\'’]\\s*)?(.+)$', 'i'));
  if (pm && parseQtyInput(pm[1])?.pk) return { name: pm[pm.length - 1], qty: parseQtyInput(pm[1]) };
  let m = s.match(/^(.*?\S)\s+(\d+(?:[.,]\d+)?\s*(?:kg|g|gr|l|cl|ml|dl|pcs?|pi[eè]ces?|x)?)$/i);
  if (m && parseQty(m[2])) return { name: m[1], qty: parseQty(m[2]) };
  m = s.match(/^(\d+(?:[.,]\d+)?\s*(?:kg|g|gr|l|cl|ml|dl|pcs?|pi[eè]ces?|x)?)\s+(?:de\s+|d['’]\s*)?(.+)$/i);
  if (m && parseQty(m[1])) return { name: m[2], qty: parseQty(m[1]) };
  return { name: s, qty: null };
}
function editStockQty(name, tab){
  const cur = getStockQty(name);
  const pre = cur ? (cur.pk ? `${String(Math.round(cur.q / cur.pk * 10) / 10).replace('.', ',')} boîtes de ${fmtQty({ q: cur.pk, u: cur.u })}` : fmtQty(cur).replace('× ', '')) : '';
  const v = prompt(`Quantité de « ${name} »\nex : 3 boîtes de 400 g · 2 x 1 l · 500 g · 1 kg · 6\nLaisser vide pour ne pas suivre la quantité.`, pre);
  if (v == null) return;
  const q = v.trim() ? parseQtyInput(v) : null;
  if (v.trim() && (!q || q.u === 'autre')){ toast('Quantité non reconnue'); return; }
  setStockQty(name, q, false);
  renderFrigoIngs(tab);
}

/* « Je l'ai cuisinée » : déduit directement des stocks les ingrédients utilisés
   (quantités converties g/ml/pièces). Produit épuisé ou sans quantité suivie :
   retiré du stock. Un bouton « Annuler » permet de revenir en arrière. */
function openDeduct(r){
  const prods = new Map(); // un produit peut servir à plusieurs lignes
  for (const hit of (r.ing || []).flatMap(stockHitsForLine)){
    const line = hit.piece;
    const key = hit.tab + '|' + norm(hit.name);
    const p = prods.get(key) || { tab: hit.tab, name: hit.name, have: getStockQty(hit.name), need: null, unknown: false };
    const need = parseQty(line);
    if (need && p.have && need.u === p.have.u) p.need = { q: (p.need ? p.need.q : 0) + need.q, u: need.u };
    else if (p.have) p.unknown = true;
    prods.set(key, p);
  }
  if (!prods.size){ toast('Bonne dégustation ! 🎉'); return; }
  const snapshot = JSON.stringify({ ings: storageIngs, qty: stockQty });
  const done = [];
  for (const p of prods.values()){
    if (p.have && !p.need){ done.push(`${FTAB_EMOJIS[p.tab]} ${p.name} : quantité inchangée`); continue; } // ex. cuillères d'huile
    const left = p.need ? p.have.q - p.need.q : 0;
    if (p.need && left > 0.0001){
      setStockQty(p.name, { q: Math.round(left * 10) / 10, u: p.have.u });
      done.push(`${FTAB_EMOJIS[p.tab]} ${p.name} : ${fmtQty(p.have)} → ${fmtQty({ q: left, u: p.have.u })}`);
    } else {
      storageIngs[p.tab] = storageIngs[p.tab].filter(n => norm(n) !== norm(p.name));
      saveStorageIngs(p.tab); setStockQty(p.name, null);
      done.push(`${FTAB_EMOJIS[p.tab]} ${p.name} : retiré`);
    }
  }
  const refresh = () => { FTABS.forEach(t => renderFrigoIngs(t)); renderFrigoSuggestions(); renderCellarHome(); };
  refresh();
  showUndoBar(`✅ Stocks mis à jour (${prods.size} produit${prods.size > 1 ? 's' : ''})`, done, () => {
    const s = JSON.parse(snapshot);
    FTABS.forEach(t => { storageIngs[t] = s.ings[t]; saveStorageIngs(t); });
    stockQty = s.qty; saveStockQty(); refresh();
    toast('Stocks restaurés');
  });
}

function showUndoBar(title, details, onUndo){
  let bar = document.getElementById('undo-bar');
  if (!bar){ bar = document.createElement('div'); bar.id = 'undo-bar'; document.body.appendChild(bar); }
  clearTimeout(bar._t);
  bar.innerHTML = `<div class="ub2-main"><span class="ub2-title">${esc(title)}</span><button class="ub2-undo">Annuler</button></div>
    <div class="ub2-details">${details.map(d => `<div>${esc(d)}</div>`).join('')}</div>`;
  bar.hidden = false;
  bar.querySelector('.ub2-undo').addEventListener('click', () => { clearTimeout(bar._t); bar.hidden = true; onUndo(); });
  bar._t = setTimeout(() => { bar.hidden = true; }, 8000);
}

/* Affichage : une ligne qui regroupe plusieurs ingrédients (« PÂTE : 500 g farine,
   7 g levure, 250 ml lait ») devient un petit titre « Pâte » + un ingrédient par ligne. */
// Titre de groupe : « BRIOCHE » → « Brioche », mais « Version Cookomix » garde ses majuscules.
function lowerIfCaps(t){ return t === t.toUpperCase() ? t.toLowerCase() : t; }
function ingDisplayItems(r){
  const out = [];
  for (const line of (r.ing || [])){
    const l = String(line).trim();
    if (!l) continue;
    const head = l.match(/^([^:()\d]{1,40}):\s*(.*)$/);
    const pieces = splitIngLine(l);
    const label = head && head[2].trim() && (head[1] === head[1].toUpperCase() || /^pour\s/i.test(head[1]) || /[,+;]/.test(head[2])) ? head[1].trim() : '';
    const allQty = pieces.length >= 2 && pieces.every(p => /^[\d½¼¾⅓]/.test(p.trim()));
    if (head && !head[2].trim()){ out.push({ head: cap(lowerIfCaps(l.replace(/\s*:\s*$/, ''))) }); continue; }  // titre de section seul
    if ((label && pieces.length >= 2) || allQty){
      if (label) out.push({ head: cap(lowerIfCaps(label)) });
      pieces.forEach(p => out.push({ text: p }));
    } else out.push({ text: l });
  }
  return out;
}
function cookIngListHtml(r){
  const sk = SEASON[monthNow()] || [];
  return ingDisplayItems(r).map((it,k)=>{
    if (it.head) return `<li class="ing-head">${esc(it.head)}</li>`;
    const item = it.text;
    const s = seasonHitsInText(item, sk).length > 0;
    const qm = item.match(ING_QTY_RE) || item.match(ING_NUM_RE);
    const txt = qm ? `<strong class="cook-qty">${esc(qm[1].trim())}</strong> ${esc(qm[2].trim())}` : esc(item);
    return `<li data-k="${k}" class="${s?'season':''}"><span class="box"></span><span>${txt}</span>${s?'<span class="leaf">🌿</span>':''}${stockBadgeHtml(stockHitsForLine(item))}</li>`;
  }).join('');
}

function openCook(id, initialTab='steps'){
  const r = ALL.find(x=>String(x.id)===String(id)); if(!r) return;
  cookRecipe = r;
  const _it = stepItems(r.steps); let _sec = '';
  cookSteps = []; cookSecs = [];
  for (const it of _it){ if (it.head) _sec = it.head; else { cookSteps.push(it.text); cookSecs.push(_sec); } }
  if(initialTab==='steps' && !cookSteps.length){ toast('Aucune étape de préparation'); return; }
  cookStep = 0;
  cookIngMap = buildIngMap(r.ing||[]);
  const ingList = cookIngListHtml(r);
  const hasSteps = cookSteps.length > 0;
  elCook.innerHTML = `
    <div class="cook-head">
      <button class="cook-quit" aria-label="Quitter">←</button>
      <span class="cook-title">${esc(r.t)}</span>
      <button class="cook-edit cook-mic" aria-label="Éditer la recette">✏️</button>
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
  elCook.querySelector('.cook-edit').addEventListener('click', ()=>{ closeCook(); openEdit(r.id); });
  document.getElementById('cook-mic').addEventListener('click', toggleCookMic);
  const prevBtn = document.getElementById('cook-prev');
  if(prevBtn){
    prevBtn.addEventListener('click', cookGoPrev);
    document.getElementById('cook-next').addEventListener('click', cookGoNext);
  }
  document.getElementById('cook-ings-pane').querySelectorAll('.ing li:not(.ing-head)').forEach(li => {
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
  const sec = cookSecs[cookStep];
  document.getElementById('cook-step-text').innerHTML = (sec ? `<div class="cook-step-sec">${esc(sec)}</div>` : '') + enrichStep(cookSteps[cookStep], cookIngMap);
  document.getElementById('cook-prev').disabled = cookStep === 0;
  document.getElementById('cook-next').textContent = cookStep === total-1 ? '✓ Terminer' : 'Suivant →';
}

function cookGoNext(){
  if(cookStep < cookSteps.length-1){ cookStep++; renderCookStep(); speakCookStep(); }
  else{ const r = cookRecipe; closeCook(); openDeduct(r); }
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
      <div class="ef-row">${field('Durée (min)', `<input id="e-min" type="number" min="0" value="${r.minEst ? '' : v(r.min)}"${r.minEst ? ` placeholder="≈ ${r.min} (estimé)"` : ''}>`)}${field('Portions', `<input id="e-serv" type="number" min="0" value="${v(r.serv)}">`)}</div>
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
// Modifications locales des cocktails (TheCocktailDB n'est pas éditable) : appliquées par-dessus.
let cocktailEdits = JSON.parse(localStorage.getItem('cocktailEdits') || '{}');
function saveCocktailEdits(){ try { localStorage.setItem('cocktailEdits', JSON.stringify(cocktailEdits)); } catch(e){} }
const GLASS_FR = {'Wine Glass':'Verre à vin','Cocktail glass':'Verre à cocktail','Highball glass':'Verre highball','Old-fashioned glass':'Verre old fashioned',
  'Collins glass':'Verre collins','Champagne flute':'Flûte à champagne','Margarita glass':'Verre à margarita','Martini Glass':'Verre à martini',
  'Shot glass':'Verre à shot','Coupe Glass':'Coupe','Hurricane glass':'Verre hurricane','Copper Mug':'Mug en cuivre','Mason jar':'Bocal',
  'Beer mug':'Chope','Beer Glass':'Verre à bière','Irish coffee cup':'Tasse irish coffee','Coffee mug':'Mug','Punch bowl':'Bol à punch',
  'Balloon Glass':'Verre ballon','Pint glass':'Verre pinte','Brandy snifter':'Verre à cognac','Whiskey sour glass':'Verre whisky sour'};
function cocktailView(c){
  const v = Object.assign({}, c, cocktailEdits[c.id] || {});
  if (!(cocktailEdits[c.id] || {}).glass) v.glass = GLASS_FR[c.glass] || c.glass;
  v.ings = v.ings.map(x => Object.assign({}, x, { qty: x.qty === 'Top' ? 'Compléter avec' : x.qty }));
  return v;
}
let appMode = 'recipes';
let appSubMode = null;

const elCocktailGrid = document.getElementById('cocktail-grid');
const elCocktailDetail = document.getElementById('cocktail-detail');

const MODE_GROUPS = {
  pizza:           { subs: ['garnies','pinsas','pates_pizza'] },
  desserts:        { subs: ['desserts_tous','gateaux','tartes_sucrees','flans','cremes_desserts','biscuits','viennoiseries','crepes_sucrees','pates_crepes','tiramisu','cheesecakes','charlottes'] },
  soupes:          { subs: ['soupes','salades'] },
  poissons:        { subs: ['poissons','fruits_mer','moules'] },
  techniques:      { subs: ['gestes','pates_maison'] },
  crepes_cakes:    { subs: ['crepes_salees','cakes_sales','tatins_salees'] },
  regions:         { subs: ['corse','espagne','majorque','portugal','italie','grece','france','japon','asie','maghreb','allemagne','gb','australie','bresil','argentine','af','arabe','bulgarie','hongrie','roumanie','paysbas','belgique'] },
  ustensiles:      { subs: ['airfryer','thermomix','sousvide'] },
  aperitif:        { subs: ['tartines','tartinades','wraps','tortillas','roules','bouchees','brochettes','paninis','samoussas','empanadas'] },
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
  garnies:'🍕 Garnitures', pinsas:'🫓 Pinsas', pates_pizza:'🍞 Pâtes',
  majorque:'🏝️ Majorque',
  desserts_tous:'🍰 Tous', gateaux:'🎂 Gâteaux', tartes_sucrees:'🥧 Tartes', flans:'🍮 Flans', cremes_desserts:'🥄 Crèmes & mousses', biscuits:'🍪 Biscuits & douceurs', viennoiseries:'🥐 Viennoiseries', crepes_sucrees:'🥞 Crêpes & gaufres', pates_crepes:'🥣 Pâtes à crêpes', tiramisu:'☕ Tiramisu', cheesecakes:'🧀 Cheesecakes', charlottes:'🍓 Charlottes',
  soupes:'🥣 Soupes', salades:'🥗 Salades', poissons:'🐟 Poissons', fruits_mer:'🦐 Fruits de mer', moules:'🦪 Moules', gestes:'🔪 Gestes & cuissons', pates_maison:'🥟 Pâtes maison', crepes_salees:'🥞 Crêpes salées', cakes_sales:'🍞 Cakes salés', tatins_salees:'🥧 Tatins salées',
  airfryer:'🌪️ Airfryer', thermomix:'⚙️ Thermomix', sousvide:'🌡️ Sous vide',
  tartines:'🍞 Tartines', tartinades:'🥖 Tartinades', wraps:'🌮 Wraps', tortillas:'🫓 Tortillas', roules:'🌀 Roulés', bouchees:'🫓 Bouchées', brochettes:'🍢 Brochettes', paninis:'🥪 Paninis', samoussas:'🔺 Samoussas', empanadas:'🥟 Empanadas',
  omelettes:'🍳 Omelettes', cocottes:'🥚 Cocottes', preparations:'🍳 Préparations',
  smoothies:'🧉 Smoothies', milkshakes:'🥤 Milkshakes', mocktails:'🍹 Sans alcool',
  sauces:'🥣 Sauces', marinades:'🌿 Marinades',
  sansgluten:'🌾 Sans gluten', proteines:'💪 Protéines', antiinflamm:'🌿 Anti-inflam.',
  vegetarien:'🥦 Végétarien', vegan:'🌱 Vegan', keto:'🥑 Keto', rapide:'⚡ ≤30 min',
};
const MODE_CAT = {
  accomp: 'Accompagnement',
  junior: 'Junior',
  garnies: 'Pizza', pinsas: 'Pinsa', pates_pizza: 'Pâte à Pizza', majorque: 'Majorque',
  desserts_tous: 'Dessert', gateaux: 'Gâteaux', tartes_sucrees: 'Tarte sucrée', flans: 'Flan', cremes_desserts: 'Crème dessert', biscuits: 'Biscuit', viennoiseries: 'Viennoiserie', crepes_sucrees: 'Crêpe sucrée', pates_crepes: 'Pâte à crêpes', tiramisu: 'Tiramisu', cheesecakes: 'Cheesecake', charlottes: 'Charlotte',
  soupes: 'Soupe', salades: 'Salade', poissons: 'Poisson', fruits_mer: 'Fruits de mer', moules: 'Moules', gestes: 'Technique', pates_maison: 'Pâte maison', crepes_salees: 'Crêpe salée', cakes_sales: 'Cake salé', tatins_salees: 'Tatin salée',
  airfryer: 'Airfryer', thermomix: 'Thermomix', sousvide: 'Sous vide',
  corse: 'Corse', espagne: 'Espagne', portugal: 'Portugal',
  italie: 'Italie', grece: 'Grèce', france: 'France',
  japon: 'Japon', asie: 'Asie', maghreb: 'Maghreb',
  allemagne: 'Allemagne', gb: 'Grande-Bretagne', australie: 'Australie',
  bresil: 'Brésil', argentine: 'Argentine', af: 'Afrique', monde: 'Monde',
  arabe: 'Monde arabe', bulgarie: 'Bulgarie', hongrie: 'Hongrie', roumanie: 'Roumanie', paysbas: 'Pays-Bas', belgique: 'Belgique',
  sauces: 'Sauce', tartines: 'Tartine', tartinades: 'Tartinade', techniques: 'Technique',
  wraps: 'Wrap', tortillas: 'Tortilla', roules: 'Roulés de tortillas', milkshakes: 'Milkshake', smoothies: 'Smoothie', marinades: 'Marinade',
  bouchees: 'Bouchée', brochettes: 'Brochette', omelettes: 'Omelette', cocottes: 'Cocotte',
  mocktails: 'Cocktail sans alcool', preparations: 'Préparation Oeuf',
  paninis: 'Panini', samoussas: 'Samoussa', empanadas: 'Empanada',
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

let searchOpen = false;
function openSearch(){
  searchOpen = true; elSearch.hidden = false; elSearch.focus();
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
    elSearch.hidden = !(searchOpen || elSearch.value);   // accueil épuré : la recherche s'ouvre depuis le menu ⋯
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
  elCocktailGrid.innerHTML = cocktailCache.map(cocktailView).map(c=>`
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
  const c0 = cocktailCache && cocktailCache.find(x=>x.id===id); if(!c0) return;
  const c = cocktailView(c0);
  const ingsHtml = c.ings.map(x=>`<li>${x.qty ? '<strong>'+esc(x.qty)+'</strong> ' : ''}${esc(x.ing)}</li>`).join('');
  const stepsHtml = c.steps ? `<div class="d-sec">Préparation</div><div class="desc">${esc(c.steps)}</div>` : '';
  elCocktailDetail.innerHTML = `
    <button class="d-back" aria-label="Retour aux cocktails">←</button>
    <button class="d-edit" aria-label="Éditer">✏️</button>
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
  elCocktailDetail.querySelector('.d-edit').addEventListener('click', ()=> openCocktailEdit(id));
}
function openCocktailEdit(id){
  const c0 = cocktailCache && cocktailCache.find(x=>x.id===id); if(!c0) return;
  const c = cocktailView(c0);
  const v = s => esc(s == null ? '' : String(s));
  elEdit.innerHTML = `
    <div class="edit-head">
      <button class="e-cancel">← Annuler</button>
      <h2>Éditer le cocktail</h2>
      <button class="e-save">Enregistrer</button>
    </div>
    <div class="edit-body">
      ${field('Nom', `<input id="c-name" value="${v(c.name)}">`)}
      <div class="ef-row">${field('Verre', `<input id="c-glass" value="${v(c.glass)}">`)}${field('Alcool', `<select id="c-alc"><option value="Alcoholic"${c.alcoholic==='Alcoholic'?' selected':''}>🍸 Avec alcool</option><option value="Non alcoholic"${c.alcoholic!=='Alcoholic'?' selected':''}>🥤 Sans alcool</option></select>`)}</div>
      ${field('Photo (URL)', `<input id="c-thumb" value="${v(c.thumb.replace('/preview',''))}">`)}
      ${field('Ingrédients (un par ligne)', `<textarea id="c-ings" rows="8">${v(c.ings.map(x => (x.qty ? x.qty + ' ' : '') + x.ing).join('\n'))}</textarea>`)}
      ${field('Préparation', `<textarea id="c-steps" rows="8">${v(c.steps)}</textarea>`)}
      ${cocktailEdits[id] ? `<button class="e-reset">↺ Rétablir la version d'origine</button>` : ''}
    </div>`;
  elEdit.hidden = false;
  elEdit.scrollTop = 0;
  const done = () => { closeEdit(); renderCocktailGrid(); openCocktailDetail(id); };
  elEdit.querySelector('.e-cancel').addEventListener('click', closeEdit);
  elEdit.querySelector('.e-save').addEventListener('click', () => {
    const val = k => document.getElementById(k).value.trim();
    const thumb = val('c-thumb');
    cocktailEdits[id] = {
      name: val('c-name') || c0.name, glass: val('c-glass'), alcoholic: val('c-alc'),
      thumb: thumb ? (thumb === c0.thumb.replace('/preview','') ? c0.thumb : thumb) : c0.thumb,
      ings: val('c-ings').split(/\r?\n/).map(x => x.trim()).filter(Boolean).map(x => ({ qty: '', ing: x })),
      steps: document.getElementById('c-steps').value.trim(),
    };
    saveCocktailEdits(); done(); toast('Cocktail enregistré ✓');
  });
  const rb = elEdit.querySelector('.e-reset');
  if (rb) rb.addEventListener('click', () => { delete cocktailEdits[id]; saveCocktailEdits(); done(); toast('Version d\'origine rétablie'); });
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

/* Viande du boucher (sans code-barres) : morceaux courants à ajouter d'un toucher,
   avec une icône dessinée au lieu d'une photo de produit industriel. */
const BOUCHERIE = {
  '🐄 Bœuf': ['Steaks hachés','Viande hachée de bœuf','Bœuf bourguignon','Rôti de bœuf','Entrecôte','Côte de bœuf','Bavette de bœuf','Bœuf pot-au-feu','Joue de bœuf'],
  '🐮 Veau': ['Escalopes de veau','Blanquette de veau','Rôti de veau','Osso buco de veau'],
  '🐖 Porc': ['Côtes de porc','Rôti de porc','Filet mignon de porc','Échine de porc','Poitrine de porc','Lardons','Saucisses','Chipolatas','Merguez','Chair à saucisse'],
  '🐑 Agneau': ['Gigot d\'agneau','Côtelettes d\'agneau','Épaule d\'agneau','Navarin d\'agneau'],
  '🐔 Volaille': ['Poulet entier','Cuisses de poulet','Blancs de poulet','Ailes de poulet','Escalopes de dinde','Magret de canard','Cuisses de canard'],
};
const MEAT_ICONS = [
  [/saucisse|chipolata|merguez|knack|chair a saucisse/, '1f32d'],
  [/lardon|poitrine|bacon|lard\b/, '1f953'],
  [/poulet|volaille|dinde|canard|magret|pintade|caille|cuisse|aile/, '1f357'],
  [/agneau|gigot|cotelette|navarin/, '1f356'],
  [/boeuf|veau|porc|steak|hache|roti|entrecote|bavette|bourguignon|filet mignon|echine|escalope|osso buco|joue|viande|cote/, '1f969'],
  [/poisson|saumon|cabillaud|colin|merlu|truite|thon|dorade|lieu/, '1f41f'],
];
function meatIcon(name){
  const n = norm(name);
  const hit = MEAT_ICONS.find(([re]) => re.test(n));
  return hit ? `img/emoji/${hit[1]}.svg` : '';
}

/* Date d'entrée au congélateur et durée de conservation conseillée (en mois). */
let stockDates = JSON.parse(localStorage.getItem('stockDates') || '{}');
function saveStockDates(){ try { localStorage.setItem('stockDates', JSON.stringify(stockDates)); } catch(e){} }
const FREEZE_MONTHS = [
  [/hache|chair a saucisse|saucisse|chipolata|merguez/, 3],
  [/poisson|saumon|cabillaud|colin|merlu|truite|thon|crevette/, 4],
  [/lardon|poitrine|porc|echine/, 6],
  [/poulet|volaille|dinde|canard|magret|cuisse|aile/, 9],
  [/boeuf|veau|agneau|gigot|roti|entrecote|bavette|cote|escalope|steak/, 9],
];
function freezeMonths(name){ const n = norm(name); const h = FREEZE_MONTHS.find(([re]) => re.test(n)); return h ? h[1] : 6; }
function freezeBadge(name){
  const ts = stockDates[norm(name)];
  if (!ts) return '';
  const days = Math.floor((Date.now() - ts) / 86400000);
  const months = freezeMonths(name);
  const age = days < 1 ? 'aujourd\'hui' : days < 14 ? `${days} j` : days < 60 ? `${Math.round(days/7)} sem.` : `${Math.round(days/30)} mois`;
  const late = days > months * 30;
  return `<span class="freeze-badge${late ? ' late' : ''}" title="Conservation conseillée : ${months} mois">❄️ ${days < 1 ? 'congelé ' : 'depuis '}${age}${late ? ' · à consommer' : ''}</span>`;
}

function renderBoucherie(){
  const el = document.getElementById('boucherie-body');
  if (!el) return;
  const have = new Set(storageIngs.congelateur.map(norm));
  el.innerHTML = Object.entries(BOUCHERIE).map(([animal, cuts]) =>
    `<div class="bouch-group"><div class="bouch-h">${animal}</div><div class="bouch-chips">${
      cuts.map(c => `<button class="bouch-chip${have.has(norm(c)) ? ' on' : ''}" data-cut="${esc(c)}">${have.has(norm(c)) ? '✓ ' : '+ '}${esc(c)}</button>`).join('')
    }</div></div>`).join('') +
    '<p class="stock-hint">Touche le nom d\'un morceau ajouté pour préciser (poids, nombre…).</p>';
  el.querySelectorAll('.bouch-chip').forEach(b => b.addEventListener('click', ()=>{
    const cut = b.dataset.cut;
    if (addStockItem(cut, 'congelateur')) toast(`❄️ « ${cut} » ajouté au congélateur`);
    renderFrigoIngs('congelateur');
    renderFrigoSuggestions();
  }));
}

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
  if (n in stockImgs || _imgQueue.some(x => norm(x) === n)) return;
  const icon = meatIcon(name);
  if (icon){ setStockImg(name, icon); return; } // viande du boucher : pas de produit industriel
  if (!navigator.onLine) return;
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
  if (stockQty[norm(old)] && !stockQty[norm(v)]) setStockQty(v, stockQty[norm(old)]);
  if (stockDates[norm(old)] && !stockDates[norm(v)]){ stockDates[norm(v)] = stockDates[norm(old)]; saveStockDates(); }
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

function closeFrigo(){ document.getElementById('frigo').hidden = true; renderCellarHome(); if (stockSort) renderGrid(); }

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
  if (tab === 'congelateur') renderBoucherie();
  const el = document.getElementById('frigo-ings-' + tab);
  if (!el) return;
  const ings = storageIngs[tab] || [];
  if (!ings.length){ el.hidden = true; return; }
  // Icônes de viande posées avant l'affichage (pas de recherche réseau pour elles).
  ings.forEach(n => { if (!(norm(n) in stockImgs)){ const ic = meatIcon(n); if (ic) setStockImg(n, ic); } });
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
          ${(() => { const q = getStockQty(ing);
            const btn = `<button class="stock-qty${q ? '' : ' empty'}" data-idx="${i}">${q ? (q.pk ? '' : '⚖️ ') + fmtStockQty(q, true) : '+ quantité'}</button>`;
            return q && (q.pk || q.u === 'pc')
              ? `<div class="sq-row"><button class="sq-btn" data-idx="${i}" data-d="-1" aria-label="Retirer une boîte">−</button>${btn}<button class="sq-btn" data-idx="${i}" data-d="1" aria-label="Ajouter une boîte">+</button></div>`
              : btn; })()}
          ${tab === 'congelateur' ? freezeBadge(ing) : ''}
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
  el.querySelectorAll('.stock-qty').forEach(btn => {
    btn.addEventListener('click', ()=> editStockQty(ings[parseInt(btn.dataset.idx)], tab));
  });
  el.querySelectorAll('.sq-btn').forEach(btn => {
    btn.addEventListener('click', ()=> stepStock(ings[parseInt(btn.dataset.idx)], tab, +btn.dataset.d));
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
  'batonnet batonnets stick sticks portion portions barquette barquettes pave paves dos surgele surgeles surgelee surgelees congele congeles congelee congelees '+
  'france francais francaise origine marque repere gr kg cl ml litre litres '+
  'carrefour auchan leclerc lidl casino intermarche monoprix franprix systeme reflets panzani barilla lustucru '+
  'bonduelle cassegrain daucy heinz amora maille lesieur puget knorr maggi vahine ancel francine saupiquet connetable').split(' '));
// Mots qui ne suffisent pas seuls : il faut aussi le 2ᵉ mot-clé.
// Formes (« pulpe de mangue » ≠ « pulpe de tomates ») et noms ambigus
// (« pois chiches » ≠ « petits pois », « pomme de terre » ≠ « pomme »).
const STOCK_GENERIC = new Set(['sauce','jus','creme','poudre','sirop','bouillon','puree','confiture','soupe','pate','huile','vinaigre','fromage','lait',
  'pulpe','couli','concentre','compote','nectar','gelee','fond','fumet','cube','flocon','farine','graine','feuille','eau','boisson','yaourt','preparation','melange',
  'filet','dos','steak','morceau','tranche','rondelle','coeur','brisure','haricot','pois','petit','pomme','noix','chou','fruit','cuisse','blanc','aile',
  'cote','cotelette','roti','escalope','epaule','jarret','joue','poitrine','echine','chair','entier']);
const LINE_STOP = new Set(['de','du','des','la','le','les','un','une','et','en','au','aux','ou','pour','avec','cuillere','cuilleres','soupe','cafe','pincee','pincees','gousse','gousses','tranche','tranches','boite','boites','sachet','sachets','verre','verres','bouquet','brin','brins','feuille','feuilles','goutte','gouttes','quelques','batonnet','batonnets','stick','sticks','portion','portions','barquette','barquettes']);

// « pâtes » (pâtes alimentaires) ≠ « pâte » (feuilletée, brisée…) : on ne singularise pas ce mot.
function stockStem(w){ return w !== 'pates' && w.length > 4 && /[sx]$/.test(w) ? w.slice(0, -1) : w; }
function stockTokens(s, stop){
  return norm(s).replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(w => w.length >= 3 && !/^\d/.test(w) && !stop.has(w)).map(stockStem);
}
function stockKeys(name){ return stockTokens(name, STOCK_STOP).slice(0, 2); }
// Produits « dérivés » : dans « bouillon de bœuf », « concentré de tomate », « vinaigre de riz »,
// le produit cité après ce mot n'est pas l'ingrédient lui-même.
const STOCK_FORMS = new Set(['bouillon','fond','fumet','concentre','sauce','couli','poudre','vinaigre','nouille','galette',
  'fecule','sirop','arome','extrait','glace','vermicelle','tartiner','huile','yaourt','yogourt','chip','biscuit','liqueur','ketchup','mayonnaise','pesto']);
// Mot qui, placé juste après le produit, en fait un autre produit (« lait de coco », « chocolat blanc »).
const STOCK_AFTER = {
  lait: ['coco','concentre','vegetal','amande','soja','avoine','riz','ribot','poudre','fermente'],
  chocolat: ['blanc','lait','poudre'],
  beurre: ['cacahuete','cacao','karite','noisette'],
  creme: ['coco','marron','patissiere','anglaise','balsamique','cassis'],
  sucre: ['glace','vanille','vanilline'],
  farine: ['mais','riz','chataigne','sarrasin','pois','coco','amande','manioc'],
  tomate: ['sechee','seche'],
  pomme: ['terre'],            // « Pommes » (fruit) ≠ « pommes de terre »
};
// Couleurs qui distinguent deux produits (« olives vertes » ≠ « olives noires »).
const STOCK_COLOR_CLASH = { verte:['noire','noir'], vert:['noire','noir'], noire:['verte','vert'], noir:['verte','vert','blanc','blanche'],
  blanc:['noir','noire'], blanche:['noir','noire'], rouge:['vert','verte','jaune'], jaune:['rouge','vert','verte'] };
// Variétés d'un même produit qui ne se remplacent pas : « saucisse de Toulouse » ≠ « saucisse
// de Morteau » ≠ « sobrassada » ; « jambon blanc » ≠ « jambon cru ». Une ligne de recette sans
// variété (« 4 saucisses ») reste couverte par n'importe quelle variété en stock.
// (chaque groupe = mots équivalents : « jambon blanc » = « jambon cuit »).
const STOCK_VARIETIES = {
  saucisse: [['toulouse'],['morteau'],['montbeliard'],['francfort','strasbourg','knack'],['fumee','fume','rookworst','kolbasz'],
    ['calabraise','linguica'],['sobrassada'],['figatelli','foie'],['cocktail'],['nuremberg','thuringe','bratwurst'],['merguez'],
    ['chipolata'],['diot'],['herbe'],['volaille','poulet','dinde'],['veau'],['cumin'],['lyon'],['seche','sec'],['italienne'],
    ['chorizo'],['anglaise','sausage','banger']],
  jambon: [['blanc','cuit','paris','braise','cotto'],['cru','sec','serrano','parme','bayonne','iberique','prosciutto','pata','negra','prisuttu','bellota'],
    ['poulet','dinde','volaille'],['fume']],
};
// Produits dont la version fumée est un autre produit : « saumon fumé » ne remplace pas le
// saumon frais ou surgelé d'une recette, et inversement (même quand la recette ne précise rien).
const STOCK_SMOKED = { saumon:1, truite:1, hareng:1, maquereau:1, haddock:1, anguille:1, thon:1, espadon:1 };
const STOCK_SMOKED_WORDS = ['fume', 'fumee', 'gravlax'];
// Ce qui n'est pas le produit lui-même (« chair à saucisse », « enveloppe à saucisse »).
const STOCK_NOT_PRODUCT = { saucisse: ['chair','enveloppe','boyau','sobrassada','figatelli'], jambon: ['couenne','os'],
  meringue: ['blanc','preparer','suisse','italienne','francaise'] }; // « réserver les blancs pour la meringue » = meringue à faire
// Équivalences : un produit en stock couvre aussi ces façons de l'écrire dans une recette.
const STOCK_SYNONYMS = [
  { when: ['pates'], alts: [['pates'],['spaghetti'],['spaghettis'],['tagliatelle'],['penne'],['macaroni'],['fusilli'],['linguine'],['farfalle'],
    ['coquillette'],['rigatoni'],['orecchiette'],['conchiglie'],['pappardelle'],['torsade'],['tortiglioni']] },
  { when: ['creme','fraiche'], alts: [['creme','fraiche'],['creme','liquide'],['creme','epaisse'],['creme','entiere'],['creme','cuisine'],['creme','fleurette']] },
  { when: ['creme','liquide'], alts: [['creme','fraiche'],['creme','liquide'],['creme','entiere'],['creme','cuisine'],['creme','fleurette']] },
  { when: ['creme','epaisse'], alts: [['creme','fraiche'],['creme','epaisse']] },
  { when: ['emmental'], alts: [['emmental'],['fromage','rape'],['gruyere','rape']] },
  { when: ['gruyere'], alts: [['gruyere'],['fromage','rape'],['emmental','rape']] },
  { when: ['comte'], alts: [['comte'],['fromage','rape']] },
  { when: ['fromage','rape'], alts: [['fromage','rape'],['emmental','rape'],['gruyere','rape'],['comte','rape']] },
  { when: ['sucre','morceau'], alts: [['sucre','morceau']] },
  // « Gouttes vanille » = mini meringues (nom commercial), pas des gouttes d'extrait de vanille.
  { when: ['goutte'], alts: [['meringue']] },
  { when: ['steak','hache'], alts: [['steak','hache'],['boeuf','hache'],['viande','hachee'],['viande','hache']] },
  { when: ['boeuf','hache'], alts: [['boeuf','hache'],['steak','hache'],['viande','hachee'],['viande','hache']] },
];
// Façons de reconnaître un produit en stock dans une ligne d'ingrédient.
const _prodAltCache = new Map();
function stockProductAlts(name){
  let v = _prodAltCache.get(name);
  if (!v){
    const keys = stockKeys(name);
    const syn = STOCK_SYNONYMS.find(x => x.when.every((w, i) => keys[i] === w));
    // Équivalences : tous les mots sont exigés (« bœuf haché » ne couvre pas « bœuf à braiser »).
    v = !keys.length ? [] : syn ? syn.alts.map(k => ({ keys: k, strict: true })) : [{ keys, strict: false }];
    _prodAltCache.set(name, v);
  }
  return v;
}
function lineHasKeys(toks, keys, strict){
  const i = toks.indexOf(keys[0]);
  if (i < 0) return false;
  if (keys.length > 1 && !toks.includes(keys[1]) && (strict || STOCK_GENERIC.has(keys[0]))) return false;
  // « sans sucre », « bouillon de bœuf », « lait de coco » : ce n'est pas le produit.
  if (toks[i - 1] === 'sans') return false;
  if (toks.slice(0, i).some(w => STOCK_FORMS.has(w)) && !keys.some(k => STOCK_FORMS.has(k))) return false;
  // Couleur précisée dans le stock et contraire dans la recette.
  const clash = keys[1] && STOCK_COLOR_CLASH[keys[1]];
  if (clash && clash.includes(toks[i + 1])) return false;
  const np = STOCK_NOT_PRODUCT[keys[0]];
  if (np && np.some(w => toks.includes(w) && !keys.includes(w))) return false;
  const after = STOCK_AFTER[keys[0]];
  if (after && after.includes(toks[i + 1]) && !keys.includes(toks[i + 1])) return false;
  return true;
}
const _prodTokCache = new Map();
function stockVarietyOk(toks, name){
  let own = _prodTokCache.get(name);
  if (!own){ own = new Set(stockTokens(name, STOCK_STOP)); _prodTokCache.set(name, own); }
  for (const fam of Object.keys(STOCK_SMOKED)){
    if (!own.has(fam) || !toks.includes(fam)) continue;
    const mineSmoked = STOCK_SMOKED_WORDS.some(w => own.has(w));
    const theirSmoked = STOCK_SMOKED_WORDS.some(w => toks.includes(w));
    if (mineSmoked !== theirSmoked) return false;
  }
  for (const fam of Object.keys(STOCK_VARIETIES)){
    if (!own.has(fam) || !toks.includes(fam)) continue;
    if ((STOCK_NOT_PRODUCT[fam] || []).some(w => toks.includes(w) && !own.has(w))) return false;
    const mine = STOCK_VARIETIES[fam].filter(g => g.some(w => own.has(w)));
    const theirs = STOCK_VARIETIES[fam].filter(g => g.some(w => toks.includes(w)));
    if (mine.length && theirs.length && !theirs.some(g => mine.includes(g))) return false;
  }
  return true;
}
function lineHasProduct(toks, name){
  return stockProductAlts(name).some(a => lineHasKeys(toks, a.keys, a.strict)) && stockVarietyOk(toks, name);
}
// Sel, poivre, eau… : supposés toujours disponibles, n'entrent pas dans la couverture.
function isStapleLine(line){ return /\b(sel|poivre|eau)\b/.test(norm(line)) && norm(line).split(/\s+/).length <= 6; }
function cleanIngLine(line){
  return String(line).replace(/^[\d\s.,/½¼¾⅓⅔-]+/, '')
    .replace(/^(g|kg|mg|ml|cl|dl|l|grammes?|c\.?\s?[aà]\s?[sc]\.?|cuill?\w*( à \w+)?|pinc\w*|gouttes?|b[aâ]tonnets?|gousses?|tranches?|bo[iî]tes?|sachets?|verres?|brins?|feuilles?)\s+/i, '')
    .replace(/^(de |d'|d’)/i, '').trim();
}
// Mots de préparation : « coupées en dés », « fondu », « facultatif »… ne sont pas des ingrédients.
const PREP_WORDS = new Set(['coupe','coupee','emince','eminee','emincee','hache','hachee','pele','pelee','epluche','epluchee','epepine','epepinee',
  'concasse','concassee','rape','rapee','ecrase','ecrasee','cisele','ciselee','fondu','fondue','mou','molle','ramolli','ramollie','froid','froide',
  'chaud','chaude','tiede','battu','battue','cuit','cuite','egoutte','egouttee','rince','rincee','facultatif','facultative','optionnel','environ',
  'selon','gout','des','morceau','rondelle','lamelle','fine','fin','finement','grossierement','gros','grosse','petit','petite','moyen','moyenne',
  'bien','mure','mur','frais','fraiche','entier','entiere','temperature','ambiante','servir','decorer','dorure','moule','graisser','choix','type',
  'plus','moins','peu','quelque','tasse','piece','pieces','portion','part','demi','moitie','zeste','jus']);
function isPrepPiece(piece){
  return stockTokens(piece, LINE_STOP).every(w => PREP_WORDS.has(w));
}
// Coupe une ligne « PÂTE : 500 g farine, 2 œufs, 1 c. sucre » en ingrédients séparés
// (virgules hors parenthèses ; une précision comme « coupées en dés » reste avec l'ingrédient).
function splitIngLine(line){
  let l = String(line).replace(/^\s*[-–•*]\s*/, '');
  // « PÂTE : … », « Pour la farce : … » → on retire l'intitulé ; « Farine : 30 g » reste tel quel.
  const head = l.match(/^([^:()\d]{1,40}):\s*(.*)$/);
  if (head){
    const label = head[1].trim(), rest = head[2].trim();
    if (!rest) return [];                       // titre de section (« Pour la sauce : »)
    if (label === label.toUpperCase() || /^pour\s/i.test(label) || /[,+;]/.test(rest)) l = rest;
    else l = label + ' ' + rest;
  }
  if (/^\s*pour (le|la|les|l'|l’)\b[^,]*$/i.test(l) && !/\d/.test(l)) return [];
  const parts = []; let cur = '', depth = 0;
  for (let i = 0; i < l.length; i++){
    const ch = l[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    // « 1,5 kg » : virgule décimale, on ne coupe pas.
    const decimal = ch === ',' && /\d/.test(l[i - 1] || '') && /\d/.test(l[i + 1] || '');
    if ((ch === ',' || ch === '+' || ch === ';') && !depth && !decimal){ parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  const out = [];
  for (const p0 of parts){
    const p = p0.trim();
    if (!p) continue;
    if (out.length && (isPrepPiece(p) || /^(ou|et)\s/i.test(p))) out[out.length - 1] += ', ' + p;
    else out.push(p);
  }
  return out;
}
const _recipeLineCache = new WeakMap();
function recipeLines(r){
  let v = _recipeLineCache.get(r);
  if (!v){
    v = (r.ing || []).filter(l => l && l.trim()).flatMap(splitIngLine)
      .filter(l => !isStapleLine(l))
      .map(l => ({ raw: l, toks: stockTokens(l, LINE_STOP) }))
      .filter(x => x.toks.length && !x.toks.every(w => PREP_WORDS.has(w)));
    _recipeLineCache.set(r, v);
  }
  return v;
}

let frigoSugFilter = 'all';

function stockHaveList(){
  return FTABS.flatMap(t => storageIngs[t].map(name => ({ name, tab: t })))
    .filter(p => stockProductAlts(p.name).length);
}
// Couverture d'une recette par les produits en stock (null si aucun ingrédient exploitable).
function recipeStockCoverage(r, have){
  const lines = recipeLines(r);
  if (!lines.length) return null;
  const used = new Map();
  let covered = 0;
  const missing = [];
  for (const ln of lines){
    const hit = have.find(p => lineHasProduct(ln.toks, p.name));
    if (hit){ covered++; used.set(hit.name, hit.tab); }
    else missing.push(cleanIngLine(ln.raw));
  }
  return { r, covered, total: lines.length, pct: covered / lines.length, used, matched: [...used.keys()], missing };
}

function matchFrigoRecipes(filter = frigoSugFilter, limit = 40){
  const have = stockHaveList();
  if (!have.length) return [];
  const out = [];
  for (const r of ALL){
    const c = recipeStockCoverage(r, have);
    if (!c || !c.covered) continue;
    // Filtre : la recette doit utiliser au moins un produit de ce stock.
    if (filter !== 'all' && ![...c.used.values()].includes(filter)) continue;
    const { used, ...rest } = c;
    out.push(rest);
  }
  return out.sort((a, b) => stockRank(a, b) || a.r.t.localeCompare(b.r.t)).slice(0, limit);
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

/* Accueil : un seul bandeau de propositions à partir des stocks (frigo, congélo,
   cellier). Classement : produits en stock utilisés, stocks mélangés, produits
   de saison, puis couverture des ingrédients. */
const HOME_SEASON_SKIP = new Set(['oignon','ail','echalote','citron','carotte']);
/* Accueil « Avec mes stocks » : menu progressif.
   - Rangée de mes produits : en toucher un ne garde que les recettes qui l'utilisent ;
     on peut en cumuler plusieurs pour affiner pas à pas.
   - Recettes rangées par paliers : tout en stock, puis il manque 1, 2, 3 ingrédients…
     (dans un palier : celles qui utilisent le plus de mes produits, puis de saison). */
let homeStockSel = [];
const HOME_BASICS = new Set(['huile','ail','oignon','echalote','beurre','farine','sucre','lait','oeuf','vinaigre','moutarde','levure','margarine','miel','cacao']);
let homeTiersShown = 2;
// Paliers repliés par l'utilisateur (mémorisés) : on touche le titre pour replier / déplier.
let homeTierClosed = new Set();
try { homeTierClosed = new Set(JSON.parse(localStorage.getItem('homeTierClosed') || '[]')); } catch(e){}
function saveHomeTierClosed(){ try { localStorage.setItem('homeTierClosed', JSON.stringify([...homeTierClosed])); } catch(e){} }
const HOME_TIER_MAX = 3;      // dernier palier : « il manque 3 ingrédients ou plus »
function homeStockCandidates(){
  const have = stockHaveList();
  if (!have.length) return [];
  const m = monthNow();
  const out = [];
  for (const r of ALL){
    if (/\b(guide|technique)\b/.test(norm(r.cat || ''))) continue;
    if (catList(r).some(c => c === 'Sauce' || c === 'Marinade')) continue;  // sauces et marinades : pas des recettes à proposer
    const c = recipeStockCoverage(r, have);
    if (!c || !c.covered) continue;
    const hits = seasonalHits(r, m).filter(h => !HOME_SEASON_SKIP.has(h));
    out.push({ ...c, hits, miss: c.total - c.covered });
  }
  return out;
}
function renderCellarHome(){
  const el = document.getElementById('cellar-home');
  if (!el) return;
  if (!getAllStorageIngs().length){
    el.innerHTML = `<button class="cellar-cta" id="cellar-cta">🧺 Ajoute ce que tu as au frigo, au congélo ou au cellier pour voir des recettes adaptées →</button>`;
    el.querySelector('#cellar-cta').addEventListener('click', ()=>{ openFrigo(); });
    return;
  }
  const tabOf = new Map();
  FTABS.forEach(t => storageIngs[t].forEach(n => { if (!tabOf.has(n)) tabOf.set(n, t); }));
  homeStockSel = homeStockSel.filter(n => tabOf.has(n));
  const all = homeStockCandidates();
  const pool = all.filter(x => homeStockSel.every(n => x.used.has(n)));
  if (!all.length){ el.innerHTML = ''; return; }

  // Produits proposés : ceux qui servent encore dans la sélection en cours ; les produits
  // « principaux » d'abord (viande, légumes, pâtes…), les basiques (huile, ail, œufs…) à la fin.
  const count = new Map();
  pool.forEach(x => x.used.forEach((_, n) => count.set(n, (count.get(n) || 0) + 1)));
  const basic = n => HOME_BASICS.has(stockKeys(n)[0]) ? 1 : 0;
  const chipNames = [...homeStockSel, ...[...count.keys()].filter(n => !homeStockSel.includes(n))
    .sort((a, b) => basic(a) - basic(b) || count.get(b) - count.get(a) || a.localeCompare(b))];
  const chips = chipNames.map(n => {
    const on = homeStockSel.includes(n);
    return `<button class="hs-chip${on ? ' on' : ''}" data-n="${esc(n)}">${FTAB_EMOJIS[tabOf.get(n)]} ${esc(n)}${on ? ' ✕' : ` <span>${count.get(n)}</span>`}</button>`;
  }).join('');

  const tiers = [];
  for (let k = 0; k <= HOME_TIER_MAX; k++){
    const list = pool.filter(x => k < HOME_TIER_MAX ? x.miss === k : x.miss >= k)
      .sort((a, b) => a.miss - b.miss || b.covered - a.covered || b.hits.length - a.hits.length || a.r.t.localeCompare(b.r.t));
    if (list.length) tiers.push({ k, list });
  }
  const tierLabel = k => k === 0 ? '✅ Tout est en stock'
    : k < HOME_TIER_MAX ? `Il manque ${k} ingrédient${k > 1 ? 's' : ''}` : `Il manque ${k} ingrédients ou plus`;
  const cardHtml = ({ r, matched, hits, covered, total, missing }) => {
    const img = r.img
      ? `<img src="${esc(r.img)}" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=feed-ph>🍲</div>'" loading="lazy">`
      : '<div class="feed-ph">🍲</div>';
    const stockTags = matched.slice(0,3).map(n=>`<span class="cellar-tag stock-${tabOf.get(n)}">${FTAB_EMOJIS[tabOf.get(n)]} ${esc(n)}</span>`).join('')
      + (matched.length>3 ? `<span class="cellar-tag">+${matched.length-3}</span>` : '');
    const seasonTags = hits.slice(0,1).map(h=>`<span class="cellar-tag season">🌿 ${esc(cap(h))}</span>`).join('');
    const miss = missing.length
      ? `<div class="stock-cover">Manque : ${esc(missing.slice(0,2).join(', '))}${missing.length>2?'…':''}</div>`
      : `<div class="stock-cover ok">✓ ${covered}/${total} en stock</div>`;
    return `<div class="feed-card cellar-card" data-id="${esc(String(r.id))}">${img}<div class="feed-info">
      <div class="feed-t">${esc(r.t)}</div>
      <div class="cellar-tags">${stockTags}${seasonTags}</div>
      ${miss}
    </div></div>`;
  };
  const shown = tiers.slice(0, homeTiersShown);
  const rest = tiers.slice(homeTiersShown);
  el.innerHTML =
    `<div class="feed-label">🧺 Avec mes stocks <span class="feed-count">${pool.length}</span>` +
    (homeStockSel.length ? `<button class="hs-clear" id="hs-clear">Tout effacer</button>` : '') + `</div>` +
    `<div class="hs-hint">${homeStockSel.length ? 'Recettes avec ' + homeStockSel.map(esc).join(' + ') + ' — touche un autre produit pour affiner' : 'Touche un produit pour ne voir que les recettes qui l\'utilisent'}</div>` +
    `<div class="hs-chips">${chips}</div>` +
    (shown.length ? shown.map(t => {
      const closed = homeTierClosed.has(t.k);
      return `<div class="hs-tier"><button class="hs-tier-label" data-k="${t.k}" aria-expanded="${!closed}">${tierLabel(t.k)} <span class="feed-count">${t.list.length}</span><span class="hs-chev">${closed ? '▾' : '▴'}</span></button>` +
        (closed ? '' : `<div class="feed-strip">${t.list.slice(0, 20).map(cardHtml).join('')}</div>`) + `</div>`;
    }).join('')
      : '<div class="hs-hint">Aucune recette avec tous ces produits.</div>') +
    ((rest.length || homeTiersShown > 2) ? `<div class="hs-more-row">` +
      (homeTiersShown > 2 ? `<button class="hs-more" id="hs-less">▴ Refermer</button>` : '') +
      (rest.length ? `<button class="hs-more" id="hs-more">▾ ${tierLabel(rest[0].k)} (${rest[0].list.length})</button>` : '') +
      `</div>` : '');
  el.querySelectorAll('.feed-card').forEach(c => c.addEventListener('click', () => openDetail(c.dataset.id)));
  el.querySelectorAll('.hs-chip').forEach(b => b.addEventListener('click', () => {
    const n = b.dataset.n;
    homeStockSel = homeStockSel.includes(n) ? homeStockSel.filter(x => x !== n) : [...homeStockSel, n];
    homeTiersShown = 2;
    renderCellarHome();
  }));
  const clr = el.querySelector('#hs-clear');
  if (clr) clr.addEventListener('click', () => { homeStockSel = []; homeTiersShown = 2; renderCellarHome(); });
  const more = el.querySelector('#hs-more');
  if (more) more.addEventListener('click', () => { homeTiersShown++; renderCellarHome(); });
  const less = el.querySelector('#hs-less');
  if (less) less.addEventListener('click', () => { homeTiersShown = 2; renderCellarHome(); });
  el.querySelectorAll('.hs-tier-label').forEach(b => b.addEventListener('click', () => {
    const k = +b.dataset.k;
    homeTierClosed.has(k) ? homeTierClosed.delete(k) : homeTierClosed.add(k);
    saveHomeTierClosed(); renderCellarHome();
  }));
}

/* ---------- inventaire ----------
   Revue de tous les produits en stock : présent ✓, quantité −/+, retirer.
   À la fin, les produits non vérifiés peuvent être retirés. */
let invDates = JSON.parse(localStorage.getItem('invDates') || '{}');
let inv = null; // { tab, checked:Set }
const INV_STEP = { g: 100, ml: 100, pc: 1 };

function openInventory(){
  inv = { tab: activeFTab || 'cellier', checked: new Set() };
  let el = document.getElementById('inventory');
  if (!el){ el = document.createElement('div'); el.id = 'inventory'; el.className = 'frigo inv'; document.body.appendChild(el); }
  el.hidden = false;
  renderInventory();
}
function closeInventory(){ const el = document.getElementById('inventory'); if (el) el.hidden = true; inv = null; FTABS.forEach(t => renderFrigoIngs(t)); renderFrigoSuggestions(); renderCellarHome(); if (stockSort) renderGrid(); }
function invTabs(){ return inv.tab === 'tous' ? FTABS : [inv.tab]; }
function invItems(){ return invTabs().flatMap(t => storageIngs[t].map(name => ({ tab: t, name }))); }
function invKey(it){ return it.tab + '|' + norm(it.name); }

function renderInventory(){
  const el = document.getElementById('inventory');
  if (!el || !inv) return;
  const items = invItems();
  const done = items.filter(it => inv.checked.has(invKey(it))).length;
  const last = invTabs().map(t => invDates[t]).filter(Boolean).sort().shift();
  const tabLabel = { tous: '🧺 Tout', frigo: '🧊 Frigo', congelateur: '❄️ Congélo', cellier: '🥫 Cellier' };
  el.innerHTML = `
    <div class="frigo-head">
      <button class="frigo-head-back" id="inv-back" aria-label="Retour">←</button>
      <div class="frigo-head-title">📋 Inventaire</div>
    </div>
    <div class="frigo-tabs">${['cellier','frigo','congelateur','tous'].map(t => `<button class="frigo-tab${t === inv.tab ? ' active' : ''}" data-it="${t}">${tabLabel[t]}</button>`).join('')}</div>
    <div class="frigo-scroll"><div class="frigo-body">
      <div class="inv-progress"><div class="inv-bar"><div style="width:${items.length ? Math.round(done / items.length * 100) : 0}%"></div></div>
        <span>${done}/${items.length} vérifié${done > 1 ? 's' : ''}${last ? ` · dernier inventaire le ${new Date(last).toLocaleDateString('fr-FR')}` : ''}</span></div>
      ${canLiveScan() ? '<button class="frigo-capture-btn" id="inv-scan">🔍 Scanner pour l\'inventaire</button>' : ''}
      <p class="stock-hint">Scanne chaque article présent (les quantités sont recomptées), ou touche ✓ pour chaque produit, ajuste avec − / +, ou retire-le.</p>
      <div class="inv-list">${items.length ? items.map((it, i) => {
        const q = getStockQty(it.name), img = getStockImg(it.name), ok = inv.checked.has(invKey(it));
        return `<div class="inv-row${ok ? ' ok' : ''}" data-i="${i}">
          <button class="inv-check" data-act="check" aria-label="Présent">${ok ? '✓' : ''}</button>
          <span class="inv-img">${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer">` : FTAB_EMOJIS[it.tab]}</span>
          <span class="inv-name">${inv.tab === 'tous' ? FTAB_EMOJIS[it.tab] + ' ' : ''}${esc(it.name)}${it.tab === 'congelateur' ? freezeBadge(it.name) : ''}</span>
          <span class="inv-qty">${q ? `<button data-act="minus">−</button><button class="inv-qv" data-act="edit">${fmtStockQty(q)}</button><button data-act="plus">+</button>` : `<button class="inv-qv empty" data-act="edit">+ qté</button>`}</span>
          <button class="inv-del" data-act="del" aria-label="Retirer">🗑</button>
        </div>`; }).join('') : '<p class="stock-hint">Aucun produit dans ce stock.</p>'}</div>
      <div class="inv-actions">
        <button class="frigo-scan-btn" id="inv-all">✓ Tout marquer présent</button>
        <button class="frigo-scan-btn" id="inv-share">📤 Copier / partager la liste</button>
        <button class="frigo-scan-btn" id="inv-csv">📊 Exporter en CSV (Excel)</button>
        <button class="scan-add-btn" id="inv-finish">Terminer l'inventaire</button>
      </div>
    </div></div>`;
  el.querySelector('#inv-back').addEventListener('click', closeInventory);
  el.querySelectorAll('[data-it]').forEach(b => b.addEventListener('click', () => { inv.tab = b.dataset.it; renderInventory(); }));
  el.querySelectorAll('.inv-row').forEach(row => {
    const it = items[+row.dataset.i];
    row.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => invAction(it, b.dataset.act)));
  });
  el.querySelector('#inv-scan')?.addEventListener('click', () => {
    scanTargetTab = inv.tab === 'tous' ? 'cellier' : inv.tab;
    const ov = document.getElementById('scan-overlay'); if (ov) ov.hidden = false;
    startLiveScan({ inventory: true });
  });
  el.querySelector('#inv-all').addEventListener('click', () => { items.forEach(it => inv.checked.add(invKey(it))); renderInventory(); });
  el.querySelector('#inv-share').addEventListener('click', () => shareInventory(items));
  el.querySelector('#inv-csv').addEventListener('click', () => exportInventoryCsv(items));
  el.querySelector('#inv-finish').addEventListener('click', () => finishInventory(items));
}

function invAction(it, act){
  const q = getStockQty(it.name);
  if (act === 'check'){ const k = invKey(it); inv.checked.has(k) ? inv.checked.delete(k) : inv.checked.add(k); }
  else if (act === 'plus' || act === 'minus'){
    const step = q.pk || INV_STEP[q.u] || 1, v = q.q + (act === 'plus' ? step : -step); // par boîte si contenance connue
    if (v <= 0){ if (!confirm(`« ${it.name} » épuisé : le retirer du stock ?`)) return; return invAction(it, 'del-ok'); }
    setStockQty(it.name, { q: v, u: q.u }); inv.checked.add(invKey(it));
  }
  else if (act === 'edit'){ editStockQty(it.name, it.tab); inv.checked.add(invKey(it)); }
  else if (act === 'del' || act === 'del-ok'){
    if (act === 'del' && !confirm(`Retirer « ${it.name} » du stock ?`)) return;
    storageIngs[it.tab] = storageIngs[it.tab].filter(n => norm(n) !== norm(it.name));
    saveStorageIngs(it.tab); setStockQty(it.name, null); inv.checked.delete(invKey(it));
  }
  renderInventory();
}

function inventoryText(items){
  const lines = [`Inventaire du ${new Date().toLocaleDateString('fr-FR')}`];
  for (const t of FTABS){
    const its = items.filter(it => it.tab === t);
    if (!its.length) continue;
    lines.push('', `${FTAB_EMOJIS[t]} ${t === 'frigo' ? 'Frigo' : t === 'congelateur' ? 'Congélateur' : 'Cellier'} (${its.length})`);
    its.forEach(it => { const q = getStockQty(it.name); lines.push(`- ${it.name}${q ? ' : ' + (q.pk ? fmtStockQty(q).replace('📦 ', '') : fmtQty(q).replace('× ', '') + (q.u === 'pc' ? ' pièce(s)' : '')) : ''}`); });
  }
  return lines.join('\n');
}
/* Export CSV (séparateur « ; », UTF-8 avec BOM : s'ouvre directement dans Excel). */
function inventoryCsv(items){
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const tabName = t => t === 'frigo' ? 'Frigo' : t === 'congelateur' ? 'Congélateur' : 'Cellier';
  const codeOf = name => Object.entries(barcodeBook).filter(([, v]) => norm(v.name) === norm(name)).map(([c]) => c).join(' ');
  const rows = [['Stock','Produit','Quantité','Unité','Boîtes','Contenance','Vérifié','Congelé le','À consommer avant','Code-barres']];
  for (const it of items){
    const qty = getStockQty(it.name);
    const unit = qty ? (qty.u === 'pc' ? 'pièce' : qty.u) : '';
    const ts = it.tab === 'congelateur' ? stockDates[norm(it.name)] : null;
    const limit = ts ? new Date(ts + freezeMonths(it.name) * 30 * 86400000).toLocaleDateString('fr-FR') : '';
    const dec = v => String(Math.round(v * 10) / 10).replace('.', ',');
    rows.push([tabName(it.tab), it.name, qty ? dec(qty.q) : '', unit, qty && qty.pk ? dec(qty.q / qty.pk) : '', qty && qty.pk ? fmtQty({ q: qty.pk, u: qty.u }) : '',
      inv && inv.checked.has(invKey(it)) ? 'oui' : 'non', ts ? new Date(ts).toLocaleDateString('fr-FR') : '', limit, codeOf(it.name)]);
  }
  return '\ufeff' + rows.map(r => r.map(q).join(';')).join('\r\n');
}
async function exportInventoryCsv(items){
  const csv = inventoryCsv(items);
  const name = `inventaire-${new Date().toISOString().slice(0, 10)}.csv`;
  const UP = window.Capacitor?.Plugins?.UpdatePlugin;
  if (UP?.shareFile){
    try { await UP.shareFile({ name, content: csv, mime: 'text/csv' }); return; }
    catch(e){ toast('Export : ' + (e.message || e)); return; }
  }
  // Navigateur : téléchargement classique
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Inventaire exporté 📊');
}

async function shareInventory(items){
  const text = inventoryText(items);
  try { if (navigator.share){ await navigator.share({ title: 'Inventaire', text }); return; } } catch(e){ if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('Liste copiée 📋'); }
  catch(e){ prompt('Copie la liste :', text); }
}

function finishInventory(items){
  const missing = items.filter(it => !inv.checked.has(invKey(it)));
  if (missing.length){
    const names = missing.slice(0, 8).map(it => '• ' + it.name).join('\n') + (missing.length > 8 ? `\n… et ${missing.length - 8} autres` : '');
    if (confirm(`${missing.length} produit${missing.length > 1 ? 's' : ''} non vérifié${missing.length > 1 ? 's' : ''} :\n${names}\n\nOK = les retirer du stock (absents)\nAnnuler = les garder`)){
      missing.forEach(it => {
        storageIngs[it.tab] = storageIngs[it.tab].filter(n => norm(n) !== norm(it.name));
        setStockQty(it.name, null);
      });
      FTABS.forEach(t => saveStorageIngs(t));
    }
  }
  invTabs().forEach(t => { invDates[t] = Date.now(); });
  try { localStorage.setItem('invDates', JSON.stringify(invDates)); } catch(e){}
  closeInventory();
  toast('Inventaire terminé ✓');
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
  if (tab === 'congelateur'){ stockDates[n] = Date.now(); saveStockDates(); }
  return true;
}

/* Contribution à Open Food Facts : création du produit (code, nom, quantité)
   puis envoi de la photo de face, avec le compte de l'utilisateur. */
const OFF_API = 'https://world.openfoodfacts.org';
function offCreds(){ try { return JSON.parse(localStorage.getItem('offCreds') || 'null'); } catch(e){ return null; } }
async function offContribute(code, name, qty, file){
  const c = offCreds();
  if (!c || !c.user || !c.pass) throw new Error('identifiants Open Food Facts manquants');
  const base = { code, user_id: c.user, password: c.pass, app_name: 'RecettesApp', app_version: APP_VERSION };
  const f = new FormData();
  Object.entries({ ...base, product_name_fr: name, product_name: name, lang: 'fr', countries: 'France',
    ...(qty && qty.u !== 'autre' ? { quantity: fmtQty(qty).replace('× ', '') + (qty.u === 'pc' ? ' pièces' : '') } : {}) })
    .forEach(([k, v]) => f.append(k, v));
  const r = await fetch(OFF_API + '/cgi/product_jqm2.pl', { method: 'POST', body: f });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.status !== 1) throw new Error(d.status_verbose || `erreur ${r.status}`);
  if (file){
    const g = new FormData();
    Object.entries({ ...base, imagefield: 'front_fr' }).forEach(([k, v]) => g.append(k, v));
    g.append('imgupload_front_fr', file, 'front.jpg');
    const ri = await fetch(OFF_API + '/cgi/product_image_upload.pl', { method: 'POST', body: g });
    const di = await ri.json().catch(() => ({}));
    if (!ri.ok || (di.status && di.status !== 'status ok')) return 'produit ajouté, photo refusée';
  }
  return 'ajouté sur Open Food Facts';
}

/* Ajoute un produit scanné : si une quantité est connue, elle s'ajoute à celle
   déjà en stock (2 boîtes de 400 g → 800 g). Renvoie un libellé de résumé. */
function addScannedProduct(name, tab, img, qty){
  const isNew = addStockItem(name, tab, img);
  if (!qty || qty.u === 'autre') return isNew ? '' : 'déjà en stock';
  const cur = getStockQty(name);
  const one = qty.u !== 'pc' ? { ...qty, pk: qty.pk || qty.q } : qty;
  const total = cur && cur.u === qty.u && !isNew ? { q: cur.q + qty.q, u: qty.u, pk: one.pk } : one;
  setStockQty(name, total);
  return isNew ? fmtStockQty(total) : `+${fmtQty(qty)} → ${fmtStockQty(total)}`;
}

/* Produit déjà en stock : propose d'ajouter des boîtes (contenance connue), des
   pièces, ou demande la contenance. onDone(total | null) appelé à la fermeture. */
function stockTabOf(name){ const n = norm(name); return FTABS.find(t => storageIngs[t].some(x => norm(x) === n)) || null; }
function askAddBoxes(name, tab, onDone){
  const cur = getStockQty(name);
  const unit = cur && (cur.pk ? { q: cur.pk, u: cur.u } : cur.u === 'pc' ? { q: 1, u: 'pc' } : null);
  // Contenances proposées : celle déjà connue d'abord, puis les formats courants.
  const base = cur?.u === 'ml' ? [250, 330, 500, 750, 1000] : [125, 200, 250, 400, 500, 1000];
  const sizes = [...new Set([...(cur?.pk ? [cur.pk] : []), ...base])].slice(0, 6)
    .map(q => fmtQty({ q, u: cur?.u === 'ml' ? 'ml' : 'g' }));
  let n = 1;
  const ov = document.createElement('div');
  ov.className = 'addbox-ov';
  ov.innerHTML = `<div class="addbox-card" role="dialog" aria-modal="true">
    <div class="addbox-title">${FTAB_EMOJIS[tab] || '📦'} « ${esc(name)} » est déjà en stock</div>
    <div class="addbox-cur">${cur ? 'En stock : <b>' + esc(fmtStockQty(cur)) + '</b>' : 'Quantité non renseignée'}</div>
    <div class="addbox-q">Ajouter des boîtes ?</div>
    <div class="addbox-step">
      <button class="sq-btn" data-d="-1" aria-label="Moins">−</button><b id="ab-n">1</b><button class="sq-btn" data-d="1" aria-label="Plus">+</button>
      <span>boîte(s) de</span><input id="ab-pk" class="frigo-manual-input" type="text" inputmode="decimal" placeholder="400 g" value="${unit && unit.u !== 'pc' ? esc(fmtQty(unit)) : ''}">
    </div>
    <div class="addbox-lbl">Nombre</div>
    <div class="addbox-chips">${[2, 3, 6, 12].map(v => `<button data-n="${v}">${v}</button>`).join('')}</div>
    <div class="addbox-lbl">Contenance d'une boîte</div>
    <div class="addbox-chips addbox-sizes">${sizes.map(v => `<button data-pk="${esc(v)}">${esc(v)}</button>`).join('')}${!cur || cur.u === 'pc' ? '<button data-pk="">pièces</button>' : ''}</div>
    <div class="addbox-res" id="ab-res"></div>
    <div class="unk-actions"><button class="unk-skip" id="ab-no">Non merci</button><button class="scan-add-btn" id="ab-ok">Ajouter</button></div>
  </div>`;
  document.body.appendChild(ov);
  const pkEl = ov.querySelector('#ab-pk');
  // Contenance saisie ; vide = pièces si le stock n'est pas compté en poids / volume.
  const curUnit = ()=>{
    const v = pkEl.value.trim();
    if (!v) return !cur || cur.u === 'pc' ? { q: 1, u: 'pc' } : null;
    const q = parseQty(v);
    return q && q.u !== 'autre' ? q : null;
  };
  // Même unité : on additionne ; contenance différente de celle en stock → total seul
  // (pas de nombre de boîtes trompeur) ; autre unité → la nouvelle quantité remplace.
  const compute = ()=>{
    const u = curUnit(); if (!u) return null;
    const add = n * u.q;
    if (u.u === 'pc') return { q: (cur?.u === 'pc' ? cur.q : 0) + add, u: 'pc' };
    if (cur && cur.u === u.u) return { q: cur.q + add, u: u.u, pk: cur.pk && cur.pk !== u.q ? 0 : u.q };
    return { q: add, u: u.u, pk: u.q };
  };
  const refresh = ()=>{
    ov.querySelector('#ab-n').textContent = n;
    const u = curUnit(), t = compute();
    ov.querySelectorAll('[data-pk]').forEach(b => b.classList.toggle('on', u && (b.dataset.pk ? norm(b.dataset.pk) === norm(pkEl.value.trim()) : !pkEl.value.trim())));
    const note = !t ? '' : cur && cur.u !== t.u ? ` (remplace ${fmtStockQty(cur, true)})`
      : cur?.pk && t.u === cur.u && !t.pk ? ' — contenances mélangées' : u.u === 'pc' ? ' pièce(s)' : '';
    ov.querySelector('#ab-res').textContent = t ? '→ ' + fmtStockQty(t) + note : 'Indique la contenance d\'une boîte (ex. 400 g)';
    ov.querySelector('#ab-ok').disabled = !t;
  };
  const close = total => { ov.remove(); document.removeEventListener('keydown', onKey); onDone?.(total); };
  const onKey = e => { if (e.key === 'Escape'){ e.stopPropagation(); close(null); } };
  document.addEventListener('keydown', onKey);
  ov.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', ()=>{ n = Math.max(1, n + +b.dataset.d); refresh(); }));
  ov.querySelectorAll('[data-n]').forEach(b => b.addEventListener('click', ()=>{ n = +b.dataset.n; refresh(); }));
  ov.querySelectorAll('[data-pk]').forEach(b => b.addEventListener('click', ()=>{ pkEl.value = b.dataset.pk; refresh(); }));
  pkEl.addEventListener('input', refresh);
  ov.querySelector('#ab-no').addEventListener('click', ()=> close(null));
  ov.addEventListener('click', e => { if (e.target === ov) close(null); });
  ov.querySelector('#ab-ok').addEventListener('click', ()=>{
    const t = compute(); if (!t) return;
    setStockQty(name, t, false);
    renderFrigoIngs(tab); renderFrigoSuggestions();
    toast(`${name} : ${fmtStockQty(t, true)}`);
    close(t);
  });
  refresh();
  if (!unit) setTimeout(()=> pkEl.focus(), 50);
}

/* Inventaire par scan : chaque article scanné est compté ; la quantité en
   stock devient « nombre scanné × contenance » (ou un nombre de pièces). */
function inventoryCount(session, name, tab, img, packQty){
  const n = norm(name);
  const existing = FTABS.find(t => storageIngs[t].some(x => norm(x) === n));
  const t = existing || tab;
  if (!existing) addStockItem(name, t, img);
  else if (img && !getStockImg(name)) setStockImg(name, img);
  const c = (session.counts.get(n) || 0) + 1;
  session.counts.set(n, c);
  const unit = packQty && packQty.u !== 'autre' ? packQty : null;
  const total = unit ? { q: unit.q * c, u: unit.u, ...(unit.u !== 'pc' ? { pk: unit.q } : {}) } : { q: c, u: 'pc' };
  setStockQty(name, total);
  if (inv) inv.checked.add(t + '|' + n);
  return { tab: t, detail: `✓ ${unit ? `${c} × ${fmtQty(unit)} = ${fmtQty(total)}` : `× ${c}`}${existing ? '' : ' · ajouté'}` };
}

async function startLiveScan(opts = {}){
  const invMode = !!opts.inventory;
  const body = document.getElementById('scan-body');
  const titleEl = document.getElementById('scan-title');
  if (!body) return;
  stopLiveScan();
  if (titleEl) titleEl.textContent = invMode ? '📋 Inventaire par scan' : 'Scan en continu';
  body.innerHTML = `
    <div class="scan-live"><video id="scan-video" playsinline muted autoplay></video><div class="scan-live-frame"></div></div>
    <p class="scan-info" id="scan-live-msg">${invMode ? 'Scanne chaque article présent, un par un : les quantités sont recomptées.' : 'Vise les codes-barres un par un. Un même produit scanné deux fois s\'ajoute deux fois.'}</p>
    <div id="scan-unknown" hidden></div>
    <button class="frigo-scan-btn" id="scan-nocode">➕ Produit sans code-barres (bocal, vrac…)</button>
    <div class="scan-tab-sel">
      ${FTABS.map(t=>`<button class="scan-tab-btn${t===scanTargetTab?' active':''}" data-stab="${t}">${FTAB_EMOJIS[t]} ${t==='frigo'?'Frigo':t==='congelateur'?'Congélo':'Cellier'}</button>`).join('')}
    </div>
    ${invMode ? '<p class="stock-hint">Les produits nouveaux sont rangés dans le stock sélectionné ci-dessus.</p>' : ''}
    <div class="scan-count" id="scan-count"></div>
    <div id="scan-live-list" class="scan-list"></div>
    <button class="scan-add-btn" id="scan-live-done">✓ Terminer</button>`;
  body.querySelectorAll('.scan-tab-btn').forEach(b => b.addEventListener('click', ()=>{
    scanTargetTab = b.dataset.stab;
    body.querySelectorAll('.scan-tab-btn').forEach(x => x.classList.toggle('active', x === b));
  }));
  body.querySelector('#scan-live-done').addEventListener('click', ()=>{
    const tab = scanTargetTab;
    closeScanOverlay();
    if (invMode){ renderInventory(); return; }
    frigoSugFilter = tab;
    switchFrigoTab(tab);
    renderFrigoSuggestions();
  });
  const msg = body.querySelector('#scan-live-msg');
  const list = body.querySelector('#scan-live-list');
  const video = body.querySelector('#scan-video');
  const unk = body.querySelector('#scan-unknown');
  const countEl = body.querySelector('#scan-count');
  const session = { stream: null, timer: 0, busy: false, paused: false, last: new Map(), n: 0, counts: new Map() };
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

  function addRow(tab, name, img, detail){
    session.n++;
    countEl.textContent = `${session.n} produit${session.n > 1 ? 's' : ''} scanné${session.n > 1 ? 's' : ''}`;
    const row = document.createElement('div');
    row.className = 'scan-row';
    row.innerHTML = `<span class="scan-row-img">${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer">` : FTAB_EMOJIS[tab]}</span>
      <span class="scan-row-txt"><b>${esc(name)}</b>${detail ? `<span>${esc(detail)}</span>` : ''}</span>`;
    list.prepend(row);
    renderFrigoIngs(tab);
    renderFrigoSuggestions();
  }

  // Produit inconnu : pause, fiche nom + photo + quantité, mémorisée pour les prochains scans.
  // code = null : produit sans code-barres (bocal maison, vrac…), saisi à la main sans quitter le scan.
  function askUnknown(code, tab){
    session.paused = true;
    let photo = '', photoFile = null;
    unk.hidden = false;
    const known = [...new Set(FTABS.flatMap(t => storageIngs[t]))];
    unk.innerHTML = `<div class="unk-card${code ? '' : ' nocode'}">
      <div class="unk-title">${code ? `❓ Produit inconnu <span class="unk-code">${esc(code)}</span>` : '➕ Produit sans code-barres'}</div>
      <input id="unk-name" class="frigo-manual-input" type="text" list="unk-known" placeholder="Nom (ex : ${code ? 'lentilles vertes' : 'confiture de figues maison'})" autocapitalize="sentences">
      <datalist id="unk-known">${known.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      <div class="unk-row">
        <label class="unk-photo" for="unk-file"><span id="unk-prev">📷</span><span>Photo du produit</span></label>
        <input id="unk-file" class="frigo-file-hidden" type="file" accept="image/*" capture="environment">
        <input id="unk-qty" class="frigo-manual-input unk-qty" type="text" placeholder="${code ? 'Contenance : 400 g, 1 l, 6' : 'Qté : 3 boîtes de 400 g, 1 kg, 6'}">
      </div>
      ${code ? `<label class="unk-off"><input type="checkbox" id="unk-off" ${offCreds() ? 'checked' : ''}> 🌍 Ajouter aussi sur Open Food Facts${offCreds() ? '' : ' <span>(identifiants à saisir dans ⚙️)</span>'}</label>` : ''}
      <div class="unk-actions"><button class="unk-skip" id="unk-skip">Passer</button><button class="scan-add-btn" id="unk-save">Enregistrer</button></div>
    </div>`;
    const nameEl = unk.querySelector('#unk-name');
    setTimeout(()=> nameEl.focus(), 50);
    if (!code){ // produit déjà en stock : rappel de la quantité et ajout rapide de boîtes
      const hint = document.createElement('div');
      hint.className = 'unk-hint'; hint.hidden = true;
      nameEl.after(hint);
      nameEl.addEventListener('input', ()=>{
        const name = nameEl.value.trim();
        const cur = name && stockTabOf(name) ? getStockQty(name) : null;
        hint.hidden = !(name && stockTabOf(name));
        if (hint.hidden) return;
        const one = cur && (cur.pk ? `boîte de ${fmtQty({ q: cur.pk, u: cur.u })}` : cur.u === 'pc' ? '' : null);
        hint.innerHTML = `Déjà en stock${cur ? ' : <b>' + esc(fmtStockQty(cur)) + '</b>' : ''}${invMode ? ' — indique le total compté' : ' — ajouter :'}`
          + (!invMode && one != null ? [1, 2, 3, 6].map(v => ` <button type="button" data-n="${v}">+${v}</button>`).join('') : '');
        hint.querySelectorAll('[data-n]').forEach(b => b.addEventListener('click', ()=>{
          const v = +b.dataset.n;
          unk.querySelector('#unk-qty').value = one ? `${v} ${one.replace('boîte', v > 1 ? 'boîtes' : 'boîte')}` : String(v);
        }));
      });
    }
    unk.querySelector('#unk-file').addEventListener('change', async (e)=>{
      const f = e.target.files?.[0]; if (!f) return;
      photoFile = f;
      try { photo = await imageThumb(f, 240); unk.querySelector('#unk-prev').innerHTML = `<img src="${photo}" alt="">`; }
      catch(_){ toast('Photo illisible'); }
    });
    const ncBtn = body.querySelector('#scan-nocode'); if (ncBtn) ncBtn.hidden = true;
    const resume = ()=>{ unk.hidden = true; unk.innerHTML = ''; session.paused = false; if (ncBtn) ncBtn.hidden = false; msg.textContent = 'Vise le code-barres suivant…'; };
    if (!code) unk.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    unk.querySelector('#unk-skip').addEventListener('click', resume);
    const save = ()=>{
      const name = nameEl.value.trim();
      if (!name){ nameEl.focus(); return; }
      const qv = unk.querySelector('#unk-qty').value.trim();
      if (!code){ // sans code-barres : la quantité saisie est le total (« 3 boîtes de 400 g »)
        const q = qv ? parseQtyInput(qv) : null;
        if (qv && (!q || q.u === 'autre')){ toast('Quantité non reconnue'); return; }
        const n = norm(name);
        const existing = FTABS.find(t => storageIngs[t].some(x => norm(x) === n));
        const t = existing || tab;
        if (!existing) addStockItem(name, t, photo);
        if (photo) setStockImg(name, photo);
        const cur = getStockQty(name);
        let total = q;
        if (q && cur && cur.u === q.u && existing && !invMode) total = { q: cur.q + q.q, u: q.u, pk: q.pk || cur.pk }; // ajout
        if (total) setStockQty(name, total, false);
        if (invMode && inv) inv.checked.add(t + '|' + n);
        addRow(t, name, photo || getStockImg(name), `${invMode ? '✓ ' : ''}${total ? fmtStockQty(total) : ''}${existing ? '' : ' · ajouté'}`);
        resume();
        return;
      }
      const qty = qv ? parseQty(qv) : null;
      rememberBarcode(code, name, photo, qty && qty.u !== 'autre' ? qty : null);
      if (photo) setStockImg(name, photo);
      let detail, rowTab = tab;
      if (invMode){ const r = inventoryCount(session, name, tab, photo, qty); detail = r.detail; rowTab = r.tab; }
      else detail = addScannedProduct(name, tab, photo, qty);
      addRow(rowTab, name, photo, detail);
      if (unk.querySelector('#unk-off')?.checked){
        if (!offCreds()) toast('Renseigne ton compte Open Food Facts dans ⚙️ pour contribuer');
        else {
          const row = list.firstElementChild?.querySelector('.scan-row-txt');
          const note = document.createElement('span'); note.textContent = '🌍 envoi à Open Food Facts…'; row?.appendChild(note);
          offContribute(code, name, qty, photoFile)
            .then(m => { note.textContent = '🌍 ' + m; })
            .catch(e => { note.textContent = '🌍 échec : ' + e.message; note.style.color = '#f0a090'; });
        }
      }
      resume();
    };
    unk.querySelector('#unk-save').addEventListener('click', save);
    nameEl.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); save(); } });
  }

  // Déjà en stock sans contenance connue : pause, proposition d'ajouter des boîtes.
  function askBoxesInScan(name, tab, code){
    session.paused = true;
    const span = list.firstElementChild?.querySelector('.scan-row-txt span');
    askAddBoxes(name, tab, total => {
      if (total && span) span.textContent = fmtStockQty(total);
      session.paused = false;
      session.last.set(code, Date.now()); // laisser le temps d'écarter le produit
      msg.textContent = 'Vise le code-barres suivant…';
    });
  }

  body.querySelector('#scan-nocode').addEventListener('click', ()=>{ if (!session.paused) askUnknown(null, scanTargetTab); });

  session.timer = setInterval(async ()=>{
    if (session.busy || session.paused || liveScan !== session || video.readyState < 2) return;
    session.busy = true;
    try {
      const codes = await det.detect(video);
      const now = Date.now();
      // Même code ignoré 3 s (le temps d'écarter le produit), puis de nouveau compté.
      const code = codes.map(c => c.rawValue).find(v => v && now - (session.last.get(v) || 0) > 3000);
      if (!code) return;
      session.last.set(code, now);
      navigator.vibrate?.(60);
      const tab = scanTargetTab;
      msg.textContent = `Code ${code} — recherche…`;
      const prod = await lookupBarcode(code);
      if (liveScan !== session) return;
      if (prod?.name){
        if (invMode){ const r = inventoryCount(session, prod.name, tab, prod.img, prod.qty); addRow(r.tab, prod.name, prod.img || getStockImg(prod.name), r.detail); }
        else {
          const had = stockTabOf(prod.name);
          const t = had || tab;
          const detail = addScannedProduct(prod.name, t, prod.img, prod.qty);
          addRow(t, prod.name, prod.img || getStockImg(prod.name), detail);
          if (had && detail === 'déjà en stock') askBoxesInScan(prod.name, t, code);
        }
        msg.textContent = `✓ ${prod.name}`;
      } else {
        navigator.vibrate?.([60, 80, 60]);
        msg.textContent = 'Produit inconnu : donne-lui un nom et une photo, il sera reconnu la prochaine fois.';
        askUnknown(code, tab);
      }
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
function rememberBarcode(code, name, img, qty){
  if (!code || !name) return;
  barcodeBook[code] = { name, img: img || barcodeBook[code]?.img || '', qty: qty || barcodeBook[code]?.qty || null };
  try { localStorage.setItem('barcodeBook', JSON.stringify(barcodeBook)); } catch(e){}
}

async function lookupBarcode(code){
  if (barcodeBook[code]) return { ...barcodeBook[code], known: true };
  try {
    const r = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}?fields=product_name_fr,product_name,generic_name_fr,generic_name,image_front_small_url,image_small_url,quantity,product_quantity,product_quantity_unit`,
      { headers: { 'User-Agent': 'RecettesApp/2.98 (github.com/laurentsar/recettes)' } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    if (d.status !== 1) return null;
    const p = d.product || {};
    const name = (p.product_name_fr || p.product_name || p.generic_name_fr || p.generic_name || '').trim();
    if (!name) return null;
    const img = p.image_front_small_url || p.image_small_url || '';
    // Quantité de l'emballage (« 500 g », « 4 x 125 g »…) → g / ml / pièces
    let qty = null;
    const pq = parseFloat(p.product_quantity), pu = String(p.product_quantity_unit || '').toLowerCase();
    if (pq > 0 && QTY_UNITS[pu]) qty = { q: pq * QTY_UNITS[pu][1], u: QTY_UNITS[pu][0] };
    else if (p.quantity){
      const m = String(p.quantity).match(/(\d+)\s*x\s*(\d+(?:[.,]\d+)?\s*[a-z]+)/i);
      const one = parseQty(m ? m[2] : p.quantity);
      if (one && one.u !== 'autre') qty = { q: one.q * (m ? +m[1] : 1), u: one.u };
    }
    rememberBarcode(code, name, img, qty);
    return { name, img, qty };
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
  const existing = stockTabOf(name);
  if (existing){ // déjà en stock : on propose d'en ajouter plutôt que de dupliquer
    if (img) setStockImg(name, img);
    switchFrigoTab(existing);
    closeScanOverlay();
    askAddBoxes(name, existing);
    return;
  }
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
      if (!storageIngs[tab].some(x=> norm(x)===n)){ storageIngs[tab].push(ing); if (tab === 'congelateur') stockDates[n] = Date.now(); }
    }
    saveStorageIngs(tab);
    saveStockDates();
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
      <div class="batch-ing-title">${esc(r.t)}${r.min?` <span style="font-weight:400;font-size:.85em;color:var(--muted)">⏱️ ${r.min} min</span>`:''}${r.serv?` <span style="font-weight:400;font-size:.85em;color:var(--muted)">· 🍽️ ${esc(servTxt(r.serv))}</span>`:''}</div>
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
    const steps = stepTexts(r.steps);
    return `<div class="batch-cook-card">
      <div class="batch-cook-card-title">
        <span class="batch-cook-order">${i+1}</span>
        <span>${esc(r.t)}</span>
      </div>
      ${(r.min||r.serv)?`<div class="batch-cook-meta">${r.min?'⏱️ '+fmtMin(totalMinutes(r)):''}${r.serv?' · 🍽️ '+servTxt(r.serv):''}</div>`:''}
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
  fixLocalSeafoodCats();
  fixLocalCourseCats();
  ALL = mergeEdits();
  buildIngredientIndex();
  elSub.textContent = `${ALL.length} recettes · v${APP_VERSION}`;
  buildCats();
  renderDaily();
  renderCellarHome();
  renderGrid();
  setTimeout(()=>{ if (navigator.onLine !== false) prefetchOfficialSteps(); }, 4000);
  // Index de la recherche express préparé en tâche de fond : ouverture instantanée.
  (window.requestIdleCallback || (f => setTimeout(f, 1500)))(() => { try { qkIndex(); } catch(e){} });
  window.addEventListener('online', ()=> prefetchOfficialSteps());
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
  document.getElementById('wizard-btn').addEventListener('click', ()=>{ document.getElementById('more-menu').hidden=true; openQuick(); });
  document.getElementById('ing-menu-btn').addEventListener('click', ()=>{ document.getElementById('more-menu').hidden=true; openIngPick(); });
  document.getElementById('search-menu-btn').addEventListener('click', ()=>{ document.getElementById('more-menu').hidden=true; if (appMode !== 'recipes') switchMode('recipes'); openSearch(); });
  document.getElementById('cat-menu-btn').addEventListener('click', (e)=>{ e.stopPropagation(); document.getElementById('more-menu').hidden=true; if (appMode !== 'recipes') switchMode('recipes');
    const panel = document.getElementById('cat-panel'); if (panel){ panel.hidden = false; fillCatPanel(panel); panel.scrollIntoView({block:'nearest'}); } });
  document.getElementById('stock-menu-btn').addEventListener('click', ()=>{ document.getElementById('more-menu').hidden=true; toggleStockSort(); });
  document.getElementById('wizard-close-btn').addEventListener('click', closeWizard);
  document.getElementById('wz-prev').addEventListener('click', wizardPrev);
  document.getElementById('wz-next').addEventListener('click', wizardNext);
  document.getElementById('frigo-btn').addEventListener('click', openFrigo);
  document.getElementById('frigo-back').addEventListener('click', closeFrigo);
  document.getElementById('inv-open').addEventListener('click', openInventory);
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
  const offUser = document.getElementById('off-user'), offPass = document.getElementById('off-pass');
  if (offUser && offCreds()) offUser.value = offCreds().user;
  document.getElementById('off-save')?.addEventListener('click', ()=>{
    const user = offUser.value.trim(), pass = offPass.value;
    if (user && pass){ localStorage.setItem('offCreds', JSON.stringify({ user, pass })); offPass.value = ''; toast('Compte Open Food Facts enregistré ✓'); }
    else if (!user){ localStorage.removeItem('offCreds'); toast('Compte Open Food Facts retiré'); }
    else toast('Saisis aussi le mot de passe');
  });
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
      // « , » suivi d'un espace sépare deux produits (« 1,5 kg » reste un nombre)
      const items = raw.split(/;|,\s+/).map(s=>s.trim()).filter(Boolean);
      const again = []; // déjà en stock sans quantité saisie → proposer d'ajouter des boîtes
      for (const item of items){
        const { name, qty } = splitNameQty(item);
        const other = stockTabOf(name);
        if (other && other !== tab && !qty){ again.push([name, other]); continue; }
        const isNew = addStockItem(name, tab);
        if (!isNew && !qty){ again.push([name, tab]); continue; }
        if (!qty || qty.u === 'autre') continue;
        const cur = getStockQty(name);
        if (!isNew && cur && cur.u === qty.u){ // produit déjà en stock : on ajoute (ex. 2 boîtes de plus)
          const total = { q: cur.q + qty.q, u: qty.u, pk: qty.pk || cur.pk };
          setStockQty(name, total, false);
          toast(`${name} : +${qty.pk ? fmtStockQty(qty, true).replace('📦 ', '') : fmtQty(qty)} → ${fmtStockQty(total, true)}`);
        } else setStockQty(name, qty, false);
      }
      manualInput.value = '';
      renderFrigoIngs(tab);
      renderFrigoSuggestions();
      const next = ()=>{ const a = again.shift(); if (a) askAddBoxes(a[0], a[1], next); };
      next();
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
  if (appMode === 'recipes') elSearch.hidden = !(searchOpen || elSearch.value);
  elSearch.addEventListener('blur', ()=>{ if (appMode === 'recipes' && !elSearch.value){ searchOpen = false; elSearch.hidden = true; } });
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

/* ---------- recherche express : 5 questions max, un toucher par réponse ---------- */
// Chaque réponse filtre la liste ; le nombre de recettes restantes s'affiche sur chaque choix.
// Dès qu'il reste 10 recettes ou moins, les résultats s'affichent.
const QK_RX = (words) => new RegExp('(^|[^a-z])(' + words + ')s?([^a-z]|$)');
const QK = {
  viande: QK_RX('boeuf|porc|veau|agneau|jambon|lardon|saucisse|chorizo|viande|steak|merguez|bacon|cote|roti|jarret|kefta|boulette|boudin|lapin|pigeon|lievre|gibier|sanglier|chevreuil|andouillette|pancetta|guanciale|bresaola|coppa|salami|figatell|lonzu|haggis|carbonara|cordon bleu|hachis|chicken|beef|pork|vitello|carbonade|bourguignon|blanquette|pot-au-feu|osso|daube|cassoulet|choucroute'),
  volaille: QK_RX('poulet|dinde|canard|volaille|pintade|magret|caille|chapon'),
  poisson: QK_RX('poisson|saumon|thon|cabillaud|colin|truite|sardine|maquereau|crevette|gambas|moule|saint-jacques|calamar|encornet|merlu|dorade|bar|lotte|crabe|surimi|anchois|morue|bacalao|bacalhau|homard|langouste|langoustine|sole|limande|anguille|palourde|ameijoa|clam|poulpe|seiche|coryphene|loup|rouget|daurade|hareng|lieu noir|perche|brochet|sandre|turbot|raie|huitre|saumonette|fruits de mer|fish'),
  oeuf: QK_RX('oeuf|omelette|fromage|chevre|feta|mozzarella|raclette|reblochon|camembert|brocciu|ricotta|comte|parmesan|tartiflette|fondue|cheddar|welsh|flan|quiche'),
  feculent: QK_RX('pate|spaghetti|tagliatelle|penne|lasagne|gnocchi|riz|risotto|nouille|couscous|semoule|quinoa|polenta|pommes? de terre|patate|frite|puree|lentille|pois chiche|pasta|pizza|calzone|pain|okonomiyaki|crozet|croziflette|tartiflette|aligot'),
  chocolat: QK_RX('chocolat|cacao|nutella|praline|brownie'),
  fruit: QK_RX('pomme|poire|banane|fraise|framboise|peche|abricot|citron|orange|mangue|ananas|cerise|myrtille|kiwi|coco|figue|prune|rhubarbe|fruit'),
  creme: QK_RX('creme|flan|mousse|panna cotta|tiramisu|cheesecake|riz au lait|charlotte|oeufs au lait|yaourt|crema|pudim|toucinho|gelato|glace|sorbet|souffle|ile flottante|creme brulee|creme catalane|semifreddo|parfait|verrine'),
  pate: QK_RX('gateau|tarte|biscuit|cookie|brioche|crepe|gaufre|cake|genoise|buche|madeleine|beignet|muffin|cannele|viennoiserie|chou|chouquette|bugne|churros|donut|galette|pain perdu|pastel|pasteis|sable|canistrelli|fritelli|polvoron|torrija|ensaimada|rabanada|queijada|bolo|cannoli|torta|meringue|migliacci|imbrucciata|fiadone|financier|macaron|tuile|palmier|croissant|pain au chocolat|kouign|far|clafoutis|crumble|fondant|moelleux|cheesecake|tiramisu|strudel|baklava|corne de gazelle'),
  four: QK_RX('four|enfourner|gratiner|prechauffe[rz]?|th[0-9]'),
  feu: QK_RX('poele|casserole|sauteuse|wok|cocotte|faitout|mijoter|frire|friture|revenir|saisir|plancha|suer|rissoler|braiser|pocher|blanchir|bouillir|ebullition|griller|gril|barbecue|bbq|gaufrier|crepiere|feu doux|feu moyen|feu vif'),
  cuisson: QK_RX('cuire|cuisson|four|enfourner|poele|casserole|cocotte|frire|griller|rotir|mijoter|bouillir|dorer|airfryer|air fryer|micro-ondes'),
  leger: QK_RX('leger|legere|light|minceur|salade|vapeur|healthy|detox|ww|sans matiere grasse|veloute|gaspacho'),
  reconfort: QK_RX('gratin|raclette|tartiflette|fondue|mijote|ragout|bourguignon|blanquette|lasagne|puree|parmentier|soupe|pot-au-feu|cassoulet|choucroute|daube|chili|curry|risotto|crumble|fondant|brioche|croziflette|aligot'),
  recevoir: QK_RX('noel|fete|buche|foie gras|saint-jacques|homard|langouste|caviar|wellington|chapon|magret|truffe|champagne|paella|couscous royal|osso|carpaccio|tartare|verrine|feuillete|mignardise'),
};
function qkHay(r){
  if (!r._qk){
    const ing = (r.ing||[]).join(' ');
    const steps = Array.isArray(r.steps) ? r.steps.join(' ') : (r.steps||'');
    r._qk = { title: norm(r.t||''), main: norm((r.t||'') + ' ' + (r.ing||[]).slice(0,4).join(' ')), all: norm((r.t||'') + ' ' + ing), steps: norm(steps), cat: catList(r) };
  }
  return r._qk;
}
const qkCat = (r, ...cs) => qkHay(r).cat.some(c => cs.includes(c));
// Desserts et boissons : jamais dans les familles salées (« riz au lait » n'est pas un féculent de plat).
const qkSweet = r => qkCat(r,'Dessert','Gâteaux','Viennoiserie','Biscuit','Flan','Crème dessert','Tarte sucrée','Boissons','Smoothie','Milkshake','Cocktail','Cocktail sans alcool');
const QK_SALTY = [
  { v:'viande', label:'🥩 Viande', f: r => !qkSweet(r) && QK.viande.test(qkHay(r).main) },
  { v:'volaille', label:'🍗 Volaille', f: r => !qkSweet(r) && QK.volaille.test(qkHay(r).main) },
  { v:'poisson', label:'🐟 Poisson', f: r => !qkSweet(r) && QK.poisson.test(qkHay(r).main) },
  { v:'oeuf', label:'🥚 Œufs', f: r => !qkSweet(r) && QK.oeuf.test(qkHay(r).title) },
  { v:'legume', label:'🥦 Légumes', f: r => !qkSweet(r) && checkDiet(r,'vegetarien') && !QK.oeuf.test(qkHay(r).title) && !QK.feculent.test(qkHay(r).title) },
  { v:'feculent', label:'🍝 Féculents', f: r => !qkSweet(r) && QK.feculent.test(qkHay(r).title) },
];
// « Autre » : le reste (sauces, soupes à l'oignon…), pour qu'aucune recette salée ne soit hors d'atteinte.
const qkSalty = () => [...QK_SALTY, { v:'autre', label:'🧂 Autre', f: r => !qkSweet(r) && !QK_SALTY.some(o => o.f(r)) }];
const QK_TYPES = [
  { v:'apero', label:'🥂 Apéro', f: r => qkCat(r,'Apéritif','Bouchée','Tartine','Tartinade','Wrap','Tortilla','Samoussa','Empanada','Brochette','Panini','Allumettes') },
  { v:'entree', label:'🥗 Entrée', f: r => qkCat(r,'Entrée','Soupe','Salade') },
  { v:'plat', label:'🍽️ Plat', f: r => qkCat(r,'Plat') },
  { v:'dessert', label:'🍰 Dessert', f: r => qkCat(r,'Dessert','Gâteaux','Viennoiserie','Biscuit','Flan','Crème dessert','Tarte sucrée') },
  { v:'boisson', label:'🥤 Boisson', f: r => qkCat(r,'Boissons','Smoothie','Milkshake','Cocktail','Cocktail sans alcool') },
  { v:'accomp', label:'🥖 Accomp. & pains', f: r => qkCat(r,'Accompagnement','Légumes','Frites','Pommes de terre au four','Pommes de terre écrasées','Pomme de terre','Pâtes','Pain','Boulangerie') },
];
// Chaque recette doit pouvoir sortir : ce qui n'entre dans aucun type (sauces, pâtes maison, techniques…) va dans « Sauces & bases ».
const QK_QUESTIONS = [
  { key:'type', title:'Type', opts: () => [
    ...QK_TYPES,
    { v:'base', label:'🫙 Sauces & bases', f: r => !QK_TYPES.some(o => o.f(r)) },
  ]},
  { key:'temps', title:'Temps', opts: () => [
    { v:'15', label:'⚡ 15 min', f: r => r.min && totalMinutes(r) <= 15 },
    { v:'30', label:'⏱️ 30 min', f: r => r.min && totalMinutes(r) <= 30 },
    { v:'60', label:'🕐 1 h', f: r => r.min && totalMinutes(r) <= 60 },
    { v:'*', label:'🐢 Peu importe', f: () => true },
  ]},
  { key:'ingr', title:'Ingrédient', opts: (a) => a.type === 'dessert' ? [
    { v:'chocolat', label:'🍫 Chocolat', f: r => QK.chocolat.test(qkHay(r).all) },
    { v:'fruit', label:'🍓 Fruits', f: r => QK.fruit.test(qkHay(r).main) },
    { v:'creme', label:'🍮 Crème', f: r => qkCat(r,'Flan','Crème dessert','Glace') || QK.creme.test(qkHay(r).title) },
    { v:'pate', label:'🥐 Gâteau', f: r => qkCat(r,'Gâteaux','Viennoiserie','Biscuit','Tarte sucrée','Crêpe sucrée','Cheesecake') || QK.pate.test(qkHay(r).title) },
  ] : a.type === 'boisson' ? [
    { v:'fruit', label:'🍓 Fruitée', f: r => QK.fruit.test(qkHay(r).all) },
    { v:'lait', label:'🥛 Lactée', f: r => /lait|yaourt|creme|glace|milkshake/.test(qkHay(r).all) },
    { v:'alcool', label:'🍸 Avec alcool', f: r => qkCat(r,'Cocktail') },
    { v:'sans', label:'🧃 Sans alcool', f: r => !qkCat(r,'Cocktail') },
  ] : qkSalty() },
  { key:'outil', title:'Cuisson', opts: () => [
    { v:'four', label:'🔥 Four', f: r => QK.four.test(qkHay(r).steps) && !qkCat(r,'Airfryer') },
    { v:'feu', label:'🍳 Poêle', f: r => QK.feu.test(qkHay(r).steps) },
    { v:'airfryer', label:'🌪️ Airfryer', f: r => qkCat(r,'Airfryer') || !!r.af },
    { v:'thermomix', label:'⚙️ Thermomix', f: r => qkCat(r,'Thermomix') },
    { v:'cru', label:'🥒 Cru', f: r => !QK.cuisson.test(qkHay(r).steps) },
    { v:'*', label:'🍽️ Peu importe', f: () => true },
  ]},
  { key:'envie', title:'Envie', opts: () => [
    { v:'leger', label:'🥗 Léger', f: r => { const h = qkHay(r); if (/chocolat|brioche|beignet|bugne|buche|tartiflette|raclette|frit|lardon|creme|gratin|fondue|cookie|brownie|gateau|mascarpone/.test(h.title)) return false; return QK.leger.test(h.title) || qkCat(r,'Santé') || (qkCat(r,'Salade','Soupe','Légumes','Smoothie') && !/creme|fromage|beurre|lardon|frit|chocolat|sucre/.test(h.all)); } },
    { v:'reconfort', label:'🍲 Réconfortant', f: r => QK.reconfort.test(qkHay(r).title) },
    { v:'recevoir', label:'🎉 Recevoir', f: r => QK.recevoir.test(qkHay(r).title) || qkCat(r,'Noël') },
    { v:'stock', label:'🧺 Mes stocks', f: r => { if (qkCat(r,'Sauce','Marinade')) return false; const c = qkStockCov(r); return c && c.total - c.covered <= 2; } },
    { v:'saison', label:'🌿 De saison', f: r => { const sk = (SEASON[monthNow()]||[]).filter(k => !WZ_BASIC.has(k)); return seasonHitsInText((r.ing||[]).join(' '), sk).length > 0; } },
    { v:'*', label:'😋 Peu importe', f: () => true },
  ]},
];
// Raccourcis de l'accueil : la recherche express avec des critères déjà cochés.
const QK_SHORTCUTS = [
  { label:'⚡ Rapide ce soir', answers:{ type:'plat', temps:'30' } },
  { label:'🧺 Avec mes stocks', answers:{ envie:'stock' } },
  { label:'🌿 De saison', answers:{ envie:'saison' } },
  { label:'🥗 Léger', answers:{ envie:'leger' } },
  { label:'🎉 Pour recevoir', answers:{ envie:'recevoir' } },
  { label:'⚙️ Thermomix', answers:{ outil:'thermomix' } },
  { label:'🌪️ Airfryer', answers:{ outil:'airfryer' } },
];
let qk = null;
function qkStockCov(r){
  if (!qk) return null;
  if (!qk.have) qk.have = stockHaveList();
  if (!qk.have.length) return null;
  if (!qk.cov.has(r)) qk.cov.set(r, recipeStockCoverage(r, qk.have));
  return qk.cov.get(r);
}
// Index précalculé à l'ouverture : un masque par choix (1 = la recette correspond).
function qkOptsFor(q, answers){ return q.opts(answers).map(o => Object.assign({ id: q.key + ':' + o.v + ':' + o.label }, o)); }
function qkBuildIndex(){
  const n = ALL.length, masks = {};
  const saved = state.cats; state.cats = [];
  const shown = new Set(collapseVariants(ALL).map(r => r.id)); state.cats = saved;
  const classic = Uint8Array.from(ALL, r => shown.has(r.id) ? 1 : 0);
  for (const q of QK_QUESTIONS)
    for (const ctx of [{}, { type: 'dessert' }, { type: 'boisson' }])
      for (const o of qkOptsFor(q, ctx)){
        if (masks[o.id] || o.v === 'stock' || o.v === '*') continue;
        const m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = o.f(ALL[i]) ? 1 : 0; masks[o.id] = m;
      }
  return { classic, masks };
}
let _qkIdx = null, _qkIdxFor = null;
function qkIndex(){ if (_qkIdxFor !== ALL){ _qkIdx = qkBuildIndex(); _qkIdxFor = ALL; } return _qkIdx; }
function qkMasks(answers){
  const ms = [];
  for (const q of QK_QUESTIONS){
    const a = answers[q.key]; if (!a || a === '*' || a === 'stock') continue;
    const o = qkOptsFor(q, answers).find(x => x.v === a); if (o) ms.push(qk.idx.masks[o.id]);
  }
  if (answers.outil !== 'thermomix' && answers.outil !== 'airfryer') ms.push(qk.idx.classic);
  return ms;
}
function qkCount(answers){
  const ms = qkMasks(answers), n = ALL.length; let c = 0;
  outer: for (let i = 0; i < n; i++){ for (const m of ms) if (!m[i]) continue outer; c++; }
  return c;
}
function qkFilter(answers){
  const ms = qkMasks(answers), out = [];
  outer: for (let i = 0; i < ALL.length; i++){ for (const m of ms) if (!m[i]) continue outer; out.push(ALL[i]); }
  if (answers.envie === 'stock') return out.filter(r => { const c = qkStockCov(r); return c && c.total - c.covered <= 2; });
  return out;
}
function openQuick(preset){
  qk = { answers: Object.assign({}, preset && preset.answers), cov: new Map(), have: null };
  qk.idx = qkIndex();
  // Raccourci : on démarre à la première question sans réponse (résultats directs seulement s'il en reste ≤ 10).
  qk.step = Math.max(0, QK_QUESTIONS.findIndex(q => !qk.answers[q.key]));
  if (preset && qkFilter(qk.answers).length <= 10) qk.step = QK_QUESTIONS.length;
  let el = document.getElementById('quick');
  if (!el){ el = document.createElement('div'); el.id = 'quick'; el.className = 'editview quick'; document.body.appendChild(el); }
  el.hidden = false; document.body.style.overflow = 'hidden';
  try { const d = document.documentElement; if (d.requestFullscreen && !document.fullscreenElement) d.requestFullscreen({ navigationUI: 'hide' }).catch(()=>{}); } catch(e){}
  qkRender();
}
function closeQuick(){ const el = document.getElementById('quick'); if (el) el.hidden = true;
  try { if (document.fullscreenElement) document.exitFullscreen().catch(()=>{}); } catch(e){} document.body.style.overflow = ''; qk = null; }
function qkRender(){
  // Étape par étape : seule la question en cours est affichée (grosses icônes) ; les réponses déjà
  // données restent en petites pastilles (toucher = revenir à cette question) ; recettes en bas.
  const el = document.getElementById('quick');
  if (qk.step == null) qk.step = 0;
  const list = qkFilter(qk.answers);
  const sorted = qk.answers.envie === 'stock' ? list.slice().sort((a, b) => stockRank(qkStockCov(a), qkStockCov(b))) : list;
  const total = QK_QUESTIONS.length, done = qk.step >= total;
  const answered = QK_QUESTIONS.map((q, i) => {
    const a = qk.answers[q.key]; const o = a && q.opts(qk.answers).find(x => x.v === a);
    return o && i !== qk.step ? `<button class="qk-ans" data-i="${i}">${o.label} ✎</button>` : '';
  }).join('');
  let body = '';
  if (!done){
    const q = QK_QUESTIONS[qk.step];
    body = `<div class="qk-q"><span class="qk-step">${qk.step + 1} / ${total}</span>${esc(q.title)}</div>
      <div class="qk-tiles big">${q.opts(qk.answers).map(o => {
        const on = qk.answers[q.key] === o.v;
        const n = o.v === 'stock' ? -1 : qkCount(Object.assign({}, qk.answers, { [q.key]: o.v }));
        const sp = o.label.indexOf(' ');
        return `<button class="qk-tile${on ? ' on' : ''}" data-v="${o.v}"${n === 0 ? ' disabled' : ''}><span class="qk-ico">${o.label.slice(0, sp)}</span><span class="qk-txt">${esc(o.label.slice(sp + 1))}</span>${n > 0 ? `<small>${n}</small>` : ''}</button>`;
      }).join('')}</div>
      <div class="qk-nav">${qk.step ? '<button id="qk-prev">← Précédent</button>' : '<span></span>'}<button id="qk-skip">Passer →</button></div>`;
  } else body = `<div class="qk-q">✨ C'est prêt</div>`;
  const open = done || qk.open || list.length <= 10;
  el.innerHTML = `<div class="qk-top">
      <button class="qk-x" id="qk-close" aria-label="Fermer">✕</button>
      <span class="qk-title">🔎 Express</span>
      ${Object.keys(qk.answers).length ? '<button class="qk-reset" id="qk-restart">↺ Recommencer</button>' : ''}
    </div>
    ${answered ? `<div class="qk-answers">${answered}</div>` : ''}
    <div class="qk-filters">${body}</div>
    <div class="qk-panel${open ? ' open' : ''}${done ? ' full' : ''}">
      <button class="qk-handle" id="qk-handle"><b>${list.length}</b> recette${list.length > 1 ? 's' : ''} <span>${open ? '▼' : '▲'}</span></button>
      <div class="qk-res">${sorted.length ? '' : '<p class="qk-empty">Aucune recette : change une réponse.</p>'}</div>
    </div>`;
  const grid = el.querySelector('.qk-res');
  // Toutes les recettes restent accessibles : 40 cartes, puis « Afficher plus » ajoute le paquet suivant.
  let shown = 0;
  const more = () => {
    const old = grid.querySelector('.qk-more'); if (old) old.remove();
    sorted.slice(shown, shown + 40).forEach(r => { const d = document.createElement('div'); d.innerHTML = card(r, qk.answers.envie === 'stock' ? qkStockCov(r) : null); const c = d.firstElementChild; c.addEventListener('click', () => openDetail(c.dataset.id)); grid.appendChild(c); });
    shown += 40;
    if (shown < sorted.length){
      const b = document.createElement('button'); b.className = 'qk-more';
      b.textContent = `Afficher plus (${sorted.length - shown})`;
      b.addEventListener('click', more); grid.appendChild(b);
    }
  };
  more();
  el.querySelectorAll('.qk-tile').forEach(b => b.addEventListener('click', () => {
    const q = QK_QUESTIONS[qk.step];
    qk.answers[q.key] = b.dataset.v;
    if (q.key === 'type') delete qk.answers.ingr;
    qk.step++; qk.open = false;
    while (qk.step < total && qk.answers[QK_QUESTIONS[qk.step].key]) qk.step++;  // question déjà répondue (raccourci) : on passe
    if (qkFilter(qk.answers).length <= 10) qk.step = total;
    qkRender();
  }));
  el.querySelectorAll('.qk-ans').forEach(b => b.addEventListener('click', () => { qk.step = +b.dataset.i; qk.open = false; qkRender(); }));
  const sk = el.querySelector('#qk-skip'); if (sk) sk.addEventListener('click', () => { delete qk.answers[QK_QUESTIONS[qk.step].key]; qk.step++; while (qk.step < total && qk.answers[QK_QUESTIONS[qk.step].key]) qk.step++; qkRender(); });
  const pv = el.querySelector('#qk-prev'); if (pv) pv.addEventListener('click', () => { qk.step--; qkRender(); });
  el.querySelector('#qk-handle').addEventListener('click', () => { if (done) { qk.step = QK_QUESTIONS.findIndex(q => !qk.answers[q.key]); if (qk.step < 0) qk.step = total - 1; } else qk.open = !open; qkRender(); });
  el.querySelector('#qk-close').addEventListener('click', closeQuick);
  const rb = el.querySelector('#qk-restart'); if (rb) rb.addEventListener('click', () => { qk.answers = {}; qk.step = 0; qk.open = false; qkRender(); });
}
function qkSummary(){
  return QK_QUESTIONS.map(q => { const a = qk.answers[q.key]; const o = a && q.opts(qk.answers).find(x => x.v === a); return o ? o.label.replace(/^\S+\s/, '') : ''; }).filter(Boolean).join(' · ');
}
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
  return stepTexts(r.steps).length;
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
      const meta = [r.min?'⏱️ '+fmtMin(totalMinutes(r)):'', r.serv?'🍽️ '+servTxt(r.serv):''].filter(Boolean).join(' · ');
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
