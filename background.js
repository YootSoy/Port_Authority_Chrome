import { browser } from "./global/webext.js";
import {
  getItemFromLocal,
  setItemInLocal,
  modifyItemInLocal,
  addBlockedPortToHost,
  addBlockedTrackingHost,
  increaseBadge
} from "./global/BrowserStorageManager.js";
import { updateBadges } from "./global/browserActions.js";

const RULE_IDS = {
  LOCAL: 1,
  DIRECT_ONLINE_METRIX: 2,
  LEARNED_START: 10000
};

const STORAGE_KEYS = {
  DNS_CACHE: "dns_alias_cache_v1",
  LEARNED_RULES: "learned_alias_rules_v1",
  NEXT_RULE_ID: "next_dynamic_rule_id_v1"
};

const BLOCKED_CNAME_SUFFIXES = [
  "online-metrix.net"
];

const REQUEST_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "script",
  "xmlhttprequest",
  "image",
  "media",
  "font",
  "ping",
  "object",
  "websocket",
  "other"
];

const LOCAL_TARGET_REGEX =
  "^(https?|wss?|ftps?|ftp):\\/\\/" +
  "(" +
    "localhost" +
    "|0\\.0\\.0\\.0" +
    "|127(?:\\.\\d{1,3}){3}" +
    "|10(?:\\.\\d{1,3}){3}" +
    "|172\\.(?:1[6-9]|2\\d|3[0-1])(?:\\.\\d{1,3}){2}" +
    "|192\\.168(?:\\.\\d{1,3}){2}" +
    "|169\\.254(?:\\.\\d{1,3}){2}" +
  ")" +
  "(?::\\d+)?(?:\\/|$)";

const DIRECT_ONLINE_METRIX_REGEX =
  "^https?:\\/\\/([^\\/]+\\.)?online-metrix\\.net(?::\\d+)?(?:\\/|$)";

const DOH_TIMEOUT_MS = 3500;
const MIN_CACHE_TTL_SECONDS = 300;
const MAX_CACHE_TTL_SECONDS = 86400;
const MAX_CNAME_DEPTH = 8;

const pendingLookups = new Map();

function normalizeHost(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
}

function clampTTL(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3600;
  return Math.max(MIN_CACHE_TTL_SECONDS, Math.min(MAX_CACHE_TTL_SECONDS, Math.floor(n)));
}

function normalizeAllowEntry(value) {
  if (!value) return null;

  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;

  try {
    const parsed = raw.includes("://")
      ? new URL(raw)
      : new URL(`https://${raw}`);
    return normalizeHost(parsed.hostname);
  } catch {
    return normalizeHost(raw.replace(/:\d+$/, ""));
  }
}

function normalizeAllowList(values) {
  return [...new Set((values || []).map(normalizeAllowEntry).filter(Boolean))];
}

function getInitiatorHost(initiator) {
  try {
    if (!initiator || initiator === "null") return "";
    return normalizeHost(new URL(initiator).hostname);
  } catch {
    return "";
  }
}

function looksSameSiteEnough(a, b) {
  const left = normalizeHost(a);
  const right = normalizeHost(b);
  if (!left || !right) return false;
  return (
    left === right ||
    left.endsWith(`.${right}`) ||
    right.endsWith(`.${left}`)
  );
}

function isLocalAddress(host) {
  const h = normalizeHost(host);
  return (
    h === "localhost" ||
    h === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(h) ||
    /^10(?:\.\d{1,3}){3}$/.test(h) ||
    /^172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(h) ||
    /^192\.168(?:\.\d{1,3}){2}$/.test(h) ||
    /^169\.254(?:\.\d{1,3}){2}$/.test(h)
  );
}

function matchedBlockedSuffix(host) {
  const h = normalizeHost(host);
  for (const suffix of BLOCKED_CNAME_SUFFIXES) {
    if (h === suffix || h.endsWith(`.${suffix}`)) {
      return suffix;
    }
  }
  return null;
}

function buildLocalRule(allowList) {
  return {
    id: RULE_IDS.LOCAL,
    priority: 1,
    action: { type: "block" },
    condition: {
      regexFilter: LOCAL_TARGET_REGEX,
      resourceTypes: REQUEST_RESOURCE_TYPES,
      domainType: "thirdParty",
      ...(allowList.length ? { excludedInitiatorDomains: allowList } : {})
    }
  };
}

function buildDirectOnlineMetrixRule(allowList) {
  return {
    id: RULE_IDS.DIRECT_ONLINE_METRIX,
    priority: 1,
    action: { type: "block" },
    condition: {
      regexFilter: DIRECT_ONLINE_METRIX_REGEX,
      resourceTypes: REQUEST_RESOURCE_TYPES,
      domainType: "thirdParty",
      ...(allowList.length ? { excludedInitiatorDomains: allowList } : {})
    }
  };
}

