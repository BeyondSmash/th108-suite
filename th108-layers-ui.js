/* th108-layers-ui.js — layer-cards UI for the TH108 controller (module #3 of the controller decomposition).
   Builds the per-layer cards (header + type-specific body + shared Adjust block), the grip drag-to-reorder,
   and the layer persistence (localStorage th108_layers / th108_layerOrder + debounced save that mirrors
   edits to the daemon's config.json). Extracted unchanged from th108-controller.html's inline script.
   UMD so the pure parts (serializeLayers / serializeOrder / overlayLayers) are unit-testable under node --test.

   Usage: const LUI = TH108LayersUI.create({state, engine, cards, panel,
            attachHex, snap, pushConfig, isRunning, onPatternPick});
   The module owns the #layerCards subtree and the persist keys; everything else (engine state object,
   run-loop state, daemon client, hex/snap UI helpers) arrives via opts — zero globals beyond localStorage. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TH108LayersUI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TYPES=['background','reactive','gradient','pattern','individual','audio','media'], BLENDS=['normal','add','screen','multiply','max','replace'];
  const root_PaintBoard = () => (typeof window!=='undefined' && window.TH108PaintBoard) || { mount(){ return { draw(){}, recolorSelection(){}, clearSelection(){}, selectNone(){}, selCount(){return 0;}, destroy(){} }; } };
  // lucide chevrons-down-up (= "collapse") / chevrons-up-down (= "expand") for the card corner toggle
  const SVGA='<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const CHEV_COLLAPSE=SVGA+'<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/></svg>';
  const CHEV_EXPAND=SVGA+'<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>';

  // ----- pure persist helpers (node-testable) -----
  function serializeLayers(layers){ return layers.map(L=>({name:L.name,enabled:L.enabled,type:L.type,opacity:L.opacity,blend:L.blend,fps:L.fps,settings:L.settings,collapsed:!!L.collapsed})); }
  function serializeOrder(layers){ return layers.map(L=>L.type+':'+L.name); }
  function overlayLayers(layers, a){
    if(!Array.isArray(a)) return;
    for(let i=0;i<layers.length&&i<a.length;i++){ const o=a[i]; if(!o) continue; const L=layers[i];
      if(o.name!=null)L.name=o.name; L.enabled=!!o.enabled; if(o.type)L.type=o.type; if(o.opacity!=null)L.opacity=o.opacity; if(o.blend)L.blend=o.blend; if(o.fps)L.fps=Math.min(30,o.fps);   // clamp any pre-cap saved fps
      L.collapsed=!!o.collapsed;   // card collapse is a UI pref but rides the same persisted object (survives reorders)
      if(o.settings&&typeof o.settings==='object')L.settings=o.settings; }
  }

  function create(opts){
    opts = opts || {};
    const noop = function () {};
    const E = opts.engine, state = opts.state,
          cards = opts.cards, panel = opts.panel,                       // #layerCards host + #layersPanel (persist-on-edit scope)
          attachHex = opts.attachHex || noop, snap = opts.snap || noop, // page UI helpers (hex box per color picker, slider detent)
          pushConfig = opts.pushConfig || noop,                         // mirror saves to the daemon's config.json
          isRunning = opts.isRunning || (() => false),                  // layer loop live? (reorder warm-renders so the change shows immediately)
          onPatternPick = opts.onPatternPick || noop;                   // page hook: picking a pattern while a firmware effect shows = "back to layers"

    // ----- persist full layer state (settings survive page refresh) -----
    let _slsT=0;
    function saveLayers(){ try{ localStorage.setItem('th108_layers', JSON.stringify(serializeLayers(state.layers))); }catch(_){ } }
    function scheduleSaveLayers(){ clearTimeout(_slsT); _slsT=setTimeout(()=>{ saveLayers(); pushConfig(); },400); }   // mirror the edit to the daemon's config.json (no-op if no daemon)
    function restoreLayers(){ try{ overlayLayers(state.layers, JSON.parse(localStorage.getItem('th108_layers')||'null')); }catch(_){ } }
    function saveLayerOrder(){ try{ localStorage.setItem('th108_layerOrder', JSON.stringify(serializeOrder(state.layers))); }catch(_){ } }

    // ===== layer cards UI (built from the layers array; Layer 1 listed first) =====
    function buildLayerCards(){
      const host=cards; host.innerHTML='';
      // ascending — Layer 1 (bottom of the stack) reads first, Layer 4 (top) last (user request 2026-06-11)
      for(let n=0;n<state.layers.length;n++){
        const L=state.layers[n], card=document.createElement('div');
        card.className='lcard'+(L.enabled?'':' off')+(L.collapsed?' coll':''); card.dataset.n=n;
        card.draggable=true;
        const opt=(arr,sel)=>arr.map(v=>'<option'+(v===sel?' selected':'')+'>'+v+'</option>').join('');
        card.innerHTML=
          '<div class="lhead">'+
            '<span class="lgrip" title="drag to change layer level">⠿</span>'+
            '<span class="llvl">Layer '+(n+1)+'</span>'+
            '<input type="checkbox" class="le"'+(L.enabled?' checked':'')+' title="enable layer">'+
            '<input type="text" class="ln" value="'+L.name.replace(/"/g,'&quot;')+'">'+
            '<select class="lt">'+opt(TYPES,L.type)+'</select>'+
            '<span class="lfield">Opacity <input type="range" class="lo" min="0" max="100" value="'+Math.round(L.opacity*100)+'"><input type="number" class="numin lon" min="0" max="100" value="'+Math.round(L.opacity*100)+'"></span>'+
            '<select class="lbl">'+opt(BLENDS,L.blend)+'</select>'+
            '<span class="lfield">FPS <input type="range" class="lf" min="1" max="30" value="'+L.fps+'"><input type="number" class="numin lfn" min="1" max="30" value="'+L.fps+'"></span>'+
          '</div>'+
          '<button type="button" class="lcoll" title="collapse / expand this layer card">'+(L.collapsed?CHEV_EXPAND:CHEV_COLLAPSE)+'</button>'+
          '<div class="lbody"></div>';
        host.appendChild(card);
        // header wiring
        const lc=card.querySelector('.lcoll');
        lc.addEventListener('click',()=>{ L.collapsed=!L.collapsed; card.classList.toggle('coll',L.collapsed); lc.innerHTML=L.collapsed?CHEV_EXPAND:CHEV_COLLAPSE; saveLayers(); });
        card.querySelector('.le').addEventListener('change',e=>{ L.enabled=e.target.checked; card.classList.toggle('off',!L.enabled); });
        card.querySelector('.ln').addEventListener('input',e=>{ L.name=e.target.value; });
        card.querySelector('.lt').addEventListener('change',e=>{ L.type=e.target.value; E.ensureSettings(L);
          if(L.type==='individual' && L.blend!=='replace'){ L.blend='replace'; const bl=card.querySelector('.lbl'); if(bl) bl.value='replace'; }   // per-key paint defaults to the replace blend (black keys transparent)
          if(L.type==='audio'){ L.blend='multiply'; const bl=card.querySelector('.lbl'); if(bl) bl.value='multiply'; L.opacity=0.85; lo.value=85; lon.value=85; }   // audio visualizer reads best multiplied over a base layer at ~85% (the music keys carve into what's below)
          buildLayerBody(card,L); });
        const lo=card.querySelector('.lo'), lon=card.querySelector('.lon');
        const setOpa=(v,reNum)=>{ v=Math.max(0,Math.min(100,Math.round(v||0))); L.opacity=v/100; lo.value=v; if(reNum) lon.value=v; };
        lo.addEventListener('input',e=>setOpa(+e.target.value,true));
        lon.addEventListener('input',e=>{ if(e.target.value!=='') setOpa(+e.target.value,false); });
        lon.addEventListener('change',e=>setOpa(+e.target.value,true));
        card.querySelector('.lbl').addEventListener('change',e=>{ L.blend=e.target.value; });
        // fps: range <-> number input, synced bidirectionally (min 1 max 30)
        const lf=card.querySelector('.lf'), lfn=card.querySelector('.lfn');
        const setFps=(v,reNum)=>{ v=Math.max(1,Math.min(30,Math.round(v||1))); L.fps=v; lf.value=v; if(reNum) lfn.value=v; };   // 30fps cap — board can't sustain faster full-frame streaming
        lf.addEventListener('input',e=>setFps(+e.target.value,true));
        lfn.addEventListener('input',e=>{ if(e.target.value!=='') setFps(+e.target.value,false); });
        lfn.addEventListener('change',e=>setFps(+e.target.value,true));
        // layer card drag-to-reorder (grip only)
        card.addEventListener('dragstart',e=>{
          if(!e.target.closest('.lgrip')){ e.preventDefault(); return; }   // only the grip starts a card drag
          lcardDragging=card; card.classList.add('ldragging');
          try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain','lcard'); }catch(_){ }
        });
        card.addEventListener('dragend',()=>{ card.classList.remove('ldragging'); lcardDragging=null; });
        buildLayerBody(card,L);
      }
    }
    // ===== layer-card reorder: dragging the grip rearranges the layers array =====
    let lcardDragging=null;
    cards.addEventListener('dragover',e=>{
      if(!lcardDragging) return;   // don't interfere with block-layout drags
      e.preventDefault();
      const after=lcardAfter(cards,e.clientY,e.clientX);
      if(after==null) cards.appendChild(lcardDragging);
      else if(after!==lcardDragging) cards.insertBefore(lcardDragging,after);
    });
    cards.addEventListener('drop',e=>{
      if(!lcardDragging) return;
      e.preventDefault();
      // cards are listed ascending (Layer 1 first); rebuild the layers array straight from DOM order
      const order=[...cards.querySelectorAll('.lcard')].map(c=>state.layers[+c.dataset.n]);
      state.layers.length=0; for(let i=0;i<order.length;i++) state.layers.push(order[i]);   // ascending display: DOM order = array order (first card = Layer 1 = bottom of the stack)
      buildLayerCards();                                  // re-render so labels + dataset.n update
      saveLayerOrder(); saveLayers();
      if(isRunning()){ const now=performance.now(); for(const L of state.layers){ E.renderLayer(L,now,state); L.lastTick=now; } }
    });
    function lcardAfter(host,y,x){
      // row-major 2D walk — the cards sit in a multi-column grid now, so a pure Y-midpoint test ignores
      // horizontal drags entirely (same-row moves never reorder). Above a card's row → before it; within
      // the row and left of its center → before it; otherwise keep walking (= after it).
      const cardEls=[...host.querySelectorAll('.lcard:not(.ldragging)')];
      for(const c of cardEls){ const r=c.getBoundingClientRect();
        if(y < r.top) return c;
        if(y < r.bottom && x < r.left + r.width/2) return c; }
      return null;
    }
    function buildLayerBody(card,L){
      const body=card.querySelector('.lbody'), s=L.settings;
      const row=(label,html)=>'<label>'+label+'</label>'+html;
      if(L.type==='background'){
        body.innerHTML='<div class="ctl">'+
          row('Color','<input type="color" class="s-color" value="'+s.color+'"><span></span>')+
          row('Pulse Period','<input type="range" class="s-period" min="400" max="6000" step="100" value="'+s.period+'"><span class="val s-periodV"></span>')+
          row('Min Brightness','<input type="range" class="s-bgMin" min="0" max="100" value="'+s.bgMin+'"><span class="val s-bgMinV"></span>')+
          row('Max Brightness','<input type="range" class="s-bgMax" min="0" max="100" value="'+s.bgMax+'"><span class="val s-bgMaxV"></span>')+
        '</div>';
        const c=q=>body.querySelector(q);
        c('.s-color').addEventListener('input',e=>s.color=e.target.value);
        const pv=c('.s-periodV'), upP=()=>pv.textContent=(s.period/1000).toFixed(1)+'s';
        c('.s-period').addEventListener('input',e=>{ s.period=+e.target.value; upP(); }); upP();
        const mnv=c('.s-bgMinV'), upMn=()=>mnv.textContent=s.bgMin+'%';
        c('.s-bgMin').addEventListener('input',e=>{ s.bgMin=+e.target.value; upMn(); }); upMn();
        const mxv=c('.s-bgMaxV'), upMx=()=>mxv.textContent=s.bgMax+'%';
        c('.s-bgMax').addEventListener('input',e=>{ s.bgMax=+e.target.value; upMx(); }); upMx();
      } else if(L.type==='reactive'){
        const mode=s.mode||'single', seqSrc=s.seqSrc||'abc';
        const modes=[['single','Single color'],['ab','A–B shimmer'],['rgb','RGB shimmer'],['random','Random'],['sequential','Sequential']];
        const mopt=modes.map(m=>'<option value="'+m[0]+'"'+(m[0]===mode?' selected':'')+'>'+m[1]+'</option>').join('');
        const styles=[['fade','Fade'],['double-blink','Double-blink'],['blink','Blink'],['pulse','Pulse'],['ramp','Ramp (in→out)'],['strobe','Strobe'],['heartbeat','Heartbeat']];
        const sopt=styles.map(m=>'<option value="'+m[0]+'"'+(m[0]===(s.style||'fade')?' selected':'')+'>'+m[1]+'</option>').join('');
        const palDefs=['#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff'];
        const palHtml=[0,1,2,3,4].map(i=>'<input type="color" class="s-pal" data-i="'+i+'" value="'+((s.pal&&s.pal[i])||palDefs[i])+'">').join(' ');
        // decide which color controls this mode needs
        const showA = mode==='single' || mode==='ab' || mode==='rgb' || (mode==='sequential' && seqSrc==='abc');
        const showB = mode==='ab' || mode==='rgb' || (mode==='sequential' && seqSrc==='abc');
        const showC = mode==='rgb' || (mode==='sequential' && seqSrc==='abc');
        const showPal = mode==='random' || (mode==='sequential' && seqSrc==='palette');
        const showAny = mode==='random';
        const aLabel = mode==='single' ? 'Color' : 'Color A';
        let html='<div class="ctl">'+
          row('Mode','<select class="s-mode">'+mopt+'</select><span></span>')+
          row('Style','<select class="s-style">'+sopt+'</select><span></span>');
        if(mode==='sequential'){
          const srcOpt=[['abc','A/B/C'],['palette','Palette']].map(o=>'<option value="'+o[0]+'"'+(o[0]===seqSrc?' selected':'')+'>'+o[1]+'</option>').join('');
          html+=row('Source','<select class="s-seqSrc">'+srcOpt+'</select><span></span>');
        }
        if(showA) html+=row(aLabel,'<input type="color" class="s-color" value="'+s.color+'"><span></span>');
        if(showB) html+=row('Color B','<input type="color" class="s-colorB" value="'+s.colorB+'"><span></span>');
        if(showC) html+=row('Color C','<input type="color" class="s-colorC" value="'+s.colorC+'"><span></span>');
        if(showPal) html+=row('Palette','<span style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">'+palHtml+'</span><span></span>');
        if(showAny) html+=row('Any Color','<label class="sl" style="margin:0"><input type="checkbox" class="s-anyColor"'+(s.anyColor?' checked':'')+'> Full Spectrum (Random Hues)</label><span></span>');
        html+=
          row('Hold','<input type="range" class="s-hold" min="0" max="1000" step="10" value="'+s.hold+'"><span style="display:flex;gap:6px;align-items:center"><input type="number" class="numin s-holdN" min="0" max="1000" value="'+s.hold+'"><span class="val s-holdV"></span></span>')+
          row('Fade','<input type="range" class="s-fade" min="80" max="1500" step="20" value="'+s.fade+'"><span style="display:flex;gap:6px;align-items:center"><input type="number" class="numin s-fadeN" min="80" max="1500" value="'+s.fade+'"><span class="val s-fadeV"></span></span>')+
          row('Isolate','<label class="sl" style="margin:0"><input type="checkbox" class="s-isolate"'+(s.isolate?' checked':'')+'> Punch Through Layers Below</label><span></span>')+
        '</div>';
        body.innerHTML=html;
        // Mode change → store + rebuild body so contextual controls refresh (rebuild re-runs attachHex)
        body.querySelector('.s-mode').addEventListener('change',e=>{ s.mode=e.target.value; buildLayerBody(card,L); });
        body.querySelector('.s-style').addEventListener('change',e=>s.style=e.target.value);
        const seqSel=body.querySelector('.s-seqSrc');
        if(seqSel) seqSel.addEventListener('change',e=>{ s.seqSrc=e.target.value; buildLayerBody(card,L); });
        if(!Array.isArray(s.pal)) s.pal=palDefs.slice();
        body.querySelectorAll('.s-pal').forEach(inp=>inp.addEventListener('input',e=>{ s.pal[+e.target.dataset.i]=e.target.value; }));
        const anyEl=body.querySelector('.s-anyColor'); if(anyEl) anyEl.addEventListener('change',e=>s.anyColor=e.target.checked);
        const colA=body.querySelector('.s-color'); if(colA) colA.addEventListener('input',e=>s.color=e.target.value);
        const colB=body.querySelector('.s-colorB'); if(colB) colB.addEventListener('input',e=>s.colorB=e.target.value);
        const colC=body.querySelector('.s-colorC'); if(colC) colC.addEventListener('input',e=>s.colorC=e.target.value);
        body.querySelector('.s-isolate').addEventListener('change',e=>s.isolate=e.target.checked);
        const hd=body.querySelector('.s-hold'), hdn=body.querySelector('.s-holdN'), hv=body.querySelector('.s-holdV');
        // reNum=true rewrites the number field (slider drag / blur); on typing we update the model+slider
        // but leave the field alone — clamping it mid-keystroke made "9" jump to the min (the Fade bug)
        const setHold=(v,reNum)=>{ v=Math.max(0,Math.min(1000,Math.round(v||0))); s.hold=v; hd.value=v; if(reNum) hdn.value=v; hv.textContent='ms'; };
        hd.addEventListener('input',e=>setHold(+e.target.value,true));
        hdn.addEventListener('input',e=>{ if(e.target.value!=='') setHold(+e.target.value,false); });
        hdn.addEventListener('change',e=>setHold(+e.target.value,true));
        hv.textContent='ms';
        const fd=body.querySelector('.s-fade'), fdn=body.querySelector('.s-fadeN'), fv=body.querySelector('.s-fadeV');
        const setFade=(v,reNum)=>{ v=Math.max(80,Math.min(1500,Math.round(v||80))); s.fade=v; fd.value=v; if(reNum) fdn.value=v; fv.textContent='ms'; };
        fd.addEventListener('input',e=>setFade(+e.target.value,true));
        fdn.addEventListener('input',e=>{ if(e.target.value!=='') setFade(+e.target.value,false); });
        fdn.addEventListener('change',e=>setFade(+e.target.value,true));
        fv.textContent='ms';
      } else if(L.type==='gradient'){
        body.innerHTML='<div class="ctl">'+
          row('Color A','<input type="color" class="s-a" value="'+s.colorA+'"><span></span>')+
          row('Color B','<input type="color" class="s-b" value="'+s.colorB+'"><span></span>')+
          row('Angle','<input type="range" class="s-angle" min="0" max="360" value="'+s.angle+'"><span class="val s-angleV"></span>')+
          row('Scroll','<input type="range" class="s-scroll" min="0" max="100" value="'+Math.round(s.scroll*100)+'"><span class="val s-scrollV"></span>')+
        '</div>';
        const c=q=>body.querySelector(q);
        c('.s-a').addEventListener('input',e=>s.colorA=e.target.value);
        c('.s-b').addEventListener('input',e=>s.colorB=e.target.value);
        const av=c('.s-angleV'), upA=()=>av.textContent=s.angle+'°';
        c('.s-angle').addEventListener('input',e=>{ s.angle=+e.target.value; upA(); }); upA();
        const sv=c('.s-scrollV'), upS=()=>sv.textContent=(s.scroll).toFixed(2);
        c('.s-scroll').addEventListener('input',e=>{ s.scroll=(+e.target.value)/100; upS(); }); upS();
      } else if(L.type==='pattern'){
        const pp=E.patParams(s);                     // per-pattern params — each pattern remembers its own colours/speed/scale/etc.
        const pats=['rainbow','spectrum','radial-rainbow','wave','breathing','ripple','scan','twinkle','rain','fire','comet','gradient-flow','static','snowfall','color-fountain','colorful-interchange','turning-peaks','two-birds','layered-mountains','gentle-rain','back-forth','bloom','plasma','aurora'];
        const pbtns=pats.map(p=>'<button type="button" class="patbtn'+(p===s.pattern?' sel':'')+'" data-p="'+p+'">'+p+'</button>').join('');
        const colModes=[['rainbow','Rainbow'],['c1','Color 1'],['c12','Color 1→2'],['palette','Palette']];
        const cm=pp.colMode||'rainbow';
        const cmOpt=colModes.map(m=>'<option value="'+m[0]+'"'+(m[0]===cm?' selected':'')+'>'+m[1]+'</option>').join('');
        const fountain=(s.pattern==='color-fountain');
        body.innerHTML='<div class="ph" style="margin:0 0 4px">Pattern</div><div class="patgrid">'+pbtns+'</div>'+
          '<div class="ctl">'+
          row('Colors','<select class="s-colMode">'+cmOpt+'</select><span></span>')+
          row('Color 1','<input type="color" class="s-color" value="'+(pp.color||'#00ffff')+'"><span></span>')+
          row('Color 2','<input type="color" class="s-color2" value="'+(pp.color2||'#ff00ff')+'"><span></span>')+
          row('Color 3','<input type="color" class="s-color3" value="'+(pp.color3||'#00ff00')+'"><span></span>')+
          row('Speed','<span class="srange" style="width:100%"><input type="range" class="s-speed" min="0" max="100" value="'+(pp.speed!=null?pp.speed:50)+'"><i class="tick" style="left:calc(7px + (100% - 14px)*0.5)"></i></span><span class="val s-speedV"></span>')+
          row('Scale','<span class="srange" style="width:100%"><input type="range" class="s-scale" min="0" max="100" value="'+(pp.scale!=null?pp.scale:(fountain?50:10))+'"><i class="tick" style="left:calc(7px + (100% - 14px)*'+(fountain?0.5:0.10)+')"></i></span><span style="display:flex;gap:4px;align-items:center"><input type="number" class="numin s-scaleN" min="0" max="100" value="'+(pp.scale!=null?pp.scale:(fountain?50:10))+'"><span class="val">%</span></span>')+
          (fountain ? (
            row('Ring gap','<span class="srange" style="width:100%"><input type="range" class="s-gap" min="0" max="300" value="'+(pp.gap!=null?pp.gap:150)+'"><i class="tick" style="left:calc(7px + (100% - 14px)*0.5)"></i></span><span class="val s-gapV"></span>')+
            row('Ring darkness','<span class="srange" style="width:100%"><input type="range" class="s-ringdark" min="0" max="100" value="'+(pp.ringDark!=null?pp.ringDark:70)+'"><i class="tick" style="left:calc(7px + (100% - 14px)*0.7)"></i></span><span class="val s-ringdarkV"></span>')+
            row('Ring falloff','<span class="srange" style="width:100%"><input type="range" class="s-ringedge" min="0" max="100" value="'+(pp.ringEdge!=null?pp.ringEdge:17)+'"><i class="tick" style="left:calc(7px + (100% - 14px)*0.17)"></i></span><span class="val s-ringedgeV"></span>')+
            row('Center X','<span class="srange" style="width:100%"><input type="range" class="s-cx" min="-50" max="50" value="'+(pp.cox!=null?pp.cox:-8)+'"><i class="tick" style="left:calc(7px + (100% - 14px)*0.5)"></i></span><span class="val s-cxV"></span>')+
            row('Center Y','<span class="srange" style="width:100%"><input type="range" class="s-cy" min="-50" max="50" value="'+(pp.coy!=null?pp.coy:-10)+'"><i class="tick" style="left:calc(7px + (100% - 14px)*0.5)"></i></span><span class="val s-cyV"></span>')
          ) : '')+
        '</div>';
        const c=q=>body.querySelector(q);
        body.querySelectorAll('.patbtn').forEach(btn=>btn.addEventListener('click',()=>{ s.pattern=btn.dataset.p; buildLayerBody(card,L); scheduleSaveLayers();   // rebuild → restores that pattern's own saved params + its pattern-specific controls
        onPatternPick();   // page hook: picking a pattern while a firmware effect is showing = "back to layers", no extra click
      }));
        c('.s-colMode').addEventListener('change',e=>{ pp.colMode=e.target.value; scheduleSaveLayers(); });
        c('.s-color').addEventListener('input',e=>pp.color=e.target.value);
        c('.s-color2').addEventListener('input',e=>pp.color2=e.target.value);
        c('.s-color3').addEventListener('input',e=>pp.color3=e.target.value);
        const spv=c('.s-speedV'), upSp=()=>spv.textContent=(pp.speed!=null?pp.speed:50)+'%';
        c('.s-speed').addEventListener('input',e=>{ snap(e.target,50,4); pp.speed=+e.target.value; upSp(); }); upSp();
        const scsl=c('.s-scale'), scn=c('.s-scaleN');
        scsl.addEventListener('input',e=>{ snap(e.target,fountain?50:10,4); const v=Math.max(0,Math.min(100,Math.round(+e.target.value||0))); pp.scale=v; scn.value=v; });
        scn.addEventListener('input',e=>{ const v=Math.max(0,Math.min(100,Math.round(+e.target.value||0))); pp.scale=v; scsl.value=v; });   // type-in; don't reformat while typing
        const gp=c('.s-gap'); if(gp){ const gpv=c('.s-gapV'), upGp=()=>{ gpv.textContent=(pp.gap!=null?pp.gap:150)+'%'; }; gp.addEventListener('input',e=>{ snap(e.target,150,8); pp.gap=+e.target.value; upGp(); }); upGp();
          const rd=c('.s-ringdark'), rdv=c('.s-ringdarkV'), upRd=()=>{ rdv.textContent=(pp.ringDark!=null?pp.ringDark:70)+'%'; }; rd.addEventListener('input',e=>{ snap(e.target,70,4); pp.ringDark=+e.target.value; upRd(); }); upRd();
          const edgeWord=v=>v<34?'hard':v<67?'medium':'soft';   // describe the edge, not a % (hard = left, soft = right)
          const re=c('.s-ringedge'), rev=c('.s-ringedgeV'), upRe=()=>{ rev.textContent=edgeWord(pp.ringEdge!=null?pp.ringEdge:17); }; re.addEventListener('input',e=>{ snap(e.target,17,4); pp.ringEdge=+e.target.value; upRe(); }); upRe();
          const sgn=v=>(v>0?'+':'')+v;
          const cxi=c('.s-cx'), cxv=c('.s-cxV'), upCx=()=>{ cxv.textContent=sgn(pp.cox!=null?pp.cox:-8); }; cxi.addEventListener('input',e=>{ snap(e.target,0,3); pp.cox=+e.target.value; upCx(); }); upCx();
          const cyi=c('.s-cy'), cyv=c('.s-cyV'), upCy=()=>{ cyv.textContent=sgn(pp.coy!=null?pp.coy:-10); }; cyi.addEventListener('input',e=>{ snap(e.target,0,3); pp.coy=+e.target.value; upCy(); }); upCy(); }
      } else if(L.type==='individual'){
        if(!s.keys||typeof s.keys!=='object') s.keys={};
        if(s.current===undefined) s.current='#ff8c00';
        body.innerHTML='<div class="ctl">'+
          row('Paint color','<input type="color" class="s-current" value="'+s.current+'"><span></span>')+
          row('','<button class="s-showkb" type="button">⌨ Show Keyboard</button><span class="val s-selcount" style="margin-left:8px"></span>')+
          row('','<button class="s-clearsel" type="button">Clear selection</button> <button class="s-clearall" type="button">Clear all</button>')+
        '</div>';
        const c=q=>body.querySelector(q);
        let pb=null, wrap=null;
        const reRender=()=>{ L.lastTick=0; };   // force the running layer loop to repaint next frame
        const updCount=()=>{ const el=c('.s-selcount'); if(el) el.textContent = pb ? (pb.selCount()+' selected') : ''; };
        function mountBoard(){
          if(pb) return;
          wrap=document.createElement('div'); wrap.className='pb-wrap pb-large';
          wrap.innerHTML='<div class="pb-board"></div><div class="pb-hint">Click/drag to paint · Shift+ add · Ctrl+ deselect · Alt+drag erase · pick a color to recolor the selection</div>';
          card.parentNode.insertBefore(wrap, card);   // wedge the board directly ABOVE this layer card
          pb=root_PaintBoard().mount(wrap.querySelector('.pb-board'), {
            engine:E, getKeys:()=>s.keys, getColor:()=>s.current,
            onPaint:(idx,hex)=>{ if(hex) s.keys[idx]=hex; else delete s.keys[idx]; reRender(); },
            onChange:()=>{ updCount(); scheduleSaveLayers(); },
          });
          c('.s-showkb').textContent='⌨ Hide Keyboard'; updCount();
        }
        function unmountBoard(){ if(!pb) return; pb.destroy(); pb=null; if(wrap&&wrap.parentNode) wrap.parentNode.removeChild(wrap); wrap=null; c('.s-showkb').textContent='⌨ Show Keyboard'; updCount(); }
        c('.s-current').addEventListener('input',e=>{ s.current=e.target.value; if(pb) pb.recolorSelection(); });
        c('.s-showkb').addEventListener('click',()=>{ pb?unmountBoard():mountBoard(); });
        c('.s-clearsel').addEventListener('click',()=>{ if(pb){ pb.clearSelection(); } reRender(); scheduleSaveLayers(); });
        c('.s-clearall').addEventListener('click',()=>{ s.keys={}; if(pb){ pb.selectNone(); pb.draw(); } reRender(); scheduleSaveLayers(); });
      } else if(L.type==='audio'){
        const style=s.style||'bars', uid=card.dataset.n;
        // Phase 1 drives a synthetic signal for ALL sources, so only System is wired; App/Tab/Mic are
        // disabled (greyed) until real per-source capture lands (Plan 1b) — no dead controls that lie.
        const sources=[['system','All system audio',true],['app','Specific app',false],['tab','This tab',false],['mic','Mic / line-in',false]];
        const srcBubbles=sources.map(o=>{ const dis=!o[2]; return '<label class="sl" style="margin:0 8px 0 0'+(dis?';opacity:.4':'')+'"'+(dis?' title="real per-source capture lands in the next update (Plan 1b)"':'')+'><input type="radio" name="aud-src-'+uid+'" class="s-source" value="'+o[0]+'"'+((o[0]===(s.source||'system'))?' checked':'')+(dis?' disabled':'')+'> '+o[1]+(dis?' — soon':'')+'</label>'; }).join('');
        const styles=[['bars','Spectrum bars'],['pulse','Beat pulse'],['bloom','Radial bloom'],['wave','Waveform']];
        const sopt=styles.map(m=>'<option value="'+m[0]+'"'+(m[0]===style?' selected':'')+'>'+m[1]+'</option>').join('');
        let html='<div class="ctl">'+
          row('Source','<span style="display:flex;flex-wrap:wrap;align-items:center">'+srcBubbles+'</span><span></span>')+
          row('Source note','<span class="val" style="opacity:.7">Phase 1: driven by a synthetic test signal — real capture lands next.</span><span></span>')+
          row('Style','<select class="s-style">'+sopt+'</select><span></span>')+
          row('Preview','<div style="display:flex;flex-direction:column;gap:5px"><button type="button" class="s-prevToggle" style="align-self:flex-start">'+(s.previewOff?'Show preview':'Hide preview')+'</button><canvas class="s-audioPrev" width="378" height="108" style="width:100%;height:auto;display:'+(s.previewOff?'none':'block')+';background:#0d1117;border-radius:8px"></canvas></div><span></span>');
        if(style==='bars') html+=
          row('Bass color','<input type="color" class="s-barColorBass" value="'+s.barColorBass+'"><span></span>')+
          row('Treble color','<input type="color" class="s-barColorTreble" value="'+s.barColorTreble+'"><span></span>');
        else if(style==='pulse') html+=row('Color','<input type="color" class="s-pulseColor" value="'+s.pulseColor+'"><span></span>');
        else if(style==='bloom') html+=row('Color','<input type="color" class="s-bloomColor" value="'+s.bloomColor+'"><span></span>');
        else if(style==='wave')  html+=row('Color','<input type="color" class="s-waveColor" value="'+s.waveColor+'"><span></span>')+
          row('Direction','<label class="sl" style="margin:0"><input type="checkbox" class="s-waveReverse"'+(s.waveReverse?' checked':'')+'> Reverse flow</label><span></span>');
        // Dim-while-active: pick OTHER layers to quiet while this audio layer is emitting, each with its
        // own max-brightness slider — so the music keys read against a darker base. Stored in s.ducks.
        if(!Array.isArray(s.ducks)) s.ducks=[];
        const myIdx=+card.dataset.n, esc=t=>(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
        const duckOf=i=>s.ducks.find(d=>d&&d.layer===i);
        const duckRows=state.layers.map((L2,i)=>({L2,i})).filter(o=>o.i!==myIdx).map(o=>{
          const d=duckOf(o.i), on=!!d, dim=on?d.dim:30;
          return row('',
            '<label class="sl" style="margin:0"><input type="checkbox" class="s-duckOn" data-i="'+o.i+'"'+(on?' checked':'')+'> Layer '+(o.i+1)+' · '+esc(o.L2.name)+'</label>'+
            '<span style="display:flex;gap:6px;align-items:center"><input type="range" class="s-duckDim" data-i="'+o.i+'" min="0" max="100" value="'+dim+'"'+(on?'':' disabled')+' title="Max brightness this layer is allowed while the music is showing"><span class="val s-duckDimV" data-i="'+o.i+'">'+dim+'%</span></span>');
        }).join('');
        html+=
          row('Gain','<span class="srange" style="width:100%"><input type="range" class="s-gain" min="50" max="300" value="'+Math.round((s.gain||1)*100)+'" title="Boost/cut input sensitivity before it drives the keys"><i class="tick" style="left:calc(7px + (100% - 14px)*0.2)"></i></span><span class="val s-gainV"></span>')+
          row('Noise floor','<span class="srange" style="width:100%"><input type="range" class="s-floor" min="0" max="40" value="'+s.floor+'" title="Gate out quiet hiss below this level so idle keys stay dark"><i class="tick" style="left:calc(7px + (100% - 14px)*0.125)"></i></span><span class="val s-floorV"></span>')+
          row('Attack','<span class="srange" style="width:100%"><input type="range" class="s-attackMs" min="0" max="300" step="5" value="'+s.attackMs+'" title="How fast keys brighten on a rise (ms). Lower = snappier"><i class="tick" style="left:calc(7px + (100% - 14px)*0.133)"></i></span><span class="val s-attackMsV"></span>')+
          row('Decay','<span class="srange" style="width:100%"><input type="range" class="s-decayMs" min="40" max="800" step="10" value="'+s.decayMs+'" title="How slowly keys fade after a peak (ms). Higher = smoother"><i class="tick" style="left:calc(7px + (100% - 14px)*0.237)"></i></span><span class="val s-decayMsV"></span>')+
          row('Beat sensitivity','<span class="srange" style="width:100%"><input type="range" class="s-beatSens" min="0" max="100" value="'+s.beatSens+'" title="How strongly kicks/onsets pop in pulse and bloom"><i class="tick" style="left:calc(7px + (100% - 14px)*0.5)"></i></span><span class="val s-beatSensV"></span>')+
          (duckRows ? row('Dim while active','<span class="val" style="opacity:.7">quiet these layers while the music shows</span><span></span>')+duckRows : '')+
          row('','<button type="button" class="s-logVals">Log current values</button><span></span>')+
        '</div>';
        body.innerHTML=html;
        const c=q=>body.querySelector(q);
        body.querySelectorAll('.s-source').forEach(r=>r.addEventListener('change',e=>{ s.source=e.target.value; }));
        c('.s-style').addEventListener('change',e=>{ s.style=e.target.value; buildLayerBody(card,L); });
        ['barColorBass','barColorTreble','pulseColor','bloomColor','waveColor'].forEach(key=>{ const el=c('.s-'+key); if(el) el.addEventListener('input',e=>s[key]=e.target.value); });
        { const wr=c('.s-waveReverse'); if(wr) wr.addEventListener('change',e=>s.waveReverse=e.target.checked); }
        const slider=(cls,key,fmt,xform,snapTo)=>{ const el=c('.s-'+cls), v=c('.s-'+cls+'V'); if(!el||!v) return; const up=()=>v.textContent=fmt(s[key]); el.addEventListener('input',e=>{ if(snapTo!=null) snap(el,snapTo,4); s[key]=xform(+el.value); up(); }); up(); };   // guard !v so a class mismatch can't crash init; snap to the default tick
        slider('gain','gain',x=>Math.round(x*100)+'%',v=>v/100,100);
        slider('floor','floor',x=>x+'%',v=>v,5);
        slider('attackMs','attackMs',x=>x+'ms',v=>v,40);
        slider('decayMs','decayMs',x=>x+'ms',v=>v,220);
        slider('beatSens','beatSens',x=>x+'%',v=>v,50);
        body.querySelectorAll('.s-duckOn').forEach(cb=>cb.addEventListener('change',e=>{
          const i=+e.target.dataset.i, sl=body.querySelector('.s-duckDim[data-i="'+i+'"]');
          if(!Array.isArray(s.ducks)) s.ducks=[];
          if(e.target.checked){ if(!s.ducks.find(d=>d&&d.layer===i)) s.ducks.push({layer:i, dim:sl?+sl.value:30}); if(sl) sl.disabled=false; }
          else { s.ducks=s.ducks.filter(d=>d&&d.layer!==i); if(sl) sl.disabled=true; }
        }));
        body.querySelectorAll('.s-duckDim').forEach(sl=>sl.addEventListener('input',e=>{
          const i=+e.target.dataset.i, v=+e.target.value, lab=body.querySelector('.s-duckDimV[data-i="'+i+'"]');
          if(lab) lab.textContent=v+'%';
          const d=Array.isArray(s.ducks)&&s.ducks.find(x=>x&&x.layer===i); if(d) d.dim=v;   // only persists once the layer is checked on
        }));
        c('.s-logVals').addEventListener('click',()=>console.log('[audio layer "'+L.name+'"]', JSON.parse(JSON.stringify(s))));
        { const tb=c('.s-prevToggle'), cvp=c('.s-audioPrev'); if(tb&&cvp) tb.addEventListener('click',()=>{ s.previewOff=!s.previewOff; cvp.style.display=s.previewOff?'none':'block'; tb.textContent=s.previewOff?'Show preview':'Hide preview'; }); }
        // Live preview: drive a scratch audio layer off the synthetic feed and paint the keys onto a canvas.
        // Reads s each frame so style/colors/tuning/reverse update live; runs independent of the device.
        (function(){
          const cv=c('.s-audioPrev'); if(!cv||!cv.getContext) return;
          const ctx=cv.getContext('2d'), W=cv.width, H=cv.height;
          const pState={ audio:{ bands:new Float32Array(32), level:0, beat:0, centroid:0.5, _t:0 } };
          const pL={ type:'audio', settings:s, rgb:new Uint8Array(E.NLED*3) };
          if(!window._audSynthPrev && window.TH108AudioSynth) window._audSynthPrev=TH108AudioSynth.createSynth();
          const synth=window._audSynthPrev;
          function frame(now){
            if(!document.body.contains(cv)) return;                 // card rebuilt/removed → stop this loop
            if(cv.offsetParent!==null && synth){                    // skip work while the card is collapsed/hidden
              E.applyAudioFeatures(pState, synth.sample(now/1000), s, now);
              E.renderAudio(pL, now, pState);
              ctx.clearRect(0,0,W,H);
              for(let k=0;k<E.NLED;k++){ const cell=E.keyCell(E.INDICES[k]); if(!cell) continue;
                const o=k*3, x=(cell[0]-cell[2]/2)*W, y=(cell[1]-cell[3]/2)*H, w=cell[2]*W, h=cell[3]*H;
                ctx.fillStyle='rgb('+pL.rgb[o]+','+pL.rgb[o+1]+','+pL.rgb[o+2]+')';
                ctx.fillRect(x+0.5,y+0.5,Math.max(1,w-1),Math.max(1,h-1));
              }
            }
            requestAnimationFrame(frame);
          }
          requestAnimationFrame(frame);
        })();
      } else {   // media — Stage 1 placeholder
        body.innerHTML='<div class="ph">Media layer — port of the GIF engine lands in Stage 2. (Use the GIF → keyboard panel below for now.)</div>';
      }
      buildAdjustBlock(body,L);   // shared per-layer adjust controls appended to every type
      attachHex(body);            // typeable hex box on every color picker (incl. reactive palette)
    }
    // shared "Adjust" block (brightness / saturation / contrast / gamma / rotate / speed + Static) on every card
    function buildAdjustBlock(body,L){
      const s=L.settings;
      // [label, rawMin, rawMax, decimals, unit, default] — decimals>0 → number shows raw/100 (gamma 1.00, speed 1.0×); slider stays raw
      const CFG={ bri:['Brightness',0,200,0,'%',100], sat:['Saturation',0,300,0,'%',100], con:['Contrast',50,250,0,'%',100],
                  gam:['Gamma',50,300,2,'',100], rot:['Rotate',0,360,0,'°',0] };   // (per-layer "Speed" removed — each layer type has its own speed/period/scroll)
      // Individual-keys layers paint EXACT colors; brightness >100% per-channel-boosts and clips → shifts the
      // painted hue. Cap it at 100% (dim-only, never distorts) and pull any already-saved >100 value back down.
      if(L.type==='individual'){ CFG.bri=['Brightness',0,100,0,'%',100]; if(s.bri>100) s.bri=100; }
      const disp=(key,raw)=>{ const d=CFG[key][3]; return d?(raw/100).toFixed(d):String(raw); };
      const ctl=key=>{ const c=CFG[key], dec=c[3], frac=(c[5]-c[1])/(c[2]-c[1]);   // tick at the default value
        const nMin=dec?c[1]/100:c[1], nMax=dec?c[2]/100:c[2], nStep=dec?1/Math.pow(10,dec):1;
        return '<label>'+c[0]+'</label>'+
          '<span class="srange" style="width:100%;min-width:30px"><input type="range" class="a-'+key+'" min="'+c[1]+'" max="'+c[2]+'" value="'+s[key]+'"><i class="tick" style="left:calc(7px + (100% - 14px)*'+frac+')"></i></span>'+
          '<span style="display:flex;gap:4px;align-items:center"><input type="number" class="numin a-'+key+'N" min="'+nMin+'" max="'+nMax+'" step="'+nStep+'" value="'+disp(key,s[key])+'"><span class="val" style="min-width:10px">'+c[4]+'</span></span>'; };
      const adj=document.createElement('div');
      adj.innerHTML=
        '<div class="lbody" style="margin-top:8px"><div class="ph" style="margin-bottom:6px">Adjust</div><div class="ctl">'+
          ctl('bri')+ctl('sat')+ctl('con')+ctl('gam')+ctl('rot')+
          '<label>Static</label><label class="sl" style="margin:0"><input type="checkbox" class="a-frozen"'+(s.frozen?' checked':'')+'> Freeze Animation</label><span></span>'+
        '</div></div>';
      body.appendChild(adj.firstChild);
      Object.keys(CFG).forEach(key=>{ const c=CFG[key], min=c[1], max=c[2], dec=c[3], def=c[5], thr=Math.max(1,Math.round((max-min)*0.03));
        const rng=body.querySelector('.a-'+key), num=body.querySelector('.a-'+key+'N');
        const apply=raw=>{ raw=Math.max(min,Math.min(max,Math.round(raw||0))); s[key]=raw; rng.value=raw; return raw; };
        rng.addEventListener('input',e=>{ snap(e.target, def, thr); num.value=disp(key,apply(+e.target.value)); });   // snap+flash at default
        num.addEventListener('input',e=>{ const v=parseFloat(e.target.value); if(!isNaN(v)) apply(dec?v*100:v); });   // don't reformat while typing
        rng.value=s[key]; num.value=disp(key,s[key]);
      });
      body.querySelector('.a-frozen').addEventListener('change',e=>{ s.frozen=e.target.checked; });
    }

    function init(){
      restoreLayers();                            // bring back saved layer settings from a previous session (overlays onto the engine state in place)
      state.layers.forEach(E.ensureSettings);     // backfill any missing fields
      buildLayerCards();
      panel.addEventListener('input', scheduleSaveLayers);    // persist edits (debounced)
      panel.addEventListener('change', scheduleSaveLayers);
    }

    return { init, buildCards: buildLayerCards, save: saveLayers, scheduleSave: scheduleSaveLayers, restore: restoreLayers };
  }

  return { create, serializeLayers, serializeOrder, overlayLayers, TYPES, BLENDS };
});
