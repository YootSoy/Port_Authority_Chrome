import { getItemFromLocal, modifyItemInLocal } from "../global/BrowserStorageManager.js";
import { createElement } from "../global/domUtils.js";

function allowlistItem(domain, abortSignal) {
  const removeDomainListener = () => {
    modifyItemInLocal("allowed_domain_list", [], (list) =>
      list.filter((d) => d !== domain)
    ).then((list) => loadAllowlist(list));
  };

  const item = createElement("li", {}, [domain, " "]);
  const removeButton = createElement(
    "button",
    {
      class: "unselectable",
      "aria-label": `Remove '${domain}' from allowlist`
    },
    "✕"
  );

  removeButton.addEventListener("click", removeDomainListener, {
    signal: abortSignal
  });

  item.appendChild(removeButton);
  return item;
}

let removeButtonsEventController;
const allowlistWrapper = document.getElementById("allowlist_section");
const allowlistContents = document.getElementById("allowlist_contents");

async function loadAllowlist(allowedDomainList) {
  if (removeButtonsEventController) {
    removeButtonsEventController.abort();
  }

  removeButtonsEventController = new AbortController();

  allowedDomainList ??= await getItemFromLocal("allowed_domain_list", []);

  allowlistContents.replaceChildren();

  if (!allowedDomainList?.length) {
    allowlistWrapper.setAttribute("hidden", "");
    return;
  }

  for (const domain of allowedDomainList) {
    const row = allowlistItem(domain, removeButtonsEventController.signal);
    allowlistContents.appendChild(row);
  }

  allowlistWrapper.removeAttribute("hidden");
}

function extractURLDomain(url) {
  url = url.trim();

  if (!url.match(/^\w*:\/\//)) {
    url = "http://" + url;
  }

  const parsed = new URL(url);
  return parsed.hostname.toLowerCase();
}

const allowlistAddForm = document.getElementById("allowlist_add_form");

function allowlistAddListener(event) {
  event.preventDefault();

  const formUrl = allowlistAddForm.elements["add_domain"];
  let url = formUrl.value;

  try {
    url = extractURLDomain(url);
  } catch (error) {
    console.warn("Error parsing a domain to add to the allowlist:", { url, error });
    alert("Please enter a valid domain.");
    return;
  }

  formUrl.value = "";

  modifyItemInLocal("allowed_domain_list", [], (list) => {
    if (!list.includes(url)) {
      return list.concat(url).sort();
    }

    alert("This domain is already in the list.");
    return list;
  }).then((list) => loadAllowlist(list));
}

allowlistAddForm.addEventListener("submit", allowlistAddListener);
loadAllowlist();
