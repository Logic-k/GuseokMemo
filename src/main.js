const params = new URLSearchParams(location.search);
const isPanel = params.has("panel");
const isToast = params.has("toast");

document.getElementById("handles").classList.toggle("hidden", isPanel || isToast);
document.getElementById("panel").classList.toggle("hidden", !isPanel);
document.getElementById("toastHost").classList.toggle("hidden", !isToast);

if (isPanel) {
  await import("./panel.js");
} else if (isToast) {
  await import("./toast.js");
} else {
  await import("./handles.js");
}
