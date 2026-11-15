const params = new URLSearchParams(location.search);
const isPanel = params.has("panel");

document.getElementById("handles").classList.toggle("hidden", isPanel);
document.getElementById("panel").classList.toggle("hidden", !isPanel);

if (isPanel) {
  await import("./panel.js");
} else {
  await import("./handles.js");
}
