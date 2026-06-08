// TH108 V2 PRO key map (captured from the device) + uiohook bridge.
// KEYMAP: KeyboardEvent.code -> LED index.   INDICES: every LED index (for the background).
// KEYMAP/INDICES are the canonical capture and now live in th108-engine.js (single source);
// re-export them here so the daemon and engine never drift.
const { KEYMAP, INDICES } = require('../th108-engine.js');

// uiohook-napi UiohookKey property name -> KeyboardEvent.code.
// (Property names taken from uiohook-napi's UiohookKey export; values resolved at runtime so
//  whatever the lib actually defines is used. Anything missing is caught by DISCOVER mode.)
const UIOHOOK_TO_CODE = {
  Escape:"Escape",
  F1:"F1",F2:"F2",F3:"F3",F4:"F4",F5:"F5",F6:"F6",F7:"F7",F8:"F8",F9:"F9",F10:"F10",F11:"F11",F12:"F12",
  PrintScreen:"PrintScreen",ScrollLock:"ScrollLock",Pause:"Pause",
  Backquote:"Backquote",
  1:"Digit1",2:"Digit2",3:"Digit3",4:"Digit4",5:"Digit5",6:"Digit6",7:"Digit7",8:"Digit8",9:"Digit9",0:"Digit0",
  Minus:"Minus",Equal:"Equal",Backspace:"Backspace",
  Insert:"Insert",Home:"Home",PageUp:"PageUp",
  Tab:"Tab",
  Q:"KeyQ",W:"KeyW",E:"KeyE",R:"KeyR",T:"KeyT",Y:"KeyY",U:"KeyU",I:"KeyI",O:"KeyO",P:"KeyP",
  BracketLeft:"BracketLeft",BracketRight:"BracketRight",Backslash:"Backslash",
  Delete:"Delete",End:"End",PageDown:"PageDown",
  CapsLock:"CapsLock",
  A:"KeyA",S:"KeyS",D:"KeyD",F:"KeyF",G:"KeyG",H:"KeyH",J:"KeyJ",K:"KeyK",L:"KeyL",
  Semicolon:"Semicolon",Quote:"Quote",Enter:"Enter",
  Shift:"ShiftLeft",ShiftRight:"ShiftRight",
  Z:"KeyZ",X:"KeyX",C:"KeyC",V:"KeyV",B:"KeyB",N:"KeyN",M:"KeyM",
  Comma:"Comma",Period:"Period",Slash:"Slash",
  ArrowUp:"ArrowUp",ArrowDown:"ArrowDown",ArrowLeft:"ArrowLeft",ArrowRight:"ArrowRight",
  Ctrl:"ControlLeft",CtrlRight:"ControlRight",
  Meta:"MetaLeft",MetaRight:"MetaRight",
  Alt:"AltLeft",AltRight:"AltRight",
  Space:"Space",
  NumLock:"NumLock",
  NumpadDivide:"NumpadDivide",NumpadMultiply:"NumpadMultiply",NumpadSubtract:"NumpadSubtract",
  NumpadAdd:"NumpadAdd",NumpadEnter:"NumpadEnter",NumpadDecimal:"NumpadDecimal",
  Numpad0:"Numpad0",Numpad1:"Numpad1",Numpad2:"Numpad2",Numpad3:"Numpad3",Numpad4:"Numpad4",
  Numpad5:"Numpad5",Numpad6:"Numpad6",Numpad7:"Numpad7",Numpad8:"Numpad8",Numpad9:"Numpad9"
};

module.exports = { KEYMAP, INDICES, UIOHOOK_TO_CODE };
