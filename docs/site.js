(function () {
  document.documentElement.classList.add("js");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var pad = function (n) { return String(n).padStart(2, "0"); };

  // The HUD timecode runs while the page is open.
  var tc = document.getElementById("tc");
  if (!reduced && tc) {
    var start = performance.now();
    var tick = function (now) {
      var s = (now - start) / 1000;
      tc.textContent =
        pad(Math.floor(s / 3600)) + ":" +
        pad(Math.floor(s / 60) % 60) + ":" +
        pad(Math.floor(s) % 60) + ";" +
        pad(Math.floor((s % 1) * 30));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  var copyText = function (button, text) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function () {
      button.textContent = "copied";
      setTimeout(function () { button.textContent = "copy"; }, 1500);
    });
  };

  // Hero install command.
  var copy = document.getElementById("copy");
  var cmd = document.getElementById("cmd");
  if (copy && cmd) {
    copy.addEventListener("click", function () { copyText(copy, cmd.textContent); });
  }

  // Any <pre class="copyable"> gets a copy button.
  document.querySelectorAll("pre.copyable").forEach(function (pre) {
    if (!navigator.clipboard) return;
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = "copy";
    b.setAttribute("aria-label", "Copy snippet");
    b.addEventListener("click", function () { copyText(b, pre.querySelector("code").textContent); });
    pre.appendChild(b);
  });

  // Tabs: [role=tablist] buttons control panels by aria-controls; the hash picks one.
  document.querySelectorAll("[role=tablist]").forEach(function (list) {
    var tabs = Array.prototype.slice.call(list.querySelectorAll("[role=tab]"));
    var show = function (tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      });
      if (focus) tab.focus();
    };
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () {
        show(t);
        history.replaceState(null, "", "#" + t.getAttribute("aria-controls"));
      });
      t.addEventListener("keydown", function (e) {
        var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (d) show(tabs[(i + d + tabs.length) % tabs.length], true);
      });
    });
    var fromHash = tabs.filter(function (t) { return "#" + t.getAttribute("aria-controls") === location.hash; })[0];
    show(fromHash || tabs[0]);
  });
})();
