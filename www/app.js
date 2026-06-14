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
  const ing = r.ing.length ? `<div class="d-sec">Ingrédients</div><ul class="ing">${
    r.ing.map((i,k)=>`<li data-k="${k}"><span class="box"></span><span>${esc(i)}</span></li>`).join('')}</ul>` : '';
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
  renderGrid();
  elSearch.addEventListener('input', ()=>{
    clearTimeout(searchTimer);
    searchTimer = setTimeout(()=>{ state.q = elSearch.value; renderGrid(); }, 180);
  });
  window.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && !elDetail.hidden) closeDetail(); });
  if ('serviceWorker' in navigator){ try{ navigator.serviceWorker.register('sw.js'); }catch(e){} }
}
init();