function buildLearnedAliasRule(host, ruleId, allowList) {
  return {
    id: ruleId,
    priority: 1,
    action: { type: "block" },
    condition: {
      requestDomains: [host],
      resourceTypes: REQUEST_RESOURCE_TYPES,
      domainType: "thirdParty",
      ...(allowList.length ? { excludedInitiatorDomains: allowList } : {})
    }
  };
}

async function fetchDohJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/dns-json" },
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`DoH HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function queryCname(hostname) {
  const host = normalizeHost(hostname);
  const encoded = encodeURIComponent(host);

  const providers = [
    `https://dns.google/resolve?name=${encoded}&type=CNAME`,
    `https://cloudflare-dns.com/dns-query?name=${encoded}&type=CNAME`
  ];

  let lastError = null;

  for (const url of providers) {
    try {
      const json = await fetchDohJson(url);
      const answers = Array.isArray(json.Answer) ? json.Answer : [];
      const cname = answers.find((record) => Number(record.type) === 5);

      if (!cname) {
        return {
          target: null,
          ttl: 3600
        };
      }

      return {
        target: normalizeHost(cname.data),
        ttl: clampTTL(cname.TTL)
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No DoH provider succeeded");
}

async function resolveCnameChain(hostname) {
  const host = normalizeHost(hostname);
  const seen = new Set();
  const chain = [];
  let current = host;
  let minTTL = MAX_CACHE_TTL_SECONDS;

  while (current && !seen.has(current) && chain.length < MAX_CNAME_DEPTH) {
    seen.add(current);

    const { target, ttl } = await queryCname(current);
    minTTL = Math.min(minTTL, clampTTL(ttl));

    if (!target) break;

    chain.push(target);
    current = target;
  }

  const allHosts = [host, ...chain];
  const matchedSuffix =
    allHosts.map(matchedBlockedSuffix).find(Boolean) || null;

  return {
    host,
    chain,
    terminal: current,
    matchedSuffix,
    ttl: clampTTL(minTTL === MAX_CACHE_TTL_SECONDS ? 3600 : minTTL)
  };
}

async function getAllowList() {
  return normalizeAllowList(await getItemFromLocal("allowed_domain_list", []));
}

async function allocateRuleId() {
  return modifyItemInLocal(STORAGE_KEYS.NEXT_RULE_ID, RULE_IDS.LEARNED_START, (current) => {
    const n = Number.isFinite(Number(current))
      ? Number(current)
      : RULE_IDS.LEARNED_START;
    return Math.max(RULE_IDS.LEARNED_START, n) + 1;
  });
}

async function pruneExpiredState() {
  const now = Date.now();
  const [cache, learned] = await Promise.all([
    getItemFromLocal(STORAGE_KEYS.DNS_CACHE, {}),
    getItemFromLocal(STORAGE_KEYS.LEARNED_RULES, {})
  ]);

  let cacheChanged = false;
  let learnedChanged = false;

  for (const [host, entry] of Object.entries(cache)) {
    if (!entry || Number(entry.expiresAt) <= now) {
      delete cache[host];
      cacheChanged = true;
    }
  }

  for (const [host, entry] of Object.entries(learned)) {
    if (!entry || Number(entry.expiresAt) <= now) {
      delete learned[host];
      learnedChanged = true;
    }
  }

  if (cacheChanged) {
    await setItemInLocal(STORAGE_KEYS.DNS_CACHE, cache);
  }

  if (learnedChanged) {
    await setItemInLocal(STORAGE_KEYS.LEARNED_RULES, learned);
  }
}

async function syncAllRules() {
  await pruneExpiredState();

  const enabled = await getItemFromLocal("blocking_enabled", true);
  const allowList = await getAllowList();

  const existingRules = await browser.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules.map((rule) => rule.id);

  if (!enabled) {
    if (removeRuleIds.length) {
      await browser.declarativeNetRequest.updateDynamicRules({
        removeRuleIds
      });
    }
    return;
  }

  const learned = await getItemFromLocal(STORAGE_KEYS.LEARNED_RULES, {});
  const addRules = [
    buildLocalRule(allowList),
    buildDirectOnlineMetrixRule(allowList),
    ...Object.entries(learned).map(([host, entry]) =>
      buildLearnedAliasRule(host, entry.ruleId, allowList)
    )
  ];

  await browser.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules
  });
}

async function cacheResolution(result) {
  const expiresAt = Date.now() + (result.ttl * 1000);

  await modifyItemInLocal(STORAGE_KEYS.DNS_CACHE, {}, (cache) => {
    cache[result.host] = {
      verdict: result.matchedSuffix ? "block" : "allow",
      matchedSuffix: result.matchedSuffix,
      chain: result.chain,
      terminal: result.terminal,
      expiresAt
    };
    return cache;
  });
}

