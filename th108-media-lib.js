// th108-media-lib.js — shared persistent media library (IndexedDB) for the TH108 pages.
// Stores imported media (GIF/image/video blobs) + a thumbnail, so they can be re-picked across sessions
// and across both pages (controller + screen). Persistence requires a single origin → serve via the local
// server (http://localhost:8123), not file:// (different file:// paths can't share storage).
//
// window.TH108Media: { available, add(blob,name), list(), get(id), remove(id), mountPicker(el,onPick) }
(function(){
  const DB='th108media', STORE='items', SRC='layersrc'; let dbp=null;   // SRC = hidden per-layer source blobs (Media layer re-framing), NOT shown in the user's library
  const available = typeof indexedDB!=='undefined';
  function db(){ return dbp || (dbp=new Promise((res,rej)=>{
    const r=indexedDB.open(DB,2);
    r.onupgradeneeded=()=>{ const d=r.result; if(!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE,{keyPath:'id',autoIncrement:true}); if(!d.objectStoreNames.contains(SRC)) d.createObjectStore(SRC); };   // SRC keyed by an explicit string id (the layer's mediaId)
    r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
  })); }
  async function store(mode){ const d=await db(); return d.transaction(STORE,mode).objectStore(STORE); }
  // per-layer source blob store (re-framing keeps the original image across reloads)
  async function putSource(id,blob){ const d=await db(); return reqP(d.transaction(SRC,'readwrite').objectStore(SRC).put(blob,id)); }
  async function getSource(id){ const d=await db(); return reqP(d.transaction(SRC,'readonly').objectStore(SRC).get(id)); }
  async function delSource(id){ const d=await db(); return reqP(d.transaction(SRC,'readwrite').objectStore(SRC).delete(id)); }
  const reqP=req=>new Promise((res,rej)=>{ req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error); });

  // first-frame thumbnail -> small PNG dataURL (works for images/GIF/WebP; videos fall back to a label tile)
  async function makeThumb(blob){
    try{
      let bmp=null;
      try{ bmp=await createImageBitmap(blob); }catch(_){ bmp=null; }
      if(!bmp && /^video\//.test(blob.type)){ return await videoThumb(blob); }
      if(!bmp) return '';
      const r=Math.min(96/bmp.width, 60/bmp.height, 1), w=Math.max(1,bmp.width*r|0), h=Math.max(1,bmp.height*r|0);
      const c=document.createElement('canvas'); c.width=w; c.height=h; c.getContext('2d').drawImage(bmp,0,0,w,h);
      if(bmp.close) bmp.close();
      return c.toDataURL('image/png');
    }catch(_){ return ''; }
  }
  function videoThumb(blob){
    return new Promise(res=>{
      const v=document.createElement('video'); v.muted=true; v.preload='metadata'; v.src=URL.createObjectURL(blob);
      const done=u=>{ URL.revokeObjectURL(v.src); res(u||''); };
      v.onloadeddata=()=>{ try{ const r=Math.min(96/v.videoWidth,60/v.videoHeight,1), w=Math.max(1,v.videoWidth*r|0), h=Math.max(1,v.videoHeight*r|0);
        const c=document.createElement('canvas'); c.width=w; c.height=h; c.getContext('2d').drawImage(v,0,0,w,h); done(c.toDataURL('image/png')); }catch(_){ done(''); } };
      v.onerror=()=>done(''); setTimeout(()=>done(''),4000);
    });
  }

  async function add(blob,name){
    const rec={ kind:'single', name:name||'media', type:blob.type||'', addedAt:Date.now(), blob, thumb:await makeThumb(blob) };
    const s=await store('readwrite'); rec.id=await reqP(s.add(rec)); return rec;
  }
  async function addSequence(blobs,name){     // a PNG/image folder/sequence stored as one item (array of blobs, in order)
    const rec={ kind:'seq', name:name||'sequence', addedAt:Date.now(), blobs:[...blobs], frames:blobs.length, thumb:await makeThumb(blobs[0]) };
    const s=await store('readwrite'); rec.id=await reqP(s.add(rec)); return rec;
  }
  async function list(){ const s=await store('readonly'); const all=await reqP(s.getAll()); return (all||[]).sort((a,b)=>b.addedAt-a.addedAt); }
  async function get(id){ const s=await store('readonly'); return reqP(s.get(id)); }
  async function remove(id){ const s=await store('readwrite'); return reqP(s.delete(id)); }

  // render a thumbnail grid into el; onPick(item) fires on click (item has .blob/.name/.type)
  async function mountPicker(el, onPick){
    if(!available){ el.innerHTML='<span style="color:#f85149">IndexedDB unavailable — open the page via http://localhost:8123 (not file://) for the library to work.</span>'; return; }
    let items=[]; try{ items=await list(); }catch(e){ el.innerHTML='<span style="color:#f85149">library error: '+e.message+'</span>'; return; }
    el.innerHTML='';
    if(!items.length){ el.innerHTML='<span style="color:#8b949e">library empty — load media, then click “★ Add to Library” to save it here.</span>'; return; }
    for(const it of items){
      const card=document.createElement('div'); card.style.cssText='position:relative;display:inline-block;margin:4px;cursor:pointer;vertical-align:top'; card.title=it.name+'  ('+(it.type||'?')+')';
      const img=document.createElement('img'); img.src=it.thumb||''; img.alt=it.name;
      img.style.cssText='display:block;width:96px;height:60px;object-fit:cover;border:1px solid #30363d;border-radius:4px;background:#000';
      img.addEventListener('click',()=>onPick(it));
      const tag=document.createElement('div'); tag.textContent=it.name; tag.style.cssText='max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#8b949e;margin-top:2px';
      const del=document.createElement('button'); del.textContent='✕'; del.title='delete';
      del.style.cssText='position:absolute;top:2px;right:2px;padding:0 5px;font:11px/16px ui-monospace,monospace;background:#da3633;border:none;border-radius:3px;color:#fff;cursor:pointer';
      del.addEventListener('click',async e=>{ e.stopPropagation(); await remove(it.id); mountPicker(el,onPick); });
      card.appendChild(img); card.appendChild(tag); card.appendChild(del); el.appendChild(card);
    }
  }

  window.TH108Media={ available, add, addSequence, list, get, remove, mountPicker, putSource, getSource, delSource };
})();
