// Picks light or dark mode from the system setting before the page is drawn,
// so the page never flashes in the wrong colours. app.js handles the switch button.
(function () {
  var dark = !window.matchMedia || window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
