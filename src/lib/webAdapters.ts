// Per-site "adapters": how to drop a prompt into a web AI's input box and
// submit it. These selectors are the brittle part — when a site redesigns its
// composer, fix it HERE and nowhere else. `buildInjectJs(url, text)` returns a
// self-contained JS string that the Rust side evals inside that tab's webview.

type Adapter = {
  /** matched against the tab's hostname */
  host: RegExp;
  /** prompt input: textarea, <input>, or a contenteditable element */
  input: string;
  /** send button; if it can't be found we fall back to pressing Enter */
  send?: string;
};

const ADAPTERS: Adapter[] = [
  {
    host: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/,
    input: "#prompt-textarea, textarea[data-id], textarea",
    send: 'button[data-testid="send-button"], button[aria-label*="Send" i]',
  },
  {
    host: /(^|\.)claude\.ai$/,
    input: 'div[contenteditable="true"], textarea',
    send: 'button[aria-label*="Send" i]',
  },
  {
    host: /(^|\.)gemini\.google\.com$/,
    input: '.ql-editor[contenteditable="true"], div[contenteditable="true"], textarea',
    send: 'button[aria-label*="Send" i], button.send-button',
  },
];

/** Generic fallback when no site adapter matches. */
const GENERIC: Adapter = { host: /.*/, input: 'textarea, [contenteditable="true"]' };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function adapterFor(url: string): Adapter {
  const host = hostOf(url);
  return ADAPTERS.find((a) => a.host.test(host)) ?? GENERIC;
}

/** Sites that refuse to render inside an embedded webview (bot protection), so
 *  they're opened in a real Chrome (via CDP) instead. */
const EMBED_BLOCKED = /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/;
export const embedBlocked = (url: string): boolean => EMBED_BLOCKED.test(hostOf(url));

/** True if a URL is a known AI chat site we have an adapter for (used to pick
 *  which CDP browser tabs a broadcast should target). */
export const isKnownChatSite = (url: string): boolean => {
  const host = hostOf(url);
  return ADAPTERS.some((a) => a.host.test(host));
};

export const knownSites = [
  { name: "ChatGPT", url: "https://chatgpt.com/" },
  { name: "Claude", url: "https://claude.ai/new" },
  { name: "Gemini", url: "https://gemini.google.com/app" },
];

/**
 * Build a self-contained injector. It fills the composer (handling React's
 * controlled <textarea>/<input> via the native value setter, and contenteditable
 * via insertText) then clicks send — or presses Enter if no send button.
 */
export function buildInjectJs(url: string, text: string): string {
  const a = adapterFor(url);
  const T = JSON.stringify(text);
  const INPUT = JSON.stringify(a.input);
  const SEND = JSON.stringify(a.send ?? "");
  return `(function(){
  try {
    var text = ${T};
    var input = document.querySelector(${INPUT});
    if (!input) { input = document.querySelector('textarea, [contenteditable="true"]'); }
    if (!input) { return; }
    input.focus();
    var tag = input.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      var proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      setter.set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable composer
      var sel = window.getSelection();
      sel.removeAllRanges();
      var range = document.createRange();
      range.selectNodeContents(input);
      sel.addRange(range);
      if (!document.execCommand('insertText', false, text)) {
        input.textContent = text;
      }
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    var sendSel = ${SEND};
    setTimeout(function(){
      var btn = sendSel ? document.querySelector(sendSel) : null;
      if (btn && !btn.disabled) { btn.click(); return; }
      ['keydown','keypress','keyup'].forEach(function(type){
        input.dispatchEvent(new KeyboardEvent(type, { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true }));
      });
    }, 80);
  } catch (e) { /* page not ready / selector changed */ }
})();`;
}
