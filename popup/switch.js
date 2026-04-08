import { browser } from "../global/webext.js";
import { getItemFromLocal, setItemInLocal } from "../global/BrowserStorageManager.js";

document
  .getElementById("settings")
  .addEventListener("click", () => browser.runtime.openOptionsPage());

const blockingSwitch = document.getElementById("blocking_switch");
const blockingSetup = getItemFromLocal("blocking_enabled", true).then(
  (blockingEnabled) => {
    blockingSwitch.checked = blockingEnabled;
    blockingSwitch.addEventListener("change", (ev) =>
      browser.runtime.sendMessage({
        type: "toggleEnabled",
        value: ev.target.checked
      })
    );
  }
);

const notificationsSwitch = document.getElementById("notifications_switch");
const notificationsSetup = getItemFromLocal("notificationsAllowed", true).then(
  (notificationsAllowed) => {
    notificationsSwitch.checked = notificationsAllowed;
    notificationsSwitch.addEventListener("change", (ev) =>
      setItemInLocal("notificationsAllowed", ev.target.checked)
    );
  }
);

Promise.allSettled([blockingSetup, notificationsSetup]).then(() => {
  document.body.getBoundingClientRect();
  document.body.classList.remove("loading");
});
