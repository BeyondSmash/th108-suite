// th108-audio-synth.js — deterministic synthetic audio features for the music layer.
// Stand-in for the real capture sidecar (Plan 1b): same {bands,level,beat,centroid} contract,
// so the visualizer can be built + tuned + hardware-glanced with zero native code. Pure: sample(t)
// depends only on t, so renders are reproducible and unit-testable.
(function(root){
  'use strict';
  const NB = 32, BEAT_PERIOD = 0.5;   // ~120 bpm kick
  function createSynth(){
    return {
      sample(t){
        const bands = new Float32Array(NB);
        for(let i=0;i<NB;i++){
          const f = i/(NB-1);                                   // 0 bass … 1 treble
          const slow = 0.5 + 0.5*Math.sin(t*1.3 - i*0.5);
          const fast = 0.5 + 0.5*Math.sin(t*5.0 + i*1.7);
          let m = (1-f)*0.9*slow + 0.35*fast*(0.3+0.7*f);        // bass louder
          bands[i] = Math.max(0, Math.min(1, m));
        }
        const ph = (t % BEAT_PERIOD)/BEAT_PERIOD;
        const beat = Math.exp(-ph*7);                            // sharp attack, decay
        let level=0; for(let i=0;i<NB;i++) level+=bands[i]; level/=NB;
        const centroid = 0.5 + 0.5*Math.sin(t*0.4);
        // stereo: pan the energy left↔right over ~10s so the 'stereo' bars layout visibly sweeps in the preview
        const pan = 0.5 + 0.5*Math.sin(t*0.6);                   // 0 = hard left … 1 = hard right
        const bandsL = new Float32Array(NB), bandsR = new Float32Array(NB);
        for(let i=0;i<NB;i++){ bandsL[i] = bands[i]*(1 - 0.85*pan); bandsR[i] = bands[i]*(0.15 + 0.85*pan); }
        return { bands, bandsL, bandsR, level, beat, centroid };
      },
    };
  }
  const api = { createSynth };
  if(typeof module!=='undefined' && module.exports) module.exports = api;
  else root.TH108AudioSynth = api;
})(typeof window!=='undefined' ? window : globalThis);
