'use strict';

let ALL = [];
let cats = [];
let state = { q:'', cat:'all' };
const favs = new Set(JSON.parse(localStorage.getItem('recetteFavs') || '[]'));

const $ = (s)=>document.querySelector(s);
const elGrid=$('#grid'), elCats=$('#cats'), elStatus=$('#status'), elSearch=$('#search'),
      elDetail=$('#detail'), elSub=$('#hero-sub');

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

/* ---------- filtres ---------- */
function filtered(){
  const q = norm(state.q.trim());
  return ALL.filter(r=>{
    if (state.cat==='fav'){ if(!favs.has(r.id)) return false; }
    else if (state.cat!=='all'){ if(r.cat!==state.cat) return false; }
    if (!q) return true;
    if (norm(r.t).includes(q)) return true;
    if (norm(r.cat).includes(q)) return true;
    return r.ing.some(i=> norm(i).includes(q));
  });
}

/* ---------- catégories ---------- */
function buildCats(){
  const count={};
  ALL.forEach(r=>{ const c=r.cat||'Sans catégorie'; count[c]=(count[c]||0)+1; });
  cats = Object.keys(count).sort((a,b)=> count[b]-count[a] || a.localeCompare(b));
  renderChips();
}
function renderChips(){
  const chip=(id,label)=>`<button class="chip ${state.cat===id?'active':''}" data-cat="${esc(id)}">${esc(label)}</button>`;
  let html = chip('all','Tout');
  if (favs.size) html += chip('fav','❤️ Favoris');
  html += cats.map(c=>chip(c,c)).join('');
  elCats.innerHTML = html;
  elCats.querySelectorAll('.chip').forEach(b=> b.addEventListener('click',()=>{ state.cat=b.dataset.cat; renderChips(); renderGrid(); }));
}

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
  elStatus.textContent = `${list.length} recette${list.length>1?'s':''}` + (state.cat==='fav'?' en favoris':'');
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
  const tags = [
    r.cat?`<span class="tag cat">${esc(r.cat)}</span>`:'',
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
  const links = [
    r.url?`<a class="src" href="${esc(r.url)}" target="_blank" rel="noopener">🔗 Source</a>`:'',
    r.vid?`<a href="${esc(r.vid)}" target="_blank" rel="noopener">▶️ Vidéo</a>`:'',
  ].filter(Boolean).join('');
  elDetail.innerHTML = `
    <button class="d-back" aria-label="Retour">←</button>
    <button class="d-fav" aria-label="Favori">${isFav?'❤️':'🤍'}</button>
    <div class="d-hero">${hero}</div>
    <div class="d-body">
      <div class="d-title">${esc(r.t)}</div>
      <div class="d-meta">${tags}</div>
      ${r.desc?`<div class="desc">${esc(r.desc)}</div>`:''}
      ${ing}${stepsHtml}
      ${links?`<div class="d-links">${links}</div>`:''}
    </div>`;
  elDetail.hidden = false;
  document.body.style.overflow='hidden';
  elDetail.querySelector('.d-back').addEventListener('click', closeDetail);
  elDetail.querySelector('.d-fav').addEventListener('click', (e)=>{
    if (favs.has(r.id)) favs.delete(r.id); else favs.add(r.id);
    saveFavs(); e.currentTarget.textContent = favs.has(r.id)?'❤️':'🤍';
  });
  elDetail.querySelectorAll('.ing li').forEach(li=> li.addEventListener('click',()=> li.classList.toggle('done')));
}
function closeDetail(){ elDetail.hidden=true; document.body.style.overflow=''; renderChips(); renderGrid(); }

/* ---------- init ---------- */
let searchTimer;
async function init(){
  const data = await (await fetch('data/recipes.json')).json();
  ALL = data.recipes || [];
  elSub.textContent = `${ALL.length} recettes · hors-ligne`;
  buildCats();
  renderDaily();
  renderGrid();
  elSearch.addEventListener('input', ()=>{
    clearTimeout(searchTimer);
    searchTimer = setTimeout(()=>{ state.q = elSearch.value; renderGrid(); }, 180);
  });
  window.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && !elDetail.hidden) closeDetail(); });
  if ('serviceWorker' in navigator){ try{ navigator.serviceWorker.register('sw.js'); }catch(e){} }
}
init();
