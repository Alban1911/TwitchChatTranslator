const checkbox = document.getElementById("enabled");

chrome.storage.sync.get({ enabled: true }, ({ enabled }) => {
  checkbox.checked = !!enabled;
});

checkbox.addEventListener("change", async () => {
  await chrome.storage.sync.set({ enabled: checkbox.checked });
});


