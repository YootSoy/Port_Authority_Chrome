(() => {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("content/page-hook.js");
  script.async = false;

  (document.head || document.documentElement).appendChild(script);
  script.remove();

  window.addEventListener(
    "message",
    (event) => {
      if (event.source !== window) return;

      const data = event.data;
      if (!data || data.source !== "PORT_AUTHORITY_PREWARM") return;
      if (typeof data.host !== "string" || !data.host) return;

      chrome.runtime.sendMessage({
        type: "prewarmHost",
        host: data.host
      }).catch(() => {});
    },
    false
  );
})();
