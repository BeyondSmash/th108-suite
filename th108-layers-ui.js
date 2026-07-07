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
  const TYPES=['background','reactive','gradient','pattern','individual','audio','media','agent'], BLENDS=['normal','add','screen','multiply','max','replace'];
  const root_PaintBoard = () => (typeof window!=='undefined' && window.TH108PaintBoard) || { mount(){ return { draw(){}, recolorSelection(){}, clearSelection(){}, selectNone(){}, selCount(){return 0;}, destroy(){} }; } };
  // lucide chevrons-down-up (= "collapse") / chevrons-up-down (= "expand") for the card corner toggle
  const SVGA='<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const CHEV_COLLAPSE=SVGA+'<path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/></svg>';   // lucide chevrons-down (shown when expanded — click to collapse)
  const CHEV_EXPAND=SVGA+'<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/></svg>';   // lucide chevrons-right (shown when collapsed — click to expand)

  // ----- pure persist helpers (node-testable) -----
  function serializeLayers(layers){ return layers.map(L=>({name:L.name,enabled:L.enabled,type:L.type,opacity:L.opacity,blend:L.blend,fps:L.fps,settings:L.settings,collapsed:!!L.collapsed})); }
  function serializeOrder(layers){ return layers.map(L=>L.type+':'+L.name); }
  function overlayLayers(layers, a, makeLayer){
    if(!Array.isArray(a)) return;
    // reconcile COUNT first so layers added beyond the 4 defaults (or removed below 4) persist across a refresh.
    // makeLayer (caller-supplied, has the engine's NLED for the rgb buffer) builds a blank live layer to grow into.
    if(makeLayer){ while(layers.length<a.length) layers.push(makeLayer()); if(layers.length>a.length) layers.length=a.length; }
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
          attachHex = opts.attachHex || noop, snap = opts.snap || noop, snapMul = opts.snapMul || noop, // page UI helpers (hex box per color picker, slider detent single/multiple)
          pushConfig = opts.pushConfig || noop,                         // mirror saves to the daemon's config.json
          isRunning = opts.isRunning || (() => false),                  // layer loop live? (reorder warm-renders so the change shows immediately)
          onPatternPick = opts.onPatternPick || noop,                   // page hook: picking a pattern while a firmware effect shows = "back to layers"
          onAudioSource = opts.onAudioSource || noop,                   // page hook: audio-layer source pick → start/stop in-tab Web Audio capture
          liveAudioActive = opts.liveAudioActive || (()=>false),        // page hook: is real in-tab capture running? (Live preview blanks when not)
          listAgentSessions = opts.listAgentSessions || (()=>Promise.resolve([])), // page hook: fetch agentSessions from /status or /agent/sessions
          setFocusConfig = opts.setFocusConfig || noop,                 // page hook: POST outline color + auto-switch/outline-on-switch toggles
          focusWindowFront = opts.focusWindowFront || noop;             // page hook: POST "bring this session's window to front + flash"

    // ----- persist full layer state (settings survive page refresh) -----
    let _slsT=0;
    function saveLayers(){ try{ localStorage.setItem('th108_layers', JSON.stringify(serializeLayers(state.layers))); }catch(_){ } }
    function scheduleSaveLayers(){ clearTimeout(_slsT); _slsT=setTimeout(()=>{ saveLayers(); pushConfig(); },400); }   // mirror the edit to the daemon's config.json (no-op if no daemon)
    const blankLayer=()=>({ name:'Layer', enabled:false, type:'background', opacity:1, blend:'normal', fps:30, settings:{}, rgb:new Uint8Array(E.NLED*3), lastTick:0, _clk:0, _lastNow:undefined });
    function restoreLayers(){ try{ overlayLayers(state.layers, JSON.parse(localStorage.getItem('th108_layers')||'null'), blankLayer); }catch(_){ } }
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
    const SRC_KEEP = new Set(['source','appId','deviceId','micDeviceId','micGain','micGate','toggleKeyLed','toggleKeyLabel','samplePrevOff','livePrevOff','_copyUndo','bySource']);
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
        const cap=v=>v.charAt(0).toUpperCase()+v.slice(1);   // display label capitalized; the option VALUE stays lowercase (what's stored/compared)
        const opt=(arr,sel)=>arr.map(v=>'<option value="'+v+'"'+(v===sel?' selected':'')+'>'+cap(v)+'</option>').join('');
        const usedT=new Set(state.layers.filter(o=>o!==L).map(o=>o.type));   // one layer per type → grey out types already taken by another layer
        const tOpt=TYPES.map(v=>'<option value="'+v+'"'+(v===L.type?' selected':'')+(usedT.has(v)?' disabled':'')+'>'+cap(v)+'</option>').join('');
        card.innerHTML=
          '<div class="lhead">'+
            '<span class="lgrip" title="Drag to change layer level">⠿</span>'+   // drag handle for the page's pointer-based card-drag system (same lift/clone/breach-line as the Home cards)
            '<span class="llvl">Layer '+(n+1)+'</span>'+
            '<input type="checkbox" class="le"'+(L.enabled?' checked':'')+' title="Enable layer">'+
            '<input type="text" class="ln" value="'+L.name.replace(/"/g,'&quot;')+'">'+
            '<select class="lt">'+tOpt+'</select>'+
            '<span class="lctrls">'+   // Opacity + composite mode + FPS on one centered row (own line below name/type)
              '<span class="lfield">Opacity <input type="range" class="lo" min="0" max="100" value="'+Math.round(L.opacity*100)+'"><input type="number" class="numin lon" min="0" max="100" value="'+Math.round(L.opacity*100)+'"></span>'+
              '<select class="lbl">'+opt(BLENDS,L.blend)+'</select>'+
              '<span class="lfield">FPS <input type="range" class="lf" min="1" max="30" value="'+L.fps+'"><input type="number" class="numin lfn" min="1" max="30" value="'+L.fps+'"></span>'+
            '</span>'+
          '</div>'+
          '<div class="lcorner">'+
            '<button type="button" class="lreset" title="Reset this layer to its default settings">Reset</button>'+
            (state.layers.length>1?'<button type="button" class="lrm" title="Remove this layer">Delete</button>':'')+
            '<button type="button" class="lcoll" title="Collapse / expand this layer card">'+(L.collapsed?CHEV_EXPAND:CHEV_COLLAPSE)+'</button>'+
          '</div>'+
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
          if(L.type==='agent'){ L.blend='add'; const bl=card.querySelector('.lbl'); if(bl) bl.value='add'; L.opacity=0.9; lo.value=90; lon.value=90; }   // agent layer = ADD so twinkles/spinner pop over the base layer
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
        const rmb=card.querySelector('.lrm'); if(rmb) rmb.addEventListener('click',()=>{ if(state.layers.length>1 && confirm('Remove layer "'+L.name+'"?')) removeLayer(n); });
        const rstb=card.querySelector('.lreset'); if(rstb) rstb.addEventListener('click',()=>resetLayer(n));
        buildLayerBody(card,L);
      }
      if(state.layers.length < TYPES.length){   // one layer per effect type → cap at TYPES.length
        const addb=document.createElement('button'); addb.type='button'; addb.className='laddbtn';
        addb.textContent='+ Add layer'; addb.title='add another lighting layer (one per effect type, up to '+TYPES.length+')';
        addb.addEventListener('click',addLayer); host.appendChild(addb);
      }
    }
    function addLayer(){
      if(state.layers.length>=TYPES.length) return;
      const used=new Set(state.layers.map(o=>o.type)), type=TYPES.find(t=>!used.has(t));
      if(!type) return;
      const blend = type==='individual'?'replace' : type==='audio'?'add' : type==='agent'?'add' : 'normal';
      const L={ name:type.charAt(0).toUpperCase()+type.slice(1), enabled:true, type, opacity: type==='audio'?0.85 : type==='agent'?0.9 : 1, blend, fps:30, settings:{} };
      E.ensureSettings(L); state.layers.push(L);
      buildLayerCards(); saveLayerOrder(); saveLayers(); pushConfig();
    }
    // reset a layer to its type's default settings (same look a freshly-added layer of this type has); keeps its
    // name/enabled/position. Undo restores the prior settings + opacity/blend/fps.
    function resetLayer(n){
      const L=state.layers[n]; if(!L) return;
      if(!confirm('Reset layer "'+L.name+'" to its default settings?')) return;
      const prev={ settings:JSON.parse(JSON.stringify(L.settings)), opacity:L.opacity, blend:L.blend, fps:L.fps };
      const apply=cfg=>{ L.settings=cfg.settings; L.opacity=cfg.opacity; L.blend=cfg.blend; L.fps=cfg.fps; E.ensureSettings(L); L.lastTick=0; buildLayerCards(); saveLayers(); pushConfig(); };
      apply({ settings:{}, opacity:(L.type==='audio'?0.85:L.type==='agent'?0.9:1), blend:(L.type==='individual'?'replace':L.type==='audio'||L.type==='agent'?'add':'normal'), fps:30 });
      showUndoToast('Reset “'+L.name+'”', ()=>apply(prev));
    }
    function removeLayer(n){
      if(n<0 || n>=state.layers.length || state.layers.length<=1) return;
      const removed=state.layers[n], idx=n;
      state.layers.splice(n,1);
      buildLayerCards(); saveLayerOrder(); saveLayers(); pushConfig();
      showUndoToast('Removed “'+removed.name+'”', ()=>{   // ~6s window to undo a mistaken removal
        state.layers.splice(Math.min(idx, state.layers.length), 0, removed);
        buildLayerCards(); saveLayerOrder(); saveLayers(); pushConfig();
      });
    }
    let _toastEl=null, _toastTimer=null;
    function showUndoToast(msg, onUndo){
      if(_toastTimer){ clearTimeout(_toastTimer); _toastTimer=null; }
      if(_toastEl && _toastEl.parentNode) _toastEl.parentNode.removeChild(_toastEl);
      const t=document.createElement('div'); t.className='undo-toast';
      t.innerHTML='<span></span><button type="button">Undo</button>';
      t.querySelector('span').textContent=msg;
      const close=()=>{ if(_toastTimer){ clearTimeout(_toastTimer); _toastTimer=null; } if(t.parentNode){ t.classList.add('out'); setTimeout(()=>{ if(t.parentNode) t.parentNode.removeChild(t); }, 250); } if(_toastEl===t) _toastEl=null; };
      t.querySelector('button').addEventListener('click',()=>{ close(); try{ onUndo(); }catch(_){ } });
      document.body.appendChild(t); _toastEl=t;
      requestAnimationFrame(()=>t.classList.add('in'));
      _toastTimer=setTimeout(close, 6000);
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
        if(s.brush!=='sub') s.brush='solid';   // active brush is PER-KEY now (each key stores its own mode); 'fill' is legacy
        // brush note shown under the controls — explains what the active brush paints
        const brushNote = b => b==='sub'
          ? 'Silhouette brush: painted keys carve the layers below into dark negative space (the color is ignored) — needs a layer beneath. Mix freely with Solid keys in this same layer.'
          : 'Solid brush: paint exact key colors. Pick a color, Show Keyboard, then click/drag keys. Switch to Silhouette to carve other keys in the SAME layer.';
        const brushBtns=[['solid','🎨 Solid'],['sub','⬛ Silhouette']].map(o=>'<button type="button" class="patbtn s-brush'+(o[0]===s.brush?' on':'')+'" data-brush="'+o[0]+'">'+o[1]+'</button>').join('');
        body.innerHTML='<div class="ctl">'+
          sec('Brush')+
          full('<span style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;flex:1 1 100%">'+brushBtns+'</span>')+
          sub('Paint')+
          full('<input type="color" class="s-current" value="'+s.current+'"'+(s.brush==='sub'?' style="opacity:.4"':'')+'><span class="val s-fillNote" style="opacity:.7;flex:1 1 100%">'+brushNote(s.brush)+'</span>')+
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
          wrap.innerHTML='<div class="pb-board"></div><div class="pb-hint">Click/drag = paint · Shift = add · Ctrl = deselect · Alt+drag = erase · pick a color to recolor the selection</div>';
          // mount the board ABOVE the whole grid row holding this layer (the full-width board would otherwise
          // split side-by-side cards, e.g. Layer 3 | Layer 4) — find the leftmost card sharing this card's row top
          const sibs=[...card.parentNode.querySelectorAll('.lcard')], myTop=card.getBoundingClientRect().top;
          let anchor=card, anchorLeft=card.getBoundingClientRect().left;
          for(const sc of sibs){ const r=sc.getBoundingClientRect(); if(Math.abs(r.top-myTop)<8 && r.left<anchorLeft){ anchor=sc; anchorLeft=r.left; } }
          card.parentNode.insertBefore(wrap, anchor);   // full-width board sits above the entire row → side-by-side cards stay together below it
          pb=root_PaintBoard().mount(wrap.querySelector('.pb-board'), {
            engine:E, getKeys:()=>s.keys, getColor:()=> s.brush==='sub' ? 'sub' : s.current,   // brush paints the silhouette marker OR the solid color
            onPaint:(idx,hex)=>{ if(hex) s.keys[idx]=hex; else delete s.keys[idx]; reRender(); },
            onChange:()=>{ updCount(); scheduleSaveLayers(); },
          });
          c('.s-showkb').textContent='⌨ Hide Keyboard'; updCount();
          // the board mounts ABOVE this card (pushing it down) — smooth-scroll the page to follow it into view.
          // rAF so the insert's reflow (and any Fill-mode masonry repack) settles before the scroll targets it.
          requestAnimationFrame(()=>{ try{ wrap.scrollIntoView({behavior:'smooth', block:'start'}); }catch(_){ try{ wrap.scrollIntoView(); }catch(__){ } } });   // keyboard at the TOP (below the sticky header via scroll-margin) so the layer card stays visible below it
        }
        function unmountBoard(){ if(!pb) return;
          const before=window.scrollY, r=wrap.getBoundingClientRect();
          pb.destroy(); pb=null; const w=wrap; wrap=null; if(w&&w.parentNode) w.parentNode.removeChild(w);
          const shift=Math.max(0, Math.min(r.height, -r.top));   // the board sat ABOVE the viewport top → its removal teleports content up by this much
          if(shift>0) window.scrollTo(0, before-shift);          // cancel that instant jump so the next step can lerp instead
          c('.s-showkb').textContent='⌨ Show Keyboard'; updCount();
          requestAnimationFrame(()=>{ try{ card.scrollIntoView({behavior:'smooth', block:'center'}); }catch(_){ } });   // smooth-scroll back to the card instead of teleporting
        }
        body.querySelectorAll('.s-brush').forEach(b=>b.addEventListener('click',()=>{   // switch the active brush in place (no rebuild — that would orphan the mounted paint board, a card sibling)
          s.brush=b.dataset.brush;
          body.querySelectorAll('.s-brush').forEach(x=>x.classList.toggle('on',x.dataset.brush===s.brush));
          const note=c('.s-fillNote'); if(note) note.textContent=brushNote(s.brush);
          const cur=c('.s-current'); if(cur) cur.style.opacity = s.brush==='sub' ? '.4' : '1';   // color is irrelevant while the Silhouette brush is active
          reRender(); scheduleSaveLayers(); }));
        c('.s-current').addEventListener('input',e=>{ s.current=e.target.value; if(s.brush!=='sub' && pb) pb.recolorSelection(); });   // recolor only repaints SOLID keys; silhouette keys ignore color
        c('.s-showkb').addEventListener('click',()=>{ pb?unmountBoard():mountBoard(); });
        c('.s-clearsel').addEventListener('click',()=>{ if(pb){ pb.clearSelection(); } reRender(); scheduleSaveLayers(); });
        c('.s-clearall').addEventListener('click',()=>{ s.keys={}; if(pb){ pb.selectNone(); pb.draw(); } reRender(); scheduleSaveLayers(); });
      } else if(L.type==='media'){
        if(!Array.isArray(s.frames)) s.frames=[];
        const MAXF=30, MAXDIM=240, NLED=E.NLED, INDICES=E.INDICES, TR=E.BOARDW/E.BOARDH;   // cap frames for /config; source decoded ≤MAXDIM px
        if(s.spd==null) s.spd=100; if(s.zoom==null) s.zoom=100; if(s.panX==null) s.panX=0; if(s.panY==null) s.panY=0; if(s.rot==null) s.rot=0;
        if(s.map===undefined) s.map='physical'; if(s.sampleMode===undefined) s.sampleMode='average'; if(s.bars===undefined) s.bars='black'; if(s.barColor===undefined) s.barColor='#000000';
        const SAMPLES=[['average','Average (area)'],['center','Center pixel'],['gaussian','Gaussian (center-weighted)'],['vivid','Most vivid pixel'],['bright','Brightest pixel (text/logos)'],['dominant','Dominant color'],['standout','Standout (max contrast)']];
        const optList=(arr,sel)=>arr.map(o=>'<option value="'+o[0]+'"'+(o[0]===sel?' selected':'')+'>'+o[1]+'</option>').join('');
        const esc=t=>(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
        const fmtBytes=b=>(b==null?'':b<1024?b+' B':b<1048576?(b/1024).toFixed(0)+' KB':(b/1048576).toFixed(1)+' MB');
        const infoTxt=()=>{ if(!s.frames.length) return 'no clip loaded';
          let durMs=0; for(const f of s.frames) durMs+=Math.max(1,f.d||100); const dur=durMs/1000, spd=(s.spd||100)/100, adj=dur/spd;
          const parts=[esc(s.mediaName||'clip'), s.frames.length+' frames'];
          if(s.srcW) parts.push(s.srcW+'×'+s.srcH);
          parts.push(dur.toFixed(1)+'s'+(Math.abs(spd-1)>0.001?' ('+adj.toFixed(1)+'s at '+spd.toFixed(1)+'×)':''));
          if(s.mediaBytes) parts.push(fmtBytes(s.mediaBytes));
          return parts.join(' · '); };
        const av=k=>(s[k]==null?100:s[k]);   // Brightness/Saturation/Contrast/Gamma + Freeze live in the shared Adjust block below (engine.applyAdjust)
        body.innerHTML='<div class="ctl">'+
          sec('Media (GIF / image)')+
          full('<canvas class="s-mediaSrc" width="378" height="150" style="width:100%;height:auto;display:block;background:#0d1117;border-radius:8px;cursor:move;touch-action:none;flex:1 1 100%" title="Drag to pan · the blue box is the keyboard area"></canvas>')+
          sec('Keyboard preview')+
          full('<canvas class="s-mediaPrev" width="378" height="110" style="width:100%;height:auto;display:block;background:#0d1117;border-radius:8px;flex:1 1 100%"></canvas>')+
          full('<span class="val" style="opacity:.55;flex:1 1 100%;font-size:12px;line-height:1.4;text-align:center">Sampled onto the keys, played by the daemon (no Connect) and blended with the other layers. Long GIFs sample down to '+MAXF+' frames. Color &amp; Freeze live in <b>Adjust</b> below.</span>')+
          full('<div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:0 12px;width:100%"><span></span><input type="file" class="s-mediaFile" accept="image/*" style="justify-self:center"><button type="button" class="s-mediaClear" style="margin:0;justify-self:start" title="Offload the loaded GIF/image from this layer">Release</button></div>')+
          full('<div style="display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;flex:1 1 100%"><input type="text" class="s-murl" placeholder="paste an image / GIF URL…" style="flex:1;min-width:150px"><button type="button" class="s-murlload" style="flex:none">Load URL</button><button type="button" class="s-mpaste" style="flex:none" title="Paste an image from the clipboard">Paste</button><button type="button" class="s-mseqbtn" style="flex:none" title="Pick multiple images = one frame each">+ PNG Frames</button><input type="file" class="s-mseq" accept="image/*" multiple style="display:none"><button type="button" class="s-mfolderbtn" style="flex:none" title="Pick a folder of images = one frame each">+ Folder</button><input type="file" class="s-mfolder" webkitdirectory style="display:none"><button type="button" class="s-mlibbtn" style="flex:none">📚 Library</button><button type="button" class="s-msave" style="flex:none" title="Save the loaded clip to the library">★ Add</button></div>')+
          full('<div class="s-mlib" style="display:none;width:100%;margin-top:4px;padding:8px;background:var(--inset);border-radius:10px;flex:1 1 100%"></div>')+
          full('<span class="val s-mediaInfo" style="opacity:.85;flex:1 1 100%;text-align:center">'+infoTxt()+'</span>')+
          sub('Framing')+
          ((s.frames.length && !s.mediaId)?full('<span class="val" style="color:var(--warn,#e0a200);opacity:.85;flex:1 1 100%;text-align:center;font-size:12px;line-height:1.4">⚠ Re-load this clip (Choose File) to adjust framing — it was saved before framing existed, so only the baked frames remain.</span>'):'')+
          row('Zoom','<span class="srange" style="width:100%"><input type="range" class="s-mzoom" min="20" max="500" value="'+s.zoom+'"><i class="tick" style="left:calc(7px + (100% - 14px)*0.1667)"></i></span><span class="val s-mzoomV"></span>')+
          row('Rotate','<span class="srange" style="width:100%"><input type="range" class="s-mrot" min="0" max="360" value="'+s.rot+'"><i class="tick" style="left:calc(7px + (100% - 14px)*0.25)"></i><i class="tick" style="left:calc(7px + (100% - 14px)*0.5)"></i><i class="tick" style="left:calc(7px + (100% - 14px)*0.75)"></i></span><span class="val s-mrotV"></span>')+
          full('<button type="button" class="s-mframeReset" style="flex:none">Reset framing</button><span class="val" style="opacity:.5;font-size:11px">drag the preview above to pan; zoom/rotate to frame which part of the clip maps onto the keys</span>')+
          '<div class="lsub s-sampleHdr">Sampling</div>'+
          row('Map','<select class="s-mmap"><option value="physical"'+(s.map==='physical'?' selected':'')+'>Physical</option><option value="grid"'+(s.map==='grid'?' selected':'')+'>Grid (uniform)</option></select><span class="val" style="opacity:.5;font-size:11px">Physical = real key positions · Grid = even cells (best for text/pixel art)</span>')+
          row('Sample','<select class="s-msample">'+optList(SAMPLES,s.sampleMode)+'</select><span></span>')+
          row('Out-of-frame','<select class="s-mbars"><option value="black"'+(s.bars==='black'?' selected':'')+'>Black</option><option value="sampled"'+(s.bars==='sampled'?' selected':'')+'>Sampled (edge)</option><option value="custom"'+(s.bars==='custom'?' selected':'')+'>Custom…</option></select>'+(s.bars==='custom'?'<input type="color" class="s-mbarcol" value="'+(s.barColor||'#000000')+'" style="width:34px;height:26px;margin-left:6px">':'<span></span>'))+
          row('Speed','<span class="srange" style="width:100%"><input type="range" class="s-mspd" min="10" max="400" value="'+s.spd+'"><i class="tick" style="left:calc(7px + (100% - 14px)*0.2308)"></i></span><span class="val s-mspdV"></span>')+
          full('<div style="display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;flex:1 1 100%"><span style="color:var(--muted);font-size:12px">Color preset</span><button type="button" class="s-mvivid" style="flex:none" title="LED match: sat 170% / gamma 1.8 — reads as vividly on the keys as on screen (sets the Adjust block below)">✨ Vivid</button><button type="button" class="s-mraw" style="flex:none" title="Untouched / raw sRGB (sat 100%, gamma 1.0)">Raw</button><span class="val" style="opacity:.5;font-size:11px;width:100%;text-align:center">presets for the Adjust block below</span></div>')+
          sub('Motion')+
          row('Hide static','<label class="sl" style="margin:0"><input type="checkbox" class="s-mhide"'+(s.hideStatic?' checked':'')+'> Only animated pixels show — keys whose color never changes across the loop turn transparent (layers below pass through)</label><span></span>')+
          (s.hideStatic?row('Threshold','<span class="srange" style="width:100%"><input type="range" class="s-mthr" min="0" max="80" value="'+(s.motionThr==null?16:s.motionThr)+'"><i class="tick" style="left:calc(7px + (100% - 14px)*0.2)"></i></span><span class="val s-mthrV"></span>'):'')+
        '</div>';
        const c=q=>body.querySelector(q);
        const Media=(typeof window!=='undefined'&&window.TH108Media)||null;
        let _srcTmp=null, _dragging=false, _dragLast=null, _dragIdx=0, _rngFor=null, _rng=null, _currentSrc=null;   // _currentSrc = {kind,name,blob|blobs} for ★ Add to Library
        // ===== decode the source to in-memory frames (FULL image, not pre-cropped) so framing can re-sample live =====
        async function decodeSource(file){
          const out=[], tmp=document.createElement('canvas'), tx=tmp.getContext('2d',{willReadFrequently:true});
          const draw=(src,vw,vh,delay)=>{ const sc=Math.min(1,MAXDIM/Math.max(vw,vh)), w=Math.max(1,Math.round(vw*sc)), h=Math.max(1,Math.round(vh*sc));
            tmp.width=w; tmp.height=h; tx.clearRect(0,0,w,h); tx.drawImage(src,0,0,w,h); const id=tx.getImageData(0,0,w,h); out.push({img:id, w, h, d:Math.max(20,delay|0), edge:edgeAvg(id.data,w,h)}); };
          if(window.ImageDecoder){ const dec=new ImageDecoder({data:await file.arrayBuffer(), type:file.type||'image/gif'}); await dec.tracks.ready; const trk=dec.tracks.selectedTrack;
            for(let i=0;i<5000;i++){ let res; try{ res=await dec.decode({frameIndex:i}); }catch(e){ break; } const vf=res.image, w=vf.displayWidth||vf.codedWidth, h=vf.displayHeight||vf.codedHeight; draw(vf,w,h, vf.duration?vf.duration/1000:100); if(vf.close)vf.close(); if(trk.frameCount && i>=trk.frameCount-1) break; if(i>=300) break; } }
          if(!out.length){ const bmp=await createImageBitmap(file); draw(bmp,bmp.width,bmp.height,100); bmp.close&&bmp.close(); }
          if(out.length>MAXF){ const s2=[], step=out.length/MAXF; for(let k=0;k<MAXF;k++){ const a=Math.floor(k*step), b2=Math.floor((k+1)*step); let d=0; for(let i=a;i<Math.max(b2,a+1);i++) d+=out[i].d; s2.push({img:out[a].img, w:out[a].w, h:out[a].h, d}); } return s2; }   // thin frame COUNT, preserve duration
          return out;
        }
        // image sequence (PNG frames / folder) → one source frame each, filename order
        async function decodeSourceSeq(files){
          const arr=[...files].filter(f=>/^image\//.test(f.type)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
          const out=[], tmp=document.createElement('canvas'), tx=tmp.getContext('2d',{willReadFrequently:true});
          for(const f of arr){ const bmp=await createImageBitmap(f).catch(()=>null); if(!bmp) continue;
            const sc=Math.min(1,MAXDIM/Math.max(bmp.width,bmp.height)), w=Math.max(1,bmp.width*sc|0), h=Math.max(1,bmp.height*sc|0);
            tmp.width=w; tmp.height=h; tx.clearRect(0,0,w,h); tx.drawImage(bmp,0,0,w,h); if(bmp.close)bmp.close();
            const id=tx.getImageData(0,0,w,h); out.push({img:id, w, h, d:100, edge:edgeAvg(id.data,w,h)}); }
          if(out.length>MAXF){ const s2=[], step=out.length/MAXF; for(let k=0;k<MAXF;k++) s2.push(out[Math.floor(k*step)]); return s2; }
          return out;
        }
        // border-pixel average of an RGBA buffer → the "sampled" out-of-frame fill color
        function edgeAvg(D,dw,dh){ let er=0,eg=0,eb=0,en=0; const rw=y=>{ for(let x=0;x<dw;x++){ const o=(y*dw+x)*4; er+=D[o];eg+=D[o+1];eb+=D[o+2];en++; } }; const cw=x=>{ for(let y=0;y<dh;y++){ const o=(y*dw+x)*4; er+=D[o];eg+=D[o+1];eb+=D[o+2];en++; } }; rw(0);rw(dh-1);cw(0);cw(dw-1); return [er/en|0,eg/en|0,eb/en|0]; }
        const cellFor=idx=>{ if(s.map==='grid'){ const G=E.GRID[idx]; if(G) return [(G[0]+0.5)/E.GW,(G[1]+0.5)/E.GH,1/E.GW,1/E.GH]; } return E.keyCell(idx); };   // grid = even cells (text/pixel art) · physical = real key positions
        function barFill(edge){ const m=s.bars||'black'; if(m==='custom'){ const h=s.barColor||'#000000'; return [parseInt(h.substr(1,2),16),parseInt(h.substr(3,2),16),parseInt(h.substr(5,2),16)]; } if(m==='sampled') return edge||[0,0,0]; return [0,0,0]; }
        // sample one source frame onto the keys via the current framing (cover + zoom/pan/rotate) + sample strategy
        function sampleFrame(fr){
          const data=fr.img.data, SW=fr.w, SH=fr.h, cr=E.computeCrop(SW,SH,TR,(s.zoom||100)/100,s.panX||0,s.panY||0); s.panX=cr.panX; s.panY=cr.panY;
          const mode=s.sampleMode||'average', N=mode==='center'?0:4, bc=barFill(fr.edge);
          const rot=((s.rot||0))*Math.PI/180, cs=Math.cos(rot), sn=Math.sin(rot), ccx=cr.cx+cr.cw/2, ccy=cr.cy+cr.ch/2, rgb=new Array(INDICES.length*3);
          for(let k=0;k<INDICES.length;k++){ const cl=cellFor(INDICES[k]), t=k*3; if(!cl){ rgb[t]=rgb[t+1]=rgb[t+2]=0; continue; }
            const sx=cr.cx+(cl[0]-cl[2]/2)*cr.cw, sy=cr.cy+(cl[1]-cl[3]/2)*cr.ch, sw=cl[2]*cr.cw, sh=cl[3]*cr.ch;
            const SR=[],SG=[],SB=[],SU=[],SV=[];
            for(let iy=0;iy<=N;iy++)for(let ix=0;ix<=N;ix++){ const u=N?ix/N:0.5, v=N?iy/N:0.5; let fx=sx+sw*u, fy=sy+sh*v;
              if(rot){ const dx=fx-ccx,dy=fy-ccy; fx=ccx+dx*cs+dy*sn; fy=ccy-dx*sn+dy*cs; }
              if(fx<0||fy<0||fx>=SW||fy>=SH) continue; const o=((fy|0)*SW+(fx|0))*4; SR.push(data[o]);SG.push(data[o+1]);SB.push(data[o+2]);SU.push(u);SV.push(v); }
            const n=SR.length; let R,G,B;
            if(!n){ rgb[t]=bc[0]; rgb[t+1]=bc[1]; rgb[t+2]=bc[2]; continue; }   // fully outside the source → fill color
            if(mode==='vivid'){ let bi=0,bs=-1; for(let i=0;i<n;i++){ const sa=Math.max(SR[i],SG[i],SB[i])-Math.min(SR[i],SG[i],SB[i]); if(sa>bs){bs=sa;bi=i;} } R=SR[bi];G=SG[bi];B=SB[bi]; }
            else if(mode==='bright'){ let bi=0,bl=-1; for(let i=0;i<n;i++){ const L=0.299*SR[i]+0.587*SG[i]+0.114*SB[i]; if(L>bl){bl=L;bi=i;} } R=SR[bi];G=SG[bi];B=SB[bi]; }
            else if(mode==='standout'){ let mr=0,mg=0,mb=0; for(let i=0;i<n;i++){mr+=SR[i];mg+=SG[i];mb+=SB[i];} mr/=n;mg/=n;mb/=n; let bi=0,bd=-1; for(let i=0;i<n;i++){ const dr=SR[i]-mr,dg=SG[i]-mg,db=SB[i]-mb,d=dr*dr+dg*dg+db*db; if(d>bd){bd=d;bi=i;} } R=SR[bi];G=SG[bi];B=SB[bi]; }
            else if(mode==='dominant'){ const cnt={}; for(let i=0;i<n;i++){ const q=((SR[i]>>6)<<4)|((SG[i]>>6)<<2)|(SB[i]>>6); (cnt[q]||(cnt[q]=[])).push(i); } let best=null,bn=0; for(const q in cnt){ if(cnt[q].length>bn){bn=cnt[q].length;best=cnt[q];} } let r=0,g=0,b=0; for(const i of best){r+=SR[i];g+=SG[i];b+=SB[i];} R=r/best.length;G=g/best.length;B=b/best.length; }
            else if(mode==='gaussian'){ let r=0,g=0,b=0,w=0; for(let i=0;i<n;i++){ const du=SU[i]-0.5,dv=SV[i]-0.5,wt=Math.exp(-(du*du+dv*dv)*8); r+=SR[i]*wt;g+=SG[i]*wt;b+=SB[i]*wt;w+=wt; } R=r/w;G=g/w;B=b/w; }
            else { let r=0,g=0,b=0; for(let i=0;i<n;i++){r+=SR[i];g+=SG[i];b+=SB[i];} R=r/n;G=g/n;B=b/n; }   // average (area) + center
            rgb[t]=R|0; rgb[t+1]=G|0; rgb[t+2]=B|0;
          }
          return rgb;
        }
        function resampleAll(){ if(!L._srcFrames||!L._srcFrames.length) return; s.frames=L._srcFrames.map(fr=>({d:fr.d, rgb:sampleFrame(fr)})); L._mediaFrames=null; L.lastTick=0; _rngFor=null; }
        function resampleOne(i){ if(!L._srcFrames||!L._srcFrames[i]||!s.frames[i]) return; s.frames[i].rgb=sampleFrame(L._srcFrames[i]); L._mediaFrames=null; }   // light re-sample of the current frame during a drag
        // positioning canvas: source frame (fit) + the keyboard crop box overlaid; dims the cropped-out area. Paints
        // any canvas (the main draggable one OR the floating-pill duplicate).
        function drawSrc(idx){ drawSrcOn(c('.s-mediaSrc'), idx); }
        function drawSrcOn(cv, idx){
          if(!cv) return; const ctx=cv.getContext('2d');
          ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,cv.width,cv.height);
          const fr=L._srcFrames&&L._srcFrames[idx||0]; if(!fr){ cv._map=null; return; }
          if(!_srcTmp) _srcTmp=document.createElement('canvas');
          _srcTmp.width=fr.w; _srcTmp.height=fr.h; _srcTmp.getContext('2d').putImageData(fr.img,0,0);
          const sc=Math.min(cv.width/fr.w, cv.height/fr.h), dw=fr.w*sc, dh=fr.h*sc, ox=(cv.width-dw)/2, oy=(cv.height-dh)/2;
          ctx.drawImage(_srcTmp, ox,oy,dw,dh);
          const cr=E.computeCrop(fr.w,fr.h,TR,(s.zoom||100)/100,s.panX||0,s.panY||0); s.panX=cr.panX; s.panY=cr.panY;
          const rx=ox+cr.cx*sc, ry=oy+cr.cy*sc, rw=cr.cw*sc, rh=cr.ch*sc, rot=((s.rot||0))*Math.PI/180;
          if(rot){ ctx.save(); ctx.translate(rx+rw/2, ry+rh/2); ctx.rotate(-rot); ctx.strokeStyle='#58a6ff'; ctx.lineWidth=2; ctx.strokeRect(-rw/2,-rh/2,rw,rh); ctx.restore(); }
          else { ctx.fillStyle='rgba(1,4,9,.6)'; ctx.fillRect(ox,oy,dw,ry-oy); ctx.fillRect(ox,ry+rh,dw,oy+dh-(ry+rh)); ctx.fillRect(ox,ry,rx-ox,rh); ctx.fillRect(rx+rw,ry,ox+dw-(rx+rw),rh); ctx.strokeStyle='#58a6ff'; ctx.lineWidth=2; ctx.strokeRect(rx,ry,rw,rh); }
          cv._map={sc};
        }
        async function ensureSource(){ if((L._srcFrames&&L._srcFrames.length) || !s.mediaId || !(Media&&Media.available)) return;   // lazy-load the source from IDB so framing works after a refresh
          try{ const src=await Media.getSource(s.mediaId); if(!src) return; L._srcFrames = Array.isArray(src) ? await decodeSourceSeq(src) : await decodeSource(src); drawSrc(0); }catch(_){ } }
        // ===== load pipeline (single blob / image sequence) shared by every loader =====
        const setInfo=t=>{ const el=c('.s-mediaInfo'); if(el) el.textContent=t; };
        function finishLoad(name, srcData, kind){
          s.mediaName=name; if(!s.mediaId) s.mediaId=(typeof crypto!=='undefined'&&crypto.randomUUID)?crypto.randomUUID():('m'+performance.now()+'-'+INDICES.length);
          resampleAll(); drawSrc(0); _currentSrc={kind, name, blob:kind==='single'?srcData:null, blobs:kind==='seq'?srcData:null};
          if(L._srcFrames&&L._srcFrames[0]){ s.srcW=L._srcFrames[0].w; s.srcH=L._srcFrames[0].h; }   // source dims for the stats line
          s.mediaBytes = kind==='seq' ? srcData.reduce((a,f)=>a+(f.size||0),0) : (srcData.size||0);
          if(Media&&Media.available){ try{ Media.putSource(s.mediaId, srcData); }catch(_){ } }   // persist blob OR blobs array
          setInfo(infoTxt()); scheduleSaveLayers();
        }
        async function loadBlob(blob,name){ setInfo('decoding '+name+'…'); try{ L._srcFrames=await decodeSource(blob); if(!L._srcFrames.length) throw new Error('no frames'); finishLoad(name, blob, 'single'); }catch(e){ setInfo('decode failed: '+e.message); } }
        async function loadSeq(files,name){ setInfo('decoding '+files.length+' frames…'); try{ L._srcFrames=await decodeSourceSeq(files); if(!L._srcFrames.length) throw new Error('no images'); finishLoad(name, [...files], 'seq'); }catch(e){ setInfo('decode failed: '+e.message); } }
        async function loadUrl(url){ if(!url) return; setInfo('fetching…'); try{ const r=await fetch(url,{mode:'cors'}); if(!r.ok) throw new Error('HTTP '+r.status); const blob=await r.blob(); if(!/^image\//.test(blob.type)) throw new Error('not an image ('+(blob.type||'?')+')'); await loadBlob(blob,(url.split('/').pop()||'url-image').split('?')[0]); }catch(e){ setInfo('URL load failed: '+e.message+' (host may block cross-origin fetch)'); } }
        function refreshLib(){ const el=c('.s-mlib'); if(el && el.style.display!=='none' && Media && Media.available) Media.mountPicker(el, it=>{ if(it.kind==='seq'&&it.blobs) loadSeq(it.blobs, it.name); else loadBlob(it.blob, it.name); }); }
        function currentIdx(){ if(!s.frames.length) return 0; let tot=0; for(const f of s.frames) tot+=Math.max(1,f.d||100); tot=Math.max(1,tot);
          const t=((performance.now()*((s.spd||100)/100))%tot); let acc=0, idx=0; for(let i=0;i<s.frames.length;i++){ idx=i; acc+=Math.max(1,s.frames[i].d||100); if(t<acc) break; } return idx; }
        function keyRanges(){ if(_rngFor===s.frames && _rng) return _rng; const N=INDICES.length, lo=new Array(N*3).fill(255), hi=new Array(N*3).fill(0);
          for(const f of s.frames){ const fr=f.rgb; if(!fr) continue; const m=Math.min(N*3,fr.length); for(let i=0;i<m;i++){ const v=fr[i]|0; if(v<lo[i])lo[i]=v; if(v>hi[i])hi[i]=v; } }
          const r=new Array(N); for(let k=0;k<N;k++){ const o=k*3; r[k]=Math.max(hi[o]-lo[o],hi[o+1]-lo[o+1],hi[o+2]-lo[o+2]); } _rngFor=s.frames; _rng=r; return r; }
        function drawMediaPrev(idx){ paintKeysOn(c('.s-mediaPrev'), idx); }
        function paintKeysOn(cvp, idx){
          if(!cvp) return; const ctx=cvp.getContext('2d');
          ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,cvp.width,cvp.height);
          if(!s.frames.length || !s.frames[idx]) return;
          const rgb=s.frames[idx].rgb, sa=av('sat')/100, co=av('con')/100, gm=av('gam')/100, br=av('bri')/100;
          const hide=!!s.hideStatic, thr=(s.motionThr==null?16:s.motionThr), rng=hide?keyRanges():null;
          const pad=4, W=cvp.width-2*pad, H=cvp.height-2*pad;
          for(let k=0;k<INDICES.length;k++){ const q=E.keyCell(INDICES[k]); if(!q) continue; if(hide && rng[k]<=thr) continue;   // static -> transparent (leave background)
            const o=k*3, cc=E.adjustRgb(rgb[o],rgb[o+1],rgb[o+2],sa,co,gm,br);
            ctx.fillStyle='rgb('+cc[0]+','+cc[1]+','+cc[2]+')';
            ctx.fillRect(pad+(q[0]-q[2]/2)*W+0.75, pad+(q[1]-q[3]/2)*H+0.75, Math.max(1,q[2]*W-1.5), Math.max(1,q[3]*H-1.5)); }
        }
        ensureSource();
        // ===== Floating side-peek (mirrors the audio Live pill): when the previews scroll above the view, a pill docks
        // to the card's side; Show inserts a DUPLICATE Media+Keyboard preview right above the Sampling section so you can
        // watch the framing/result while tuning. Scrolling back to the inline previews auto-removes it. =====
        const peek=document.createElement('div'); peek.className='s-mPeek';
        peek.style.cssText='position:fixed;z-index:60;display:inline-flex;opacity:0;pointer-events:none;transition:opacity .25s ease;left:-9999px;top:0;align-items:center;gap:10px;background:var(--inset);border:1px solid var(--border);border-radius:10px;padding:7px 12px;box-shadow:0 8px 26px rgba(0,0,0,.32)';
        peek.innerHTML='<span class="val" style="opacity:.65;font-size:11px;white-space:nowrap">Media preview</span><button type="button" class="s-mPeekBtn" style="margin:0;padding:2px 9px">Show</button>';
        body.appendChild(peek);
        const peekBtn=peek.querySelector('.s-mPeekBtn'); let pillVisible=false;
        const dup=document.createElement('div'); dup.className='s-mPeekDup';
        dup.style.cssText='grid-column:1/-1;margin:5px 0;background:var(--inset);border-radius:8px;padding:5px 6px';
        dup.innerHTML='<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:3px"><span class="val" style="opacity:.65">Preview</span></div>'+
          '<canvas class="s-mDupSrc" width="320" height="120" style="display:block;width:100%;height:auto;background:#0d1117;border-radius:6px;margin-bottom:5px"></canvas>'+
          '<canvas class="s-mDupKeys" width="320" height="92" style="display:block;width:100%;height:auto;background:#0d1117;border-radius:6px"></canvas>';
        const dupSrc=dup.querySelector('.s-mDupSrc'), dupKeys=dup.querySelector('.s-mDupKeys');
        const positionPeek=()=>{ const grid=card.parentElement; if(!grid) return; const gr=grid.getBoundingClientRect(), comp=grid.closest('.card')||grid, compR=comp.getBoundingClientRect(), cr=card.getBoundingClientRect();
          const pw=peek.offsetWidth||160, gap=12; peek.style.top=Math.round(window.innerHeight*0.30)+'px';
          const onLeft=(cr.left+cr.width/2)<(gr.left+gr.width/2), outside=onLeft?(compR.left-gap-pw):(compR.right+gap);
          const fits=outside>=4 && outside<=window.innerWidth-4-pw; let left=fits?outside:(onLeft?(compR.left+gap):(compR.right-gap-pw));
          peek.style.left=Math.round(Math.max(4,Math.min(left,window.innerWidth-4-pw)))+'px'; };
        const showDup=()=>{ const anchor=card.querySelector('.s-sampleHdr'); if(anchor && anchor.parentNode) anchor.insertAdjacentElement('beforebegin', dup); else body.appendChild(dup);
          requestAnimationFrame(()=>{ try{ dup.scrollIntoView({behavior:'smooth', block:'center'}); }catch(_){ } }); peekBtn.textContent='Hide'; };
        const hideDup=()=>{ if(dup.parentNode) dup.parentNode.removeChild(dup); peekBtn.textContent='Show'; };
        const fadePill=on=>{ peek.style.opacity=on?'1':'0'; peek.style.pointerEvents=on?'auto':'none'; pillVisible=on; };
        peekBtn.addEventListener('click',()=>{ if(dup.parentNode) hideDup(); else showDup(); });
        (function tick(){ const cvp=c('.s-mediaPrev'); if(!cvp || !document.body.contains(cvp) || L.type!=='media'){ [peek,dup].forEach(e=>{ if(e.parentNode) e.parentNode.removeChild(e); }); return; }   // card rebuilt -> stop + clean the pill
          const idx=_dragging?_dragIdx:currentIdx();
          if(cvp.offsetParent!==null && !document.hidden){ if(!_dragging) drawSrc(idx); drawMediaPrev(idx); }   // freeze on the dragged frame while panning
          const shown=cvp.offsetParent!==null;
          if(shown){ const r=cvp.getBoundingClientRect(), cr=card.getBoundingClientRect();
            const cardInView=cr.bottom>window.innerHeight*0.30+(peek.offsetHeight||36) && cr.top<window.innerHeight-40;
            const off=cardInView && r.bottom<4;                                   // the inline keyboard preview scrolled above the view
            const dupOffTop=!!dup.parentNode && dup.getBoundingClientRect().bottom<4;
            if(off && !dupOffTop){ positionPeek(); if(!pillVisible) fadePill(true); } else if(pillVisible){ fadePill(false); }
            if(!off && dup.parentNode) hideDup();                                 // scrolled back to the inline previews → drop the duplicate
            if(dup.parentNode && dup.offsetParent!==null){ drawSrcOn(dupSrc, idx); paintKeysOn(dupKeys, idx); }
          } else if(pillVisible){ fadePill(false); }
          setTimeout(tick, 1000/30); })();
        // framing controls
        { const zo=c('.s-mzoom'), zv=c('.s-mzoomV'); const upd=()=>{ if(zv) zv.textContent=(s.zoom||100)+'%'; }; if(zo) zo.addEventListener('input',e=>{ snap(e.target,100,10); s.zoom=+e.target.value||100; upd(); resampleAll(); scheduleSaveLayers(); }); upd(); }   // detent at 100%
        { const ro=c('.s-mrot'), rv=c('.s-mrotV'); const upd=()=>{ if(rv) rv.textContent=(s.rot||0)+'°'; }; if(ro) ro.addEventListener('input',e=>{ snapMul(e.target,90,8); s.rot=+e.target.value||0; upd(); resampleAll(); scheduleSaveLayers(); }); upd(); }   // detents at 0/90/180/270
        { const fb=c('.s-mframeReset'); if(fb) fb.addEventListener('click',()=>{ if(!confirm('Reset framing (zoom / pan / rotate) to default?')) return; s.zoom=100; s.panX=0; s.panY=0; s.rot=0; const z=c('.s-mzoom'); if(z)z.value=100; const r=c('.s-mrot'); if(r)r.value=0; const zv=c('.s-mzoomV'); if(zv)zv.textContent='100%'; const rv=c('.s-mrotV'); if(rv)rv.textContent='0°'; resampleAll(); drawSrc(currentIdx()); scheduleSaveLayers(); }); }
        // sampling: Map (physical/grid) + Sample strategy + Out-of-frame fill — re-sample on change (no decode needed)
        { const mp=c('.s-mmap'); if(mp) mp.addEventListener('change',e=>{ s.map=e.target.value; resampleAll(); drawSrc(currentIdx()); scheduleSaveLayers(); }); }
        { const sm=c('.s-msample'); if(sm) sm.addEventListener('change',e=>{ s.sampleMode=e.target.value; resampleAll(); drawSrc(currentIdx()); scheduleSaveLayers(); }); }
        { const bs=c('.s-mbars'); if(bs) bs.addEventListener('change',e=>{ s.bars=e.target.value; resampleAll(); buildLayerBody(card,L); scheduleSaveLayers(); }); }   // rebuild → show/hide the custom color picker
        { const bc=c('.s-mbarcol'); if(bc) bc.addEventListener('input',e=>{ s.barColor=e.target.value; resampleAll(); drawSrc(currentIdx()); scheduleSaveLayers(); }); }
        { const cv=c('.s-mediaSrc'); if(cv){
          cv.addEventListener('pointerdown',e=>{ if(!L._srcFrames||!L._srcFrames.length)return; _dragging=true; _dragIdx=currentIdx(); _dragLast={x:e.clientX,y:e.clientY}; cv.setPointerCapture(e.pointerId); });
          cv.addEventListener('pointermove',e=>{ if(!_dragging||!cv._map)return; s.panX=(s.panX||0)+(e.clientX-_dragLast.x)/cv._map.sc; s.panY=(s.panY||0)+(e.clientY-_dragLast.y)/cv._map.sc; _dragLast={x:e.clientX,y:e.clientY}; drawSrc(_dragIdx); resampleOne(_dragIdx); drawMediaPrev(_dragIdx); });   // freeze + resample the one dragged frame for an immediate, coherent update
          cv.addEventListener('pointerup',()=>{ if(_dragging){ _dragging=false; resampleAll(); scheduleSaveLayers(); } });
        } }
        { const sp=c('.s-mspd'), spv=c('.s-mspdV'); const upd=()=>{ if(spv) spv.textContent=(s.spd/100).toFixed(1)+'×'; }; if(sp) sp.addEventListener('input',e=>{ s.spd=+e.target.value||100; upd(); setInfo(infoTxt()); scheduleSaveLayers(); }); upd(); }   // refresh the speed-adjusted duration in the stats
        { const vb=c('.s-mvivid'); if(vb) vb.addEventListener('click',()=>{ s.sat=170; s.con=100; s.gam=180; s.bri=100; L.lastTick=0; buildLayerBody(card,L); scheduleSaveLayers(); }); }
        { const rb=c('.s-mraw'); if(rb) rb.addEventListener('click',()=>{ s.sat=100; s.con=100; s.gam=100; s.bri=100; L.lastTick=0; buildLayerBody(card,L); scheduleSaveLayers(); }); }
        { const hb=c('.s-mhide'); if(hb) hb.addEventListener('change',e=>{ s.hideStatic=e.target.checked; L.lastTick=0; buildLayerBody(card,L); scheduleSaveLayers(); }); }   // rebuild -> Threshold row shows/hides
        { const tb=c('.s-mthr'), tv=c('.s-mthrV'); if(tb){ const upd=()=>{ if(tv) tv.textContent=tb.value; }; tb.addEventListener('input',e=>{ snap(e.target,16,3); s.motionThr=+e.target.value; upd(); L.lastTick=0; scheduleSaveLayers(); }); upd(); } }   // detent at the default (16)
        c('.s-mediaFile').addEventListener('change',e=>{ const f=e.target.files[0]; if(f) loadBlob(f, f.name); });
        { const u=c('.s-murl'), b=c('.s-murlload'); if(b&&u){ b.addEventListener('click',()=>loadUrl(u.value.trim())); u.addEventListener('keydown',e=>{ if(e.key==='Enter') loadUrl(u.value.trim()); }); } }
        { const pb=c('.s-mpaste'); if(pb) pb.addEventListener('click',async()=>{ try{ const items=await navigator.clipboard.read(); for(const it of items){ const ty=it.types.find(t=>t.startsWith('image/')); if(ty) return loadBlob(await it.getType(ty),'pasted-image'); } setInfo('no image on the clipboard'); }catch(e){ setInfo('clipboard read failed: '+e.message); } }); }
        { const b=c('.s-mseqbtn'), inp=c('.s-mseq'); if(b&&inp){ b.addEventListener('click',()=>inp.click()); inp.addEventListener('change',e=>{ if(e.target.files.length) loadSeq(e.target.files, e.target.files.length+'-image sequence'); }); } }
        { const b=c('.s-mfolderbtn'), inp=c('.s-mfolder'); if(b&&inp){ b.addEventListener('click',()=>inp.click()); inp.addEventListener('change',e=>{ if(e.target.files.length) loadSeq(e.target.files, 'folder sequence'); }); } }
        { const lb=c('.s-mlibbtn'); if(lb) lb.addEventListener('click',()=>{ const el=c('.s-mlib'); if(el){ el.style.display=el.style.display==='none'?'block':'none'; refreshLib(); } }); }
        { const sv=c('.s-msave'); if(sv) sv.addEventListener('click',async()=>{ if(!_currentSrc){ setInfo('nothing loaded to save'); return; } if(!(Media&&Media.available)){ setInfo('library unavailable — serve via http://localhost:8123'); return; }
            try{ if(_currentSrc.kind==='seq') await Media.addSequence(_currentSrc.blobs,_currentSrc.name); else await Media.add(_currentSrc.blob,_currentSrc.name); refreshLib(); setInfo('★ added “'+_currentSrc.name+'” to library'); }catch(e){ setInfo('add to library failed: '+e.message); } }); }
        { const cl=c('.s-mediaClear'); if(cl) cl.addEventListener('click',()=>{
            if(s.mediaId && Media&&Media.delSource){ try{ Media.delSource(s.mediaId); }catch(_){ } }
            s.frames=[]; s.mediaName=''; s.mediaId=''; s.srcW=0; s.srcH=0; s.mediaBytes=0; L._srcFrames=null; L._mediaFrames=null; L.lastTick=0; _srcTmp=null; _currentSrc=null;
            drawSrc(0); const fi=c('.s-mediaFile'); if(fi) fi.value=''; setInfo('no clip loaded'); scheduleSaveLayers(); }); }   // Release = offload the clip + its stored source
      } else if(L.type==='audio'){
        const style=s.style||'bars', uid=card.dataset.n;
        // All four sources are live: system + app run through the background daemon (loopback / process-loopback);
        // tab + mic are captured in-tab via Web Audio. App needs the daemon (it spawns app-capture.exe).
        const sources=[['system','All System Audio',true],['app','Specific App',true],['tab','Specific Tab',true],['mic','Mic / Line-in',true]];   // 'tab' = getDisplayMedia: you pick which tab/window to share (NOT this page — this site emits no sound), so "Specific Tab"
        const srcBubbles=sources.map(o=>{ const dis=!o[2]; return '<label class="sl" style="margin:0'+(dis?';opacity:.4':'')+'"><input type="radio" name="aud-src-'+uid+'" class="s-source" value="'+o[0]+'"'+((o[0]===(s.source||'system'))?' checked':'')+(dis?' disabled':'')+'> '+o[1]+'</label>'; }).join('');
        const styles=[['bars','Spectrum Bars'],['pulse','Beat Pulse'],['bloom','Radial Bloom'],['wave','Waveform'],['aurora','Aurora']];
        const sopt=styles.map(m=>'<option value="'+m[0]+'"'+(m[0]===style?' selected':'')+'>'+m[1]+'</option>').join('');
        const esc=t=>(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
        // Center the PRIMARY control optically, float the secondary (Reset / Show / Refresh …) absolutely to its
        // right so it doesn't shift the primary off-center. left:100% anchors it just past the primary's edge.
        const centerAside=(primary,aside)=>'<span style="position:relative;display:inline-flex;align-items:center;max-width:100%">'+primary+'<span style="position:absolute;left:100%;top:50%;transform:translateY(-50%);margin-left:8px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap">'+aside+'</span></span>';
        let html='<div class="ctl">'+
          sec('Source')+
          full('<span style="display:grid;grid-template-columns:auto auto;gap:7px 24px;justify-content:center;flex:1 1 100%">'+srcBubbles+'</span>')+
          full('<span class="val s-srcNow" style="opacity:.8;flex:1 1 100%;text-align:center;font-size:12px;min-height:1em"></span>')+   // "▶ what's playing" (tab/mic = shared-tab title; + a hint when this tab isn't driving the keyboard)
          full('<span class="val" style="opacity:.55;flex:1 1 100%;text-align:center;font-size:12px;line-height:1.4">Specific Tab &amp; Mic / Line-in are captured in this page (reliable mic pick) — they show on the keyboard while this site is open AND driving it. System Audio &amp; Specific App run in the daemon (work with this page closed); Mic also has a daemon fallback for when the tab is closed (pick its device below).</span>')+   // centered note: capture-location gotcha + mic page/daemon split
          (s.source==='app' ? sub('Specific App')+full(centerAside('<select class="s-appId" style="max-width:180px"></select>', '<button type="button" class="s-appRefresh" title="Rescan currently-playing apps" style="flex:none">Refresh</button><span class="val s-appNote" style="opacity:.7"></span>')) : '')+
          (s.source==='mic' ? sub('Mic Input')+
            row('Device',centerAside('<select class="s-micDev" style="max-width:200px;padding-right:24px"><option value="">— Default Recording Device —</option></select>', '<button type="button" class="s-micDevRefresh" title="Rescan recording devices" style="flex:none">⟳</button>'))+
            full('<span class="val" style="opacity:.55;flex:1 1 100%;text-align:center;font-size:11px;line-height:1.4">Which mic the DAEMON captures when this tab is CLOSED (the default endpoint is often silent). While the tab drives, your browser-picked mic is used instead.</span>')+
            row('Mic Gain','<span class="srange" style="width:100%"><input type="range" class="s-micGain" min="0" max="1000" step="1" value="'+Math.round(1000*Math.log((s.micGain==null?100:s.micGain)/50)/Math.log(144))+'" title="SENSITIVITY — how little input drives the bars to full (LOG scale: each step is a meaningful multiplier, 50% … 7200%). Higher = less voice/volume needed to fill the board."></span><span class="val s-micGainV"></span>')+
            row('Noise Gate','<span class="srange" style="width:100%"><input type="range" class="s-micGate" min="0" max="20" step="0.25" value="'+(s.micGate==null?0:s.micGate)+'" title="Mute the keys until the mic exceeds this absolute level — raise it just above your room/fan noise so background hum stops lighting the board. Scaled 0–20% to match a real mic’s RMS range. 0 = off"><i class="tick" style="left:calc(7px + (100% - 14px)*0.0)"></i></span><span class="val s-micGateV"></span>')+
            row('Input Level','<span style="position:relative;display:block;width:100%;height:11px;background:#0d1117;border-radius:6px;overflow:hidden;border:1px solid var(--border)"><span class="s-micMeterFill" style="position:absolute;left:0;top:0;bottom:0;width:0%;background:linear-gradient(90deg,#2ea043,#d29922 80%,#f85149);border-radius:6px"></span><span class="s-micMeterGate" style="position:absolute;top:-1px;bottom:-1px;width:2px;background:#e0a200;left:0%"></span></span><span class="val" style="opacity:.6">live mic level (yellow line = gate)</span>') : '')+
          sec('Style')+ '<div class="lfull" style="justify-content:center">'+centerAside('<select class="s-style">'+sopt+'</select>', '<button type="button" class="s-styleReset" title="Reset THIS style\'s appearance + tuning to default (other styles untouched)">Reset</button>')+'</div>'+   // primary (select) optically centered; Reset floats to its right
          sec('Preview')+ full('<div style="display:flex;flex-direction:column;gap:9px;flex:1 1 100%">'+
            '<div><div style="display:flex;justify-content:center;align-items:center;min-height:30px;margin-bottom:3px">'+centerAside('<span class="val" style="opacity:.65">Sample — test signal</span>', '<button type="button" class="s-samplePrevToggle" style="padding:2px 11px;font-size:12px;margin:0">'+(s.samplePrevOff?'Show':'Hide')+'</button>')+'</div>'+
              '<canvas class="s-audioPrev" width="378" height="92" style="width:100%;height:auto;display:'+(s.samplePrevOff?'none':'block')+';background:#0d1117;border-radius:8px"></canvas></div>'+
            '<div class="s-liveWrap" style="background:var(--inset);border-radius:8px;padding:4px 0">'+   // scrolls with the controls; once it leaves the viewport the floating side-peek (built below) takes over
              '<div style="display:flex;justify-content:center;align-items:center;min-height:30px;margin-bottom:3px">'+centerAside('<span class="val" style="opacity:.65">Live — real audio</span>', '<button type="button" class="s-livePrevToggle" style="padding:2px 11px;font-size:12px;margin:0">'+(s.livePrevOff?'Show':'Hide')+'</button>')+'</div>'+
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
        if(style==='bars'){
          if(s.barDrive==='spectrum' || !s.barDrive){ s.barDrive='volume'; s.barSpread=true; }   // Spectrum drive retired → migrate to Volume + per-column Spread (identical analyzer look; the synth/live previews supply level+bandsRaw)
          const bt=s.barTip||'off', bf=s.barFill||'solid', bc=s.barColor||'bassTreble', blo=s.barLayout||'standard', bdr=s.barDrive, bsp=!!s.barSpread;
          const btOpt=[['off','Off'],['color','Solid color'],['rainbow','Rainbow'],['vu','VU (green→red by level)'],['silhouette','Silhouette (carve below)']].map(o=>'<option value="'+o[0]+'"'+(o[0]===bt?' selected':'')+'>'+o[1]+'</option>').join('');
          const bfOpt=[['solid','Solid'],['subtract','Subtract (silhouette)']].map(o=>'<option value="'+o[0]+'"'+(o[0]===bf?' selected':'')+'>'+o[1]+'</option>').join('');
          const bcOpt=[['bassTreble','Bass → Treble'],['gradient','Gradient (bottom→top)'],['vu','VU (green→red by level)']].map(o=>'<option value="'+o[0]+'"'+(o[0]===bc?' selected':'')+'>'+o[1]+'</option>').join('');
          const bloOpt=[['standard','Standard (bass L → treble R)'],['reverse','Reverse (treble L → bass R)'],['mirror','Mirror (bass centered, treble at edges)'],['stereo','Stereo (left half = L channel, right = R)'],['topdown','Top-down (bars hang from the top)'],['centerout','Center-out (bars grow from the middle row)']].map(o=>'<option value="'+o[0]+'"'+(o[0]===blo?' selected':'')+'>'+o[1]+'</option>').join('');
          const bdrOpt=[['volume','Volume (overall loudness)'],['beat','Beat (pumps on kicks)']].map(o=>'<option value="'+o[0]+'"'+(o[0]===bdr?' selected':'')+'>'+o[1]+'</option>').join('');
          html+=
          row('Drive','<select class="s-barDrive" title="What the bar HEIGHT follows. Volume = every bar tracks the song’s overall loudness. Beat = bars pump on each kick. Turn on Spread below to shape the columns by the per-column spectrum (the classic analyzer). (Color still varies across columns regardless.)">'+bdrOpt+'</select><span></span>')+
          row('Spread','<label class="sl" style="margin:0"><input type="checkbox" class="s-barSpread"'+(bsp?' checked':'')+'> Shape columns by spectrum / stereo (per Layout) instead of a flat wall</label><span></span>')+
          row('Layout','<select class="s-barLayout" title="How the spectrum maps to the keys. Standard = bass left → treble right, bars grow up. Reverse = treble left → bass right. Mirror = bass centered, treble at both edges. Stereo = left half is the LEFT audio channel, right half the RIGHT (bass meets in the middle) — needs a stereo source. Top-down = bars hang from the top. Center-out = bars grow from the middle row outward.">'+bloOpt+'</select><span></span>')+
          row('Bar Fill','<select class="s-barFill" title="Solid = filled bars. Subtract = empty bars that carve the layers below into a spectrum silhouette (the tips still draw).">'+bfOpt+'</select><span></span>')+
          (bf==='subtract' ? '' :
            row('Bar Color','<select class="s-barColor" title="Bass→Treble = horizontal hue across columns; Gradient = your 2 colors bottom→top; VU = green→yellow→orange→red by bar height">'+bcOpt+'</select><span></span>')+
            (bc==='bassTreble' ? row('Bass Color','<input type="color" class="s-barColorBass" value="'+s.barColorBass+'"><span></span>')+row('Treble Color','<input type="color" class="s-barColorTreble" value="'+s.barColorTreble+'"><span></span>')
             : bc==='gradient' ? row('Top Color','<input type="color" class="s-barGradB" value="'+s.barGradB+'"><span></span>')+row('Bottom Color','<input type="color" class="s-barGradA" value="'+s.barGradA+'"><span></span>')+row('Reverse','<label class="sl" style="margin:0"><input type="checkbox" class="s-barGradRev"'+(s.barGradRev?' checked':'')+'> Swap gradient colors</label><span></span>')
             : ''))+
          row('Bar Tips','<select class="s-barTip" title="Outline the top key of each bar so the silhouette stands out">'+btOpt+'</select><span></span>')+
          (bt==='color' ? row('Tip Color','<input type="color" class="s-barTipColor" value="'+s.barTipColor+'"><span></span>') : '')+
          row('Dynamics','<label class="sl" style="margin:0"><input type="checkbox" class="s-barDynamics"'+(s.barDynamics?' checked':'')+'> Steady bars recede (dim); a beat or spectral shift pops a bright rebound — depth instead of a flat constant-volume wall</label><span></span>')+
          row('Transparency','<label class="sl" style="margin:0"><input type="checkbox" class="s-barDynamicsAlpha"'+(s.barDynamicsAlpha?' checked':'')+'> Recede as SEE-THROUGH — steady bars fade transparent so the layers below show through (real front/back depth), pop solid on a hit. Stacks with Dynamics</label><span></span>')+
          ((s.barDynamics||s.barDynamicsAlpha) ? row('Dynamics Depth','<span class="srange" style="width:100%"><input type="range" class="s-barDynamicsDepth" min="0" max="100" value="'+(s.barDynamicsDepth==null?60:s.barDynamicsDepth)+'" title="How far a STEADY bar recedes (dims and/or fades see-through) before a change/beat pops it back to full. Higher = more breathing/depth; 0 = no recede"><i class="tick" style="left:calc(7px + (100% - 14px)*0.6)"></i></span><span class="val s-barDynamicsDepthV"></span>') : ''); }
        else if(style==='pulse') html+=row('Color','<input type="color" class="s-pulseColor" value="'+s.pulseColor+'"><span></span>')+   // no Drive dropdown — Beat Pulse is always Beat (kicks)-driven
          row('Gradient','<label class="sl" style="margin:0"><input type="checkbox" class="s-pulseGrad"'+(s.pulseGrad?' checked':'')+'> Two-color (bottom→top)</label><span></span>')+
          (s.pulseGrad ? row('2nd Color','<input type="color" class="s-pulseColor2" value="'+s.pulseColor2+'"><span></span>')+row('Reverse','<label class="sl" style="margin:0"><input type="checkbox" class="s-pulseGradRev"'+(s.pulseGradRev?' checked':'')+'> Swap gradient colors</label><span></span>') : '')+
          row('Min Brightness','<span class="srange" style="width:100%"><input type="range" class="s-pulseMin" min="0" max="100" value="'+(s.pulseMin==null?0:s.pulseMin)+'" title="Resting glow held even at silence (0 = goes fully dark on silence)"><i class="tick" style="left:calc(7px + (100% - 14px)*0.0)"></i></span><span class="val s-pulseMinV"></span>')+
          row('Max Brightness','<span class="srange" style="width:100%"><input type="range" class="s-pulseMax" min="0" max="100" value="'+(s.pulseMax==null?100:s.pulseMax)+'" title="Brightness a FULL beat reaches (the ceiling of the pump)"><i class="tick" style="left:calc(7px + (100% - 14px)*1.0)"></i></span><span class="val s-pulseMaxV"></span>')+
          dynRows('pulse');
        else if(style==='bloom') html+=row('Color','<input type="color" class="s-bloomColor" value="'+s.bloomColor+'"><span></span>')+   // Beat-driven only (Volume drive retired) — no Drive selector
          row('Gradient','<label class="sl" style="margin:0"><input type="checkbox" class="s-bloomGrad"'+(s.bloomGrad?' checked':'')+'> Two-color (center→edge)</label><span></span>')+
          (s.bloomGrad ? row('Edge Color','<input type="color" class="s-bloomColor2" value="'+s.bloomColor2+'"><span></span>')+row('Reverse','<label class="sl" style="margin:0"><input type="checkbox" class="s-bloomGradRev"'+(s.bloomGradRev?' checked':'')+'> Swap gradient colors</label><span></span>') : '')+
          dynRows('bloom');
        else if(style==='wave')  html+=row('Color','<input type="color" class="s-waveColor" value="'+s.waveColor+'"><span></span>')+   // no Drive dropdown — Waveform is always Volume-driven (Beat looked inferior)
          row('Gradient','<label class="sl" style="margin:0"><input type="checkbox" class="s-waveGrad"'+(s.waveGrad?' checked':'')+'> Two-color (start→end)</label><span></span>')+
          (s.waveGrad ? row('2nd Color','<input type="color" class="s-waveColor2" value="'+s.waveColor2+'"><span></span>')+row('Reverse','<label class="sl" style="margin:0"><input type="checkbox" class="s-waveGradRev"'+(s.waveGradRev?' checked':'')+'> Swap gradient colors</label><span></span>') : '')+
          row('Amplitude','<span class="srange" style="width:100%"><input type="range" class="s-waveAmp" min="10" max="200" value="'+(s.waveAmp==null?100:s.waveAmp)+'" title="Vertical gain of the trace — 100% = a full-scale sample reaches the top/bottom row; higher exaggerates quiet audio"><i class="tick" style="left:calc(7px + (100% - 14px)*0.474)"></i></span><span class="val s-waveAmpV"></span>')+
          row('Thickness','<span class="srange" style="width:100%"><input type="range" class="s-waveThick" min="0" max="100" value="'+(s.waveThick==null?50:s.waveThick)+'" title="How many keys thick the trace line is drawn"><i class="tick" style="left:calc(7px + (100% - 14px)*0.5)"></i></span><span class="val s-waveThickV"></span>')+
          row('Max Density','<span class="srange" style="width:100%"><input type="range" class="s-waveDensity" min="0" max="100" value="'+(s.waveDensity==null?50:s.waveDensity)+'" title="Ceiling on how fine the wave is allowed to get. The wave still freely responds to the audio below this; bright/complex parts only reach this fineness and never exceed it — past the cap the excess turns into faster scroll instead of cramming smaller waves. Lower it if the busy parts get too fine to read."><i class="tick" style="left:calc(7px + (100% - 14px)*0.5)"></i></span><span class="val s-waveDensityV"></span>')+
          row('Adaptive Intensity','<span class="srange" style="width:100%"><input type="range" class="s-waveAdaptive" min="0" max="100" value="'+(s.waveAdaptive==null?0:s.waveAdaptive)+'" title="On intense (loud) parts of a song, ramps the line thickness 50%→100% and brightness 100%→200% for that stretch. 0 = off"><i class="tick" style="left:7px"></i></span><span class="val s-waveAdaptiveV"></span>')+
          row('Direction','<label class="sl" style="margin:0"><input type="checkbox" class="s-waveReverse"'+(s.waveReverse?' checked':'')+'> Reverse flow</label><span></span>');
        else if(style==='aurora') html+=driveRow('aurora','volume')+row('Width','<span class="srange" style="width:100%"><input type="range" class="s-auroraWidth" min="0" max="100" value="'+(s.auroraWidth==null?50:s.auroraWidth)+'" title="Thickness of the aurora curtains — higher = fatter, softer bands; lower = thin ribbons"><i class="tick" style="left:calc(7px + (100% - 14px)*0.5)"></i></span><span class="val s-auroraWidthV"></span>')+
          row('Translucency','<label class="sl" style="margin:0"><input type="checkbox" class="s-auroraAlpha"'+(s.auroraAlpha?' checked':'')+'> See-through — dim parts of the curtain let the layers below show through (bright bands stay opaque), so the aurora reads over other layers</label><span></span>');
        // Dim-while-active: pick OTHER layers to quiet while this audio layer is emitting, each with its
        // own max-brightness slider — so the music keys read against a darker base. Stored in s.ducks.
        if(!Array.isArray(s.ducks)) s.ducks=[];
        const myIdx=+card.dataset.n;   // esc() defined above (source block)
        const duckOf=i=>s.ducks.find(d=>d&&d.layer===i);
        const duckRows=state.layers.map((L2,i)=>({L2,i})).filter(o=>o.i!==myIdx).map(o=>{
          const d=duckOf(o.i), on=!!d, dim=on?d.dim:30;
          // a FLEX row (not the 3-col subgrid) so the slider gets the full width left of the value, not a cramped 84px cell
          return '<p class="lrow duckrow">'+
            '<label class="sl duckname" style="margin:0"><input type="checkbox" class="s-duckOn" data-i="'+o.i+'"'+(on?' checked':'')+'> Layer '+(o.i+1)+' · '+esc(o.L2.name)+'</label>'+
            '<input type="range" class="s-duckDim duckrange" data-i="'+o.i+'" min="0" max="100" value="'+dim+'"'+(on?'':' disabled')+' title="Max brightness this layer is allowed while the music is showing">'+
            '<span class="val s-duckDimV" data-i="'+o.i+'" style="white-space:nowrap">'+dim+'%</span>'+
          '</p>';
        }).join('');
        const ap=E.audioParams(s);   // tuner sliders are PER-STYLE (gain/floor/attack/decay/beatSens live in s.ap[style])
        // Copy-from: pull another style's PER-STYLE values into this one. Only Tuning (the ap block) and the
        // Dynamics/Transparency trio mean the same thing across styles — appearance colors/layout are inherently
        // style-specific (a bar layout means nothing to a pulse), and Dim-while-active is one shared layer-level
        // setting — so those aren't offered (nothing to copy). Source list = styles you've actually tuned.
        const STYLE_LABELS={bars:'Spectrum Bars',pulse:'Beat Pulse',bloom:'Radial Bloom',wave:'Waveform',aurora:'Aurora'};
        const tunedStyles=Object.keys(s.ap||{}).filter(st=>st!==style && STYLE_LABELS[st]);
        const copyCtl = tunedStyles.length ? full('<span style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;flex:1 1 100%;justify-content:center;border:1.5px solid rgba(145,150,160,.42);border-radius:9px;padding:7px 12px"><span class="val" style="opacity:.7">Copy From</span><select class="s-copyFrom">'+tunedStyles.map(st=>'<option value="'+st+'">'+STYLE_LABELS[st]+'</option>').join('')+'</select><label class="sl" style="margin:0"><input type="checkbox" class="s-copyTuning" checked> Tuning</label><label class="sl" style="margin:0"><input type="checkbox" class="s-copyDyn" checked> Dynamics</label><button type="button" class="s-copyApply" style="flex:none">Apply</button>'+(s._copyUndo?'<button type="button" class="s-copyUndo" style="flex:none" title="Revert the last Apply">Undo</button>':'')+'</span>') : '';
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
          (function(){ const twinkleOK = !(style==='bars' && !s.barSpread);   // Twinkle needs per-column structure to sparkle away; a flat wall (Spread off) can only Settle
            if(!twinkleOK && s.pauseStyle==='twinkle') s.pauseStyle='linear';
            const pOpt=[['linear','Settle (glide down)']].concat(twinkleOK?[['twinkle','Twinkle out (freeze + sparkle away)']]:[]);
            return row('Pause As','<select class="s-pauseStyle" title="What the keys do when the music STOPS. Settle = bars glide down to 0 over Pause decay. Twinkle out = the last frame FREEZES, then each lit key sparkles away individually over Pause decay.'+(twinkleOK?'':' (Twinkle out needs Spread on — a flat wall can only Settle.)')+'">'+pOpt.map(o=>'<option value="'+o[0]+'"'+(o[0]===(s.pauseStyle||'linear')?' selected':'')+'>'+o[1]+'</option>').join('')+'</select><span></span>'); })()+
          row('Beat Sensitivity','<span class="srange" style="width:100%"><input type="range" class="s-beatSens" min="0" max="100" value="'+ap.beatSens+'" title="How strongly kicks/onsets pop in pulse and bloom (this style only)"><i class="tick" style="left:calc(7px + (100% - 14px)*0.5)"></i></span><span class="val s-beatSensV"></span>')+
          copyCtl+   // Copy-from moved here (below Beat Sensitivity) — under the 'Tuning' header it read as a confusing duplicate of the Tuning checkbox
          (duckRows ? sub('Dim While Active')+full('<span class="val" style="opacity:.7;flex:1 1 100%;text-align:center">Quiet these layers while the music shows</span>')+duckRows : '')+
        '</div>';
        body.innerHTML=html;
        const c=q=>body.querySelector(q);
        body.querySelectorAll('.s-source').forEach(r=>r.addEventListener('change',e=>{ const v=e.target.value; switchSource(s, L, s.source, v);   // each source is its own profile (style + whole look) — swap the entire look in/out
          if((v==='tab'||v==='mic') && opts.isDriving && !opts.isDriving() && opts.connectKeyboard) opts.connectKeyboard();   // auto-handover: Tab + Mic are page-captured (getUserMedia) → grab the keyboard so they reach the keys while this tab drives; the daemon mic sidecar covers the closed-tab case
          onAudioSource(v); buildLayerBody(card,L); scheduleSaveLayers(); }));   // tab/mic start in-tab capture; system/app stop it (daemon-driven); rebuild so the App/Mic panels show/hide
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
        if(s.source==='mic'){ const sel=c('.s-micDev'), rf=c('.s-micDevRefresh');   // daemon recording-device picker (closed-tab capture)
          const fill=(inputs)=>{ if(!sel) return; const cur=s.micDeviceId||''; let has=false;
            const optsHtml=['<option value="">— Default Recording Device —</option>'];
            (inputs||[]).filter(d=>d&&d.id).forEach(d=>{ if(d.id===cur) has=true; optsHtml.push('<option value="'+esc(d.id)+'"'+(d.id===cur?' selected':'')+'>'+esc(d.name||d.id)+'</option>'); });
            if(cur && !has) optsHtml.push('<option value="'+esc(cur)+'" selected>(saved device — not present)</option>');   // keep the saved pick visible
            sel.innerHTML=optsHtml.join(''); };
          const load=()=>Promise.resolve(opts.listAudioInputs && opts.listAudioInputs()).then(a=>fill(a||[])).catch(()=>fill([]));
          if(sel) sel.addEventListener('change',e=>{ s.micDeviceId=e.target.value; });   // 'change' pushes config → daemon (re)starts mic capture on that device
          if(rf) rf.addEventListener('click',load);
          load();
        }
        c('.s-style').addEventListener('change',e=>{ const oldK=E.audioVariantKey(s); s.style=e.target.value; swapVariant(s, oldK, E.audioVariantKey(s)); buildLayerBody(card,L); scheduleSaveLayers(); });   // carry each variant's own Adjust/crop/pause/ducks
        // Per-style Reset: restore just THIS style's appearance keys + its per-style tuning (s.ap[variant]) to default; leaves the other styles, source, crop, ducks and the shared pause alone.
        const STYLE_DEFAULTS={
          bars:{ barTip:'off', barTipColor:'#ffffff', barFill:'solid', barColor:'bassTreble', barColorBass:'#ff2200', barColorTreble:'#22aaff', barGradA:'#00ff66', barGradB:'#ff00aa', barGradRev:false, barLayout:'standard', barDrive:'volume', barSpread:true, barDynamics:false, barDynamicsAlpha:false, barDynamicsDepth:60 },
          pulse:{ pulseColor:'#19b6ff', pulseColor2:'#ff00aa', pulseGrad:false, pulseGradRev:false, pulseMin:0, pulseMax:100, pulseDynamics:false, pulseDynamicsAlpha:false, pulseDynamicsDepth:60 },
          bloom:{ bloomColor:'#ff5a00', bloomColor2:'#ffd000', bloomGrad:false, bloomGradRev:false, bloomDynamics:false, bloomDynamicsAlpha:false, bloomDynamicsDepth:60 },
          wave:{ waveColor:'#00e0ff', waveColor2:'#ff00aa', waveGrad:false, waveGradRev:false, waveReverse:false, waveAmp:100, waveThick:50, waveDensity:50, waveAdaptive:0 },
          aurora:{ auroraWidth:50, auroraDrive:'volume', auroraAlpha:false } };
        { const sr=c('.s-styleReset'); if(sr) sr.addEventListener('click',()=>{ const d=STYLE_DEFAULTS[style]; if(!d) return;
          const sel=c('.s-style'); const styleName=(sel && sel.options[sel.selectedIndex]) ? sel.options[sel.selectedIndex].text : style;
          if(!confirm('Reset the '+styleName+' style to defaults?\nOther styles, source, crop, ducks and pause are untouched.')) return;
          const vkey=E.audioVariantKey(s);
          const snapKeys={}; for(const k in d) snapKeys[k]=s[k];   // prior values of just the keys the reset overwrites
          const snapAp=(s.ap && s.ap[vkey]!==undefined) ? JSON.parse(JSON.stringify(s.ap[vkey])) : undefined;
          Object.assign(s,d); if(s.ap) delete s.ap[vkey]; buildLayerBody(card,L); scheduleSaveLayers();
          showUndoToast('Reset '+styleName+' style', ()=>{ Object.assign(s,snapKeys); if(snapAp!==undefined){ if(!s.ap) s.ap={}; s.ap[vkey]=snapAp; } buildLayerBody(card,L); scheduleSaveLayers(); }); }); }
        ['barColorBass','barColorTreble','barTipColor','barGradA','barGradB','pulseColor','pulseColor2','bloomColor','bloomColor2','waveColor','waveColor2'].forEach(key=>{ const el=c('.s-'+key); if(el) el.addEventListener('input',e=>s[key]=e.target.value); });
        // per-style appearance VALUE sliders that write to s directly (not the per-style tuner `ap`): pulse min/max, aurora width
        [['pulseMin','%'],['pulseMax','%'],['auroraWidth',''],['waveAmp','%'],['waveThick','%'],['waveDensity','%'],['waveAdaptive','%'],['micGate','%']].forEach(pair=>{ const key=pair[0], unit=pair[1], el=c('.s-'+key), v=c('.s-'+key+'V'); if(el&&v){ const up=()=>v.textContent=el.value+unit; el.addEventListener('input',()=>{ s[key]=+el.value; up(); }); up(); } });
        // Mic Gain is a LOG slider: position 0..1000 → 50%..7200% (each step a multiplier, so the useful low end isn't crammed at the bottom). The position maps to the real % stored in s.micGain.
        { const el=c('.s-micGain'), v=c('.s-micGainV'); if(el&&v){ const toG=pos=>Math.round(50*Math.pow(144, pos/1000)/10)*10; const up=()=>v.textContent=(s.micGain==null?100:s.micGain)+'%';
          el.addEventListener('input',()=>{ s.micGain=toG(+el.value); up(); }); up(); } }
        // (Mic toggle-hotkey moved to the Hotkeys → "Host Actions" binder tab; the daemon migrates an old per-layer
        // toggleKeyLed bind into the registry on startup.)
        { const wr=c('.s-waveReverse'); if(wr) wr.addEventListener('change',e=>s.waveReverse=e.target.checked); }
        { const aa=c('.s-auroraAlpha'); if(aa) aa.addEventListener('change',e=>s.auroraAlpha=e.target.checked); }
        { const bt=c('.s-barTip'); if(bt) bt.addEventListener('change',e=>{ s.barTip=e.target.value; buildLayerBody(card,L); }); }   // rebuild so the tip-color picker shows/hides
        { const bf=c('.s-barFill'); if(bf) bf.addEventListener('change',e=>{ s.barFill=e.target.value; buildLayerBody(card,L); }); }   // rebuild so the color controls show/hide with solid/subtract
        { const bl=c('.s-barLayout'); if(bl) bl.addEventListener('change',e=>s.barLayout=e.target.value); }   // no dependent controls — no rebuild needed
        { const bdy=c('.s-barDynamics'); if(bdy) bdy.addEventListener('change',e=>{ s.barDynamics=e.target.checked; buildLayerBody(card,L); }); }   // rebuild so the depth slider shows/hides
        { const bda=c('.s-barDynamicsAlpha'); if(bda) bda.addEventListener('change',e=>{ s.barDynamicsAlpha=e.target.checked; buildLayerBody(card,L); }); }   // rebuild so the depth slider shows/hides
        { const el=c('.s-barDynamicsDepth'), v=c('.s-barDynamicsDepthV'); if(el&&v){ const up=()=>v.textContent=el.value+'%'; el.addEventListener('input',()=>{ s.barDynamicsDepth=+el.value; up(); }); up(); } }
        // wash-style Dynamics/Transparency (pulse/bloom) — same shape as bars, keyed by prefix
        ['pulse','bloom'].forEach(p=>{
          ['Dynamics','DynamicsAlpha'].forEach(suf=>{ const el=c('.s-'+p+suf); if(el) el.addEventListener('change',e=>{ s[p+suf]=e.target.checked; buildLayerBody(card,L); }); });   // rebuild so the depth slider shows/hides
          const el=c('.s-'+p+'DynamicsDepth'), v=c('.s-'+p+'DynamicsDepthV'); if(el&&v){ const up=()=>v.textContent=el.value+'%'; el.addEventListener('input',()=>{ s[p+'DynamicsDepth']=+el.value; up(); }); up(); }
        });
        { const ps=c('.s-pauseStyle'); if(ps) ps.addEventListener('change',e=>s.pauseStyle=e.target.value); }   // layer-level pause behavior: linear settle vs twinkle-out
        // Copy-from Apply: clone the chosen style's Tuning (ap) and/or Dynamics trio into THIS style, then rebuild.
        { const DP={bars:'bar',pulse:'pulse',bloom:'bloom'};
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
        { const bsp=c('.s-barSpread'); if(bsp) bsp.addEventListener('change',e=>{ s.barSpread=e.target.checked; buildLayerBody(card,L); }); }   // rebuild so Pause As re-gates Twinkle on Spread
        { const bc=c('.s-barColor'); if(bc) bc.addEventListener('change',e=>{ s.barColor=e.target.value; buildLayerBody(card,L); }); }   // rebuild so bass/treble vs gradient vs vu color pickers swap
        ['pulseGrad','bloomGrad','waveGrad'].forEach(key=>{ const el=c('.s-'+key); if(el) el.addEventListener('change',e=>{ s[key]=e.target.checked; buildLayerBody(card,L); }); });   // rebuild so the 2nd-color picker shows/hides
        ['pulseGradRev','bloomGradRev','waveGradRev','barGradRev'].forEach(key=>{ const el=c('.s-'+key); if(el) el.addEventListener('change',e=>s[key]=e.target.checked); });   // swap gradient ends — no rebuild (preview reads s live)
        ['pulse','bloom','wave','aurora'].forEach(p=>{ const el=c('.s-'+p+'Drive'); if(el) el.addEventListener('change',e=>s[p+'Drive']=e.target.value); });   // Volume/Beat drive for the non-bars styles
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
        { const cr=c('.s-cropReset'); if(cr) cr.addEventListener('click',()=>{ if(!confirm('Reset the crop box to the default window?')) return; s.cropX=0.1; s.cropY=0.1; s.cropW=0.8; s.cropH=0.8; scheduleSaveLayers(); }); }
        body.querySelectorAll('.s-duckOn').forEach(cb=>cb.addEventListener('change',e=>{
          const i=+e.target.dataset.i, sl=body.querySelector('.s-duckDim[data-i="'+i+'"]');
          if(!Array.isArray(s.ducks)) s.ducks=[];
          if(e.target.checked){ if(!s.ducks.find(d=>d&&d.layer===i)) s.ducks.push({layer:i, dim:sl?+sl.value:30}); if(sl) sl.disabled=false; }
          else { s.ducks=s.ducks.filter(d=>d&&d.layer!==i); if(sl) sl.disabled=true; }
          const nb=sl&&sl.parentElement.querySelector('input[type=number].numin'); if(nb) nb.disabled=!e.target.checked;   // keep the typable box enabled/disabled with the slider
        }));
        body.querySelectorAll('.s-duckDim').forEach(sl=>sl.addEventListener('input',e=>{
          const i=+e.target.dataset.i, v=+e.target.value, lab=body.querySelector('.s-duckDimV[data-i="'+i+'"]');
          if(lab) lab.textContent=v+'%';
          const d=Array.isArray(s.ducks)&&s.ducks.find(x=>x&&x.layer===i); if(d) d.dim=v;   // only persists once the layer is checked on
        }));
        // --- Make every slider's value box TYPABLE (one generic pass) ---------------------------------------
        // Each value display stays as a hidden <span class="s-XV"> that the existing wiring keeps current; we drop
        // a number input beside it that drives the matching range slider by dispatching its 'input' event — so the
        // model write + display update run through the code already there. Covers appearance, tuning, dynamics
        // depth, beat-sensitivity and the duck sliders with no per-slider plumbing. (micGain is a LOG slider, so it
        // can't show the raw position as a %; handled separately just below.)
        const typableVal=(rangeEl, spanEl)=>{ if(!rangeEl||!spanEl||spanEl._typable) return; spanEl._typable=true;
          spanEl.style.display='none';   // the existing up() still writes fmt() here harmlessly; we read the unit from it
          const wrap=document.createElement('span'); wrap.style.cssText='display:flex;gap:4px;align-items:center;justify-content:flex-end;flex:none';
          const num=document.createElement('input'); num.type='number'; num.className='numin'; num.style.textAlign='right';
          num.min=rangeEl.min; num.max=rangeEl.max; if(rangeEl.step) num.step=rangeEl.step; num.value=parseFloat(rangeEl.value); num.disabled=rangeEl.disabled;
          const dec=(rangeEl.step&&(''+rangeEl.step).indexOf('.')>=0)?3:0, chars=(''+rangeEl.max).replace('-','').length+dec;
          num.style.width=Math.max(56, chars*10+28)+'px';   // size to the max value's digits (+decimals) so the spinner never clips the last digit
          const u=document.createElement('span'); u.className='val'; u.style.cssText='opacity:.6;min-width:6px';
          wrap.appendChild(num); wrap.appendChild(u); spanEl.parentNode.insertBefore(wrap, spanEl);
          const setUnit=()=>{ u.textContent=(spanEl.textContent||'').replace(/[-0-9.\s]/g,''); }; setUnit();
          const lo=parseFloat(rangeEl.min), hi=parseFloat(rangeEl.max), clamp=v=>Math.max(lo,Math.min(hi,v));
          rangeEl.addEventListener('input',()=>{ if(document.activeElement!==num) num.value=parseFloat(rangeEl.value); num.disabled=rangeEl.disabled; setUnit(); });
          const drive=()=>{ let v=parseFloat(num.value); if(isNaN(v)) return; rangeEl.value=clamp(v); rangeEl.dispatchEvent(new Event('input',{bubbles:true})); };
          num.addEventListener('input',drive);
          num.addEventListener('change',()=>{ let v=parseFloat(num.value); if(isNaN(v)) v=parseFloat(rangeEl.value); v=clamp(v); num.value=v; rangeEl.value=v; rangeEl.dispatchEvent(new Event('input',{bubbles:true})); }); };
        // Per-slider "reset to default" — one table of default RANGE values keyed by slider class (no 's-' prefix / 'V' suffix).
        // Tuning defaults mirror the engine's AUDIO_TUNE_DEFAULTS (gain stored ×100); mic uses smoother attack/decay/pause.
        const SLIDER_DEF={ gain:100, floor:5, ceil:100, contrast:50, attackMs:40, decayMs:220, pauseDecayMs:700, beatSens:50,
          pulseMin:0, pulseMax:100, auroraWidth:50, waveAmp:100, waveThick:50, waveDensity:50, waveAdaptive:0, micGate:0,
          barDynamicsDepth:60, pulseDynamicsDepth:60, bloomDynamicsDepth:60, duckDim:30 };
        if(s.source==='mic'){ SLIDER_DEF.attackMs=80; SLIDER_DEF.decayMs=300; SLIDER_DEF.pauseDecayMs=1500; }
        const mkReset=(range,def)=>{ const b=document.createElement('button'); b.type='button'; b.className='sreset'; b.title='Reset to default'; b.textContent='↺';
          b.style.cssText='flex:none;padding:1px 5px;line-height:1.4;font-size:13px;background:rgba(13,17,23,.82);border:1px solid rgba(145,150,160,.45);border-radius:6px;cursor:pointer;color:var(--text,#e6edf3)';   // dark chip so the icon contrasts/reads against the tinted box
          b.addEventListener('click',()=>{ if(range.disabled) return; range.value=def; range.dispatchEvent(new Event('input',{bubbles:true})); range.dispatchEvent(new Event('change',{bubbles:true})); }); return b; };
        body.querySelectorAll('span.val').forEach(span=>{ const cls=[...span.classList].find(x=>/^s-.+V$/.test(x)); if(!cls||cls==='s-micGainV') return;
          const rc=cls.slice(0,-1), range = span.dataset.i!=null ? body.querySelector('input[type=range].'+rc+'[data-i="'+span.dataset.i+'"]') : body.querySelector('input[type=range].'+rc);
          if(!range) return; typableVal(range, span);
          const dkey=cls.slice(2,-1), def=SLIDER_DEF[dkey];
          if(def!=null){ const wrap=span.previousElementSibling; if(wrap && wrap.tagName==='SPAN') wrap.appendChild(mkReset(range,def)); }   // wrap = the typable num+unit span typableVal inserted before the value span
        });
        // micGain: log slider (position 0–1000 ↔ 50–7200%). Make the % itself typable with the inverse map.
        { const el=c('.s-micGain'), span=c('.s-micGainV'); if(el&&span){ span.style.display='none';
            const wrap=document.createElement('span'); wrap.style.cssText='display:flex;gap:4px;align-items:center;justify-content:flex-end;flex:none';
            const num=document.createElement('input'); num.type='number'; num.className='numin'; num.style.cssText='width:68px;text-align:right'; num.min=50; num.max=7200; num.step=10; num.value=(s.micGain==null?100:s.micGain);
            const u=document.createElement('span'); u.className='val'; u.style.cssText='opacity:.6'; u.textContent='%';
            wrap.appendChild(num); wrap.appendChild(u); span.parentNode.insertBefore(wrap, span);
            const toPos=g=>Math.round(1000*Math.log(Math.max(50,g)/50)/Math.log(144)), clampG=g=>Math.max(50,Math.min(7200,g));
            wrap.appendChild(mkReset(el, toPos(100)));   // reset Mic Gain to 100% (the log slider's position for 100)
            el.addEventListener('input',()=>{ if(document.activeElement!==num) num.value=(s.micGain==null?100:s.micGain); });
            const drive=()=>{ let g=parseFloat(num.value); if(isNaN(g)) return; s.micGain=clampG(g); el.value=toPos(s.micGain); };
            num.addEventListener('input',drive);
            num.addEventListener('change',()=>{ let g=parseFloat(num.value); if(isNaN(g)) g=(s.micGain==null?100:s.micGain); g=clampG(g); num.value=g; s.micGain=g; el.value=toPos(g); }); } }
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
          const micFill=c('.s-micMeterFill'), micGateEl=c('.s-micMeterGate'), MIC_SCALE=0.20;   // meter tops at 20% — headroom so a loud mic doesn't pin the bar (was 0.6 → signal looked tiny)
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
          attachCropDrag(dupCv);   // the floating/duplicate live render is a real preview too — let the crop box be dragged on it (it was paint-only before)
          // dock the pill just OUTSIDE the compositor, on the SAME side as the audio card's column (audio in the LEFT
          // column → pill on the left; RIGHT column → pill on the right), clamped to stay on-screen.
          const positionPeek=()=>{ const grid=card.parentElement, gr=grid.getBoundingClientRect(), comp=grid.closest('.card')||grid, compR=comp.getBoundingClientRect(), cr=card.getBoundingClientRect();
            const pw=peek.offsetWidth||200, gap=12; peek.style.transform='none'; peek.style.right='auto';
            peek.style.top=Math.round(window.innerHeight*0.30)+'px';
            const onLeft = (cr.left+cr.width/2) < (gr.left+gr.width/2);
            const outside = onLeft ? (compR.left-gap-pw) : (compR.right+gap);   // HUG the compositor's OUTSIDE edge (in the adjacent page margin)
            const fits = outside >= 4 && outside <= window.innerWidth-4-pw;      // room in the margin for it?
            let left = fits ? outside : (onLeft ? (compR.left+gap) : (compR.right-gap-pw));   // no room (compositor spans the viewport) → tuck just inside instead of detaching to the page edge
            left = Math.max(4, Math.min(left, window.innerWidth-4-pw));
            peek.style.left=Math.round(left)+'px'; };
          // insert the duplicate INLINE right after the section header nearest the top of the view (what you're tuning)
          const showDup=(skipScroll)=>{ L._livePeekOpen=true; const aim=window.innerHeight*0.16; let best=null, bd=1e9;
            card.querySelectorAll('.lsec,.lsub').forEach(sc=>{ const t=sc.getBoundingClientRect().top; if(Math.abs(t-aim)<bd){ bd=Math.abs(t-aim); best=sc; } });
            const sbody = best && best.closest('.lsecbox') && best.closest('.lsecbox').querySelector('.lsecbody');
            if(sbody) sbody.insertBefore(dup, sbody.firstChild);   // INSIDE the section's boxed body so the dup respects the box padding/border (was landing between header and body → broke out of the box)
            else if(best && best.parentNode) best.insertAdjacentElement('afterend', dup); else body.appendChild(dup);
            if(!skipScroll) requestAnimationFrame(()=>{ try{ dup.scrollIntoView({behavior:'smooth', block:'center'}); }catch(_){ } });   // lerp-scroll to the new second/lower live preview (skipped on a rebuild-restore so a toggle doesn't yank the scroll)
            peekBtn.textContent='Hide'; };
          const hideDup=()=>{ L._livePeekOpen=false; if(dup.parentNode) dup.parentNode.removeChild(dup); peekBtn.textContent='Show'; };
          const fadePill=(on)=>{ peek.style.opacity=on?'1':'0'; peek.style.pointerEvents=on?'auto':'none'; pillVisible=on; };   // 250ms via the CSS transition
          peekBtn.addEventListener('click',()=>{ if(dup.parentNode) hideDup(); else showDup(); });   // Show inserts the second/lower live preview (and lerp-scrolls to it); Hide removes it
          const nowEl=c('.s-srcNow'); let _lastNow=null;
          function frame(now){
            if(!document.body.contains(cvL||cvS)){ [peek,dup].forEach(e=>{ if(e.parentNode) e.parentNode.removeChild(e); }); return; }   // card rebuilt/removed → stop + clean
            updMicMeter();
            if(nowEl){ let txt='';   // "what's playing" under the sources: only Specific Tab is page-captured → show a hint when this tab isn't driving (mic now runs in the daemon, so no caveat)
              if(s.source==='tab' && liveAudioActive()){
                const driving=opts.isDriving?opts.isDriving():true;   // the shared tab's TITLE isn't obtainable (opaque stream id), so don't show a wrong title
                txt='▶ Shared tab'+(driving?'':'   ·   preview only — click “Drive from this Tab” to show it on the keyboard'); }
              else if(s.source==='mic' && liveAudioActive()){ const driving=opts.isDriving?opts.isDriving():true; txt='▶ Microphone'+(driving?'':'   ·   preview only — click “Drive from this Tab” to show it on the keyboard'); }
              if(txt!==_lastNow){ nowEl.textContent=txt; nowEl.style.color=(txt.indexOf('preview only')>=0)?'var(--warn,#e0a200)':''; _lastNow=txt; } }
            if(ctxS && cvS.offsetParent!==null && synth){ E.applyAudioFeatures(pState, synth.sample(now/1000), s, now); E.renderAudio(sampL, now, pState); paint(ctxS, sampL.rgb); }
            let dupOn=false;
            if(liveWrap){
              const shown=liveWrap.offsetParent!==null && !s.livePrevOff;   // card expanded/enabled AND the live preview isn't toggled off
              const r=shown?liveWrap.getBoundingClientRect():null;
              const cr=shown?card.getBoundingClientRect():null;
              const cardInView=shown && cr.bottom > window.innerHeight*0.30 + (peek.offsetHeight||36) && cr.top<window.innerHeight-40;   // card still reaches the pill's 30% anchor — once its BOTTOM scrolls above the pill, hide it (don't float the pill beside empty space)
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
          if(L._livePeekOpen) showDup(true);   // a card rebuild (any toggle) tore down the old docked duplicate — restore it so the live pill preview doesn't vanish on every toggle (frame loop self-corrects if you're actually scrolled back to the inline preview)
          requestAnimationFrame(frame);
        })();
      } else if(L.type==='agent'){
        // ---- AI/LLM agent-activity lighting layer card ----
        // Colors — each picker gets a ↺ that restores just that glyph's default color
        const AG_COLOR_DEF={ twinkleColor:'#ff8c00', spinColor:'#ffffff', checkColor:'#22cc44', bangColor:'#ff3b30' };
        const colorRow=(label,key)=>row(label,'<span style="display:inline-flex;align-items:center;gap:6px"><input type="color" class="s-'+key+'" value="'+s[key]+'"><button type="button" class="sreset s-agColReset" data-key="'+key+'" title="Reset to the default '+label.toLowerCase()+' color">↺</button></span><span></span>');
        const colorRows=
          colorRow('Twinkle','twinkleColor')+
          colorRow('Spinner','spinColor')+
          colorRow('Checkmark','checkColor')+
          colorRow('Exclamation','bangColor');
        // Session filter — TWO labeled dropdowns side by side (Active | Idle) instead of one wide grouped select.
        // Both carry "All Sessions" as their neutral top option; picking a session in one shows it there and the
        // other rests on "All Sessions". Options filled async after mount.
        const sessionRow=full('<label class="sl" style="margin:0 0 7px;justify-content:center" title="Automatically follow whichever Claude Code session’s VSCode window is in front. The background app detects the foreground window (Windows only) and matches it to a session by project folder. Switch windows and the agent lighting follows; leave all VSCode windows and it reverts to All Sessions after a few seconds. No extra setup."><input type="checkbox" class="s-agFollowFocus"'+(s.session==='focus'?' checked':'')+'> 🎯 Follow focused session</label>'
          +'<div style="display:flex;gap:12px;width:100%">'
          +'<label style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted);text-align:center">Active<select class="s-agSessionActive" style="width:100%;font-size:13px"><option value="all">All Sessions</option></select></label>'
          +'<label style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted);text-align:center">Idle<select class="s-agSessionIdle" style="width:100%;font-size:13px"><option value="all">All Sessions</option></select></label>'
          +'</div><div class="val s-agSessionNote" style="opacity:.85;font-size:12px;text-align:center;margin-top:4px;display:flex;align-items:center;justify-content:center;gap:7px"><span class="s-agNoteTxt"></span><span class="s-agSymbol" style="display:none;align-items:center;font-weight:700"></span></div>');
        // Twinkle-region paint-board row (mirrors individual layer). Twinkles = one dot per running subagent;
        // this picks WHICH keys they can appear on (default = the A–Z letter cluster).
        const regionRow=full('<div style="text-align:center;font-size:12.5px;color:var(--muted);width:100%;margin-bottom:5px">Twinkles (one per running subagent) light up on these keys</div>'
          +'<button type="button" class="s-agShowkb" title="Paint the keys where subagent twinkles may appear">⌨ Set Twinkle Keys</button>'
          +'<button type="button" class="s-agRegRandom" style="margin-left:6px" title="Scatter the twinkle keys randomly across the whole board — same number of keys as now, shown live on the preview. Click again for a fresh scatter.">🎲 Random</button>'
          +'<button type="button" class="s-agRegReset" style="margin-left:6px" title="Reset the twinkle region back to the default A–Z letter cluster">↺ Reset to letters</button>'
          +'<span class="val s-agRegCount" style="opacity:.6;font-size:12px;margin-left:6px"></span>'
          +'<div style="text-align:center;width:100%;margin-top:7px"><label class="sl" style="margin:0" title="Color each twinkle by its position (red→violet) instead of one flat color, so the number of running subagents reads as a progressing ROYGBIV spectrum across the region"><input type="checkbox" class="s-twinkleSpectrum"'+(s.twinkleSpectrum?' checked':'')+'> Spectrum twinkles (ROYGBIV by count)</label></div>');
        // Emphasis toggles
        const emphRows=
          row('Numpad<br>Silhouette','<label class="sl" style="margin:0"><input type="checkbox" class="s-silhouetteNumpad"'+(s.silhouetteNumpad?' checked':'')+'> Carve numpad from layers below while agent is active</label><span></span>')+
          row('Dim Below','<label class="sl" style="margin:0"><input type="checkbox" class="s-dimBelow"'+(s.dimBelow?' checked':'')+'> Dim the numpad on layers below while agent is active</label><span></span>')+
          (s.dimBelow ? row('Dim Amount','<span class="srange" style="width:100%"><input type="range" class="s-dimBelowAmt" min="0" max="100" value="'+Math.round((s.dimBelowAmt!=null?s.dimBelowAmt:0.9)*100)+'"><i class="tick" style="left:calc(7px + (100% - 14px)*0.9)"></i></span><span class="val s-dimBelowAmtV"></span>') : '');
        // Exclamation (!) animation controls
        const bangRows=
          row('Hold','<span class="srange" style="width:100%"><input type="range" class="s-holdMs" min="200" max="10000" step="100" value="'+(s.holdMs!=null?s.holdMs:1000)+'"><i class="tick" style="left:calc(7px + (100% - 14px)*0.08)"></i></span><span class="val s-holdMsV"></span>')+
          row('Reminder','<label class="sl" style="margin:0"><input type="checkbox" class="s-reminderEnabled"'+(s.reminderEnabled?' checked':'')+'> Re-blink if still waiting after delay</label><span></span>')+
          (s.reminderEnabled ?
            row('Reminder Delay','<span class="srange" style="width:100%"><input type="range" class="s-reminderAfterMs" min="1000" max="60000" step="1000" value="'+(s.reminderAfterMs!=null?s.reminderAfterMs:8000)+'"><i class="tick" style="left:calc(7px + (100% - 14px)*0.122)"></i></span><span class="val s-reminderAfterMsV"></span>') : '')+
          (s.reminderEnabled ?
            row('Blinks','<select class="s-reminderBlinks"><option value="2"'+(s.reminderBlinks===2?' selected':'')+'>2 blinks</option><option value="3"'+(s.reminderBlinks===3?' selected':'')+'>3 blinks</option></select><span></span>') : '');
        // Preview toggle (page-side synthetic feed)
        const previewRow=full('<div style="text-align:center"><label class="sl" style="margin:0;text-align:center" title="Loops a fake agent session (busy spinner → subagent twinkles → green ✓ → red ! attention) so you can dial in the colors and animation without a real Claude Code session running. Turn off for live use."><input type="checkbox" class="s-agPreview"'+(s.preview?' checked':'')+'> <span>Demo the animations (loop a fake session)<br>so you can tune colors without a live agent</span></label></div>'
          +'<div style="text-align:center;margin-top:6px"><span style="opacity:.6;font-size:11px;margin-right:6px">Trigger once:</span>'
          +'<button type="button" class="s-agTrig" data-trig="twinkle">Twinkle</button> '
          +'<button type="button" class="s-agTrig" data-trig="spinner">Spinner</button> '
          +'<button type="button" class="s-agTrig" data-trig="check">Checkmark</button> '
          +'<button type="button" class="s-agTrig" data-trig="bang">Exclamation</button></div>');
        const kbPreviewRow=full('<button type="button" class="s-agKbShow" style="margin:0 auto">⌨ Show live agent preview</button>'
          +'<div class="s-agKbWrap" style="display:none;width:100%;margin-top:8px"><canvas class="s-agKbCanvas" style="width:100%;display:block;border-radius:8px;background:#0d1117"></canvas><div style="text-align:center;font-size:11px;opacity:.55;margin-top:3px">Live — the same agent layer your keyboard shows</div></div>');
        const windowRow=full('<div style="display:flex;flex-direction:column;gap:6px;width:100%">'
          +'<label class="sl" style="margin:0;justify-content:center" title="When a session needs you (the ! state), bring its VSCode window to the front and flash the outline. Windows only."><input type="checkbox" class="s-agAutoSwitch"> Bring window forward when a session needs you</label>'
          +'<label class="sl" style="margin:0;justify-content:center" title="Flash the color outline on a session’s monitor when focus switches to it — no window-stealing."><input type="checkbox" class="s-agOutlineSwitch"> Flash outline when focus switches</label>'
          +'<div style="display:flex;align-items:center;justify-content:center;gap:9px;margin-top:2px"><span style="font-size:12px;color:var(--muted)">Outline color</span><input type="color" class="s-agOutlineColor" value="#f97316" style="width:34px;height:24px;padding:0;border:none;background:none;cursor:pointer"><button type="button" class="s-agBringFront" title="Bring the followed/selected session’s VSCode window to the front + flash the outline">⤒ Bring window to front</button></div></div>');
        body.innerHTML='<div class="ctl">'+
          sec('Colors')+colorRows+
          sec('Session')+sessionRow+kbPreviewRow+windowRow+
          sec('Twinkle Region')+regionRow+
          sec('Emphasis')+emphRows+
          sub('Exclamation Animation')+bangRows+
          sec('Preview')+previewRow+
        '</div>';
        const c=q=>body.querySelector(q);
        // Color pickers + per-color ↺ reset to default
        ['twinkleColor','spinColor','checkColor','bangColor'].forEach(key=>{ const el=c('.s-'+key); if(el) el.addEventListener('input',e=>{ s[key]=e.target.value; scheduleSaveLayers(); }); });
        body.querySelectorAll('.s-agColReset').forEach(b=>b.addEventListener('click',()=>{ const key=b.dataset.key, def=AG_COLOR_DEF[key]; if(!def) return; s[key]=def; const el=c('.s-'+key); if(el) el.value=def; scheduleSaveLayers(); }));
        // Session filter — follow-focus checkbox + two selects (Active | Idle)
        const selActive=c('.s-agSessionActive'), selIdle=c('.s-agSessionIdle'), sessNote=c('.s-agSessionNote'), noteTxt=c('.s-agNoteTxt'), agSymbol=c('.s-agSymbol'), follow=c('.s-agFollowFocus');
        let _lastSessions=[], _lastFocus=null, _lastFollowId=null, _lastAgg=null, _lastFcfg=null;   // _lastFocus = focusedSession {id,fresh,following}; _lastFollowId = last note session (pulse on a SWITCH); _lastAgg = live agent aggregate (drives the phase symbol); _lastFcfg = window-focus config (color + toggles)
        // Derive the current agent PHASE from the daemon's aggregate — the same priority the keyboard renders.
        function agPhase(a){ if(!a) return null; if(a.busy) return 'busy'; if(a.attention) return 'bang'; if(a.checkmarkAt && Date.now()-a.checkmarkAt < 4000) return 'check'; if(a.subagentCount>0) return 'subs'; return null; }
        function setAgSymbol(a){ if(!agSymbol) return; const ph=agPhase(a);
          if(!ph){ agSymbol.style.display='none'; agSymbol.innerHTML=''; return; }
          agSymbol.style.display='inline-flex';
          if(ph==='busy'){ agSymbol.innerHTML='<i class="ag-spin"></i>'; const sp=agSymbol.querySelector('.ag-spin'); if(sp) sp.style.borderTopColor=s.spinColor||'#ffffff'; agSymbol.title='working…'; }
          else if(ph==='check'){ agSymbol.innerHTML='✓'; agSymbol.style.color=s.checkColor||'#22cc44'; agSymbol.title='done'; }
          else if(ph==='bang'){ agSymbol.innerHTML='<span class="ag-bang">!</span>'; agSymbol.style.color=s.bangColor||'#ff3b30'; agSymbol.title='needs you'; }
          else { agSymbol.innerHTML='<i class="ag-twk"></i>'+a.subagentCount; agSymbol.style.color=s.twinkleColor||'#ff8c00'; const tw=agSymbol.querySelector('.ag-twk'); if(tw) tw.style.background=s.twinkleColor||'#ff8c00'; agSymbol.title=a.subagentCount+' subagent'+(a.subagentCount===1?'':'s'); } }
        // sessions: array = fresh fetch (with .focus stashed), null = daemon unavailable, undefined = re-render from _lastSessions
        function fillSessionDrop(sessions){ if(!selActive||!selIdle) return;
          if(Array.isArray(sessions)){ _lastSessions=sessions; _lastFocus=sessions.focus||null; if('agg' in sessions) _lastAgg=sessions.agg; if('fcfg' in sessions){ _lastFcfg=sessions.fcfg; applyFcfg(_lastFcfg); } }
          const followOn=(s.session==='focus');
          selActive.disabled=selIdle.disabled=followOn;   // follow mode owns the selection → the manual dropdowns go inert
          const cur=followOn?'all':(s.session||'all'), esc=t=>String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;'), escA=t=>String(t).replace(/"/g,'&quot;');
          const opt=ag=>'<option value="'+escA(ag.id)+'"'+(ag.id===cur?' selected':'')+'>'+esc(ag.label||ag.id)+'</option>';
          const list=_lastSessions.filter(ag=>ag&&ag.id), has=list.some(ag=>ag.id===cur);
          const active=list.filter(ag=>ag.active), idle=list.filter(ag=>!ag.active);
          const allSel=(cur==='all')?' selected':'';   // both rest on "All Sessions" until a specific session is picked
          selActive.innerHTML='<option value="all"'+allSel+'>All Sessions</option>'+active.map(opt).join('');
          selIdle.innerHTML='<option value="all"'+allSel+'>All Sessions</option>'+idle.map(opt).join('');
          // a saved pick that's no longer live (ended) → keep it visible + selected, parked in the Active column
          if(!followOn && cur!=='all' && !has){ const lbl=esc(s.sessionLabel||('session '+cur.slice(0,6)));
            selActive.insertAdjacentHTML('beforeend','<option value="'+escA(cur)+'" selected>'+lbl+' (ended)</option>'); }
          if(!noteTxt) return;
          setAgSymbol(_lastAgg);   // live agent phase (spinner / ✓ / ! / subagent count) next to the note — mirrors the keyboard
          if(followOn){   // show what focus is currently following (from the daemon's focusedSession)
            const f=_lastFocus, ss=f&&f.following&&list.find(x=>x.id===f.following);
            noteTxt.textContent = ss ? ('🎯 Following: '+ss.label)
              : (f&&f.following) ? ('🎯 Following session '+String(f.following).slice(0,6))
              : 'No focused VSCode window yet — showing all sessions';
            const fid=(f&&f.following)||null;
            if(fid && fid!==_lastFollowId){ sessNote.classList.remove('ag-focus-flash'); void sessNote.offsetWidth; sessNote.classList.add('ag-focus-flash'); }   // pulse only when focus SWITCHES to a new session (not on every 2.5s poll of the same one)
            _lastFollowId=fid;
          } else { _lastFollowId=null; if(sessions!==undefined) noteTxt.textContent=(sessions&&sessions.length)?'':(sessions===null?'(daemon not available)':'(no sessions seen yet)'); } }
        fillSessionDrop([]);
        const onPick=e=>{ s.session=e.target.value;
          const o=e.target.selectedOptions&&e.target.selectedOptions[0];   // remember the friendly label so it stays readable after the session ends
          s.sessionLabel = e.target.value==='all' ? '' : (o?o.textContent.replace(/ \(ended\)$/,''):'');
          scheduleSaveLayers(); fillSessionDrop(); };   // re-render both → the non-chosen column resets to All Sessions
        selActive.addEventListener('change',onPick); selIdle.addEventListener('change',onPick);
        // Follow-focus toggle: 'focus' is a pseudo-session the daemon resolves to the live focused id (or 'all' if stale)
        let _followTimer=0;
        const stopFollowPoll=()=>{ if(_followTimer){ clearInterval(_followTimer); _followTimer=0; } };
        const startFollowPoll=()=>{ stopFollowPoll(); _followTimer=setInterval(()=>{ if(!follow||!follow.isConnected||!follow.checked){ stopFollowPoll(); return; } listAgentSessions().then(fillSessionDrop).catch(()=>{}); },2500); };   // keep the "Following:" line live while following (self-stops when the card unmounts or you untick)
        if(follow) follow.addEventListener('change',()=>{
          if(follow.checked){ if(s.session!=='focus') s._sessionPrev=s.session||'all'; s.session='focus'; startFollowPoll(); listAgentSessions().then(fillSessionDrop).catch(()=>{}); }
          else { s.session=s._sessionPrev||'all'; stopFollowPoll(); }
          scheduleSaveLayers(); fillSessionDrop(); });
        // Async load on card open + re-fetch when either dropdown opens (a just-started session lands on the next open)
        listAgentSessions().then(fillSessionDrop).catch(()=>fillSessionDrop(null));
        [selActive,selIdle].forEach(sel=>sel.addEventListener('pointerdown',()=>{ listAgentSessions().then(fillSessionDrop).catch(()=>{}); }));
        if(follow&&follow.checked) startFollowPoll();   // card opened already in follow mode → keep the label live
        // ⌨ Live agent preview: render the SAME agent layer the keyboard shows (E.renderAgent) onto a mini canvas.
        (function(){
          const pbtn=c('.s-agKbShow'), pwrap=c('.s-agKbWrap'), pcv=c('.s-agKbCanvas');
          if(!pbtn||!pwrap||!pcv) return;
          const pctx=pcv.getContext('2d'), AR=E.BOARDW/E.BOARDH, PL={settings:s, rgb:new Uint8Array(E.NLED*3)};
          let praf=0, ppoll=0;
          const psize=()=>{ const w=Math.max(120, pcv.clientWidth||pwrap.clientWidth||360); pcv.width=Math.round(w*2); pcv.height=Math.round(w*2/AR); };
          function pdraw(){ const W=pcv.width, H=pcv.height; pctx.setTransform(1,0,0,1,0,0); pctx.fillStyle='#0d1117'; pctx.fillRect(0,0,W,H);
            for(let k=0;k<E.NLED;k++){ const cell=E.keyCell(E.INDICES[k]); if(!cell) continue; const cx=cell[0],cy=cell[1],w=cell[2],h=cell[3];
              const x=(cx-w/2)*W, y=(cy-h/2)*H, ww=w*W, hh=h*H, o=k*3, r=PL.rgb[o],g=PL.rgb[o+1],b=PL.rgb[o+2];
              pctx.fillStyle=(r+g+b>6)?('rgb('+r+','+g+','+b+')'):'#20262e'; pctx.fillRect(x+1,y+1,Math.max(1,ww-2),Math.max(1,hh-2)); } }
          function ploop(){ if(!praf) return; E.renderAgent(PL, performance.now(), {agent:_lastAgg}); pdraw(); praf=requestAnimationFrame(ploop); }
          function pshow(){ pwrap.style.display='block'; psize(); pbtn.textContent='⌨ Hide live agent preview'; if(!praf) praf=requestAnimationFrame(ploop);
            listAgentSessions().then(fillSessionDrop).catch(()=>{});   // pull the live aggregate now (preview shows real state even with Follow off)
            if(!ppoll) ppoll=setInterval(()=>{ if(!pwrap.isConnected||pwrap.style.display==='none'){ clearInterval(ppoll); ppoll=0; return; } listAgentSessions().then(fillSessionDrop).catch(()=>{}); }, 2000); }
          function phide(){ pwrap.style.display='none'; pbtn.textContent='⌨ Show live agent preview'; if(praf){ cancelAnimationFrame(praf); praf=0; } if(ppoll){ clearInterval(ppoll); ppoll=0; } }
          pbtn.addEventListener('click',()=>{ (pwrap.style.display==='none')?pshow():phide(); });
          window.addEventListener('resize',()=>{ if(praf) psize(); });
        })();
        // Window-focus + color outline controls (self-contained claude-view-style actions). applyFcfg is
        // a hoisted declaration so fillSessionDrop (defined earlier) can seed the controls from /status once.
        const wcAu=c('.s-agAutoSwitch'), wcOs=c('.s-agOutlineSwitch'), wcCol=c('.s-agOutlineColor'), wcBf=c('.s-agBringFront');
        function applyFcfg(f){ if(!f||!wcAu) return; if(f.color) wcCol.value=f.color; wcAu.checked=!!f.autoSwitch; wcOs.checked=!!f.outlineOnSwitch; }
        applyFcfg(_lastFcfg);
        if(wcAu) wcAu.addEventListener('change',()=>setFocusConfig({autoSwitch:wcAu.checked}));
        if(wcOs) wcOs.addEventListener('change',()=>setFocusConfig({outlineOnSwitch:wcOs.checked}));
        if(wcCol) wcCol.addEventListener('change',()=>setFocusConfig({color:wcCol.value}));
        if(wcBf) wcBf.addEventListener('click',()=>{ const id=(s.session==='focus')?(_lastFocus&&_lastFocus.following):(s.session&&s.session!=='all'?s.session:null); const ss=id&&_lastSessions.find(x=>x.id===id); focusWindowFront(ss?ss.project:''); });
        // Twinkle-region paint board (same API as individual layer)
        let pb=null, pbWrap=null;
        const regionKeys={};   // idx→color source the board draws from; hoisted so Random can rewrite it live (pb.draw reads it fresh)
        const updRegCount=()=>{ const el=c('.s-agRegCount'); if(el) el.textContent = pb ? (pb.selCount()+' keys selected') : (Array.isArray(s.twinkleKeys)&&s.twinkleKeys.length ? s.twinkleKeys.length+' custom keys' : 'A–Z (26 keys)'); };
        updRegCount();
        function mountAgentBoard(){
          if(pb) return;
          pbWrap=document.createElement('div'); pbWrap.className='pb-wrap pb-large';
          pbWrap.innerHTML='<div class="pb-board"></div><div class="pb-hint">Click/drag to select twinkle keys · Shift = add · Ctrl = deselect · Right-click = clear key</div>';
          const sibs=[...card.parentNode.querySelectorAll('.lcard')], myTop=card.getBoundingClientRect().top;
          let anchor=card, anchorLeft=card.getBoundingClientRect().left;
          for(const sc of sibs){ const r=sc.getBoundingClientRect(); if(Math.abs(r.top-myTop)<8 && r.left<anchorLeft){ anchor=sc; anchorLeft=r.left; } }
          card.parentNode.insertBefore(pbWrap, anchor);
          // The agent board shows SELECTED region (not painted colors) — we repurpose PaintBoard in selection mode.
          // We give every key the twinkleColor as its stored "color" so the selection highlight reads correctly.
          for(const k in regionKeys) delete regionKeys[k];
          if(Array.isArray(s.twinkleKeys)) s.twinkleKeys.forEach(i=>{ regionKeys[i]=s.twinkleColor||'#ff8c00'; });
          pb=root_PaintBoard().mount(pbWrap.querySelector('.pb-board'), {
            engine:E, getKeys:()=>regionKeys, getColor:()=>s.twinkleColor||'#ff8c00',
            onPaint:(idx,hex)=>{ if(hex) regionKeys[idx]=hex; else delete regionKeys[idx];
              s.twinkleKeys=Object.keys(regionKeys).map(Number); scheduleSaveLayers(); updRegCount(); },
            onChange:()=>{ updRegCount(); scheduleSaveLayers(); },
          });
          c('.s-agShowkb').textContent='⌨ Hide Twinkle Region';
          updRegCount();
          requestAnimationFrame(()=>{ try{ pbWrap.scrollIntoView({behavior:'smooth', block:'start'}); }catch(_){ try{ pbWrap.scrollIntoView(); }catch(__){ } } });
        }
        function unmountAgentBoard(){ if(!pb) return;
          const before=window.scrollY, r=pbWrap.getBoundingClientRect();
          pb.destroy(); pb=null; const w=pbWrap; pbWrap=null; if(w&&w.parentNode) w.parentNode.removeChild(w);
          const shift=Math.max(0, Math.min(r.height, -r.top)); if(shift>0) window.scrollTo(0, before-shift);
          c('.s-agShowkb').textContent='⌨ Set Twinkle Keys'; updRegCount();
          requestAnimationFrame(()=>{ try{ card.scrollIntoView({behavior:'smooth', block:'center'}); }catch(_){ } }); }
        c('.s-agShowkb').addEventListener('click',()=>{ pb?unmountAgentBoard():mountAgentBoard(); });
        // 🎲 Random: scatter N twinkle keys randomly across the board, N = current count (default 26, the A–Z size),
        // so density is preserved and only the placement is random (nothing arbitrary about the count). Shows live.
        c('.s-agRegRandom').addEventListener('click',()=>{
          const n=(Array.isArray(s.twinkleKeys)&&s.twinkleKeys.length)?s.twinkleKeys.length:26;
          const pool=E.INDICES.slice();
          for(let i=pool.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=pool[i]; pool[i]=pool[j]; pool[j]=t; }   // Fisher–Yates
          s.twinkleKeys=pool.slice(0,Math.max(1,Math.min(pool.length,n))).sort((a,b)=>a-b);
          if(!pb) mountAgentBoard();                                             // not open → open it so the scatter is visible
          else { for(const k in regionKeys) delete regionKeys[k]; s.twinkleKeys.forEach(i=>{ regionKeys[i]=s.twinkleColor||'#ff8c00'; }); pb.selectNone&&pb.selectNone(); pb.draw(); }
          updRegCount(); scheduleSaveLayers();
        });
        c('.s-agRegReset').addEventListener('click',()=>{ s.twinkleKeys=null; unmountAgentBoard(); updRegCount(); scheduleSaveLayers(); });
        { const el=c('.s-twinkleSpectrum'); if(el) el.addEventListener('change',e=>{ s.twinkleSpectrum=e.target.checked; scheduleSaveLayers(); }); }
        // Emphasis toggles
        { const el=c('.s-silhouetteNumpad'); if(el) el.addEventListener('change',e=>s.silhouetteNumpad=e.target.checked); }
        { const el=c('.s-dimBelow'); if(el) el.addEventListener('change',e=>{ s.dimBelow=e.target.checked; buildLayerBody(card,L); scheduleSaveLayers(); }); }
        { const el=c('.s-dimBelowAmt'), v=c('.s-dimBelowAmtV'); if(el&&v){ const up=()=>v.textContent=Math.round(+el.value)+'%'; el.addEventListener('input',e=>{ s.dimBelowAmt=Math.round(+e.target.value)/100; up(); }); up(); } }
        // Exclamation animation
        { const el=c('.s-holdMs'), v=c('.s-holdMsV'); if(el&&v){ const up=()=>v.textContent=(+el.value/1000).toFixed(1)+'s'; el.addEventListener('input',e=>{ s.holdMs=+e.target.value; up(); }); up(); } }
        { const el=c('.s-reminderEnabled'); if(el) el.addEventListener('change',e=>{ s.reminderEnabled=e.target.checked; buildLayerBody(card,L); scheduleSaveLayers(); }); }
        { const el=c('.s-reminderAfterMs'), v=c('.s-reminderAfterMsV'); if(el&&v){ const up=()=>v.textContent=(+el.value/1000).toFixed(0)+'s'; el.addEventListener('input',e=>{ s.reminderAfterMs=+e.target.value; up(); }); up(); } }
        { const el=c('.s-reminderBlinks'); if(el) el.addEventListener('change',e=>s.reminderBlinks=+e.target.value); }
        // Preview: synthetic agent feed injected into state.agent while toggle is on + page is driving
        { const el=c('.s-agPreview'); if(el) el.addEventListener('change',e=>{ s.preview=e.target.checked; }); }
        // Synthetic feed loop — injects a rotating fake state.agent each frame while Preview is on.
        // When Preview is off, leaves state.agent alone (daemon feed stays in control).
        (function(){
          let _phase=0; // cycle: 0=busy+2 subagents, 1=checkmark flash, 2=attention/!, 3=idle
          const PHASE_MS=[4000, 2000, 6000, 2000];
          let _phaseStart=performance.now();
          function syntheticAgent(now){
            const elapsed=now-_phaseStart;
            if(elapsed>PHASE_MS[_phase]){ _phaseStart=now; _phase=(_phase+1)%4; }
            if(_phase===0) return { busy:true, subagentCount:2, checkmarkAt:null, notifyAt:null, attention:false, bootAt:null };
            if(_phase===1) return { busy:false, subagentCount:0, checkmarkAt:now, notifyAt:null, attention:false, bootAt:null };
            if(_phase===2) return { busy:false, subagentCount:0, checkmarkAt:null, notifyAt:now-500, attention:true, bootAt:null };
            return null;   // idle — nothing lighting
          }
          // One-shot triggers: each button injects JUST that animation for its natural duration,
          // overriding the Preview cycle while active (no daemon needed, works with Preview off).
          let _trig=null;   // {kind, at, until}
          const TRIG_MS={ twinkle:4000, spinner:4000, check:1500, bang:5000 };
          body.querySelectorAll('.s-agTrig').forEach(b=>b.addEventListener('click',()=>{
            const now=performance.now();
            _trig={ kind:b.dataset.trig, at:now, until:now+TRIG_MS[b.dataset.trig] };
          }));
          function triggerAgent(){
            const at=_trig.at;
            if(_trig.kind==='twinkle') return { busy:false, subagentCount:3, checkmarkAt:null, notifyAt:null, attention:false, bootAt:null };
            if(_trig.kind==='spinner') return { busy:true, subagentCount:0, checkmarkAt:null, notifyAt:null, attention:false, bootAt:null };
            if(_trig.kind==='check')   return { busy:false, subagentCount:0, checkmarkAt:at, notifyAt:null, attention:false, bootAt:null };
            return { busy:false, subagentCount:0, checkmarkAt:null, notifyAt:at, attention:true, bootAt:null };
          }
          function frame(now){
            if(!document.body.contains(body) || L.type!=='agent') return;   // card rebuilt/removed → stop loop
            if(_trig){ if(now<_trig.until) state.agent=triggerAgent(); else { _trig=null; if(!s.preview) state.agent=null; } }
            else if(s.preview) state.agent = syntheticAgent(now);
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
      applySectionChrome(body, L);   // box + lock + collapse each labeled section on EVERY layer type (run LAST so all controls are wired/finalized before re-parenting); flat bodies get one synthesized "Settings" box
      if(L.type==='agent') groupAgentAlerts(body);   // wrap the alert-related sections in one titled "Agent Alerts" box
    }
    // Agent card: gather the four alert-related sections into a single titled "Agent Alerts" group box so they
    // read as one cluster (they all govern how the agent signals you). Runs AFTER applySectionChrome boxed them.
    function groupAgentAlerts(body){
      const slugs=['twinkle-region','emphasis','exclamation-animation','preview'];
      const boxes=slugs.map(sg=>body.querySelector('.lsecbox[data-sec="'+sg+'"]')).filter(Boolean);
      if(boxes.length<2 || body.querySelector('.aa-group')) return;
      const group=document.createElement('div'); group.className='aa-group';
      const title=document.createElement('div'); title.className='aa-group-title'; title.textContent='Agent Alerts';
      boxes[0].parentNode.insertBefore(group, boxes[0]);
      group.appendChild(title); boxes.forEach(b=>group.appendChild(b));
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
    // ---- Section chrome (audio cards): wrap each labeled section (.lsec/.lsub) in a box with a lock + collapse
    // toggle on the right of the header, zebra-stripe the boxes, and remember collapsed/locked per layer (s._secUI).
    const SEC_LOCK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
    const SEC_UNLOCK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
    const SEC_CHEV='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    function ensureSecStyles(){ if(document.getElementById('th108-secchrome')) return;
      const st=document.createElement('style'); st.id='th108-secchrome';
      st.textContent=
        '.lbody .lsecbox{ grid-column:1/-1; margin:3px 0 8px; }'+
        // header band: tall enough to fully contain the action buttons (no clipping); title centered (column so the
        // shared Adjust block's subtitle stacks under it); symmetric padding reserves the action space so the
        // centered title never overlaps the buttons. .ph = the Adjust block's header.
        '.lbody .lsecbox > .lsec, .lbody .lsecbox > .lsub, .lbody .lsecbox > .ph{ position:relative; box-sizing:border-box; min-height:36px; margin:0; padding:5px 38px; display:flex; flex-direction:column; align-items:center; justify-content:center; border:1.5px solid rgba(145,150,160,.42); border-bottom:none; border-radius:11px 11px 0 0; }'+
        '.lbody .lsecbox > .lsec::before, .lbody .lsecbox > .lsub::before{ display:none; }'+   // the box border replaces the old divider rule
        '.lbody .lsecbox > .lsecbody{ display:grid; grid-template-columns:84px minmax(30px,1fr) 124px; gap:7px 8px; }'+   // col3 widened (84->124) so the value number + unit + reset button fit without clipping the box edge
        // body box: audio sections use .lsecbody (3-col grid); the shared Adjust block keeps its own .ctl grid — both get the box border/padding.
        '.lbody .lsecbox > .lsecbody, .lbody .lsecbox > .ctl{ border:1.5px solid rgba(145,150,160,.42); border-top:none; border-radius:0 0 11px 11px; padding:9px 9px 11px; margin:0; }'+
        // zebra: tint the WHOLE box (header + body) and alternate it with clear contrast so sections are easy to follow
        '.lbody .lsecbox > .lsec, .lbody .lsecbox > .lsub, .lbody .lsecbox > .ph, .lbody .lsecbox > .lsecbody, .lbody .lsecbox > .ctl{ background:rgba(145,150,160,.05); }'+
        '.lbody .lsecbox.zeb > .lsec, .lbody .lsecbox.zeb > .lsub, .lbody .lsecbox.zeb > .ph, .lbody .lsecbox.zeb > .lsecbody, .lbody .lsecbox.zeb > .ctl{ background:rgba(145,150,160,.16); }'+
        // Agent-card "Agent Alerts" group: a titled outer box wrapping the four alert sections so they read as one cluster
        '.lbody .aa-group{ grid-column:1/-1; margin:6px 0 10px; padding:0 9px 9px; border:1.5px solid rgba(120,150,220,.45); border-radius:13px; background:rgba(120,150,220,.05); }'+
        '.lbody .aa-group-title{ text-align:center; font-weight:700; font-size:15.5px; color:var(--text); letter-spacing:.4px; padding:9px 0 7px; }'+
        '.lbody .aa-group > .lsecbox{ margin:0 0 8px; }'+   // tighten the inner boxes inside the group
        '.lbody .aa-group > .lsecbox:last-child{ margin-bottom:0; }'+
        '.lbody .lsecbox.collapsed > .lsec, .lbody .lsecbox.collapsed > .lsub, .lbody .lsecbox.collapsed > .ph{ border-bottom:1.5px solid rgba(145,150,160,.42); border-radius:11px; }'+   // collapsed → header is the whole box: full rounding + a bottom border
        '.lbody .lsecbox.collapsed > .lsecbody, .lbody .lsecbox.collapsed > .ctl{ display:none; }'+
        '.lbody .lsecbox.locked > .lsecbody, .lbody .lsecbox.locked > .ctl{ pointer-events:none; }'+
        '.lbody .lsecbox.locked > .lsecbody input[type=range], .lbody .lsecbox.locked > .ctl input[type=range]{ opacity:.4; filter:grayscale(1); }'+
        '.lsec-actions{ position:absolute; right:7px; top:50%; transform:translateY(-50%); display:flex; gap:2px; align-items:center; }'+
        '.lsec-actions button{ position:relative; background:rgba(13,17,23,.82); border:1px solid rgba(145,150,160,.45); cursor:pointer; color:var(--text); padding:3px; display:flex; align-items:center; border-radius:7px; }'+   // dark chip so the icon contrasts/reads; position:relative anchors the click ray-burst
        '.lsec-actions button:hover{ background:rgba(40,46,56,.95); border-color:rgba(145,150,160,.7); }'+
        '.lsec-actions button.on{ color:var(--warn,#e0a200); }'+
        '.lsec-actions svg{ width:14px; height:14px; display:block; }'+
        '.lsec-chevwrap svg{ transition:transform .15s ease; }'+
        '.lsecbox.collapsed .lsec-chevwrap svg{ transform:rotate(-90deg); }'+
        // radial ray-burst on lock/collapse click: 12 short lines shoot outward from the button center + fade over 250ms (inherits the button color — amber on a locked toggle)
        '.rayburst{ position:absolute; left:50%; top:50%; width:0; height:0; pointer-events:none; z-index:3; }'+
        '.rayburst i{ position:absolute; left:0; top:0; width:2px; height:7px; margin:-3.5px 0 0 -1px; border-radius:1px; background:currentColor; transform-origin:50% 50%; animation:lsecRay .25s ease-out forwards; }'+
        '@keyframes lsecRay{ from{ transform:rotate(var(--a)) translateY(-11px) scaleY(.5); opacity:.9 } to{ transform:rotate(var(--a)) translateY(-26px) scaleY(1); opacity:0 } }'+   // start ~11px out so the rays clear the 14px glyph instead of hugging it
        // Follow-focus "switched to a new session" pulse: brighten + blue glow + slight pop, settling back (properties return to neutral, so no need to know the base color)
        '.ag-focus-flash{ animation:agFocusFlash .7s ease-out; }'+
        '@keyframes agFocusFlash{ 0%{ filter:brightness(1.9); text-shadow:0 0 11px rgba(130,180,255,.95); transform:scale(1.09); } 100%{ filter:brightness(1); text-shadow:0 0 0 rgba(130,180,255,0); transform:scale(1); } }'+
        // on-screen agent-phase symbol (mirrors the keyboard): busy spinner, ! pulse, subagent twinkle dot
        '.s-agSymbol .ag-spin{ display:inline-block; width:11px; height:11px; border:2px solid rgba(255,255,255,.22); border-top-color:#fff; border-radius:50%; animation:agSpin .8s linear infinite; }'+
        '@keyframes agSpin{ to{ transform:rotate(360deg); } }'+
        '.s-agSymbol .ag-bang{ display:inline-block; animation:agBangPulse .6s ease-in-out infinite; }'+
        '@keyframes agBangPulse{ 0%,100%{ opacity:1; transform:scale(1); } 50%{ opacity:.35; transform:scale(1.25); } }'+
        '.s-agSymbol .ag-twk{ display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:3px; vertical-align:-1px; animation:agTwk .9s ease-in-out infinite; }'+
        '@keyframes agTwk{ 0%,100%{ opacity:.4; } 50%{ opacity:1; } }';
      document.head.appendChild(st); }
    // radial ray-burst on a lock/collapse button click: 12 short lines shoot outward + fade over 250ms
    function burstRays(btn){ const b=document.createElement('span'); b.className='rayburst';
      for(let i=0;i<6;i++){ const r=document.createElement('i'); r.style.setProperty('--a',(i*60)+'deg'); b.appendChild(r); }
      btn.appendChild(b); setTimeout(()=>{ if(b.parentNode) b.remove(); }, 300); }
    function applySectionChrome(body, L){ ensureSecStyles();
      const s=L.settings; if(!s._secUI) s._secUI={};
      // add the lock + collapse buttons to a box's header, wired to s._secUI[slug] (remembered per layer)
      const addSecActions=(box, header, slug)=>{
        const st=s._secUI[slug] || (s._secUI[slug]={collapsed:false, locked:false});
        if(st.collapsed) box.classList.add('collapsed'); if(st.locked) box.classList.add('locked');
        const actions=document.createElement('span'); actions.className='lsec-actions';
        const lockBtn=document.createElement('button'); lockBtn.type='button'; lockBtn.className='lsec-lock'+(st.locked?' on':'');
        const setLock=()=>{ lockBtn.innerHTML=st.locked?SEC_LOCK:SEC_UNLOCK; lockBtn.title=st.locked?'Locked — click to allow changes to this section':'Unlocked — click to protect this section from changes'; lockBtn.classList.toggle('on',st.locked); }; setLock();
        lockBtn.addEventListener('click',e=>{ e.stopPropagation(); st.locked=!st.locked; box.classList.toggle('locked',st.locked); setLock(); burstRays(lockBtn); scheduleSaveLayers(); });
        const colBtn=document.createElement('button'); colBtn.type='button'; colBtn.className='lsec-chevwrap'; colBtn.title='Collapse / expand this section'; colBtn.innerHTML=SEC_CHEV;
        colBtn.addEventListener('click',e=>{ e.stopPropagation(); st.collapsed=!st.collapsed; box.classList.toggle('collapsed',st.collapsed); burstRays(colBtn); scheduleSaveLayers(); });
        actions.appendChild(lockBtn); actions.appendChild(colBtn); header.appendChild(actions);
      };
      // shared "Adjust" block = a nested .lbody (header .ph + its own .ctl) → box it FIRST so the .ctl loop below
      // can safely synthesize headers for flat bodies without re-touching the Adjust .ctl.
      const adj=body.querySelector(':scope > .lbody');
      if(adj){ const ph=adj.querySelector(':scope > .ph'), actl=adj.querySelector(':scope > .ctl');
        if(ph && actl && !adj.classList.contains('lsecbox')){ adj.classList.add('lsecbox'); adj.dataset.sec='adjust'; ph.style.marginBottom='0'; addSecActions(adj, ph, 'adjust'); } }
      body.querySelectorAll('.ctl').forEach(ctl=>{
        if(ctl.closest('.lsecbox')) return;   // already boxed (e.g. the Adjust .ctl)
        if(!ctl.querySelector(':scope > .lsec, :scope > .lsub')){   // a flat body (background/reactive/gradient/pattern) → wrap its controls in one boxed "Settings" section so it gets lock/collapse too
          const h=document.createElement('div'); h.className='lsec'; h.textContent='Settings'; ctl.insertBefore(h, ctl.firstChild); }
        const kids=[...ctl.children];
        for(let i=0;i<kids.length;i++){ const node=kids[i];
          if(!(node.classList && (node.classList.contains('lsec')||node.classList.contains('lsub')))) continue;   // only labeled headers start a section
          const title=(node.textContent||'').trim(), slug=title.toLowerCase().replace(/[^a-z0-9]+/g,'-')||('sec'+i);
          const content=[]; let j=i+1;
          while(j<kids.length && !(kids[j].classList && (kids[j].classList.contains('lsec')||kids[j].classList.contains('lsub')))){ content.push(kids[j]); j++; }
          const box=document.createElement('div'); box.className='lsecbox'; box.dataset.sec=slug;
          ctl.insertBefore(box, node); box.appendChild(node);
          const wrap=document.createElement('div'); wrap.className='lsecbody'; content.forEach(n=>wrap.appendChild(n)); box.appendChild(wrap);
          addSecActions(box, node, slug);
          i=j-1;   // resume scanning from the next header (kids snapshot indices stay valid after re-parenting)
        }
      });
      let z=0; body.querySelectorAll('.lsecbox').forEach(b=>{ if(z%2===1) b.classList.add('zeb'); z++; });   // zebra alternate boxes across the whole card (incl. Adjust)
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
      if(L.type==='media') delete CFG.rot;   // media frames are pre-sampled per-key; applyAdjust has no rotate → dead control
      if(L.type==='agent') delete CFG.rot;   // agent glyphs use explicit color pickers; hue-rotating them fights the pickers — dead control
      const showStatic = L.type!=='individual';   // individual paints a fixed color set — there's no animation to freeze, so Static is meaningless here
      const disp=(key,raw)=>{ const d=CFG[key][3]; return d?(raw/100).toFixed(d):String(raw); };
      const ctl=key=>{ const c=CFG[key], dec=c[3], frac=(c[5]-c[1])/(c[2]-c[1]);   // tick at the default value
        const nMin=dec?c[1]/100:c[1], nMax=dec?c[2]/100:c[2], nStep=dec?1/Math.pow(10,dec):1;
        return '<label>'+c[0]+'</label>'+
          '<span class="srange" style="width:100%;min-width:30px"><input type="range" class="a-'+key+'" min="'+c[1]+'" max="'+c[2]+'" value="'+s[key]+'"><i class="tick" style="left:calc(7px + (100% - 14px)*'+frac+')"></i></span>'+
          '<span style="display:flex;gap:4px;align-items:center"><input type="number" class="numin a-'+key+'N" min="'+nMin+'" max="'+nMax+'" step="'+nStep+'" value="'+disp(key,s[key])+'"><span class="val" style="min-width:10px">'+c[4]+'</span></span>'; };
      const adj=document.createElement('div');
      adj.innerHTML=
        '<div class="lbody" style="margin-top:8px"><div class="ph" style="margin-bottom:6px;color:var(--text);font-weight:600;font-size:13px;text-align:center">Adjust <span style="display:block;margin-top:1px;color:var(--muted);font-weight:400;font-size:11px">(changes colors on the keyboard — not the site preview)</span></div><div class="ctl">'+
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
      cards.addEventListener('mousedown', e=>{ if(e.button===0 && !e.target.closest('input,button,select,textarea,a,label')) e.preventDefault(); });   // LEFT button only — the focus-jump quirk is a left-click behavior; guarding all buttons also killed native MIDDLE-click autoscroll in the panel
    }

    return { init, buildCards: buildLayerCards, save: saveLayers, scheduleSave: scheduleSaveLayers, restore: restoreLayers, reorderFromDom };
  }

  return { create, serializeLayers, serializeOrder, overlayLayers, TYPES, BLENDS };
});
