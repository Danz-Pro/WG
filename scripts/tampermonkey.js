// ==UserScript==
// @name         WG
// @namespace    https://github.com/Danz-Pro/WG
// @version      2.0
// @description  WG v2 - Wayground Game Helper | VVIP UI, bulletproof answer detection
// @author       Danz-Pro
// @match        https://wayground.com/*
// @match        https://*.wayground.com/*
// @icon         https://cf.quizizz.com/img/wayground/brand/favicon/favicon-32x32.ico
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Danz-Pro/WG/main/dist/bundle.js
// @downloadURL  https://raw.githubusercontent.com/Danz-Pro/WG/main/dist/bundle.js
// ==/UserScript==

(function() {
  'use strict';

  const waitForVue = () => {
    return new Promise((resolve) => {
      const check = () => {
        const root = document.querySelector('#root') || document.querySelector('#app');
        if (root && root.__vue_app__) {
          console.log('[WG] Vue 3 app detected, loading...');
          resolve(true);
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  };

  const load = async () => {
    await waitForVue();
    try {
      const resp = await fetch('https://raw.githubusercontent.com/Danz-Pro/WG/main/dist/bundle.js');
      const code = await resp.text();
      eval(code);
    } catch (err) {
      console.error('[WG] Failed to load:', err);
    }
  };

  load();
})();
