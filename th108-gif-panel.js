/* th108-gif-panel.js — GIF → per-key lighting panel for the TH108 controller (module #4 of the controller decomposition).
   Owns media decode (GIF/WebP/APNG/static via ImageDecoder, MP4/WebM via <video> seek, image sequences),
   the crop/pan/zoom/rotate positioning canvas, per-key color sampling (6 strategies), the output-conditioning
   chain (saturation/contrast/gamma/brightness), 0x32 playback via the injected transport, and the media-library
   wiring. Extracted unchanged from th108-controller.html's inline script. UMD so the pure parts
   (adjustRgb / edgeAvg / computeCrop) are unit-testable under node --test.

   Usage: const GIF = TH108GifPanel.create({engine, log, fpsCap, snap, snapMul, flashSnap,
            hasDevice, sendFrame, isRunning, startLayers, stopLayers, clearObActive});
   The module owns the #gif* DOM subtree; the layer loop, transport, and shared slider helpers arrive via opts.
   Exposed: play(), stop() (async — clears the board), onDeviceBound(), playing/framesLoaded getters. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TH108GifPanel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ----- pure helpers (node-testable) -----
  // saturation + contrast + gamma + brightness (help the LEDs vs the monitor)
  function adjustRgb(r, g, b, s, c, gm, br) {
    if(s!==1){ const y=0.299*r+0.587*g+0.114*b; r=y+(r-y)*s; g=y+(g-y)*s; b=y+(b-y)*s; }
    if(c!==1){ r=(r-128)*c+128; g=(g-128)*c+128; b=(b-128)*c+128; }                                // contrast — push colors apart so they pop
    r=Math.max(0,Math.min(255,r)); g=Math.max(0,Math.min(255,g)); b=Math.max(0,Math.min(255,b));
    if(gm!==1){ r=255*Math.pow(r/255,gm); g=255*Math.pow(g/255,gm); b=255*Math.pow(b/255,gm); }   // crush faint bleed → truer color on the LEDs
    return [Math.max(0,Math.min(255,r*br))|0, Math.max(0,Math.min(255,g*br))|0, Math.max(0,Math.min(255,b*br))|0];
  }
  // border-pixel average of an RGBA buffer — the "sampled" bar-fill color for out-of-bounds keys
  function edgeAvg(D, dw, dh) {
    let er=0,eg=0,eb=0,en=0;
    const accRow=y=>{ for(let x=0;x<dw;x++){ const o=(y*dw+x)*4; er+=D[o];eg+=D[o+1];eb+=D[o+2];en++; } };
    const accCol=x=>{ for(let y=0;y<dh;y++){ const o=(y*dw+x)*4; er+=D[o];eg+=D[o+1];eb+=D[o+2];en++; } };
    accRow(0); accRow(dh-1); accCol(0); accCol(dw-1);
    return [er/en|0, eg/en|0, eb/en|0];
  }
  // the target-aspect source rect that maps onto the keyboard, given zoom/pan — pan clamped to the source
  function computeCrop(SW, SH, tr, zoom, panX, panY) {
    const ir=SW/SH; let cw0,ch0;
    if(ir>tr){ ch0=SH; cw0=SH*tr; } else { cw0=SW; ch0=SW/tr; }
    const cw=cw0/zoom, ch=ch0/zoom, mX=(SW-cw)/2, mY=(SH-ch)/2;
    panX = mX>0 ? Math.max(-mX,Math.min(mX,panX)) : 0;   // zoom<1 (zoomed out past cover) → crop exceeds source → center it
    panY = mY>0 ? Math.max(-mY,Math.min(mY,panY)) : 0;
    return {cx:(SW-cw)/2+panX, cy:(SH-ch)/2+panY, cw, ch, panX, panY};
  }

  function create(opts) {
    opts = opts || {};
    const noop = function () {};
    const E = opts.engine, log = opts.log || noop, fpsCap = opts.fpsCap || (() => 60),
          snap = opts.snap || noop, snapMul = opts.snapMul || noop, flashSnap = opts.flashSnap || noop,
          hasDevice = opts.hasDevice || (() => false), sendFrame = opts.sendFrame || (async () => false),
          isRunning = opts.isRunning || (() => false),
          startLayers = opts.startLayers || noop, stopLayers = opts.stopLayers || noop,
          clearObActive = opts.clearObActive || noop,
          refreshButtons = opts.refreshButtons || noop;   // host hook: re-sync the drive toggle/pill on GIF play/stop (GIF owns the board while playing)
    const {INDICES, BOARDW, BOARDH} = E;

    // uniform-grid positions (LED index -> [col,row]); the "Grid" mapping gives every key an equal cell — best for legible text/pixel art.
    // (Physical LAYOUT/BOARDW/BOARDH + KEYMAP/INDICES live in th108-engine.js; GRID is host/GIF-tool-only — the engine's keyCell is physical-only.)
    const GW=21, GH=6, GRID={"0":[0,0],"1":[2,0],"2":[3,0],"3":[4,0],"4":[5,0],"5":[6,0],"6":[7,0],"7":[8,0],"8":[9,0],"9":[10,0],"10":[11,0],"11":[12,0],"12":[13,0],"16":[0,1],"17":[1,1],"18":[2,1],"19":[3,1],"20":[4,1],"21":[5,1],"22":[6,1],"23":[7,1],"24":[8,1],"25":[9,1],"26":[10,1],"27":[11,1],"28":[12,1],"29":[17,1],"30":[18,1],"31":[19,1],"32":[0,2],"33":[1,2],"34":[2,2],"35":[3,2],"36":[4,2],"37":[5,2],"38":[6,2],"39":[7,2],"40":[8,2],"41":[9,2],"42":[10,2],"43":[11,2],"44":[12,2],"45":[17,2],"46":[18,2],"47":[19,2],"48":[0,3],"49":[1,3],"50":[2,3],"51":[3,3],"52":[4,3],"53":[5,3],"54":[6,3],"55":[7,3],"56":[8,3],"57":[9,3],"58":[10,3],"59":[11,3],"60":[13,2],"61":[17,3],"62":[18,3],"63":[19,3],"64":[0,4],"65":[2,4],"66":[3,4],"67":[4,4],"68":[5,4],"69":[6,4],"70":[7,4],"71":[8,4],"72":[9,4],"73":[10,4],"74":[11,4],"75":[12,4],"76":[13,3],"77":[17,4],"78":[18,4],"79":[19,4],"80":[0,5],"81":[1,5],"82":[2,5],"83":[6,5],"84":[10,5],"85":[11,5],"86":[12,5],"87":[13,5],"88":[14,5],"89":[15,5],"90":[15,4],"91":[16,5],"92":[13,1],"93":[18,5],"94":[19,5],"95":[20,4],"99":[14,0],"100":[15,0],"102":[16,0],"103":[14,1],"104":[15,1],"105":[16,1],"106":[14,2],"107":[15,2],"108":[16,2],"109":[20,1],"110":[20,2]};
    // host keyCell: honors the #gifMap select (grid vs physical) for the GIF tool; physical case delegates to the engine.
    function keyCell(idx){                                // -> [nx,ny,nw,nh] normalized center+size, per the active mapping
      if(document.getElementById('gifMap').value==='grid'){ const G=GRID[idx]; if(G) return [(G[0]+0.5)/GW,(G[1]+0.5)/GH,1/GW,1/GH]; }
      return E.keyCell(idx);   // physical layout (unknown index → null, no phantom key)
    }

    // ===== GIF -> per-key lighting: physical-layout sampling + drag/zoom positioning, stream via 0x32, loop =====
    const MAXDIM=340;                                    // cap decoded frame size (we only need ~104 samples) — keeps memory/CPU low
    let gifFrames=[], gifPlaying=false, gifIdx=0, currentSource=null, inFlight=false;   // currentSource = what to save to the library ({kind:'single',blob,name} | {kind:'seq',blobs,name})
    let gifPrevLayers=false;   // layers were running when Play GIF was clicked → Stop GIF hands back to them instead of leaving the board to the firmware
    // background tabs throttle main-thread setTimeout to ~1fps; a Web Worker timer keeps playback at full rate when unfocused
    const tickW=(()=>{ try{ return new Worker(URL.createObjectURL(new Blob(['let t;onmessage=e=>{if(e.data.stop){clearTimeout(t);return;}clearTimeout(t);t=setTimeout(()=>postMessage(1),e.data.delay);};'],{type:'text/javascript'}))); }catch(_){ return null; } })();
    let czoom=1, cpanX=0, cpanY=0, srcTmp=null;          // GIF position transform (source-pixel pan + zoom)
    function gifBri(){ return (+document.getElementById('gifBri').value)/100; }
    function gifSpeed(){ return (+document.getElementById('gifSpeed').value)/100; }      // playback speed multiplier
    function gifRotRad(){ return (+document.getElementById('gifRot').value)*Math.PI/180; }  // GIF rotation
    // the board-aspect source rect that maps onto the keyboard, given zoom/pan — clamped to the source
    function gifCrop(SW,SH){
      const r=computeCrop(SW,SH,BOARDW/BOARDH,czoom,cpanX,cpanY);
      cpanX=r.panX; cpanY=r.panY;                        // persist the clamping (same in-place behavior as before)
      return r;
    }
    // bar-fill color for keys whose sample falls outside the source (zoomed out / fit)
    function barColor(fr){
      const m=document.getElementById('gifBars').value;
      if(m==='custom'){ const h=document.getElementById('gifBarColor').value; return [parseInt(h.substr(1,2),16),parseInt(h.substr(3,2),16),parseInt(h.substr(5,2),16)]; }
      if(m==='sampled') return fr.edge||[0,0,0];
      return [0,0,0];
    }
    // map each key's source patch -> one raw rgb, via the chosen strategy (saturation/etc. applied later at output)
    function sampleKeyColors(fr){
      const data=fr.img.data, SW=fr.w, SH=fr.h, cr=gifCrop(SW,SH), bc=barColor(fr), rgb=new Uint8Array(INDICES.length*3);
      const mode=document.getElementById('gifSample').value, N = mode==='center' ? 0 : 4;   // 0 = single center sample, else 5×5 grid (denser → catches thin strokes)
      const rot=gifRotRad(), cs=Math.cos(rot), sn=Math.sin(rot), ccx=cr.cx+cr.cw/2, ccy=cr.cy+cr.ch/2;   // rotate sampling around crop center
      for(let k=0;k<INDICES.length;k++){
        const c=keyCell(INDICES[k]); if(!c){ rgb[k*3]=rgb[k*3+1]=rgb[k*3+2]=0; continue; } const nx=c[0],ny=c[1],nw=c[2],nh=c[3];
        const sx=cr.cx+(nx-nw/2)*cr.cw, sy=cr.cy+(ny-nh/2)*cr.ch, sw=nw*cr.cw, sh=nh*cr.ch;
        const SR=[],SG=[],SB=[],SU=[],SV=[];                       // in-bounds samples of the patch
        for(let iy=0;iy<=N;iy++)for(let ix=0;ix<=N;ix++){
          const u=N?ix/N:0.5, v=N?iy/N:0.5; let fx=sx+sw*u, fy=sy+sh*v;
          if(rot){ const dx=fx-ccx, dy=fy-ccy; fx=ccx+dx*cs+dy*sn; fy=ccy-dx*sn+dy*cs; }   // rotate sampling grid → image appears rotated
          if(fx<0||fy<0||fx>=SW||fy>=SH) continue;
          const o=((fy|0)*SW+(fx|0))*4; SR.push(data[o]); SG.push(data[o+1]); SB.push(data[o+2]); SU.push(u); SV.push(v);
        }
        const t=k*3, n=SR.length; let R,G,B;
        if(!n){ rgb[t]=bc[0]; rgb[t+1]=bc[1]; rgb[t+2]=bc[2]; continue; }   // fully outside → bar color
        if(mode==='vivid'){                                        // most saturated pixel
          let bi=0,bs=-1; for(let i=0;i<n;i++){ const s=Math.max(SR[i],SG[i],SB[i])-Math.min(SR[i],SG[i],SB[i]); if(s>bs){bs=s;bi=i;} } R=SR[bi];G=SG[bi];B=SB[bi];
        } else if(mode==='bright'){                                 // brightest pixel — any bright stroke in the patch lights the key (legible text/logos)
          let bi=0,bl=-1; for(let i=0;i<n;i++){ const L=0.299*SR[i]+0.587*SG[i]+0.114*SB[i]; if(L>bl){bl=L;bi=i;} } R=SR[bi];G=SG[bi];B=SB[bi];
        } else if(mode==='standout'){                              // pixel furthest from the patch average (max local contrast)
          let mr=0,mg=0,mb=0; for(let i=0;i<n;i++){mr+=SR[i];mg+=SG[i];mb+=SB[i];} mr/=n;mg/=n;mb/=n;
          let bi=0,bd=-1; for(let i=0;i<n;i++){ const dr=SR[i]-mr,dg=SG[i]-mg,db=SB[i]-mb,d=dr*dr+dg*dg+db*db; if(d>bd){bd=d;bi=i;} } R=SR[bi];G=SG[bi];B=SB[bi];
        } else if(mode==='dominant'){                              // most common color (quantised to 4 levels/channel), members averaged
          const cnt={}; for(let i=0;i<n;i++){ const q=((SR[i]>>6)<<4)|((SG[i]>>6)<<2)|(SB[i]>>6); (cnt[q]||(cnt[q]=[])).push(i); }
          let best=null,bn=0; for(const q in cnt){ if(cnt[q].length>bn){bn=cnt[q].length;best=cnt[q];} }
          let r=0,g=0,b=0; for(const i of best){r+=SR[i];g+=SG[i];b+=SB[i];} R=r/best.length;G=g/best.length;B=b/best.length;
        } else if(mode==='gaussian'){                              // center-weighted average
          let r=0,g=0,b=0,w=0; for(let i=0;i<n;i++){ const du=SU[i]-0.5,dv=SV[i]-0.5,wt=Math.exp(-(du*du+dv*dv)*8); r+=SR[i]*wt;g+=SG[i]*wt;b+=SB[i]*wt;w+=wt; } R=r/w;G=g/w;B=b/w;
        } else {                                                   // average (area) + center
          let r=0,g=0,b=0; for(let i=0;i<n;i++){r+=SR[i];g+=SG[i];b+=SB[i];} R=r/n;G=g/n;B=b/n;
        }
        rgb[t]=R|0; rgb[t+1]=G|0; rgb[t+2]=B|0;
      }
      return rgb;
    }
    function resampleAll(){ for(const fr of gifFrames) fr.rgb=sampleKeyColors(fr); }
    function adjustRGB(r,g,b){                            // saturation + contrast + gamma + brightness (help the LEDs vs the monitor)
      const s=(+document.getElementById('gifSat').value)/100, c=(+document.getElementById('gifContrast').value)/100,
            gm=(+document.getElementById('gifGamma').value)/100, br=gifBri();
      return adjustRgb(r,g,b,s,c,gm,br);
    }
    function gifFlat(rgb){                                // -> flat [idx,r,g,b,...] for sendFrame
      const flat=new Array(INDICES.length*4);
      for(let k=0;k<INDICES.length;k++){ const t=k*3,o=k*4, c=adjustRGB(rgb[t],rgb[t+1],rgb[t+2]);
        flat[o]=INDICES[k]; flat[o+1]=c[0]; flat[o+2]=c[1]; flat[o+3]=c[2]; }
      return flat;
    }
    // keyboard-shaped preview: each key drawn at its physical rect, in its sampled color
    function drawKb(rgb){
      const cv=document.getElementById('gifKb'), ctx=cv.getContext('2d'), pad=4, W=cv.width-2*pad, H=cv.height-2*pad;
      ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,cv.width,cv.height);
      for(let k=0;k<INDICES.length;k++){ const q=keyCell(INDICES[k]); if(!q) continue; const t=k*3, c=adjustRGB(rgb[t],rgb[t+1],rgb[t+2]);
        ctx.fillStyle='rgb('+c[0]+','+c[1]+','+c[2]+')';
        ctx.fillRect(pad+(q[0]-q[2]/2)*W+0.75, pad+(q[1]-q[3]/2)*H+0.75, Math.max(1,q[2]*W-1.5), Math.max(1,q[3]*H-1.5)); }
    }
    // positioning canvas: the source frame (fit) with the keyboard crop-box overlaid; dims the cropped-out area
    function drawSrc(){
      const cv=document.getElementById('gifSrc'), ctx=cv.getContext('2d');
      ctx.fillStyle='#000'; ctx.fillRect(0,0,cv.width,cv.height);
      const fr=gifFrames[gifIdx]; if(!fr){ cv._map=null; return; }
      if(!srcTmp) srcTmp=document.createElement('canvas');
      srcTmp.width=fr.w; srcTmp.height=fr.h; srcTmp.getContext('2d').putImageData(fr.img,0,0);
      const sc=Math.min(cv.width/fr.w, cv.height/fr.h), dw=fr.w*sc, dh=fr.h*sc, ox=(cv.width-dw)/2, oy=(cv.height-dh)/2;
      ctx.drawImage(srcTmp, ox,oy,dw,dh);
      const cr=gifCrop(fr.w,fr.h), rx=ox+cr.cx*sc, ry=oy+cr.cy*sc, rw=cr.cw*sc, rh=cr.ch*sc, rot=gifRotRad();
      if(rot){                                                    // rotated: just outline the (rotated) sampled region
        ctx.save(); ctx.translate(rx+rw/2, ry+rh/2); ctx.rotate(-rot);
        ctx.strokeStyle='#58a6ff'; ctx.lineWidth=2; ctx.strokeRect(-rw/2,-rh/2,rw,rh); ctx.restore();
      } else {                                                    // axis-aligned: dim the cropped-out area + outline
        ctx.fillStyle='rgba(1,4,9,.6)';
        ctx.fillRect(ox,oy,dw,ry-oy); ctx.fillRect(ox,ry+rh,dw,oy+dh-(ry+rh));
        ctx.fillRect(ox,ry,rx-ox,rh); ctx.fillRect(rx+rw,ry,ox+dw-(rx+rw),rh);
        ctx.strokeStyle='#58a6ff'; ctx.lineWidth=2; ctx.strokeRect(rx,ry,rw,rh);
      }
      // subtle orientation arrow at the crop center (up = 0°, rotates with the angle)
      const acx=rx+rw/2, acy=ry+rh/2, al=Math.max(12,Math.min(rw,rh)*0.28);
      ctx.save(); ctx.translate(acx,acy); ctx.rotate(-rot);
      ctx.strokeStyle='rgba(88,166,255,.7)'; ctx.fillStyle='rgba(88,166,255,.7)'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(0,al/2); ctx.lineTo(0,-al/2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0,-al/2); ctx.lineTo(-al*0.24,-al*0.22); ctx.lineTo(al*0.24,-al*0.22); ctx.closePath(); ctx.fill();
      ctx.restore();
      cv._map={sc};
    }
    function refresh(){ if(!gifFrames.length) return; resampleAll(); drawSrc(); drawKb(gifFrames[gifIdx].rgb); }
    function pushFrame(frames, id, dw, dh, delayMs){      // border color (the "sampled" bar fill) + push in our frame format
      frames.push({img:id, w:dw, h:dh, delayMs, edge:edgeAvg(id.data,dw,dh), rgb:new Uint8Array(INDICES.length*3)});
    }
    async function decodeImage(blob){                      // GIF / WebP / APNG / static via ImageDecoder
      if(!window.ImageDecoder) throw new Error('ImageDecoder unsupported — use Chrome/Edge');
      const dec=new ImageDecoder({data:await blob.arrayBuffer(), type:blob.type||'image/gif'});
      await dec.tracks.ready;
      const track=dec.tracks.selectedTrack, tmp=document.createElement('canvas'), tctx=tmp.getContext('2d',{willReadFrequently:true}), frames=[];
      for(let i=0;;i++){
        let res; try{ res=await dec.decode({frameIndex:i}); }catch(err){ break; }
        const vf=res.image, vw=vf.displayWidth||vf.codedWidth, vh=vf.displayHeight||vf.codedHeight;
        const s=Math.min(1, MAXDIM/Math.max(vw,vh)), dw=Math.max(1,Math.round(vw*s)), dh=Math.max(1,Math.round(vh*s));
        tmp.width=dw; tmp.height=dh; tctx.clearRect(0,0,dw,dh); tctx.drawImage(vf,0,0,dw,dh);
        const dur=vf.duration; if(vf.close) vf.close();
        pushFrame(frames, tctx.getImageData(0,0,dw,dh), dw, dh, dur?Math.max(20,dur/1000):100);
        if(track.frameCount && i>=track.frameCount-1) break;
        if(i>=300){ log('frame cap reached (300) — truncating','dim'); break; }
      }
      return frames;
    }
    function decodeVideo(blob){                            // MP4 / WebM via <video> frame-seek (~12fps, capped)
      return new Promise((resolve,reject)=>{
        const v=document.createElement('video'); v.muted=true; v.playsInline=true; v.preload='auto'; v.src=URL.createObjectURL(blob);
        const FPS=12, CAP=300, frames=[];
        v.onloadedmetadata=()=>{
          const dur=v.duration; if(!isFinite(dur)||dur<=0){ URL.revokeObjectURL(v.src); reject(new Error('video has no seekable duration')); return; }
          const vw=v.videoWidth, vh=v.videoHeight, s=Math.min(1,MAXDIM/Math.max(vw,vh)), dw=Math.max(1,vw*s|0), dh=Math.max(1,vh*s|0);
          const c=document.createElement('canvas'); c.width=dw; c.height=dh; const cx=c.getContext('2d',{willReadFrequently:true});
          const n=Math.min(CAP, Math.max(1, Math.round(dur*FPS))), step=dur/n; let i=0;
          const next=()=>{ if(i>=n){ URL.revokeObjectURL(v.src); resolve(frames); return; } v.currentTime=Math.min(dur-1e-3, i*step); };
          v.onseeked=()=>{ try{ cx.drawImage(v,0,0,dw,dh); pushFrame(frames, cx.getImageData(0,0,dw,dh), dw, dh, Math.round(1000/FPS)); }catch(_){ } i++; next(); };
          v.onerror=()=>{ URL.revokeObjectURL(v.src); reject(new Error('video decode error')); };
          next();
        };
        v.onerror=()=>reject(new Error('cannot load video'));
      });
    }
    function installFrames(frames, label){
      gifFrames=frames; gifIdx=0; czoom=1; cpanX=cpanY=0; document.getElementById('gifZoom').value=100;
      refresh();
      document.getElementById('gifInfo').textContent=label+': '+frames.length+' frame(s), source '+frames[0].w+'×'+frames[0].h+' → 104 keys';
      document.getElementById('gifPlay').disabled=!hasDevice();
      log('loaded '+frames.length+' frame(s): '+label,'ok');
    }
    async function loadMedia(blob, name, save){           // save (default true) → persist to the library
      if(save===undefined) save=true;
      document.getElementById('gifPlay').disabled=true; log('decoding '+name+'…','dim');
      try{
        const frames = /^video\//.test(blob.type) ? await decodeVideo(blob) : await decodeImage(blob);
        if(!frames.length) throw new Error('no frames decoded');
        installFrames(frames, name);
        currentSource={kind:'single', blob, name};               // ★ Add to Library saves this
      }catch(e){ log('media load failed: '+e.message,'err'); }
    }
    async function loadSequence(files){                    // a folder/selection of images → one frame each, in filename order
      const arr=[...files].filter(f=>/^image\//.test(f.type)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
      if(!arr.length){ log('no image files selected','err'); return; }
      log('decoding '+arr.length+' frame files…','dim');
      const tmp=document.createElement('canvas'), tctx=tmp.getContext('2d',{willReadFrequently:true}), frames=[];
      for(const f of arr){ const bmp=await createImageBitmap(f).catch(()=>null); if(!bmp) continue;
        const s=Math.min(1,MAXDIM/Math.max(bmp.width,bmp.height)), dw=Math.max(1,bmp.width*s|0), dh=Math.max(1,bmp.height*s|0);
        tmp.width=dw; tmp.height=dh; tctx.clearRect(0,0,dw,dh); tctx.drawImage(bmp,0,0,dw,dh); if(bmp.close) bmp.close();
        pushFrame(frames, tctx.getImageData(0,0,dw,dh), dw, dh, 100); }
      if(!frames.length){ log('no frames decoded','err'); return; }
      const label=arr.length+'-image sequence';
      installFrames(frames, label);
      currentSource={kind:'seq', blobs:arr, name:label};
    }
    async function gifTick(){
      if(!gifPlaying||!gifFrames.length) return;
      const fr=gifFrames[gifIdx]; let delay=Math.max(1000/fpsCap(), (fr.delayMs|0)/gifSpeed());
      if(!inFlight){ inFlight=true; const ok=await sendFrame(gifFlat(fr.rgb)); inFlight=false;
        if(ok){ if(!document.hidden && !gifDrag){ drawKb(fr.rgb); drawSrc(); }                       // while dragging the crop, let the drag handler own the canvas
          if(!gifDrag && !document.getElementById('gifStatic').checked) gifIdx=(gifIdx+1)%gifFrames.length; } }   // freeze frame during drag / when static
      else delay=20;                                            // device busy — retry soon without advancing
      if(gifPlaying){ if(tickW) tickW.postMessage({delay}); else setTimeout(gifTick, delay); }   // worker timer survives background-tab throttling
    }
    if(tickW) tickW.onmessage=gifTick;
    function gifPlay(){
      if(!hasDevice()||!gifFrames.length||gifPlaying) return;
      gifPrevLayers=isRunning(); clearObActive();               // remember what GIF playback replaced (and it overrides any firmware effect)
      if(isRunning()) stopLayers();                             // GIF mode replaces the reactive pulse
      gifPlaying=true; gifIdx=0;
      document.getElementById('gifPlay').disabled=true; document.getElementById('gifStop').disabled=false;
      refreshButtons();   // GIF now owns the board → drive toggle disables, pill shows WebHID
      log('GIF playback started ('+gifFrames.length+' frames)','ok'); gifTick();
    }
    async function gifStopFn(){
      if(!gifPlaying) return;
      gifPlaying=false;
      if(tickW) tickW.postMessage({stop:true});
      document.getElementById('gifPlay').disabled=!hasDevice(); document.getElementById('gifStop').disabled=true;
      refreshButtons();   // GIF released the board → drive toggle reflects layers/daemon state again
      const off=[]; INDICES.forEach(i=>off.push(i,0,0,0)); await sendFrame(off);
      log('GIF playback stopped (board cleared)','dim');
    }
    // drag-to-pan on the positioning canvas (image follows the cursor; full resample on release)
    let gifDrag=false, gifLast=null;
    (function(){
      const cv=document.getElementById('gifSrc');
      cv.addEventListener('pointerdown',e=>{ if(!gifFrames.length)return; gifDrag=true; gifLast={x:e.clientX,y:e.clientY}; cv.setPointerCapture(e.pointerId); });
      cv.addEventListener('pointermove',e=>{ if(!gifDrag||!cv._map)return;
        cpanX+=(e.clientX-gifLast.x)/cv._map.sc; cpanY+=(e.clientY-gifLast.y)/cv._map.sc; gifLast={x:e.clientX,y:e.clientY};
        drawSrc(); const fr=gifFrames[gifIdx]; if(fr){ fr.rgb=sampleKeyColors(fr); drawKb(fr.rgb); } });
      cv.addEventListener('pointerup',()=>{ if(gifDrag){ gifDrag=false; resampleAll(); } });
    })();
    document.getElementById('gifFile').addEventListener('change',e=>{ if(e.target.files[0]) loadMedia(e.target.files[0], e.target.files[0].name); });
    function refreshLib(){ const el=document.getElementById('gifLib'); if(el && el.style.display!=='none' && window.TH108Media && TH108Media.available) TH108Media.mountPicker(el, it=>{ if(it.kind==='seq'&&it.blobs) loadSequence(it.blobs); else loadMedia(it.blob, it.name, false); }); }
    document.getElementById('gifLibBtn').addEventListener('click',()=>{ const el=document.getElementById('gifLib'); el.style.display = el.style.display==='none'?'block':'none'; refreshLib(); });
    document.getElementById('gifSeqBtn').addEventListener('click',()=>document.getElementById('gifSeq').click());
    document.getElementById('gifSeq').addEventListener('change',e=>{ if(e.target.files.length) loadSequence(e.target.files); });
    document.getElementById('gifFolderBtn').addEventListener('click',()=>document.getElementById('gifFolder').click());
    document.getElementById('gifFolder').addEventListener('change',e=>{ if(e.target.files.length) loadSequence(e.target.files); });
    document.getElementById('gifSave').addEventListener('click',async()=>{
      if(!currentSource){ log('nothing loaded to save','dim'); return; }
      if(!(window.TH108Media&&TH108Media.available)){ log('library unavailable — open via http://localhost:8123','err'); return; }
      try{ if(currentSource.kind==='seq') await TH108Media.addSequence(currentSource.blobs,currentSource.name); else await TH108Media.add(currentSource.blob,currentSource.name); refreshLib(); log('★ added “'+currentSource.name+'” to library','ok'); }
      catch(e){ log('add to library failed: '+e.message,'err'); }
    });
    document.getElementById('gifPlay').addEventListener('click',gifPlay);
    document.getElementById('gifStop').addEventListener('click',async()=>{   // Stop GIF returns to whatever it replaced: layers if they were running, else dark
      const back=gifPrevLayers; gifPrevLayers=false;
      await gifStopFn();
      if(back && hasDevice() && !isRunning()){ startLayers(); log('layers resumed (GIF replaced them)','ok'); }
    });
    document.getElementById('gifZoom').addEventListener('input',e=>{ snap(e.target,100,10); czoom=(+e.target.value)/100; refresh(); });
    document.getElementById('gifReset').addEventListener('click',()=>{ czoom=1; cpanX=cpanY=0; document.getElementById('gifZoom').value=100; refresh(); });
    document.getElementById('gifBri').addEventListener('input',()=>{ if(gifFrames[gifIdx]) drawKb(gifFrames[gifIdx].rgb); });
    // add a live value readout + reset-to-default button to each GIF slider
    function enhanceSlider(id,def,fmt){
      const el=document.getElementById(id); if(!el) return; const host=el.closest('.sl')||el.parentElement;
      const val=document.createElement('span'); val.id=id+'V'; val.style.cssText='font-size:11px;color:#58a6ff;min-width:30px;text-align:right';
      const upd=()=>{ val.textContent=fmt(+el.value); }; el.addEventListener('input',upd); upd();
      const rb=document.createElement('button'); rb.type='button'; rb.textContent='↺'; rb.title='reset to default'; rb.style.cssText='padding:0 5px;font-size:12px;margin-left:2px';
      rb.addEventListener('click',e=>{ e.preventDefault(); el.value=def; flashSnap(el); el.dispatchEvent(new Event('input',{bubbles:true})); });
      host.appendChild(val); host.appendChild(rb);
    }
    [['gifZoom',100,v=>v+'%'],['gifRot',0,v=>v+'°'],['gifSat',170,v=>v+'%'],['gifContrast',100,v=>v+'%'],['gifGamma',180,v=>(v/100).toFixed(2)],['gifSpeed',100,v=>(v/100).toFixed(1)+'×'],['gifFps',60,v=>v+'fps'],['gifBri',100,v=>v+'%']].forEach(a=>enhanceSlider(a[0],a[1],a[2]));
    document.getElementById('gifFps').addEventListener('input',e=>{ snap(e.target,30,3); const n=document.getElementById('gifFpsNum'); if(n) n.value=e.target.value; });   // snap detent at 30fps
    // gifFps range <-> number input, synced (min 5 max 60); both drive fpsCap()
    (function(){ const fps=document.getElementById('gifFps'), fn=document.getElementById('gifFpsNum');
      const set=v=>{ v=Math.max(5,Math.min(60,Math.round(v||5))); fps.value=v; fn.value=v; };
      fps.addEventListener('input',e=>{ set(+e.target.value); });
      fn.addEventListener('input',e=>{ set(+e.target.value); fps.dispatchEvent(new Event('input',{bubbles:true})); });
    })();
    document.getElementById('gifSat').addEventListener('input',e=>{ snap(e.target,170,8); if(gifFrames[gifIdx]) drawKb(gifFrames[gifIdx].rgb); });   // saturation/brightness apply at output → preview only
    document.getElementById('gifBars').addEventListener('change',refresh);                                                      // bar fill affects out-of-bounds keys → resample
    document.getElementById('gifSample').addEventListener('change',refresh);                                                    // sampling strategy → resample
    document.getElementById('gifMap').addEventListener('change',refresh);                                                       // physical vs uniform-grid mapping → resample
    document.getElementById('gifBarColor').addEventListener('input',refresh);
    document.getElementById('gifContrast').addEventListener('input',e=>{ snap(e.target,100,8); if(gifFrames[gifIdx]) drawKb(gifFrames[gifIdx].rgb); });
    document.getElementById('gifGamma').addEventListener('input',e=>{ snap(e.target,180,8); if(gifFrames[gifIdx]) drawKb(gifFrames[gifIdx].rgb); });
    document.getElementById('gifRot').addEventListener('input',e=>{ snapMul(e.target,45,6); const v=document.getElementById('gifRotV'); if(v) v.textContent=(+e.target.value)+'°'; refresh(); });   // rotate → resample + redraw, snaps every 45°; re-sync the label AFTER the snap (enhanceSlider's display listener ran first, on the un-snapped value)
    (function(){ const sr=document.getElementById('gifRotRange'); for(let d=45;d<360;d+=45){ const i=document.createElement('i'); i.className='tick'; i.style.left='calc(7px + (100% - 14px)*'+(d/360)+')'; sr.appendChild(i); } })();   // ticks at 45..315 only — 0/360 are the redundant endpoints (user request)
    // load by URL (CORS-permitting) and from the clipboard (paste button + Ctrl+V anywhere on the page)
    async function loadFromUrl(url){
      if(!url) return;
      log('fetching '+url+'…','dim');
      try{ const r=await fetch(url,{mode:'cors'}); if(!r.ok) throw new Error('HTTP '+r.status);
        const blob=await r.blob(); if(!/^image\//.test(blob.type)) throw new Error('not an image ('+(blob.type||'unknown type')+')');
        await loadMedia(blob,(url.split('/').pop()||'url-image').split('?')[0]);
      }catch(e){ log('URL load failed: '+e.message+' — the host may block cross-origin fetch (CORS)','err'); }
    }
    document.getElementById('gifUrlLoad').addEventListener('click',()=>loadFromUrl(document.getElementById('gifUrl').value.trim()));
    document.getElementById('gifUrl').addEventListener('keydown',e=>{ if(e.key==='Enter') loadFromUrl(e.target.value.trim()); });
    document.getElementById('gifPaste').addEventListener('click',async()=>{
      try{ const items=await navigator.clipboard.read();
        for(const it of items){ const ty=it.types.find(t=>t.startsWith('image/')); if(ty) return loadMedia(await it.getType(ty),'pasted-image'); }
        log('no image on the clipboard','dim');
      }catch(e){ log('clipboard read failed: '+e.message+' — copy the image again, or just press Ctrl+V on the page','err'); }
    });
    window.addEventListener('paste',e=>{
      const items=e.clipboardData&&e.clipboardData.items; if(!items) return;
      for(const it of items){ if(it.type&&it.type.startsWith('image/')){ const b=it.getAsFile(); if(b){ e.preventDefault(); loadMedia(b,'pasted-image'); return; } } }
    });

    return {
      play: gifPlay,
      stop: gifStopFn,                                       // async — clears the board; awaitable (applyOnboard does)
      onDeviceBound(){ if(gifFrames.length) document.getElementById('gifPlay').disabled=false; },
      get playing(){ return gifPlaying; },
      get framesLoaded(){ return gifFrames.length>0; }
    };
  }

  return { create, adjustRgb, edgeAvg, computeCrop };
});
