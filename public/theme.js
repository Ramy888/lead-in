// Applies the saved light/dark choice before first paint (a separate file: the CSP allows no inline scripts).
// No saved choice means the page follows the system setting through CSS.
try {
  const saved = localStorage.getItem("lead-in-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch {
  // Storage blocked (private mode, previews): follow the system setting.
}
