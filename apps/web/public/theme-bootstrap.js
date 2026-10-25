// Run synchronously before the application and first paint. Keep preference
// resolution in sync with ThemeProvider; the inline palette supplies the color.
(function () {
  try {
    var q = new URLSearchParams(location.search).get("__theme");
    var stored = q || localStorage.getItem("theme") || "system";
    var theme = stored === "light" || stored === "dark" ? stored : "system";
    var isDark = theme === "dark" || (theme === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", isDark);
    var meta = document.getElementById("theme-color-meta");
    var chrome = getComputedStyle(document.documentElement).getPropertyValue("--brand-chrome").trim();
    if (meta && chrome) meta.setAttribute("content", chrome);
  } catch (e) {}
})();
