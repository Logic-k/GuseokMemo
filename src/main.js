const params = new URLSearchParams(location.search);
const isPanel = params.has("panel");
const isToast = params.has("toast");
const isPick = params.has("pick");

document.getElementById("handles").classList.toggle("hidden", isPanel || isToast || isPick);
document.getElementById("panel").classList.toggle("hidden", !isPanel);
document.getElementById("toastHost").classList.toggle("hidden", !isToast);
document.getElementById("pick").classList.toggle("hidden", !isPick);

if (isPanel) {
  await import("./panel.js");
} else if (isToast) {
  await import("./toast.js");
} else if (isPick) {
  await import("./pick.js");
} else {
  await import("./handles.js");
}