async function learnBlockedAlias(result) {
  const expiresAt = Date.now() + (result.ttl * 1000);

  const existingLearned = await getItemFromLocal(STORAGE_KEYS.LEARNED_RULES, {});
  const existing = existingLearned[result.host];
  const ruleId = existing?.ruleId || await allocateRuleId();

  await modifyItemInLocal(STORAGE_KEYS.LEARNED_RULES, {}, (learned) => {
    learned[result.host] = {
      ruleId,
      matchedSuffix: result.matchedSuffix,
      chain: result.chain,
      terminal: result.terminal,
      expiresAt
    };
    return learned;
  });

  await syncAllRules();
}

async function resolveAndLearnHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return;

  if (pendingLookups.has(host)) {
    return pendingLookups.get(host);
  }

  const task = (async () => {
    try {
      const result = await resolveCnameChain(host);
      await cacheResolution(result);

      if (result.matchedSuffix) {
        await learnBlockedAlias(result);
      }
    } catch (error) {
      console.warn("Port Authority DoH lookup failed:", host, error);
    }
  })().finally(() => {
    pendingLookups.delete(host);
  });

  pendingLookups.set(host, task);
  return task;
}

async function isAllowlistedInitiator(initiatorHost) {
  if (!initiatorHost) return false;
  const allowList = await getAllowList();
  return allowList.includes(initiatorHost);
}

async function observeRequest(details) {
  const enabled = await getItemFromLocal("blocking_enabled", true);
  if (!enabled) return;

  if (!details?.url) return;

  let requestUrl;
  try {
    requestUrl = new URL(details.url);
  } catch {
    return;
  }

  const requestHost = normalizeHost(requestUrl.hostname);
  if (!requestHost) return;

  const initiatorHost = getInitiatorHost(details.initiator);
  const thirdPartyish =
    initiatorHost && !looksSameSiteEnough(initiatorHost, requestHost);

  if (initiatorHost && await isAllowlistedInitiator(initiatorHost)) {
    return;
  }

  if (thirdPartyish && isLocalAddress(requestHost)) {
    if (Number.isFinite(details.tabId) && details.tabId >= 0) {
      await increaseBadge(details, false);
      await addBlockedPortToHost(requestUrl, details.tabId);
    }
    return;
  }

  if (thirdPartyish && matchedBlockedSuffix(requestHost)) {
    if (Number.isFinite(details.tabId) && details.tabId >= 0) {
      await increaseBadge(details, true);
      await addBlockedTrackingHost(requestUrl, details.tabId);
    }
    return;
  }

  if (!thirdPartyish) {
    return;
  }

  const cache = await getItemFromLocal(STORAGE_KEYS.DNS_CACHE, {});
  const cached = cache[requestHost];
  const now = Date.now();

  if (cached && Number(cached.expiresAt) > now) {
    if (cached.verdict === "block") {
      if (Number.isFinite(details.tabId) && details.tabId >= 0) {
        await increaseBadge(details, true);
        await addBlockedTrackingHost(requestUrl, details.tabId);
      }
    }
    return;
  }

  resolveAndLearnHost(requestHost).catch(console.error);
}

async function setBlockingEnabled(enabled) {
  await setItemInLocal("blocking_enabled", !!enabled);
  await syncAllRules();
}

async function handleUpdated(tabId, changeInfo, tabInfo) {
  const badges = await getItemFromLocal("badges", {});
  if (!badges[tabId] || !changeInfo.url) return;

  if (badges[tabId].lastURL !== changeInfo.url) {
    badges[tabId] = {
      counter: 0,
      alerted: 0,
      lastURL: tabInfo.url
    };

    await setItemInLocal("badges", badges);
    updateBadges("", tabId);

    await modifyItemInLocal("blocked_ports", {}, (blockedPorts) => {
      delete blockedPorts[tabId];
      return blockedPorts;
    });

    await modifyItemInLocal("blocked_hosts", {}, (blockedHosts) => {
      delete blockedHosts[tabId];
      return blockedHosts;
    });
  }
}

browser.runtime.onInstalled.addListener(() => {
  syncAllRules().catch(console.error);
});

browser.runtime.onStartup.addListener(() => {
  syncAllRules().catch(console.error);
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "toggleEnabled") {
    return setBlockingEnabled(message.value);
  }

  if (message?.type === "prewarmHost" && typeof message.host === "string") {
    return resolveAndLearnHost(message.host);
  }

  return undefined;
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes.allowed_domain_list || changes.blocking_enabled) {
    syncAllRules().catch(console.error);
  }
});

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    observeRequest(details).catch(console.error);
  },
  { urls: ["<all_urls>"] }
);

browser.tabs.onUpdated.addListener((tabId, changeInfo, tabInfo) => {
  handleUpdated(tabId, changeInfo, tabInfo).catch(console.error);
});

syncAllRules().catch(console.error);
