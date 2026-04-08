import { browser } from "./webext.js";

export async function notifyPortScanning(domainName) {
  const message = domainName
    ? `Port Authority blocked ${domainName} from port scanning your private network.`
    : "Port Authority blocked this site from port scanning your private network.";

  return browser.notifications.create("port-scanning-notification", {
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/logo-96.png"),
    title: "Port Scan Blocked",
    message
  });
}

export async function notifyThreatMetrix(domainName) {
  const message = domainName
    ? `Port Authority blocked a direct online-metrix.net request on ${domainName}.`
    : "Port Authority blocked a direct online-metrix.net request.";

  return browser.notifications.create("threatmetrix-notification", {
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/logo-96.png"),
    title: "Tracking Script Blocked",
    message
  });
}

export function updateBadges(text, tabId) {
  try {
    browser.action.setBadgeText({
      text: String(text ?? ""),
      tabId: Number(tabId)
    });

    browser.action.setBadgeBackgroundColor({
      color: "#b71c1c",
      tabId: Number(tabId)
    });
  } catch (error) {
    console.error("Couldn't update badge:", { tabId, text, error });
  }
}

export async function getActiveTabId() {
  const tabs = await browser.tabs.query({
    currentWindow: true,
    active: true
  });

  return tabs[0]?.id;
}
