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
          onPatternPick = opts.onPatternPick || noop,                   // page hook: picking a pattern while a firmware effect shows = "back to layers"
          onAudioSource = opts.onAudioSource || noop,                   // page hook: audio-layer source pick → start/stop in-tab Web Audio capture
          liveAudioActive = opts.liveAudioActive || (()=>false);        // page hook: is real in-tab capture running? (Live preview blanks when not)

    // ----- persist full layer state (settings survive page refresh) -----
    let _slsT=0;
    function saveLayers(){ try{ localStorage.setItem('th108_layers', JSON.stringify(serializeLayers(state.layers))); }catch(_){ } }
    function scheduleSaveLayers(){ clearTimeout(_slsT); _slsT=setTimeout(()=>{ saveLayers(); pushConfig(); },400); }   // mirror the edit to the daemon's config.json (no-op if no daemon)
    function restoreLayers(){ try{ overlayLayers(state.layers, JSON.parse(localStorage.getItem('th108_layers')||'null')); }catch(_){ } }
    // Per-STYLE render settings (Adjust/crop/pause/ducks share flat key NAMES across styles, so without this they
    // leak between styles WITHIN a source). Bucketed in s.sv[style]; on a style switch we snapshot the outgoing
    // style's flat values, then restore the incoming style's.
    const VARIANT_SHARED_KEYS = ['bri','sat','con','gam','spd','frozen','pauseStyle','cropOn','cropFit','cropX','cropY','cropW','cropH'];
    function saveVariantVals(s, key){ if(!s.sv) s.sv={}; const b=s.sv[key]||(s.sv[key]={}); VARIANT_SHARED_KEYS.forEach(k=>{ if(s[k]!==undefined) b[k]=s[k]; }); b.ducks = Array.isArray(s.ducks)?JSON.parse(JSON.stringify(s.ducks)):[]; }
    function loadVariantVals(s, key){ const b=s.sv&&s.sv[key]; if(!b) return;
      VARIANT_SHARED_KEYS.forEach(k=>{ if(b[k]!==undefined) s[k]=b[k]; }); if(b.ducks!==undefined) s.ducks=JSON.parse(JSON.stringify(b.ducks)); }
    function swapVariant(s, oldKey, newKey){ if(oldKey===newKey) return; saveVariantVals(s, oldKey); loadVariantVals(s, newKey); }
    // Per-SOURCE full-look isolation: each source (System/App/Tab/Mic) is its own profile — style + all appearance +
    // tuning (ap) + render bucket (sv) + adjust + crop + pause + ducks. Everything in `s` EXCEPT the source/device/
    // mic-input/hotkey config (which is what *selects* the source) is snapshotted per source in s.bySource. A
    // never-visited source starts fresh from defaults (ensureSettings), so sources don't bleed into each other.
    const SRC_KEEP = new Set(['source','appId','deviceId','micGain','micGate','toggleKeyLed','toggleKeyLabel','samplePrevOff','livePrevOff','_copyUndo','bySource']);
    function snapshotLook(s){ const o={}; for(const k in s){ if(!SRC_KEEP.has(k)) o[k]=s[k]; } return JSON.parse(JSON.stringify(o)); }
    function switchSource(s, L, oldSrc, newSrc){ if(oldSrc===newSrc) return;
      s.bySource = s.bySource || {};
      s.bySource[oldSrc] = snapshotLook(s);                                   // save the outgoing source's whole look
      const saved = s.bySource[newSrc];
      for(const k of Object.keys(s)) if(!SRC_KEEP.has(k)) delete s[k];          // clear the look
      s.source = newSrc;
      if(saved){ const copy=JSON.parse(JSON.stringify(saved)); for(const k in copy) s[k]=copy[k]; }   // restore (or leave cleared → ensureSettings fills defaults for a fresh source)
      E.ensureSettings(L); }
    function saveLayerOrder(){ try{ localStorage.setItem('th108_layerOrder', JSON.stringify(serializeOrder(state.layers))); }catch(_){ } }

    // ===== layer cards UI (built from the layers array; Layer 1 listed first) =====
    function buildLayerCards(){
      const host=cards; host.innerHTML='';
      // ascending — Layer 1 (bottom of the stack) reads first, Layer 4 (top) last (user request 2026-06-11)
      for(let n=0;n<state.layers.length;n++){
        const L=state.layers[n], card=document.createElement('div');
        card.className='lcard'+(L.enabled?'':' off')+(L.collapsed?' coll':''); card.dataset.n=n;
        const opt=(arr,sel)=>arr.map(v=>'<option'+(v===sel?' selected':'')+'>'+v+'</option>').join('');
        const usedT=new Set(state.layers.filter(o=>o!==L).map(o=>o.type));   // one layer per type → grey out types already taken by another layer
        const tOpt=TYPES.map(v=>'<option'+(v===L.type?' selected':'')+(usedT.has(v)?' disabled':'')+'>'+v+'</option>').join('');
        card.innerHTML=
          '<div class="lhead">'+
            '<span class="lgrip" title="drag to change layer level">⠿</span>'+   // drag handle for the page's pointer-based card-drag system (same lift/clone/breach-line as the Home cards)
            '<span class="llvl">Layer '+(n+1)+'</span>'+
            '<input type="checkbox" class="le"'+(L.enabled?' checked':'')+' title="enable layer">'+
            '<input type="text" class="ln" value="'+L.name.replace(/"/g,'&quot;')+'">'+
            '<select class="lt">'+tOpt+'</select>'+
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
        card.querySelector('.lt').addEventListener('change',e=>{
          if(e.target.value!==L.type && state.layers.some(o=>o!==L && o.type===e.target.value)){ e.target.value=L.type; return; }   // one layer per type (guard in case a disabled option is forced)
          L.type=e.target.value; E.ensureSettings(L);
          if(L.type==='individual' && L.blend!=='replace'){ L.blend='replace'; const bl=card.querySelector('.lbl'); if(bl) bl.value='replace'; }   // per-key paint defaults to the replace blend (black keys transparent)
          if(L.type==='audio'){ L.blend='add'; const bl=card.querySelector('.lbl'); if(bl) bl.value='add'; L.opacity=0.85; lo.value=85; lon.value=85; }   // audio visualizer = ADD so its keys have their OWN light (multiply has none → dimming the base dims the audio too, and the visualizer is invisible without a bright base). 'add' lets the keys pop and the Dim-while-active contrast actually work.
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
        buildLayerBody(card,L);
      }
    }
    // Rebuild the layers array from the cards' DOM order — called after a grip drag settles by the page's
    // shared pointer-based card-drag system (same lift/clone/breach-line as the Home cards). Cards list
    // ascending, so DOM order = array order (first card = Layer 1 = bottom of the stack).
    function reorderFromDom(){
      const order=[...cards.querySelectorAll('.lcard')].map(c=>state.layers[+c.dataset.n]).filter(Boolean);
      if(order.length!==state.layers.length) return;   // safety: never drop a layer if the DOM is mid-rebuild
      state.layers.length=0; for(let i=0;i<order.length;i++) state.layers.push(order[i]);
      buildLayerCards();                                // re-render so labels + dataset.n update
      saveLayerOrder(); saveLayers(); pushConfig();
      if(isRunning()){ const now=performance.now(); for(const L of state.layers){ E.renderLayer(L,now,state); L.lastTick=now; } }
    }
    function buildLayerBody(card,L){
      const body=card.querySelector('.lbody'), s=L.settings;
      const row=(label,html)=>'<p class="lrow"><label>'+label+'</label>'+html+'</p>';   // each row a subgrid wrapper → zebra-stripable (CSS .lrow:nth-of-type)
      const sec=t=>'<div class="lsec">'+t+'</div>';      // main section header (full-width, rule above)
      const sub=t=>'<div class="lsub">'+t+'</div>';      // subsection header (full-width, shorter/lighter rule)
      const full=html=>'<div class="lfull">'+html+'</div>';   // a control block that spans the whole grid under a header
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
        if(s.fill===undefined) s.fill='solid';
        const fillOpt=[['solid','Solid'],['subtract','Subtract (silhouette)']].map(o=>'<option value="'+o[0]+'"'+(o[0]===s.fill?' selected':'')+'>'+o[1]+'</option>').join('');
        const isSub=s.fill==='subtract';
        body.innerHTML='<div class="ctl">'+
          sec('Fill')+
          full('<select class="s-fill" title="Solid = paint exact key colors. Subtract = the painted keys carve the layers below into a dark silhouette (negative space) — needs a layer beneath to cut into.">'+fillOpt+'</select>')+
          sub('Paint')+
          full('<input type="color" class="s-current" value="'+s.current+'"><span class="val s-fillNote" style="opacity:.7;flex:1 1 100%">'+(isSub?'In Subtract the paint color is ignored — you’re choosing which keys to carve into a silhouette.':'Pick a color, Show Keyboard, then click/drag keys to paint them.')+'</span>')+
          full('<button class="s-showkb" type="button">⌨ Show Keyboard</button><span class="val s-selcount"></span>')+
          full('<button class="s-clearsel" type="button">Clear selection</button><button class="s-clearall" type="button">Clear all</button>')+
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
        c('.s-fill').addEventListener('change',e=>{ s.fill=e.target.value;   // update the note in place (no rebuild — that would orphan the mounted paint board, which is a card sibling)
          const note=c('.s-fillNote'); if(note) note.textContent = s.fill==='subtract'
            ? 'In Subtract the paint color is ignored — you’re choosing which keys to carve into a silhouette.'
            : 'Pick a color, Show Keyboard, then click/drag keys to paint them.';
          reRender(); scheduleSaveLayers(); });
        c('.s-current').addEventListener('input',e=>{ s.current=e.target.value; if(pb) pb.recolorSelection(); });
        c('.s-showkb').addEventListener('click',()=>{ pb?unmountBoard():mountBoard(); });
        c('.s-clearsel').addEventListener('click',()=>{ if(pb){ pb.clearSelection(); } reRender(); scheduleSaveLayers(); });
        c('.s-clearall').addEventListener('click',()=>{ s.keys={}; if(pb){ pb.selectNone(); pb.draw(); } reRender(); scheduleSaveLayers(); });
      } else if(L.type==='audio'){
        const style=s.style||'bars', uid=card.dataset.n;
        // All four sources are live: system + app run through the background daemon (loopback / process-loopback);
        // tab + mic are captured in-tab via Web Audio. App needs the daemon (it spawns app-capture.exe).
        const sources=[['system','All System Audio',true],['app','Specific App',true],['tab','Specific Tab',true],['mic','Mic / Line-in',true]];   // 'tab' = getDisplayMedia: you pick which tab/window to share (NOT this page — this site emits no sound), so "Specific Tab"
        const srcBubbles=sources.map(o=>{ const dis=!o[2]; return '<label class="sl" style="margin:0'+(dis?';opacity:.4':'')+'"><input type="radio" name="aud-src-'+uid+'" class="s-source" value="'+o[0]+'"'+((o[0]===(s.source||'system'))?' checked':'')+(dis?' disabled':'')+'> '+o[1]+'</label>'; }).join('');
        const styles=[['bars','Spectrum Bars'],['pulse','Beat Pulse'],['bloom','Radial Bloom'],['wave','Waveform'],['aurora','Aurora'],['sparkle','Starfield']];
        const sopt=styles.map(m=>'<option value="'+m[0]+'"'+(m[0]===style?' selected':'')+'>'+m[1]+'</option>').join('');
        const esc=t=>(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
        let html='<div class="ctl">'+
          sec('Source')+
          full('<span style="display:grid;grid-template-columns:auto auto;gap:7px 24px;justify-content:center;flex:1 1 100%">'+srcBubbles+'</span>')+
          full('<span class="val s-srcNow" style="opacity:.8;flex:1 1 100%;text-align:center;font-size:12px;min-height:1em"></span>')+   // "▶ what's playing" (tab/mic = shared-tab title; + a hint when this tab isn't driving the keyboard)
          full('<span class="val" style="opacity:.55;flex:1 1 100%;text-align:center;font-size:12px;line-height:1.4">Specific Tab is captured in this page — it only shows on the keyboard while this site is open AND driving it (Connect Keyboard / Drive from this Tab). System Audio, Specific App &amp; Mic / Line-in run in the daemon (they work with this page closed).</span>')+   // centered note: the tab capture-location gotcha, stated up front
          (s.source==='app' ? sub('Specific App')+full('<select class="s-appId" style="max-width:180px"></select><button type="button" class="s-appRefresh" title="rescan currently-playing apps" style="flex:none">Refresh</button><span class="val s-appNote" style="opacity:.7"></span>') : '')+
          (s.source==='mic' ? sub('Mic Input')+
            row('Mic Gain','<span class="srange" style="width:100%"><input type="range" class="s-micGain" min="0" max="1000" step="1" value="'+Math.round(1000*Math.log((s.micGain==null?100:s.micGain)/50)/Math.log(144))+'" title="SENSITIVITY — how little input drives the bars to full (LOG scale: each step is a meaningful multiplier, 50% … 7200%). Higher = less voice/volume needed to fill the board."></span><span class="val s-micGainV"></span>')+
            row('Noise Gate','<span class="srange" style="width:100%"><input type="range" class="s-micGate" min="0" max="12" step="0.25" value="'+(s.micGate==null?0:s.micGate)+'" title="Mute the keys until the mic exceeds this absolute level — raise it just above your room/fan noise so background hum stops lighting the board. Scaled 0–12% to match a real mic’s RMS range. 0 = off"><i class="tick" style="left:calc(7px + (100% - 14px)*0.0)"></i></span><span class="val s-micGateV"></span>')+
            row('Input Level','<span style="position:relative;display:block;width:100%;height:11px;background:#0d1117;border-radius:6px;overflow:hidden;border:1px solid var(--border)"><span class="s-micMeterFill" style="position:absolute;left:0;top:0;bottom:0;width:0%;background:linear-gradient(90deg,#2ea043,#d29922 80%,#f85149);border-radius:6px"></span><span class="s-micMeterGate" style="position:absolute;top:-1px;bottom:-1px;width:2px;background:#e0a200;left:0%"></span></span><span class="val" style="opacity:.6">live mic level (yellow line = gate)</span>')+
            row('Toggle Hotkey','<span style="display:flex;gap:6px;align-items:center;justify-content:center"><button type="button" class="s-bindKey">'+(s.toggleKeyLabel?('⌨ '+esc(s.toggleKeyLabel)):'Bind a key…')+'</button>'+(s.toggleKeyLed!=null?'<button type="button" class="s-bindClear" title="unbind" style="flex:none;padding:2px 8px">✕</button>':'')+'</span><span></span>')+
            full('<span class="val" style="opacity:.6;flex:1 1 100%;text-align:center;font-size:12px;line-height:1.4">Press it in any app to flip Mic lighting on/off — works with this page closed (the daemon must be running)</span>') : '')+
          sec('Style')+ '<div class="lfull" style="justify-content:center"><select class="s-style">'+sopt+'</select></div>'+   // no left label → center it under the header
          sec('Preview')+ full('<div style="display:flex;flex-direction:column;gap:9px;flex:1 1 100%">'+
            '<div><div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:3px"><span class="val" style="opacity:.65">Sample — test signal</span><button type="button" class="s-samplePrevToggle">'+(s.samplePrevOff?'Show':'Hide')+'</button></div>'+
              '<canvas class="s-audioPrev" width="378" height="92" style="width:100%;height:auto;display:'+(s.samplePrevOff?'none':'block')+';background:#0d1117;border-radius:8px"></canvas></div>'+
            '<div class="s-liveWrap" style="background:var(--inset);border-radius:8px;padding:4px 0">'+   // scrolls with the controls; once it leaves the viewport the floating side-peek (built below) takes over
              '<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:3px"><span class="val" style="opacity:.65">Live — real audio</span><button type="button" class="s-livePrevToggle">'+(s.livePrevOff?'Show':'Hide')+'</button></div>'+
              '<canvas class="s-audioPrevLive" width="378" height="92" style="width:100%;height:auto;display:'+(s.livePrevOff?'none':'block')+';background:#0d1117;border-radius:8px"></canvas></div>'+
          '</div>');
        // Crop: confine the audio light to a region of the board. The box is drawn + dragged on the previews above.
        html += sub('Crop')+
          full('<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;justify-content:center;flex:1 1 100%">'+
            '<label class="sl" style="margin:0"><input type="checkbox" class="s-cropOn"'+(s.cropOn?' checked':'')+'> Crop the light to a region</label>'+
            (s.cropOn?'<label class="sl" style="margin:0" title="Fit = the whole visualizer squeezes into the box; Clip = only the keys inside the box light (a window onto the full-board visual)"><input type="checkbox" class="s-cropFit"'+(s.cropFit?' checked':'')+'> Fit (squeeze in) · off = Clip</label><button type="button" class="s-cropReset" style="flex:none">Reset box</button>':'')+
          '</div>')+
          (s.cropOn?full('<span class="val" style="opacity:.6;flex:1 1 100%;text-align:center;font-size:12px">Drag the box on a preview above to move it; drag a corner to resize</span>'):'');
        // Dynamics / Transparency rows for the wash styles (pulse/bloom/starfield) — mirrors Spectrum Bars but
        // global. p = the style prefix (= its setting-key prefix). The depth slider shows only when either is on.
        const dynRows=(p)=>{ const on=!!s[p+'Dynamics'], aon=!!s[p+'DynamicsAlpha'], dep=(s[p+'DynamicsDepth']==null?60:s[p+'DynamicsDepth']);
          return row('Dynamics','<label class="sl" style="margin:0"><input type="checkbox" class="s-'+p+'Dynamics"'+(on?' checked':'')+'> Steady/sustained passages recede (dim); a beat pops it back to full — breathing depth instead of a flat wash</label><span></span>')+
            row('Transparency','<label class="sl" style="margin:0"><input type="checkbox" class="s-'+p+'DynamicsAlpha"'+(aon?' checked':'')+'> Recede as SEE-THROUGH — between beats the layers below show through, snaps opaque on a hit. Stacks with Dynamics</label><span></span>')+
            ((on||aon)?row('Dynamics Depth','<span class="srange" style="width:100%"><input type="range" class="s-'+p+'DynamicsDepth" min="0" max="100" value="'+dep+'" title="How far a steady passage recedes (dim and/or see-through) before a beat pops it back to full"><i class="tick" style="left:calc(7px + (100% - 14px)*0.6)"></i></span><span class="val s-'+p+'DynamicsDepthV"></span>'):''); };
        // Drive selector for the non-bars styles: Volume (overall loudness) vs Beat (pump on kicks). p = style prefix.
        const driveRow=(p,def)=>row('Drive','<select class="s-'+p+'Drive" title="What the effect follows — Volume = overall loudness (a steady wash); Beat = pumps on each kick/onset">'+[['volume','Volume (loudness)'],['beat','Beat (kicks)']].map(o=>'<option value="'+o[0]+'"'+(o[0]===(s[p+'Drive']||def)?' selected':'')+'>'+o[1]+'</option>').join('')+'</select><span></span>');
        html+=sub('Appearance');   // every surviving style now has at least one appearance control
        if(style==='bars'){ const bt=s.barTip||'off', bf=s.barFill||'solid', bc=s.barColor||'bassTreble', blo=s.barLayout||'standard', bdr=s.barDrive||'spectrum', bsp=!!s.barSpread;
          const btOpt=[['off','Off'],['color','Solid color'],['rainbow','Rainbow'],['vu','VU (green→red by level)']].map(o=>'<option value="'+o[0]+'"'+(o[0]===bt?' selected':'')+'>'+o[1]+'</option>').join('');
          const bfOpt=[['solid','Solid'],['subtract','Subtract (silhouette)']].map(o=>'<option value="'+o[0]+'"'+(o[0]===bf?' selected':'')+'>'+o[1]+'</option>').join('');
          const bcOpt=[['bassTreble','Bass → Treble'],['gradient','Gradient (bottom→top)'],['vu','VU (green→red by level)']].map(o=>'<option value="'+o[0]+'"'+(o[0]===bc?' selected':'')+'>'+o[1]+'</option>').join('');
          const bloOpt=[['standard','Standard (bass L → treble R)'],['reverse','Reverse (treble L → bass R)'],['mirror','Mirror (bass centered, treble at edges)'],['stereo','Stereo (left half = L channel, right = R)'],['topdown','Top-down (bars hang from the top)'],['centerout','Center-out (bars grow from the middle row)']].map(o=>'<option value="'+o[0]+'"'+(o[0]===blo?' selected':'')+'>'+o[1]+'</option>').join('');
          const bdrOpt=[['spectrum','Spectrum (per-column frequency)'],['volume','Volume (overall loudness)'],['beat','Beat (pumps on kicks)']].map(o=>'<option value="'+o[0]+'"'+(o[0]===bdr?' selected':'')+'>'+o[1]+'</option>').join('');
          html+=
          row('Drive','<select class="s-barDrive" title="What the bar HEIGHT follows. Spectrum = each column is its frequency band (classic analyzer). Volume = every bar tracks the song’s overall loudness (a level wall). Beat = bars pump on each kick. (Color still varies across columns regardless.)">'+bdrOpt+'</select><span></span>')+
          (bdr!=='spectrum' ? row('Spread','<label class="sl" style="margin:0"><input type="checkbox" class="s-barSpread"'+(bsp?' checked':'')+'> Shape columns by spectrum / stereo (per Layout) instead of a flat wall</label><span></span>') : '')+
          row('Layout','<select class="s-barLayout" title="How the spectrum maps to the keys. Standard = bass left → treble right, bars grow up. Reverse = treble left → bass right. Mirror = bass centered, treble at both edges. Stereo = left half is the LEFT audio channel, right half the RIGHT (bass meets in the middle) — needs a stereo source. Top-down = bars hang from the top. Center-out = bars grow from the middle row outward.">'+bloOpt+'</select><span></span>')+
          row('Bar Fill','<select class="s-barFill" title="Solid = filled bars. Subtract = empty bars that carve the layers below into a spectrum silhouette (the tips still draw).">'+bfOpt+'</select><span></span>')+
          (bf==='subtract' ? '' :
            row('Bar Color','<select class="s-barColor" title="Bass→Treble = horizontal hue across columns; Gradient = your 2 colors bottom→top; VU = green→yellow→orange→red by bar height">'+bcOpt+'</select><span></span>')+
            (bc==='bassTreble' ? row('Bass Color','<input type="color" class="s-barColorBass" value="'+s.barColorBass+'"><span></span>')+row('Treble Color','<input type="color" class="s-barColorTreble" value="'+s.barColorTreble+'"><span></span>')
             : bc==='gradient' ? row('Top Color','<input type="color" class="s-barGradB" value="'+s.barGradB+'"><span></span>')+row('Bottom Color','<input type="color" class="s-barGradA" value="'+s.barGradA+'"><span></span>')
             : ''))+
          row('Bar Tips','<select class="s-barTip" title="outline the top key of each bar so the silhouette stands out">'+btOpt+'</select><span></span>')+
          (bt==='color' ? row('Tip Color','<input type="color" class="s-barTipColor" value="'+s.barTipColor+'"><span></span>') : '')+
          row('Dynamics','<label class="sl" style="margin:0"><input type="checkbox" class="s-barDynamics"'+(s.barDynamics?' checked':'')+'> Steady bars recede (dim); a beat or spectral shift pops a bright rebound — depth instead of a flat constant-volume wall</label><span></span>')+
          row('Transparency','<label class="sl" style="margin:0"><input type="checkbox" class="s-barDynamicsAlpha"'+(s.barDynamicsAlpha?' checked':'')+'> Recede as SEE-THROUGH — steady bars fade transparent so the layers below show through (real front/back depth), pop solid on a hit. Stacks with Dynamics</label><span></span>')+
          ((s.barDynamics||s.barDynamicsAlpha) ? row('Dynamics Depth','<span class="srange" style="width:100%"><input type="range" class="s-barDynamicsDepth" min="0" max="100" value="'+(s.barDynamicsDepth==null?60:s.barDynamicsDepth)+'" title="How far a STEADY bar recedes (dims and/or fades see-through) before a change/beat pops it back to full. Higher = more breathing/depth; 0 = no recede"><i class="tick" style="left:calc(7px + (100% - 14px)*0.6)"></i></span><span class="val s-barDynamicsDepthV"></span>') : ''); }
        else if(style==='pulse') html+=driveRow('pulse','beat')+row('Color','<input type="color" class="s-pulseColor" value="'+s.pulseColor+'"><span></span>')+
          row('Gradient','<label class="sl" style="margin:0"><input type="checkbox" class="s-pulseGrad"'+(s.pulseGrad?' checked':'')+'> Two-color (bottom→top)</label><span></span>')+
          (s.pulseGrad ? row('2nd Color','<input type="color" class="s-pulseColor2" value="'+s.pulseColor2+'"><span></span>')+row('Reverse','<label class="sl" style="margin:0"><input type="checkbox" class="s-pulseGradRev"'+(s.pulseGradRev?' checked':'')+'> Swap gradient colors</label><span></span>') : '')+
          row('Min Brightness','<span class="srange" style="width:100%"><input type="range" class="s-pulseMin" min="0" max="100" value="'+(s.pulseMin==null?0:s.pulseMin)+'" title="Resting glow held even at silence (0 = goes fully dark on silence)"><i class="tick" style="left:calc(7px + (100% - 14px)*0.0)"></i></span><span class="val s-pulseMinV"></span>')+
          row('Max Brightness','<span class="srange" style="width:100%"><input type="range" class="s-pulseMax" min="0" max="100" value="'+(s.pulseMax==null?100:s.pulseMax)+'" title="Brightness a FULL beat reaches (the ceiling of the pump)"><i class="tick" style="left:calc(7px + (100% - 14px)*1.0)"></i></span><span class="val s-pulseMaxV"></span>')+
          dynRows('pulse');
        else if(style==='bloom') html+=driveRow('bloom','beat')+row('Color','<input type="color" class="s-bloomColor" value="'+s.bloomColor+'"><span></span>')+
          row('Gradient','<label class="sl" style="margin:0"><input type="checkbox" class="s-bloomGrad"'+(s.bloomGrad?' checked':'')+'> Two-color (center→edge)</label><span></span>')+
          (s.bloomGrad ? row('Edge Color','<input type="color" class="s-bloomColor2" value="'+s.bloomColor2+'"><span></span>')+row('Reverse','<label class="sl" style="margin:0"><input type="checkbox" class="s-bloomGradRev"'+(s.bloomGradRev?' checked':'')+'> Swap gradient colors</label><span></span>') : '')+
          dynRows('bloom');
        else if(style==='wave')  html+=driveRow('wave','volume')+row('Color','<input type="color" class="s-waveColor" value="'+s.waveColor+'"><span></span>')+
          row('Gradient','<label class="sl" style="margin:0"><input type="checkbox" class="s-waveGrad"'+(s.waveGrad?' checked':'')+'> Two-color (start→end)</label><span></span>')+
          (s.waveGrad ? row('2nd Color','<input type="color" class="s-waveColor2" value="'+s.waveColor2+'"><span></span>')+row('Reverse','<label class="sl" style="margin:0"><input type="checkbox" class="s-waveGradRev"'+(s.waveGradRev?' checked':'')+'> Swap gradient colors</label><span></span>') : '')+
          row('Amplitude','<span class="srange" style="width:100%"><input type="range" class="s-waveAmp" min="10" max="200" value="'+(s.waveAmp==null?100:s.waveAmp)+'" title="Vertical gain of the trace — 100% = a full-scale sample reaches the top/bottom row; higher exaggerates quiet audio"><i class="tick" style="left:calc(7px + (100% - 14px)*0.474)"></i></span><span class="val s-waveAmpV"></span>')+
          row('Thickness','<span class="srange" style="width:100%"><input type="range" class="s-waveThick" min="0" max="100" value="'+(s.waveThick==null?50:s.waveThick)+'" title="How many keys thick the trace line is drawn"><i class="tick" style="left:calc(7px + (100% - 14px)*0.5)"></i></span><span class="val s-waveThickV"></span>')+
          row('Direction','<label class="sl" style="margin:0"><input type="checkbox" class="s-waveReverse"'+(s.waveReverse?' checked':'')+'> Reverse flow</label><span></span>');
        else if(style==='aurora') html+=driveRow('aurora','volume')+row('Width','<span class="srange" style="width:100%"><input type="range" class="s-auroraWidth" min="0" max="100" value="'+(s.auroraWidth==null?50:s.auroraWidth)+'" title="Thickness of the aurora curtains — higher = fatter, softer bands; lower = thin ribbons"><i class="tick" style="left:calc(7px + (100% - 14px)*0.5)"></i></span><span class="val s-auroraWidthV"></span>');
        else if(style==='sparkle') html+=driveRow('sparkle','volume')+row('Color Mode','<label class="sl" style="margin:0"><input type="checkbox" class="s-sparkleMono"'+(s.sparkleMono?' checked':'')+'> Single color (off = full RGB rainbow)</label><span></span>')+
          (s.sparkleMono ? row('Color','<input type="color" class="s-sparkleColor" value="'+(s.sparkleColor||'#00e0ff')+'"><span></span>') : '')+
          dynRows('sparkle');
        // Dim-while-active: pick OTHER layers to quiet while this audio layer is emitting, each with its
        // own max-brightness slider — so the music keys read against a darker base. Stored in s.ducks.
        if(!Array.isArray(s.ducks)) s.ducks=[];
        const myIdx=+card.dataset.n;   // esc() defined above (source block)
        const duckOf=i=>s.ducks.find(d=>d&&d.layer===i);
        const duckRows=state.layers.map((L2,i)=>({L2,i})).filter(o=>o.i!==myIdx).map(o=>{
          const d=duckOf(o.i), on=!!d, dim=on?d.dim:30;
          return row('',
            '<label class="sl" style="margin:0"><input type="checkbox" class="s-duckOn" data-i="'+o.i+'"'+(on?' checked':'')+'> Layer '+(o.i+1)+' · '+esc(o.L2.name)+'</label>'+
            '<span style="display:flex;gap:6px;align-items:center"><input type="range" class="s-duckDim" data-i="'+o.i+'" min="0" max="100" value="'+dim+'"'+(on?'':' disabled')+' title="Max brightness this layer is allowed while the music is showing"><span class="val s-duckDimV" data-i="'+o.i+'">'+dim+'%</span></span>');
        }).join('');
        const ap=E.audioParams(s);   // tuner sliders are PER-STYLE (gain/floor/attack/decay/beatSens live in s.ap[style])
        // Copy-from: pull another style's PER-STYLE values into this one. Only Tuning (the ap block) and the
        // Dynamics/Transparency trio mean the same thing across styles — appearance colors/layout are inherently
        // style-specific (a bar layout means nothing to a pulse), and Dim-while-active is one shared layer-level
        // setting — so those aren't offered (nothing to copy). Source list = styles you've actually tuned.
        const STYLE_LABELS={bars:'Spectrum Bars',pulse:'Beat Pulse',bloom:'Radial Bloom',wave:'Waveform',aurora:'Aurora',sparkle:'Starfield'};
        const tunedStyles=Object.keys(s.ap||{}).filter(st=>st!==style && STYLE_LABELS[st]);
        const copyCtl = tunedStyles.length ? full('<span style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;flex:1 1 100%;justify-content:center"><span class="val" style="opacity:.7">Copy From</span><select class="s-copyFrom">'+tunedStyles.map(st=>'<option value="'+st+'">'+STYLE_LABELS[st]+'</option>').join('')+'</select><label class="sl" style="margin:0"><input type="checkbox" class="s-copyTuning" checked> Tuning</label><label class="sl" style="margin:0"><input type="checkbox" class="s-copyDyn" checked> Dynamics</label><button type="button" class="s-copyApply" style="flex:none">Apply</button>'+(s._copyUndo?'<button type="button" class="s-copyUndo" style="flex:none" title="revert the last Apply">Undo</button>':'')+'</span>') : '';
        html+=
          '</div><div class="ctl s-tuningCtl">'+   // close the colors .ctl and open a separate Tuning .ctl so the shared Adjust block can sit BETWEEN them (under color editing, above Tuning)
          sec('Tuning')+
          row('Gain','<span class="srange" style="width:100%"><input type="range" class="s-gain" min="50" max="300" value="'+Math.round((ap.gain||1)*100)+'" title="Boost/cut input sensitivity before it drives the keys (this style only)"><i class="tick" style="left:calc(7px + (100% - 14px)*0.2)"></i></span><span class="val s-gainV"></span>')+
          row('Noise Floor','<span class="srange" style="width:100%"><input type="range" class="s-floor" min="0" max="40" value="'+ap.floor+'" title="MIN level — gate out quiet hiss below this so idle keys stay dark (this style only)"><i class="tick" style="left:calc(7px + (100% - 14px)*0.125)"></i></span><span class="val s-floorV"></span>')+
          row('Ceiling','<span class="srange" style="width:100%"><input type="range" class="s-ceil" min="20" max="100" value="'+(ap.ceil==null?100:ap.ceil)+'" title="MAX level — the loudness that fills bars to the TOP. LOWER = bars hit the top more easily / more volatile (it stretches floor→ceiling across the full height). 100 = no boost (this style only)"><i class="tick" style="left:calc(7px + (100% - 14px)*1.0)"></i></span><span class="val s-ceilV"></span>')+
          row('Contrast','<span class="srange" style="width:100%"><input type="range" class="s-contrast" min="0" max="100" value="'+(ap.contrast==null?50:ap.contrast)+'" title="The VOLATILITY knob. Bands are auto-gained to their own recent peak, then this curve expands the swing — HIGHER = bars travel bottom→top far more, punchier; 0 = flat/linear (this style only)"><i class="tick" style="left:calc(7px + (100% - 14px)*0.5)"></i></span><span class="val s-contrastV"></span>')+
          (s.source==='mic' ? '' : row('Auto-Gain','<label class="sl" style="margin:0"><input type="checkbox" class="s-agc"'+(ap.agc!==false?' checked':'')+'> Volume-independent — fills to the song’s recent peak regardless of playback volume (off = react to absolute volume; Gain is the sensitivity)</label><span></span>'))+   // mic is ALWAYS absolute-volume (a VU) → no auto-gain toggle
          row('Attack','<span class="srange" style="width:100%"><input type="range" class="s-attackMs" min="0" max="300" step="5" value="'+ap.attackMs+'" title="How fast keys brighten on a rise (ms). Lower = snappier (this style only)"><i class="tick" style="left:calc(7px + (100% - 14px)*0.133)"></i></span><span class="val s-attackMsV"></span>')+
          row('Decay','<span class="srange" style="width:100%"><input type="range" class="s-decayMs" min="40" max="800" step="10" value="'+ap.decayMs+'" title="How slowly keys fade after a peak (ms). Higher = smoother (this style only)"><i class="tick" style="left:calc(7px + (100% - 14px)*0.237)"></i></span><span class="val s-decayMsV"></span>')+
          row('Pause Decay','<span class="srange" style="width:100%"><input type="range" class="s-pauseDecayMs" min="100" max="3000" step="50" value="'+(ap.pauseDecayMs==null?700:ap.pauseDecayMs)+'" title="When the music STOPS (sustained silence), how slowly the bars settle to 0 (ms). Separate from Decay so playback stays snappy but a pause glides down gracefully (this style only)"><i class="tick" style="left:calc(7px + (100% - 14px)*0.207)"></i></span><span class="val s-pauseDecayMsV"></span>')+
          row('Pause As','<select class="s-pauseStyle" title="What the keys do when the music STOPS. Settle = bars glide down to 0 over Pause decay. Twinkle out = the last frame FREEZES, then each lit key sparkles away individually over Pause decay (applies to every style).">'+[['linear','Settle (glide down)'],['twinkle','Twinkle out (freeze + sparkle away)']].map(o=>'<option value="'+o[0]+'"'+(o[0]===(s.pauseStyle||'linear')?' selected':'')+'>'+o[1]+'</option>').join('')+'</select><span></span>')+
          row('Beat Sensitivity','<span class="srange" style="width:100%"><input type="range" class="s-beatSens" min="0" max="100" value="'+ap.beatSens+'" title="How strongly kicks/onsets pop in pulse and bloom (this style only)"><i class="tick" style="left:calc(7px + (100% - 14px)*0.5)"></i></span><span class="val s-beatSensV"></span>')+
          copyCtl+   // Copy-from moved here (below Beat Sensitivity) — under the 'Tuning' header it read as a confusing duplicate of the Tuning checkbox
          (duckRows ? sub('Dim While Active')+full('<span class="val" style="opacity:.7;flex:1 1 100%;text-align:center">Quiet these layers while the music shows</span>')+duckRows : '')+
        '</div>';
        body.innerHTML=html;
        const c=q=>body.querySelector(q);
        body.querySelectorAll('.s-source').forEach(r=>r.addEventListener('change',e=>{ const v=e.target.value; switchSource(s, L, s.source, v);   // each source is its own profile (style + whole look) — swap the entire look in/out
          if(v==='tab' && opts.isDriving && !opts.isDriving() && opts.connectKeyboard) opts.connectKeyboard();   // auto-handover: only Specific Tab is page-captured → grab the keyboard from the daemon so it reaches the keys (mic is daemon-driven now)
          onAudioSource(v); buildLayerBody(card,L); scheduleSaveLayers(); }));   // tab starts in-tab capture; system/app/mic stop it (daemon-driven); rebuild so the App/Mic panels show/hide
        // re-pick: clicking the ALREADY-selected "Specific Tab" re-opens the share picker (a 'change' doesn't fire when it's already chosen)
        { const tabR=[...body.querySelectorAll('.s-source')].find(x=>x.value==='tab'); if(tabR) tabR.addEventListener('click',()=>{ if(s.source==='tab') onAudioSource('tab'); }); }
        // "Specific app" picker — populated from the daemon's list of currently-playing audio apps; the saved
        // pick persists even when that app isn't playing (so it reattaches when it resumes). Stored in s.appId.
        if(s.source==='app'){ const sel=c('.s-appId'), note=c('.s-appNote'), rf=c('.s-appRefresh');
          const HIDE_APPS=new Set(['app-capture','musicplug']);   // our own capture helper (holds a loopback session) + a non-source background app — never real capture targets
          const cap=n=>n?n.charAt(0).toUpperCase()+n.slice(1):n;   // DISPLAY only — capitalize the first letter ("brave"→"Brave"); the option VALUE stays the real process name for capture/matching
          const fill=(apps)=>{ if(!sel) return; const cur=s.appId||''; let has=false;
            const optsHtml=['<option value="">— pick a playing app —</option>'];
            (apps||[]).filter(a=>a&&a.name && !HIDE_APPS.has(a.name.toLowerCase().replace(/\.exe$/,''))).forEach(a=>{ if(a.name===cur) has=true; optsHtml.push('<option value="'+esc(a.name)+'"'+(a.name===cur?' selected':'')+'>'+esc(cap(a.name))+'</option>'); });
            if(cur && !has) optsHtml.push('<option value="'+esc(cur)+'" selected>'+esc(cap(cur))+' (idle)</option>');   // keep the saved pick visible
            sel.innerHTML=optsHtml.join('');
            if(note) note.textContent=(apps&&apps.length)?'':'nothing playing — start audio, then ⟳'; };
          const load=()=>{ if(note) note.textContent='scanning…'; Promise.resolve(opts.listAudioApps && opts.listAudioApps()).then(a=>fill(a||[])).catch(()=>{ if(note) note.textContent='(daemon not running — start it to list apps)'; fill([]); }); };
          if(sel) sel.addEventListener('change',e=>{ s.appId=e.target.value; });   // panel 'change' listener pushes config → daemon (re)starts app capture
          if(rf) rf.addEventListener('click',load);
          load();
        }
        c('.s-style').addEventListener('change',e=>{ const oldK=E.audioVariantKey(s); s.style=e.target.value; swapVariant(s, oldK, E.audioVariantKey(s)); buildLayerBody(card,L); scheduleSaveLayers(); });   // carry each variant's own Adjust/crop/pause/ducks
        ['barColorBass','barColorTreble','barTipColor','barGradA','barGradB','pulseColor','pulseColor2','bloomColor','bloomColor2','waveColor','waveColor2','sparkleColor'].forEach(key=>{ const el=c('.s-'+key); if(el) el.addEventListener('input',e=>s[key]=e.target.value); });
        // per-style appearance VALUE sliders that write to s directly (not the per-style tuner `ap`): pulse min/max, aurora width
        [['pulseMin','%'],['pulseMax','%'],['auroraWidth',''],['waveAmp','%'],['waveThick','%'],['micGate','%']].forEach(pair=>{ const key=pair[0], unit=pair[1], el=c('.s-'+key), v=c('.s-'+key+'V'); if(el&&v){ const up=()=>v.textContent=el.value+unit; el.addEventListener('input',()=>{ s[key]=+el.value; up(); }); up(); } });
        // Mic Gain is a LOG slider: position 0..1000 → 50%..7200% (each step a multiplier, so the useful low end isn't crammed at the bottom). The position maps to the real % stored in s.micGain.
        { const el=c('.s-micGain'), v=c('.s-micGainV'); if(el&&v){ const toG=pos=>Math.round(50*Math.pow(144, pos/1000)/10)*10; const up=()=>v.textContent=(s.micGain==null?100:s.micGain)+'%';
          el.addEventListener('input',()=>{ s.micGain=toG(+el.value); up(); }); up(); } }
        // Mic toggle-hotkey bind: capture one keydown → store its LED index (universal) + a readable label.
        // The daemon flips this layer's enabled when that key is pressed in any app (see daemon.js layer-toggle).
        { const bk=c('.s-bindKey');
          const keyLabel=code=>code.replace(/^Key/,'').replace(/^Digit/,'').replace(/^Numpad/,'Num ').replace(/^Arrow/,'');
          if(bk) bk.addEventListener('click',()=>{ bk.textContent='Press a key…  (Esc cancels)';
            const onKey=ev=>{ ev.preventDefault(); ev.stopPropagation(); document.removeEventListener('keydown',onKey,true);
              if(ev.code==='Escape'){ buildLayerBody(card,L); return; }
              const led=E.KEYMAP[ev.code];
              if(led==null){ bk.textContent='Unsupported key — try again'; return; }
              s.toggleKeyLed=led; s.toggleKeyLabel=keyLabel(ev.code); buildLayerBody(card,L); scheduleSaveLayers(); };
            document.addEventListener('keydown',onKey,true); });
          const bc=c('.s-bindClear'); if(bc) bc.addEventListener('click',()=>{ delete s.toggleKeyLed; delete s.toggleKeyLabel; buildLayerBody(card,L); scheduleSaveLayers(); }); }
        { const wr=c('.s-waveReverse'); if(wr) wr.addEventListener('change',e=>s.waveReverse=e.target.checked); }
        { const bt=c('.s-barTip'); if(bt) bt.addEventListener('change',e=>{ s.barTip=e.target.value; buildLayerBody(card,L); }); }   // rebuild so the tip-color picker shows/hides
        { const bf=c('.s-barFill'); if(bf) bf.addEventListener('change',e=>{ s.barFill=e.target.value; buildLayerBody(card,L); }); }   // rebuild so the color controls show/hide with solid/subtract
        { const bl=c('.s-barLayout'); if(bl) bl.addEventListener('change',e=>s.barLayout=e.target.value); }   // no dependent controls — no rebuild needed
        { const bdy=c('.s-barDynamics'); if(bdy) bdy.addEventListener('change',e=>{ s.barDynamics=e.target.checked; buildLayerBody(card,L); }); }   // rebuild so the depth slider shows/hides
        { const bda=c('.s-barDynamicsAlpha'); if(bda) bda.addEventListener('change',e=>{ s.barDynamicsAlpha=e.target.checked; buildLayerBody(card,L); }); }   // rebuild so the depth slider shows/hides
        { const el=c('.s-barDynamicsDepth'), v=c('.s-barDynamicsDepthV'); if(el&&v){ const up=()=>v.textContent=el.value+'%'; el.addEventListener('input',()=>{ s.barDynamicsDepth=+el.value; up(); }); up(); } }
        // wash-style Dynamics/Transparency (pulse/bloom/sparkle) — same shape as bars, keyed by prefix
        ['pulse','bloom','sparkle'].forEach(p=>{
          ['Dynamics','DynamicsAlpha'].forEach(suf=>{ const el=c('.s-'+p+suf); if(el) el.addEventListener('change',e=>{ s[p+suf]=e.target.checked; buildLayerBody(card,L); }); });   // rebuild so the depth slider shows/hides
          const el=c('.s-'+p+'DynamicsDepth'), v=c('.s-'+p+'DynamicsDepthV'); if(el&&v){ const up=()=>v.textContent=el.value+'%'; el.addEventListener('input',()=>{ s[p+'DynamicsDepth']=+el.value; up(); }); up(); }
        });
        { const ps=c('.s-pauseStyle'); if(ps) ps.addEventListener('change',e=>s.pauseStyle=e.target.value); }   // layer-level pause behavior: linear settle vs twinkle-out
        // Copy-from Apply: clone the chosen style's Tuning (ap) and/or Dynamics trio into THIS style, then rebuild.
        { const DP={bars:'bar',pulse:'pulse',bloom:'bloom',sparkle:'sparkle'};
          const btn=c('.s-copyApply'); if(btn) btn.addEventListener('click',()=>{
            const sel=c('.s-copyFrom'); if(!sel||!sel.value) return; const src=sel.value, dst=E.audioVariantKey(s), dp=DP[style];
            const undo={};   // snapshot what we're about to overwrite, so Undo can revert this exact Apply
            if(c('.s-copyTuning') && c('.s-copyTuning').checked && s.ap && s.ap[src]){ undo.ap=JSON.parse(JSON.stringify(s.ap[dst]||{})); s.ap[dst]=JSON.parse(JSON.stringify(s.ap[src])); }
            if(c('.s-copyDyn') && c('.s-copyDyn').checked){ const sp=DP[src];
              if(sp&&dp){ undo.dyn={Dynamics:s[dp+'Dynamics'], DynamicsAlpha:s[dp+'DynamicsAlpha'], DynamicsDepth:s[dp+'DynamicsDepth']};
                s[dp+'Dynamics']=s[sp+'Dynamics']; s[dp+'DynamicsAlpha']=s[sp+'DynamicsAlpha']; s[dp+'DynamicsDepth']=s[sp+'DynamicsDepth']; } }   // wave/aurora have no dynamics → silently skipped
            s._copyUndo = undo;
            buildLayerBody(card,L); scheduleSaveLayers();
          });
          const ub=c('.s-copyUndo'); if(ub) ub.addEventListener('click',()=>{ const u=s._copyUndo||{}, dst=E.audioVariantKey(s), dp=DP[style];
            if(u.ap){ if(!s.ap) s.ap={}; s.ap[dst]=u.ap; }
            if(u.dyn&&dp){ s[dp+'Dynamics']=u.dyn.Dynamics; s[dp+'DynamicsAlpha']=u.dyn.DynamicsAlpha; s[dp+'DynamicsDepth']=u.dyn.DynamicsDepth; }
            delete s._copyUndo; buildLayerBody(card,L); scheduleSaveLayers(); }); }
        { const bd=c('.s-barDrive'); if(bd) bd.addEventListener('change',e=>{ s.barDrive=e.target.value; buildLayerBody(card,L); }); }   // rebuild so the Spread toggle shows/hides
        { const bsp=c('.s-barSpread'); if(bsp) bsp.addEventListener('change',e=>s.barSpread=e.target.checked); }
        { const bc=c('.s-barColor'); if(bc) bc.addEventListener('change',e=>{ s.barColor=e.target.value; buildLayerBody(card,L); }); }   // rebuild so bass/treble vs gradient vs vu color pickers swap
        ['pulseGrad','bloomGrad','waveGrad','sparkleMono'].forEach(key=>{ const el=c('.s-'+key); if(el) el.addEventListener('change',e=>{ s[key]=e.target.checked; buildLayerBody(card,L); }); });   // rebuild so the 2nd-color / single-color picker shows/hides
        ['pulseGradRev','bloomGradRev','waveGradRev'].forEach(key=>{ const el=c('.s-'+key); if(el) el.addEventListener('change',e=>s[key]=e.target.checked); });   // swap gradient ends — no rebuild (preview reads s live)
        ['pulse','bloom','wave','aurora','sparkle'].forEach(p=>{ const el=c('.s-'+p+'Drive'); if(el) el.addEventListener('change',e=>s[p+'Drive']=e.target.value); });   // Volume/Beat drive for the non-bars styles
        const slider=(cls,key,fmt,xform,snapTo,tol)=>{ const el=c('.s-'+cls), v=c('.s-'+cls+'V'); if(!el||!v) return; const up=()=>v.textContent=fmt(ap[key]); el.addEventListener('input',e=>{ if(snapTo!=null) snap(el,snapTo,tol==null?4:tol); ap[key]=xform(+el.value); up(); }); up(); };   // writes the PER-STYLE param (ap); tol = snap approach width (smaller on short-range sliders); guard !v so a class mismatch can't crash init
        slider('gain','gain',x=>Math.round(x*100)+'%',v=>v/100,100);
        slider('floor','floor',x=>x+'%',v=>v,5,1);   // 0-40 range → tight snap (±1) so the tick isn't sticky
        slider('ceil','ceil',x=>x+'%',v=>v,100,1);   // MAX level (100 = no boost; lower = bars peak more easily)
        slider('contrast','contrast',x=>x+'%',v=>v,50);   // volatility / dynamic-range expansion
        { const ag=c('.s-agc'); if(ag) ag.addEventListener('change',e=>ap.agc=e.target.checked); }   // per-style auto-gain on/off
        slider('attackMs','attackMs',x=>x+'ms',v=>v,40);
        slider('decayMs','decayMs',x=>x+'ms',v=>v,220);
        slider('pauseDecayMs','pauseDecayMs',x=>x+'ms',v=>v,700);   // settle-to-0 time after the music stops
        slider('beatSens','beatSens',x=>x+'%',v=>v,50);
        { const co=c('.s-cropOn'); if(co) co.addEventListener('change',e=>{ s.cropOn=e.target.checked; buildLayerBody(card,L); }); }   // rebuild so Fit/Reset + the note show/hide
        { const cf=c('.s-cropFit'); if(cf) cf.addEventListener('change',e=>{ s.cropFit=e.target.checked; scheduleSaveLayers(); }); }
        { const cr=c('.s-cropReset'); if(cr) cr.addEventListener('click',()=>{ s.cropX=0.1; s.cropY=0.1; s.cropW=0.8; s.cropH=0.8; scheduleSaveLayers(); }); }
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
        { const tb=c('.s-samplePrevToggle'), cv=c('.s-audioPrev'); if(tb&&cv) tb.addEventListener('click',()=>{ s.samplePrevOff=!s.samplePrevOff; cv.style.display=s.samplePrevOff?'none':'block'; tb.textContent=s.samplePrevOff?'Show':'Hide'; scheduleSaveLayers(); }); }   // a button click fires no input/change, so persist explicitly (survives refresh)
        { const tb=c('.s-livePrevToggle'),  cv=c('.s-audioPrevLive'); if(tb&&cv) tb.addEventListener('click',()=>{ s.livePrevOff=!s.livePrevOff; cv.style.display=s.livePrevOff?'none':'block'; tb.textContent=s.livePrevOff?'Show':'Hide'; scheduleSaveLayers(); }); }
        // SAMPLE preview = the deterministic synth (design the look any time, independent of audio).
        // LIVE preview = the page's REAL state.audio, but ONLY while real capture is running — otherwise it
        // paints blank keys (it must NOT mimic the synth when nothing's playing). Each toggles independently.
        (function(){
          const cvS=c('.s-audioPrev'), cvL=c('.s-audioPrevLive'); if((!cvS||!cvS.getContext)&&(!cvL||!cvL.getContext)) return;
          const ctxS=cvS&&cvS.getContext('2d'), ctxL=cvL&&cvL.getContext('2d'), W=(cvS||cvL).width, H=(cvS||cvL).height;
          const pState={ audio:{ bands:new Float32Array(32), level:0, beat:0, centroid:0.5, _t:0 } };
          const sampL={ type:'audio', settings:s, rgb:new Uint8Array(E.NLED*3) };
          const liveL={ type:'audio', settings:s, rgb:new Uint8Array(E.NLED*3) };
          if(!window._audSynthPrev && window.TH108AudioSynth) window._audSynthPrev=TH108AudioSynth.createSynth();
          const synth=window._audSynthPrev;
          const paint=(ctx,rgb)=>{ ctx.clearRect(0,0,W,H);
            for(let k=0;k<E.NLED;k++){ const cell=E.keyCell(E.INDICES[k]); if(!cell) continue;
              const o=k*3, x=(cell[0]-cell[2]/2)*W, y=(cell[1]-cell[3]/2)*H, w=cell[2]*W, h=cell[3]*H;
              ctx.fillStyle='rgb('+rgb[o]+','+rgb[o+1]+','+rgb[o+2]+')';
              ctx.fillRect(x+0.5,y+0.5,Math.max(1,w-1),Math.max(1,h-1)); }
            drawCrop(ctx); };   // overlay the crop box on top of every painted frame
          // Crop overlay: the box lives in the same 0..1 keyCell space the engine crops in, so it maps straight to
          // canvas px. Dim outside, outline + corner handles inside.
          const drawCrop=(ctx)=>{ if(!s.cropOn||!ctx) return;
            const x=(s.cropX||0)*W, y=(s.cropY||0)*H, w=(s.cropW||1)*W, h=(s.cropH||1)*H;
            ctx.save();
            ctx.fillStyle='rgba(0,0,0,0.45)'; ctx.fillRect(0,0,W,y); ctx.fillRect(0,y+h,W,H-(y+h)); ctx.fillRect(0,y,x,h); ctx.fillRect(x+w,y,W-(x+w),h);
            ctx.strokeStyle='#4aa3ff'; ctx.lineWidth=1.5; ctx.strokeRect(x+0.5,y+0.5,Math.max(1,w),Math.max(1,h));
            ctx.fillStyle='#4aa3ff'; const hs=4; [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(p=>ctx.fillRect(p[0]-hs,p[1]-hs,hs*2,hs*2));
            ctx.restore(); };
          // Drag the crop box (move) / its corners (resize) on a preview canvas. Coords normalized via the canvas's
          // displayed size (it's CSS-scaled), so it works at any zoom. MIN keeps the box from collapsing.
          const attachCropDrag=(canvas)=>{ if(!canvas) return; let drag=null, lastPush=0; const MIN=0.08, TOL=0.06;
            const toN=e=>{ const r=canvas.getBoundingClientRect(); return [(e.clientX-r.left)/r.width, (e.clientY-r.top)/r.height]; };
            // Grab a CORNER (both axes near), a single EDGE (one axis near + within the other's span), or the body (move).
            const hit=(nx,ny)=>{ if(!s.cropOn) return null; const x0=s.cropX, y0=s.cropY, x1=x0+s.cropW, y1=y0+s.cropH, near=(a,b)=>Math.abs(a-b)<TOL;
              const inX=nx>=x0-TOL&&nx<=x1+TOL, inY=ny>=y0-TOL&&ny<=y1+TOL;
              const cx=(inY&&near(nx,x0))?'w':(inY&&near(nx,x1))?'e':'', cy=(inX&&near(ny,y0))?'n':(inX&&near(ny,y1))?'s':'';
              if(cy&&cx) return cy+cx;   // corner
              if(cy) return cy;          // top / bottom edge
              if(cx) return cx;          // left / right edge
              if(inX&&inY) return 'move'; return null; };
            const cursorFor=m=> m==='move'?'move' : (m==='n'||m==='s')?'ns-resize' : (m==='e'||m==='w')?'ew-resize' : (m==='ne'||m==='sw')?'nesw-resize' : m?'nwse-resize':'crosshair';
            const livePush=()=>{ const t=window.performance?performance.now():0; if(t-lastPush>120){ lastPush=t; saveLayers(); pushConfig(); } };   // throttled push so the daemon-driven keyboard updates DURING the drag, not only on release
            canvas.addEventListener('pointerdown',e=>{ if(!s.cropOn) return; const n=toN(e), m=hit(n[0],n[1]); if(!m) return;
              e.preventDefault(); try{canvas.setPointerCapture(e.pointerId);}catch(_){}
              drag={mode:m, sx:n[0], sy:n[1], x:s.cropX, y:s.cropY, w:s.cropW, h:s.cropH}; });
            canvas.addEventListener('pointermove',e=>{ if(!drag){ if(s.cropOn){ const n=toN(e); canvas.style.cursor=cursorFor(hit(n[0],n[1])); } return; }
              const n=toN(e), dx=n[0]-drag.sx, dy=n[1]-drag.sy;
              if(drag.mode==='move'){ s.cropX=Math.max(0,Math.min(1-drag.w, drag.x+dx)); s.cropY=Math.max(0,Math.min(1-drag.h, drag.y+dy)); }
              else { let x0=drag.x, y0=drag.y, x1=drag.x+drag.w, y1=drag.y+drag.h;
                if(drag.mode.indexOf('w')>=0) x0=Math.min(x1-MIN, Math.max(0, drag.x+dx));
                if(drag.mode.indexOf('e')>=0) x1=Math.max(x0+MIN, Math.min(1, drag.x+drag.w+dx));
                if(drag.mode.indexOf('n')>=0) y0=Math.min(y1-MIN, Math.max(0, drag.y+dy));
                if(drag.mode.indexOf('s')>=0) y1=Math.max(y0+MIN, Math.min(1, drag.y+drag.h+dy));
                s.cropX=x0; s.cropY=y0; s.cropW=x1-x0; s.cropH=y1-y0; }
              livePush(); });   // preview reads s live; this mirrors it to the keyboard mid-drag too
            const end=()=>{ if(drag){ drag=null; scheduleSaveLayers(); } };
            canvas.addEventListener('pointerup',end); canvas.addEventListener('pointercancel',end); };
          attachCropDrag(cvS); attachCropDrag(cvL);
          // Mic sensitivity meter: show the live ABSOLUTE input level (state.audio.inAbs) against the gate, both on
          // the 0..0.6 scale the gate slider uses — so you can see your room/fan floor and set the gate just above it.
          const micFill=c('.s-micMeterFill'), micGateEl=c('.s-micMeterGate'), MIC_SCALE=0.12;   // meter tops at 12% — headroom so a loud mic doesn't pin the bar (was 0.6 → signal looked tiny)
          const updMicMeter=()=>{ if(!micFill) return; const ia=Math.max(0,Math.min(1,(state.audio&&state.audio.inAbs)||0));
            micFill.style.width=Math.min(100, ia/MIC_SCALE*100)+'%';
            if(micGateEl) micGateEl.style.left=Math.min(100,((s.micGate==null?0:s.micGate)/100)/MIC_SCALE*100)+'%'; };
          // Floating side-peek: when the inline Live preview scrolls out of view, a small pill docks to whichever
          // side of the screen this card sits on. Clicking Show reveals a DUPLICATE live preview pinned near where
          // you're working, so you can watch the keys without scrolling back up; scrolling the inline preview back
          // into view auto-hides both. (Replaces the old position:sticky preview.)
          const liveWrap=c('.s-liveWrap');
          let pillVisible=false;
          const peek=document.createElement('div');   // the PILL = label + Show/Hide only; content-sized → symmetric padding
          peek.className='s-livePeek';
          peek.style.cssText='position:fixed;z-index:60;display:inline-flex;opacity:0;pointer-events:none;transition:opacity .25s ease;left:-9999px;top:0;align-items:center;gap:10px;background:var(--inset);border:1px solid var(--border);border-radius:10px;padding:7px 12px;box-shadow:0 8px 26px rgba(0,0,0,.32)';   // opacity-faded (250ms); position:fixed → no layout cost while invisible
          peek.innerHTML='<span class="val" style="opacity:.65;font-size:11px;white-space:nowrap">Live — real audio</span><button type="button" class="s-livePeekBtn" style="margin:0;padding:2px 9px">Show</button>';   // margin:0 overrides the global button margin-right (else the right gap is bigger than the left)
          body.appendChild(peek);
          const peekBtn=peek.querySelector('.s-livePeekBtn');
          // the DUPLICATE is a real INLINE block (a grid item inserted after a section header), NOT a floating overlay
          const dup=document.createElement('div'); dup.className='s-livePeekDup';
          dup.style.cssText='grid-column:1/-1;margin:5px 0;background:var(--inset);border-radius:8px;padding:5px 0';
          dup.innerHTML='<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:3px"><span class="val" style="opacity:.65">Live — real audio</span></div>'+
            '<canvas class="s-livePeekCv" width="'+W+'" height="'+H+'" style="display:block;width:100%;height:auto;background:#0d1117;border-radius:6px"></canvas>';
          const dupCv=dup.querySelector('.s-livePeekCv'), dupCtx=dupCv.getContext('2d');
          // dock the pill just OUTSIDE the compositor, on the SAME side as the audio card's column (audio in the LEFT
          // column → pill on the left; RIGHT column → pill on the right), clamped to stay on-screen.
          const positionPeek=()=>{ const grid=card.parentElement, gr=grid.getBoundingClientRect(), comp=grid.closest('.card')||grid, compR=comp.getBoundingClientRect(), cr=card.getBoundingClientRect();
            const pw=peek.offsetWidth||200, gap=12; peek.style.transform='none'; peek.style.right='auto';
            peek.style.top=Math.round(window.innerHeight*0.30)+'px';
            let left = (cr.left+cr.width/2) < (gr.left+gr.width/2) ? (compR.left-gap-pw) : (compR.right+gap);   // audio LEFT col → outside the compositor's left edge; RIGHT col → outside its right
            left = Math.max(4, Math.min(left, window.innerWidth-4-pw));   // never off-screen
            peek.style.left=Math.round(left)+'px'; };
          // insert the duplicate INLINE right after the section header nearest the top of the view (what you're tuning)
          const showDup=()=>{ const aim=window.innerHeight*0.16; let best=null, bd=1e9;
            card.querySelectorAll('.lsec').forEach(sc=>{ const t=sc.getBoundingClientRect().top; if(Math.abs(t-aim)<bd){ bd=Math.abs(t-aim); best=sc; } });
            if(best && best.parentNode) best.insertAdjacentElement('afterend', dup); else body.appendChild(dup);
            peekBtn.textContent='Hide'; };
          const hideDup=()=>{ if(dup.parentNode) dup.parentNode.removeChild(dup); peekBtn.textContent='Show'; };
          const fadePill=(on)=>{ peek.style.opacity=on?'1':'0'; peek.style.pointerEvents=on?'auto':'none'; pillVisible=on; };   // 250ms via the CSS transition
          peekBtn.addEventListener('click',()=>{ if(dup.parentNode) hideDup(); else showDup(); });
          const nowEl=c('.s-srcNow'); let _lastNow=null;
          function frame(now){
            if(!document.body.contains(cvL||cvS)){ [peek,dup].forEach(e=>{ if(e.parentNode) e.parentNode.removeChild(e); }); return; }   // card rebuilt/removed → stop + clean
            updMicMeter();
            if(nowEl){ let txt='';   // "what's playing" under the sources: only Specific Tab is page-captured → show a hint when this tab isn't driving (mic now runs in the daemon, so no caveat)
              if(s.source==='tab' && liveAudioActive()){
                const driving=opts.isDriving?opts.isDriving():true;   // the shared tab's TITLE isn't obtainable (opaque stream id), so don't show a wrong title
                txt='▶ Shared tab'+(driving?'':'   ·   preview only — click “Drive from this Tab” to show it on the keyboard'); }
              else if(s.source==='mic' && liveAudioActive()) txt='▶ Microphone';
              if(txt!==_lastNow){ nowEl.textContent=txt; nowEl.style.color=(txt.indexOf('preview only')>=0)?'var(--warn,#e0a200)':''; _lastNow=txt; } }
            if(ctxS && cvS.offsetParent!==null && synth){ E.applyAudioFeatures(pState, synth.sample(now/1000), s, now); E.renderAudio(sampL, now, pState); paint(ctxS, sampL.rgb); }
            let dupOn=false;
            if(liveWrap){
              const shown=liveWrap.offsetParent!==null && !s.livePrevOff;   // card expanded/enabled AND the live preview isn't toggled off
              const r=shown?liveWrap.getBoundingClientRect():null;
              const cr=shown?card.getBoundingClientRect():null;
              const cardInView=shown && cr.bottom>40 && cr.top<window.innerHeight-40;   // you're still within THIS audio card's controls
              const off=shown && cardInView && r.bottom<4;                              // and the inline preview has scrolled ABOVE the viewport (you're down in the tuner)
              const dupOffTop=!!dup.parentNode && dup.getBoundingClientRect().bottom<4;  // the shown duplicate has scrolled off the top → pill is inapplicable, hide it
              const want=off && !dupOffTop;
              if(want){ positionPeek(); if(!pillVisible) fadePill(true); }   // re-position EVERY frame while shown → tracks zoom/resize/scroll (was positioned once on show → stranded after a zoom)
              else if(pillVisible){ fadePill(false); }
              if(!off && dup.parentNode) hideDup();   // scrolled all the way back to the inline preview → remove the duplicate + reset
              dupOn=!!dup.parentNode && dup.offsetParent!==null;
            }
            const liveOn=ctxL && cvL.offsetParent!==null;
            if(liveOn || dupOn){
              if(liveAudioActive()) E.renderAudio(liveL, now, state); else liveL.rgb.fill(0);   // real capture → mirror the keys; nothing playing → blank
              if(liveOn) paint(ctxL, liveL.rgb);
              if(dupOn) paint(dupCtx, liveL.rgb);                                                 // same frame mirrored into the inline duplicate
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
      wrapCheckboxRows(body);     // checkbox in the gap + descriptor in its own column (option-1 layout)
    }
    // For a simple checkbox row [label | (checkbox + descriptor) | empty cell], split the descriptor into its
    // own span and tag the row 'cbrow' so CSS can center the checkbox in the gap and give the text its own
    // column. Skips rows whose 3rd cell holds a control (e.g. the per-layer "Dim while active" duck sliders).
    function wrapCheckboxRows(scope){
      scope.querySelectorAll('.ctl .lrow > .sl').forEach(sl=>{
        const row = sl.parentElement, last = row.lastElementChild;
        if(!(last && last.tagName==='SPAN' && last.children.length===0 && !last.textContent.trim())) return;   // 3rd cell must be the empty filler (not a duck slider)
        if(!sl.querySelector('.sl-d')){
          const input = sl.querySelector('input'); if(!input) return;
          const d = document.createElement('span'); d.className='sl-d';
          let n = input.nextSibling; while(n){ const nx = n.nextSibling; d.appendChild(n); n = nx; }
          sl.appendChild(d);
        }
        row.classList.add('cbrow'); last.remove();
      });
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
      if(L.type==='audio') delete CFG.rot;   // audio styles map to discrete columns/rows — Rotate has no effect, so don't show a dead control
      if(L.type==='individual') delete CFG.rot;   // per-key paint = explicit positions; rotating would scramble the painted layout — dead control
      const showStatic = L.type!=='individual';   // individual paints a fixed color set — there's no animation to freeze, so Static is meaningless here
      const disp=(key,raw)=>{ const d=CFG[key][3]; return d?(raw/100).toFixed(d):String(raw); };
      const ctl=key=>{ const c=CFG[key], dec=c[3], frac=(c[5]-c[1])/(c[2]-c[1]);   // tick at the default value
        const nMin=dec?c[1]/100:c[1], nMax=dec?c[2]/100:c[2], nStep=dec?1/Math.pow(10,dec):1;
        return '<label>'+c[0]+'</label>'+
          '<span class="srange" style="width:100%;min-width:30px"><input type="range" class="a-'+key+'" min="'+c[1]+'" max="'+c[2]+'" value="'+s[key]+'"><i class="tick" style="left:calc(7px + (100% - 14px)*'+frac+')"></i></span>'+
          '<span style="display:flex;gap:4px;align-items:center"><input type="number" class="numin a-'+key+'N" min="'+nMin+'" max="'+nMax+'" step="'+nStep+'" value="'+disp(key,s[key])+'"><span class="val" style="min-width:10px">'+c[4]+'</span></span>'; };
      const adj=document.createElement('div');
      adj.innerHTML=
        '<div class="lbody" style="margin-top:8px"><div class="ph" style="margin-bottom:6px;color:var(--text);font-weight:600;font-size:13px;text-align:center">Adjust</div><div class="ctl">'+
          ctl('bri')+ctl('sat')+ctl('con')+ctl('gam')+(CFG.rot?ctl('rot'):'')+
          (showStatic?'<label>Static</label><label class="sl" style="margin:0"><input type="checkbox" class="a-frozen"'+(s.frozen?' checked':'')+'> Freeze Animation</label><span></span>':'')+
        '</div></div>';
      const tuningCtl=body.querySelector('.s-tuningCtl');   // audio: drop Adjust between the colors and Tuning .ctl blocks; other layers: append at the end
      if(tuningCtl) body.insertBefore(adj.firstChild, tuningCtl); else body.appendChild(adj.firstChild);
      Object.keys(CFG).forEach(key=>{ const c=CFG[key], min=c[1], max=c[2], dec=c[3], def=c[5], thr=Math.max(1,Math.round((max-min)*0.03));
        const rng=body.querySelector('.a-'+key), num=body.querySelector('.a-'+key+'N');
        const apply=raw=>{ raw=Math.max(min,Math.min(max,Math.round(raw||0))); s[key]=raw; rng.value=raw; return raw; };
        rng.addEventListener('input',e=>{ snap(e.target, def, thr); num.value=disp(key,apply(+e.target.value)); });   // snap+flash at default
        num.addEventListener('input',e=>{ const v=parseFloat(e.target.value); if(!isNaN(v)) apply(dec?v*100:v); });   // don't reformat while typing
        rng.value=s[key]; num.value=disp(key,s[key]);
      });
      const fz=body.querySelector('.a-frozen'); if(fz) fz.addEventListener('change',e=>{ s.frozen=e.target.checked; });   // individual layers omit Static
    }

    function init(){
      restoreLayers();                            // bring back saved layer settings from a previous session (overlays onto the engine state in place)
      state.layers.forEach(E.ensureSettings);     // backfill any missing fields
      buildLayerCards();
      panel.addEventListener('input', scheduleSaveLayers);    // persist edits (debounced)
      panel.addEventListener('change', scheduleSaveLayers);
      // Bug guard: clicking empty grid/card space (a non-control) was moving focus into a stray number box
      // (reproduced even in Incognito, with NO .focus()/label in our code — a focus-on-mousedown quirk).
      // preventDefault on mousedown for non-controls cancels that focus change without affecting real controls.
      cards.addEventListener('mousedown', e=>{ if(!e.target.closest('input,button,select,textarea,a,label')) e.preventDefault(); });
    }

    return { init, buildCards: buildLayerCards, save: saveLayers, scheduleSave: scheduleSaveLayers, restore: restoreLayers, reorderFromDom };
  }

  return { create, serializeLayers, serializeOrder, overlayLayers, TYPES, BLENDS };
});
