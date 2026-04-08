(() => {
  const seen = new Set();

  function normalizeHost(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      return String(url.hostname || "").trim().toLowerCase();
    } catch {
      return "";
    }
  }

  function sendHost(rawUrl) {
    const host = normalizeHost(rawUrl);
    if (!host || seen.has(host)) return;

    seen.add(host);

    window.postMessage(
      {
        source: "PORT_AUTHORITY_PREWARM",
        host
      },
      "*"
    );
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function patchedFetch(input, init) {
      try {
        if (typeof input === "string") {
          sendHost(input);
        } else if (input && typeof input.url === "string") {
          sendHost(input.url);
        }
      } catch {}
      return originalFetch.apply(this, arguments);
    };
  }

  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    try {
      sendHost(url);
    } catch {}
    return originalXHROpen.apply(this, arguments);
  };

  const OriginalWebSocket = window.WebSocket;
  if (typeof OriginalWebSocket === "function") {
    function PatchedWebSocket(url, protocols) {
      sendHost(url);
      return protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
    }

    PatchedWebSocket.prototype = OriginalWebSocket.prototype;
    Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);
    window.WebSocket = PatchedWebSocket;
  }

  const OriginalEventSource = window.EventSource;
  if (typeof OriginalEventSource === "function") {
    function PatchedEventSource(url, config) {
      sendHost(url);
      return config === undefined
        ? new OriginalEventSource(url)
        : new OriginalEventSource(url, config);
    }

    PatchedEventSource.prototype = OriginalEventSource.prototype;
    Object.setPrototypeOf(PatchedEventSource, OriginalEventSource);
    window.EventSource = PatchedEventSource;
  }
})();
