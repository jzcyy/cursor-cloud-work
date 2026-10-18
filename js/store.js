(function () {
  "use strict";

  const KEY = "suibu.v1";

  function load() {
    const Logic = globalThis.SuibuLogic;
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return Logic.seedState(Date.now());
      return Logic.normalizeState(JSON.parse(raw), Date.now());
    } catch (error) {
      return Logic.seedState(Date.now());
    }
  }

  function save(state) {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  globalThis.SuibuStore = { KEY, load, save };
})();
