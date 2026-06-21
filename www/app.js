'use strict';

const APP_VERSION = '2.3';

let ALL = [];
let BASE = [];
let cats = [];
let catCount = {};
// state.cats = liste des catégories cochées dans le filtre (vide = toutes) ; state.fav = filtre favoris.
let state = { q:'', cats:[], fav:false, ing:null };
const favs = new Set(JSON.parse(localStorage.getItem('recetteFavs') || '[]'));
let edits = JSON.parse(localStorage.getItem('recetteEdits') || '{}');
let imports = JSON.parse(localStorage.getItem('recetteImports') || '[]');
function saveEdits(){ localStorage.setItem('recetteEdits', JSON.stringify(edits)); }
function saveImports(){ localStorage.setItem('recetteImports', JSON.stringify(imports)); }
function mergeEdits(){
  const base = BASE.map(r => edits[r.id] ? Object.assign({},r,edits[r.id]) : r);
  const imp  = imports.map(r => edits[r.id] ? Object.assign({},r,edits[r.id]) : r);
  return [...base, ...imp];
}
function refreshAll(){ ALL = mergeEdits(); buildIngredientIndex(); buildCats(); renderDaily(); renderGrid(); }

/* ---------- synchro OTA (pull du recipes.json publié) ---------- */
const REMOTE_URL = 'https://raw.githubusercontent.com/laurentsar/recettes/master/www/data/recipes.json';
let toastTimer;
function toast(msg){ const t=document.getElementById('toast'); if(!t) return; t.textContent=msg; t.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>{t.hidden=true;},3000); }
async function fetchRemoteText(){
  try{ const r = await fetch(REMOTE_URL + '?t=' + Date.now(), { cache:'no-store' }); return r.ok ? await r.text() : null; }
  catch(e){ return null; }
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
  BASE = d.recipes; refreshAll();
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
const VEGGIES = {
  'Carotte':['carotte'], 'Courgette':['courgette'], 'Tomate':['tomate'],
  'Pomme de terre':['pomme de terre','patate'], 'Oignon':['oignon'], 'Ail':['ail'],
  'Échalote':['echalote'], 'Poireau':['poireau'], 'Aubergine':['aubergine'],
  'Poivron':['poivron'], 'Champignon':['champignon','cepe','girolle'],
  'Brocoli':['brocoli'], 'Chou-fleur':['chou-fleur','chou fleur'], 'Chou':['chou','chou rouge','chou vert'],
  'Épinard':['epinard'], 'Haricot vert':['haricot vert'], 'Petit pois':['petit pois','petits pois'],
  'Courge':['courge','potiron','butternut','potimarron'], 'Concombre':['concombre'],
  'Céleri':['celeri'], 'Fenouil':['fenouil'], 'Artichaut':['artichaut'],
  'Asperge':['asperge'], 'Betterave':['betterave'], 'Navet':['navet'],
  'Radis':['radis'], 'Endive':['endive'], 'Blette':['blette','bette'],
  'Avocat':['avocat'], 'Salade verte':['laitue','roquette','mache','batavia','scarole'],
  'Lentille':['lentille'], 'Pois chiche':['pois chiche'],
};
const VIANDE_KW = ['boeuf','bœuf','porc','agneau','veau','poulet','dinde','canard','pintade','lapin','steak',
  'saucisse','lardon','jambon','bacon','viande hachee','merguez','cotelette','roti','magret','escalope',
  'chipolata','boudin','gigot','entrecote','bavette','charcuterie','chorizo'];
const POISSON_KW = ['saumon','thon','cabillaud','morue','truite','sardine','maquereau','colin','dorade',
  'poisson','merlu','hareng','crevette','moule','huitre','crabe','calamar','saint-jacques','gambas','fruits de mer'];
const DESSERT_KW = ['chocolat','sucre','gateau','patisserie','biscuit','gaufre','mousse','flan','glace','caramel',
  'vanille','meringue','tiramisu','fondant','brownie','cookie','madeleine','clafoutis','compote','confiture',
  'miel','chantilly','beignet','panna cotta','crumble','sucre glace'];
const ENTREE_KW = ['salade','soupe','veloute','potage','verrine','tartare','terrine','gaspacho','bruschetta','carpaccio','tapas','houmous','guacamole'];

function autoCategorize(){
  let added=0, touched=0;
  ALL.forEach(r=>{
    const ingHay  = norm((r.ing||[]).join('  '));                            // légumes : ingrédients seulement (précis)
    const fullHay = norm([r.t||'', (r.ing||[]).join('  '), r.steps||''].join('  '));
    const have = new Set(catList(r).map(c=>c.toLowerCase()));
    const toAdd = [];
    const push = c => { if(!have.has(c.toLowerCase())){ toAdd.push(c); have.add(c.toLowerCase()); } };
    // Légumes détaillés
    for (const [veg, kws] of Object.entries(VEGGIES)) if (kws.some(k=> hasWord(ingHay,k))) push(veg);
    // Viande / Poisson (groupés)
    if (VIANDE_KW.some(k=> hasWord(fullHay,k))) push('Viande');
    if (POISSON_KW.some(k=> hasWord(fullHay,k))) push('Poisson');
    // Type de plat (un seul : Dessert > Entrée > Plat par défaut)
    if (!['dessert','entrée','entree','plat'].some(c=> have.has(c))){
      let course = 'Plat';
      if (DESSERT_KW.some(k=> hasWord(fullHay,k))) course='Dessert';
      else if (ENTREE_KW.some(k=> hasWord(fullHay,k))) course='Entrée';
      push(course);
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
// Une recette peut avoir plusieurs catégories, stockées dans r.cat séparées par des virgules.
function catList(r){
  return String((r && r.cat) || '').split(',').map(s=>s.trim()).filter(Boolean);
}
function buildCats(){
  catCount={};
  ALL.forEach(r=>{ const cs=catList(r); (cs.length?cs:['Sans catégorie']).forEach(c=> catCount[c]=(catCount[c]||0)+1); });
  cats = Object.keys(catCount).sort((a,b)=> catCount[b]-catCount[a] || a.localeCompare(b));
  renderChips();
}
function renderChips(){
  const ingLabel = state.ing ? `🥕 ${cap(state.ing)} ✕` : '🥕 Ingrédient';
  const nSel = state.cats.length + (state.fav ? 1 : 0);
  const catLabel = nSel ? `🏷️ ${nSel} sélection${nSel>1?'s':''}` : '🏷️ Catégories';
  let rows = '';
  if (favs.size) rows += `<label class="catopt"><input type="checkbox" id="catopt-fav"${state.fav?' checked':''}><span>❤️ Favoris</span><span class="catn">(${favs.size})</span></label>`;
  rows += cats.map(c=>`<label class="catopt"><input type="checkbox" class="catopt-c" value="${esc(c)}"${state.cats.includes(c)?' checked':''}><span>${esc(c)}</span><span class="catn">(${catCount[c]||0})</span></label>`).join('');
  elCats.innerHTML = `
    <button class="chip ing-chip ${state.ing?'active':''}" id="ing-filter-btn">${esc(ingLabel)}</button>
    <div class="cat-multi">
      <button class="chip ${nSel?'active':''}" id="cat-btn">${esc(catLabel)} ▾</button>
      <div class="cat-panel" id="cat-panel" hidden>
        <button class="cat-clear" id="cat-clear">Tout afficher</button>
        ${rows || '<div class="catopt-empty">Aucune catégorie</div>'}
      </div>
    </div>`;
  const panel = document.getElementById('cat-panel');
  document.getElementById('cat-btn').addEventListener('click', (e)=>{ e.stopPropagation(); panel.hidden = !panel.hidden; });
  panel.addEventListener('click', e=> e.stopPropagation());
  const favBox = document.getElementById('catopt-fav');
  if (favBox) favBox.addEventListener('change', e=>{ state.fav = e.target.checked; renderGrid(); refreshCatLabel(); });
  panel.querySelectorAll('.catopt-c').forEach(box=> box.addEventListener('change', ()=>{
    state.cats = Array.from(panel.querySelectorAll('.catopt-c:checked')).map(i=>i.value);
    renderGrid(); refreshCatLabel();
  }));
  document.getElementById('cat-clear').addEventListener('click', ()=>{
    state.cats = []; state.fav = false; renderChips(); renderGrid();
  });
  document.getElementById('ing-filter-btn').addEventListener('click', ()=>{
    if (state.ing){ state.ing=null; renderChips(); renderGrid(); } else openIngPick();
  });
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
  const current = catList(r);
  const el = document.getElementById('catpick');
  const boxes = cats.map(c=>`<label class="cpm-chk"><input type="checkbox" value="${esc(c)}"${current.includes(c)?' checked':''}><span>${esc(c)}</span><span class="cpm-n">(${catCount[c]||0})</span></label>`).join('');
  el.innerHTML = `
    <div class="cpm-backdrop"></div>
    <div class="cpm-box">
      <div class="cpm-title">Catégories de « ${esc(r.t)} »</div>
      <div class="cpm-list">${boxes || '<div class="cpm-empty">Aucune catégorie existante</div>'}</div>
      <input id="cpm-new" type="text" placeholder="Ajouter (plusieurs séparées par des virgules)…" autocomplete="off">
      <div class="cpm-btns">
        <button class="cpm-cancel">Annuler</button>
        <button class="cpm-save">Enregistrer</button>
      </div>
    </div>`;
  el.hidden = false;
  el.querySelector('.cpm-cancel').addEventListener('click', closeCatPick);
  el.querySelector('.cpm-backdrop').addEventListener('click', closeCatPick);
  el.querySelector('.cpm-save').addEventListener('click', ()=>{
    const checked = Array.from(el.querySelectorAll('.cpm-list input:checked')).map(i=>i.value);
    const typed = (document.getElementById('cpm-new').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    const seen = new Set(); const out = [];
    checked.concat(typed).forEach(c=>{ const k=c.toLowerCase(); if(!seen.has(k)){ seen.add(k); out.push(c); } });
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
  const meta = [r.min? '⏱️ '+r.min+' min':'', r.serv? '🍽️ '+r.serv : '', r.cat||''].filter(Boolean).slice(0,2).join(' · ');
  return `<div class="rcard ${fav}" data-id="${esc(r.id)}">${img}
    <div class="info"><div class="rt">${esc(r.t)}</div><div class="meta">${esc(meta)}</div></div></div>`;
}
function renderGrid(){
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
  const cookBtn = steps.length ? `<button class="d-cook-btn">🍳 Réaliser cette recette</button>` : '';
  const links = [
    r.url?`<a class="src" href="${esc(r.url)}" target="_blank" rel="noopener">🔗 Source</a>`:'',
    r.vid?`<a href="${esc(r.vid)}" target="_blank" rel="noopener">▶️ Vidéo</a>`:'',
  ].filter(Boolean).join('');
  elDetail.innerHTML = `
    <button class="d-back" aria-label="Retour">←</button>
    <button class="d-edit" aria-label="Éditer">✏️</button>
    <button class="d-fav" aria-label="Favori">${isFav?'❤️':'🤍'}</button>
    <div class="d-hero">${hero}</div>
    <div class="d-body">
      <div class="d-title">${esc(r.t)}</div>
      <div class="d-meta">${tags}</div>
      ${r.desc?`<div class="desc">${esc(r.desc)}</div>`:''}
      ${ing}${stepsHtml}${cookBtn}
      ${links?`<div class="d-links">${links}</div>`:''}
    </div>`;
  elDetail.hidden = false;
  document.body.style.overflow='hidden';
  elDetail.querySelector('.d-back').addEventListener('click', closeDetail);
  const cookBtnEl = elDetail.querySelector('.d-cook-btn');
  if (cookBtnEl) cookBtnEl.addEventListener('click', ()=> openCook(r.id));
  elDetail.querySelector('.d-fav').addEventListener('click', (e)=>{
    if (favs.has(r.id)) favs.delete(r.id); else favs.add(r.id);
    saveFavs(); e.currentTarget.textContent = favs.has(r.id)?'❤️':'🤍';
  });
  elDetail.querySelector('.d-edit').addEventListener('click', ()=> openEdit(r.id));
  elDetail.querySelectorAll('.ing li').forEach(li=> li.addEventListener('click',()=> li.classList.toggle('done')));
  elDetail.querySelector('.tag-cat-btn').addEventListener('click', ()=> openCatPick(r.id));
}
function closeDetail(){ elDetail.hidden=true; document.body.style.overflow=''; renderChips(); renderGrid(); }

/* ---------- mode cuisine pas-à-pas ---------- */
let cookRecipe = null;
let cookStep = 0;
let cookSteps = [];
const cookSynth = window.speechSynthesis || null;
let cookRecog = null;
let cookMicActive = false;
let cookTtsBusy = false;
let cookRecogGen = 0; // chaque session a un numéro unique ; les callbacks périmés sont ignorés

function openCook(id){
  const r = ALL.find(x=>String(x.id)===String(id)); if(!r) return;
  cookRecipe = r;
  cookSteps = splitSteps(r.steps);
  if(!cookSteps.length){ toast('Aucune étape de préparation'); return; }
  cookStep = 0;
  elCook.innerHTML = `
    <div class="cook-head">
      <button class="cook-quit" aria-label="Quitter">←</button>
      <span class="cook-title">${esc(r.t)}</span>
      <button id="cook-mic" class="cook-mic" aria-label="Contrôle vocal">🎤</button>
    </div>
    <div class="cook-progress"><div id="cook-progress-bar" class="cook-progress-bar"></div></div>
    <div class="cook-counter" id="cook-counter"></div>
    <div class="cook-body"><div id="cook-step-text" class="cook-step"></div></div>
    <div class="cook-hint">🎤 Dire : « suivant » · « précédent » · « répéter » · « ingrédients »</div>
    <div class="cook-nav">
      <button id="cook-prev" class="cook-prev">← Précédent</button>
      <button id="cook-next" class="cook-next">Suivant →</button>
    </div>`;
  elCook.hidden = false;
  document.body.style.overflow = 'hidden';
  renderCookStep();
  speakCookStep();
  elCook.querySelector('.cook-quit').addEventListener('click', closeCook);
  document.getElementById('cook-mic').addEventListener('click', toggleCookMic);
  document.getElementById('cook-prev').addEventListener('click', cookGoPrev);
  document.getElementById('cook-next').addEventListener('click', cookGoNext);
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
  document.getElementById('cook-step-text').textContent = cookSteps[cookStep];
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
  else if(/ingr[eé]dient/.test(txt)) toggleCookIng();
  else if(/terminer|quitter|stop|fermer|fin/.test(txt)) closeCook();
  else if(/d[eé]but|recommencer|premi/.test(txt)){ cookStep=0; renderCookStep(); speakCookStep(); }
}

function toggleCookIng(){
  const existing = document.getElementById('cook-ing-ov');
  if(existing){ existing.remove(); return; }
  const ov = document.createElement('div');
  ov.id = 'cook-ing-ov';
  ov.className = 'cook-ing-ov';
  const sk = SEASON[monthNow()] || [];
  const ingHtml = (cookRecipe.ing||[]).map((item,k)=>{
    const s = sk.some(w=>norm(item).includes(w));
    return `<li data-k="${k}" class="${s?'season':''}"><span class="box"></span><span>${esc(item)}</span>${s?'<span class="leaf">🌿</span>':''}</li>`;
  }).join('');
  ov.innerHTML = `<div class="cook-ing-sheet">
    <button class="cook-ing-close">✕ Fermer</button>
    <div class="d-sec" style="margin-top:0">Ingrédients</div>
    <ul class="ing">${ingHtml}</ul>
  </div>`;
  ov.querySelector('.cook-ing-close').addEventListener('click', ()=> ov.remove());
  ov.querySelectorAll('.ing li').forEach(li=> li.addEventListener('click', ()=> li.classList.toggle('done')));
  elCook.appendChild(ov);
}

/* ---------- édition ---------- */
const elEdit = $('#edit');
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
      ${field('Catégories (coche plusieurs)', `<div class="e-cats" id="e-cats">${cats.map(c=>`<label class="cpm-chk"><input type="checkbox" class="e-cat-c" value="${esc(c)}"${catList(r).includes(c)?' checked':''}><span>${esc(c)}</span></label>`).join('') || '<div class="cpm-empty">Aucune catégorie</div>'}</div><input id="e-cat-new" autocomplete="off" placeholder="Ajouter de nouvelles (séparées par des virgules)…">`)}
      <div class="ef-row">${field('Durée (min)', `<input id="e-min" type="number" min="0" value="${v(r.min)}">`)}${field('Portions', `<input id="e-serv" type="number" min="0" value="${v(r.serv)}">`)}</div>
      ${field('Image (URL)', `<input id="e-img" value="${v(r.img)}">`)}
      <div class="ef-row">${field('Source (URL)', `<input id="e-url" value="${v(r.url)}">`)}${field('Vidéo (URL)', `<input id="e-vid" value="${v(r.vid)}">`)}</div>
      ${field('Description', `<textarea id="e-desc" rows="2">${v(r.desc)}</textarea>`)}
      ${field('Ingrédients (un par ligne)', `<textarea id="e-ing" rows="9">${v((r.ing||[]).join('\n'))}</textarea>`)}
      ${field('Préparation', `<textarea id="e-steps" rows="10">${v(r.steps)}</textarea>`)}
      ${edits[id] ? `<button class="e-reset">↺ Rétablir la version d'origine</button>` : ''}
    </div>`;
  elEdit.hidden = false; document.body.style.overflow='hidden';
  elEdit.querySelector('.e-cancel').addEventListener('click', closeEdit);
  elEdit.querySelector('.e-save').addEventListener('click', ()=> saveEdit(id));
  const rb = elEdit.querySelector('.e-reset'); if (rb) rb.addEventListener('click', ()=> resetEdit(id));
}
function closeEdit(){ elEdit.hidden = true; }
function saveEdit(id){
  const ing = ev('e-ing').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  // Catégories : cases cochées + nouvelles saisies (virgules), dédupliquées.
  const checked = Array.from(document.querySelectorAll('#e-cats .e-cat-c:checked')).map(i=>i.value);
  const typed = (ev('e-cat-new')||'').split(',').map(s=>s.trim()).filter(Boolean);
  const seen = new Set(); const catsOut = [];
  checked.concat(typed).forEach(c=>{ const k=c.toLowerCase(); if(!seen.has(k)){ seen.add(k); catsOut.push(c); } });
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

/* ---------- init ---------- */
let searchTimer;
async function init(){
  const bundled = await (await fetch('data/recipes.json')).json();
  let dataObj = bundled;
  const cachedTxt = localStorage.getItem('recipesData');
  if (cachedTxt){ try{ const c=JSON.parse(cachedTxt); if(c.recipes && c.recipes.length) dataObj=c; }catch(e){} }
  BASE = dataObj.recipes || [];
  ALL = mergeEdits();
  buildIngredientIndex();
  elSub.textContent = `${ALL.length} recettes · v${APP_VERSION}`;
  buildCats();
  renderDaily();
  renderGrid();
  document.getElementById('sync-btn').addEventListener('click', ()=> syncRemote(true));
  document.getElementById('import-btn').addEventListener('click', openImport);
  document.getElementById('photos-btn').addEventListener('click', fillFromSources);
  document.getElementById('autocat-btn').addEventListener('click', autoCategorize);
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
  window.addEventListener('keydown', (e)=>{
    if(e.key!=='Escape') return;
    const ip=document.getElementById('ingpick');
    if(ip && !ip.hidden) closeIngPick();
    else if(!elEdit.hidden) closeEdit();
    else if(!elCook.hidden) closeCook();
    else if(!elImport.hidden) closeImport();
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
    ['detail',  closeDetail],
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
