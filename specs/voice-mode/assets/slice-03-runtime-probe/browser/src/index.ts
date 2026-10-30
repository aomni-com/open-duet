import { installRemoteController } from './remote-controller'
import { BrowserRoomProbe } from './room-probe'

declare global {
  interface Window {
    voiceSlice03Probe: BrowserRoomProbe
  }
}

document.title = 'Duet Voice runtime probe'
document.head.insertAdjacentHTML(
  'beforeend',
  `<style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #11100f; color: #f5f1ea; }
    main { box-sizing: border-box; width: min(38rem, calc(100vw - 2rem)); padding: 2rem; border: 1px solid #3d3934; border-radius: 1rem; background: #1b1917; box-shadow: 0 1.5rem 4rem #0008; }
    p { margin: 0 0 .75rem; color: #aaa39a; font-size: .875rem; letter-spacing: .04em; text-transform: uppercase; }
    h1 { margin: 0 0 1.5rem; font-size: clamp(1.5rem, 5vw, 2rem); line-height: 1.1; }
    output { display: block; min-height: 1.5rem; padding: 1.25rem; border: 1px solid #3b3732; border-radius: .75rem; background: #25221f; color: #f2c879; font-size: 1.125rem; font-weight: 600; }
    output[data-state="ready"] { border-color: #49644d; background: #202922; color: #bde6c2; }
    output[data-state="error"] { border-color: #714b47; background: #2e201e; color: #f0b7ae; }
    button { margin-top: 1rem; width: 100%; padding: 1rem; border: 0; border-radius: .75rem; background: #f2c879; color: #1b1917; font: inherit; font-weight: 700; }
    button:disabled { opacity: .6; }
    button[data-state="ready"] { background: #49644d; color: #eef8ef; opacity: 1; }
  </style>`,
)
document.body.innerHTML = `<main><p>Slice 03 · Voice mode</p><h1>Runtime evidence probe</h1><output id="voice-probe-caption" aria-live="polite">Waiting for runtime event</output></main>`
const caption = document.querySelector<HTMLOutputElement>('#voice-probe-caption')
if (!caption) throw new Error('probe caption surface was not created')
window.voiceSlice03Probe = new BrowserRoomProbe(caption)
installRemoteController(window.voiceSlice03Probe, caption)
