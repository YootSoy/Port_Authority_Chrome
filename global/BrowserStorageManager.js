import { browser } from "./webext.js";
import {
  updateBadges,
  notifyThreatMetrix,
  notifyPortScanning
} from "./browserActions.js";
import { getPortForProtocol } from "./constants.js";

let storageQueue = Promise.resolve();

function withStorageLock(work) {
  const run = storageQueue.then(work, work);
  storageQueue = run.catch(() => {});
  return run;
}

async function rawGetItemFromLocal(key, defaultValue) {
  let storageValue;

  try {
    storageValue = await browser.storage.local.get(key);

    if (!storageValue || !(key in storageValue)) {
      return defaultValue;
    }

    return JSON.parse(storageValue[key]);
  } catch (error) {
    console.error(`Error getting storage value [${key}]`, {
      error,
      defaultValue,
      storageValue
    });
    return defaultValue;
  }
}

export async function getItemFromLocal(key, defaultValue) {
  return withStorageLock(() => rawGetItemFromLocal(key, defaultValue));
}

export async function setItemInLocal(key, value) {
  return withStorageLock(async () => {
    await browser.storage.local.set({
      [key]: JSON.stringify(value)
    });
    return value;
  });
}

export async function modifyItemInLocal(key, defaultValue, mutate) {
  return withStorageLock(async () => {
    const initialValue = await rawGetItemFromLocal(key, defaultValue);
    const newValue = await mutate(initialValue);

    await browser.storage.local.set({
      [key]: JSON.stringify(newValue)
    });

    return newValue;
  });
}

export async function clearItemsInLocal(defaultStructure = {}) {
  return withStorageLock(async () => {
    const encoded = Object.fromEntries(
      Object.entries(defaultStructure).map(([key, value]) => [
        key,
        JSON.stringify(value)
      ])
    );

    await browser.storage.local.clear();
    await browser.storage.local.set(encoded);
    return defaultStructure;
  });
}

export async function addBlockedPortToHost(url, tabIdLike) {
  const tabId = Number(tabIdLike);
  const host = url.hostname;
  const port = String(url.port || getPortForProtocol(url.protocol) || "");

  return modifyItemInLocal("blocked_ports", {}, (blockedPorts) => {
    const tabHosts = blockedPorts[tabId] || {};
    const existingPorts = Array.isArray(tabHosts[host]) ? tabHosts[host] : [];

    if (!existingPorts.includes(port)) {
      tabHosts[host] = existingPorts.concat(port);
    }

    blockedPorts[tabId] = tabHosts;
    return blockedPorts;
  });
}

export async function addBlockedTrackingHost(url, tabIdLike) {
  const tabId = Number(tabIdLike);
  const host = url.hostname;

  return modifyItemInLocal("blocked_hosts", {}, (blockedHostsTabs) => {
    const blockedHosts = Array.isArray(blockedHostsTabs[tabId])
      ? blockedHostsTabs[tabId]
      : [];

    if (!blockedHosts.includes(host)) {
      blockedHostsTabs[tabId] = blockedHosts.concat(host);
    }

    return blockedHostsTabs;
  });
}

function getHostFromOrigin(origin) {
  try {
    if (!origin || origin === "null") return undefined;
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}

export async function increaseBadge(request, isThreatMetrix) {
  const tabId = Number(request?.tabId);
  const url = request?.url;

  if (!request || !Number.isFinite(tabId) || tabId < 0) {
    console.error("Invalid request passed to increaseBadge:", {
      request,
      isThreatMetrix
    });
    return;
  }

  return modifyItemInLocal("badges", {}, async (badges) => {
    if (!badges[tabId]) {
      badges[tabId] = {
        counter: 0,
        alerted: 0,
        lastURL: url
      };
    }

    badges[tabId].counter += 1;
    updateBadges(badges[tabId].counter, tabId);

    const notificationsEnabled = await rawGetItemFromLocal(
      "notificationsAllowed",
      true
    );

    if (badges[tabId].alerted === 0 && notificationsEnabled) {
      badges[tabId].alerted += 1;

      const initiatorHost = getHostFromOrigin(request.initiator);

      if (isThreatMetrix) {
        await notifyThreatMetrix(initiatorHost);
      } else {
        await notifyPortScanning(initiatorHost);
      }
    }

    return badges;
  });
}
