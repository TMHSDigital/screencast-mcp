(function () {
  document.documentElement.classList.add("js");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var pad = function (n) { return String(n).padStart(2, "0"); };

  var timecode = function (s) {
    return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor(s / 60) % 60) + ":" +
      pad(Math.floor(s) % 60) + ";" + pad(Math.floor((s % 1) * 30));
  };

  // The page is a recording: scrolling scrubs it. The HUD timecode reads the
  // scroll position against each chapter's own timecode mark, and a track
  // along the HUD fills as you go, with a chapter marker at every chapter:
  // click one (or Tab to it) to jump there, like a marker on a timeline.
  var tc = document.getElementById("tc");
  var hud = document.querySelector(".hud");
  if (tc && hud) {
    var marks = Array.prototype.slice.call(document.querySelectorAll(".tc-mark .tc")).map(function (el) {
      var p = el.textContent.trim().split(":").map(Number);
      var label = el.nextElementSibling ? el.nextElementSibling.textContent.trim() : "";
      return { el: el.closest("section") || el, t: p[0] * 60 + p[1], tc: el.textContent.trim(), label: label };
    }).filter(function (m) { return !isNaN(m.t); });
    var track = document.createElement("nav");
    track.className = "hud-track";
    track.setAttribute("aria-label", "Chapters");
    track.innerHTML = '<span class="hud-fill" aria-hidden="true"></span>';
    hud.appendChild(track);
    var chapter = document.createElement("span");
    chapter.className = "hud-chapter";
    chapter.setAttribute("aria-hidden", "true");
    tc.insertAdjacentElement("afterend", chapter);
    var anchors = [];
    var measure = function () {
      var max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
      // Chapters hidden by the tool finder have no box; leave them out.
      var visible = marks.filter(function (m) { return m.el.getClientRects().length > 0; });
      anchors = [{ y: 0, t: 0 }].concat(visible.map(function (m) {
        return { y: Math.min(max, m.el.getBoundingClientRect().top + scrollY - innerHeight * 0.3), t: m.t, mark: m };
      }));
      var last = anchors[anchors.length - 1];
      anchors.push({ y: max, t: last.t + 4 });
      track.querySelectorAll(".hud-tick").forEach(function (t) { t.remove(); });
      anchors.slice(1, -1).forEach(function (a) {
        var m = a.mark;
        var tick = document.createElement(m.el.id ? "a" : "span");
        tick.className = "hud-tick";
        tick.style.left = (Math.max(0, a.y) / max) * 100 + "%";
        if (m.el.id) {
          tick.href = "#" + m.el.id;
          tick.setAttribute("aria-label", m.label + " (" + m.tc + ")");
          tick.setAttribute("data-label", m.tc + " " + m.label);
        }
        track.appendChild(tick);
      });
      return max;
    };
    var max = measure();
    var pending = false;
    var update = function () {
      pending = false;
      var y = scrollY, t = 0;
      for (var i = 1; i < anchors.length; i++) {
        var a = anchors[i - 1], b = anchors[i];
        if (y <= b.y || i === anchors.length - 1) {
          t = a.t + (b.t - a.t) * Math.min(1, Math.max(0, (y - a.y) / Math.max(1, b.y - a.y)));
          break;
        }
      }
      tc.textContent = timecode(t);
      track.style.setProperty("--progress", Math.min(1, y / max));
      var current = "";
      for (var j = 1; j < anchors.length - 1; j++) if (y >= anchors[j].y - 1) current = anchors[j].mark.label;
      chapter.textContent = current;
    };
    addEventListener("scroll", function () { if (!pending) { pending = true; requestAnimationFrame(update); } }, { passive: true });
    addEventListener("resize", function () { max = measure(); update(); });
    addEventListener("load", function () { max = measure(); update(); });
    update();
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
    // Switch between the Claude Code command and the setup wizard (any client).
    var sw = document.querySelector(".install-switch");
    var installNote = document.getElementById("install-note");
    if (sw) {
      var opts = Array.prototype.slice.call(sw.querySelectorAll("button"));
      opts.forEach(function (b, i) {
        b.addEventListener("click", function () {
          opts.forEach(function (o) { o.setAttribute("aria-pressed", o === b ? "true" : "false"); });
          cmd.textContent = b.getAttribute("data-cmd");
          cmd.scrollLeft = 0;
          copy.setAttribute("aria-label", "Copy " + b.getAttribute("data-label"));
          if (installNote) installNote.hidden = i === 0;
        });
      });
      sw.hidden = false;
    }
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
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        panel.hidden = !on;
        panel.classList.toggle("active", on);
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

  // Hero viewfinder: frames sampled from a real recording, one sprite per
  // version. Scrubbing shows the frame and the sample_frames call that returns it.
  var vf = document.getElementById("vf");
  if (vf) {
    var n = Number(vf.dataset.frames), fps = Number(vf.dataset.fps);
    var frame = vf.querySelector(".vf-frame"), range = vf.querySelector(".vf-range");
    var thumbs = vf.querySelector(".vf-thumbs"), vtc = document.getElementById("vf-tc");
    var call = document.getElementById("vf-call"), note = document.getElementById("vf-note");
    var intro = note.innerHTML, version = "before", touched = false, current = 0;
    // The visible note changes on every frame, so it is not a live region.
    // A hidden one speaks the note once scrubbing pauses, and never during the
    // intro animation (#224).
    var live = document.getElementById("vf-live"), liveTimer = 0;
    var announce = function () {
      if (!live) return;
      clearTimeout(liveTimer);
      liveTimer = setTimeout(function () {
        live.textContent = (current / fps).toFixed(2) + " seconds. " + note.textContent;
      }, 600);
    };
    var pos = function (i) { return (i / (n - 1)) * 100 + "%"; };
    // A readable strip: one thumbnail per second (every fourth frame).
    var per = 4;
    for (var k = 0; k < n; k += per) {
      var s = document.createElement("span");
      s.style.backgroundPositionX = pos(k);
      thumbs.appendChild(s);
    }
    var cells = thumbs.children;
    // What each stretch of the recording shows, per version.
    var noteFor = function (i) {
      var t = i / fps;
      if (version === "after") {
        if (t >= 2.5 && t < 5.25) return "<code>zoom</code> planned this from the click <code>read_events</code> logged at 3.18 s: it glides in to arrive with the click, rings it, and eases out 2 s later. Scenes mode would return only the opening frame of this version, because a smooth zoom never jumps.";
        return t < 2.5 ? "The zoomed version, before the click. The camera is about to move." : "Back out to the full window after the hold.";
      }
      if (t >= 3 && t < 3.5) return "3.2 s: Save is clicked and the screen changes. <code>sample_frames { mode: \"scenes\" }</code> returns this frame, and <code>read_events</code> logged the click at 3.18 s. An agent looking at two frames, not 104, sees the whole story.";
      if (t >= 3.5) return "After the click, the Saved banner holds. Nothing changes, so scenes mode skips all of it.";
      return intro;
    };
    var show = function (i) {
      current = i;
      var t = i / fps;
      frame.style.backgroundPositionX = pos(i);
      vf.querySelector(".vf-head-line").style.setProperty("--p", (i + 0.5) / n);
      for (var c = 0; c < cells.length; c++) cells[c].classList.toggle("past", c * per <= i);
      vtc.textContent = timecode(t);
      range.value = String(i);
      range.setAttribute("aria-valuetext", t.toFixed(2) + " seconds");
      frame.setAttribute("aria-label", "Frame at " + t.toFixed(2) + " seconds of a " +
        (version === "after" ? "zoomed " : "") + "recording of a settings window");
      call.textContent = 'sample_frames { "input": "' + (version === "after" ? "zoom.mp4" : "rec.mp4") + '", "timestamps": [' + t.toFixed(2) + "] }";
      note.innerHTML = noteFor(i);
    };
    range.addEventListener("input", function () { touched = true; show(Number(range.value)); announce(); });
    vf.querySelectorAll(".vf-toggle button").forEach(function (b) {
      b.addEventListener("click", function () {
        touched = true;
        version = b.dataset.version;
        vf.dataset.version = version;
        vf.querySelectorAll(".vf-toggle button").forEach(function (o) { o.setAttribute("aria-pressed", String(o === b)); });
        show(current);
        announce();
      });
    });
    show(0);
    // One orchestrated moment: the first time the viewfinder is on screen, the
    // playhead runs up to the click and stops there.
    if (!reduced && "IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        if (!entries[0].isIntersecting) return;
        io.disconnect();
        var target = 13, t0 = performance.now(), dur = 2200;
        var step = function (now) {
          if (touched) return;
          var f = Math.min(1, (now - t0) / dur);
          var eased = 1 - Math.pow(1 - f, 3);
          show(Math.round(eased * target));
          if (f < 1) requestAnimationFrame(step);
        };
        setTimeout(function () { requestAnimationFrame(step); }, 400);
      }, { threshold: 0.6 });
      io.observe(vf);
    }
  }

  // Chapter links: a "#link" on each chapter's timecode line. Clicking it
  // moves to the chapter and copies its URL, so a section can be shared.
  Array.prototype.slice.call(document.querySelectorAll(".chapter[id] > .tc-mark")).forEach(function (mark) {
    var id = mark.parentElement.id;
    var name = mark.lastElementChild ? mark.lastElementChild.textContent.trim().toLowerCase() : id;
    var link = document.createElement("a");
    link.className = "tc-link";
    link.href = "#" + id;
    link.textContent = "#link";
    link.setAttribute("aria-label", "Copy a link to " + name);
    link.addEventListener("click", function () {
      if (!navigator.clipboard) return;
      var url = location.href.split("#")[0] + "#" + id;
      navigator.clipboard.writeText(url).then(function () {
        link.textContent = "copied";
        link.classList.add("copied");
        setTimeout(function () { link.textContent = "#link"; link.classList.remove("copied"); }, 1500);
      }, function () { /* clipboard blocked: the jump still happens */ });
    });
    mark.appendChild(link);
  });

  // Tool finder: filter the tool tables as you type.
  var q = document.getElementById("tool-q");
  if (q) {
    var rows = Array.prototype.slice.call(document.querySelectorAll("#tools tbody tr"));
    var chapters = Array.prototype.slice.call(document.querySelectorAll("#tools .chapter"));
    var count = document.getElementById("tool-count"), empty = document.getElementById("tool-empty");
    var run = function () {
      var terms = q.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      var shown = 0;
      rows.forEach(function (r) {
        var raw = (r.getAttribute("data-search") || r.textContent).toLowerCase();
        var text = raw.replace(/_/g, " ") + " " + raw;
        var ok = terms.every(function (t) { return text.indexOf(t) >= 0; });
        r.hidden = !ok;
        if (ok) shown++;
      });
      chapters.forEach(function (c) { c.hidden = terms.length > 0 && !c.querySelector("tbody tr:not([hidden])"); });
      count.textContent = terms.length ? shown + " of " + rows.length + " tools" : rows.length + " tools";
      empty.hidden = shown > 0;
      empty.textContent = shown ? "" : "No tool matches “" + q.value.trim() + "”. Try a word like trim, OCR, GIF, or zoom.";
      // Keep the query in the URL so a filtered list can be shared, and let
      // the HUD re-measure its chapter markers for the new page height.
      try {
        var url = new URL(location.href);
        if (q.value.trim()) url.searchParams.set("q", q.value.trim()); else url.searchParams.delete("q");
        history.replaceState(null, "", url);
      } catch (e) { /* file:// or old browser: the filter still works */ }
      dispatchEvent(new Event("resize"));
    };
    q.addEventListener("input", run);
    // "/" jumps to the finder from anywhere on the page; Escape clears it.
    addEventListener("keydown", function (e) {
      var t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        q.focus();
        q.select();
      } else if (e.key === "Escape" && t === q && q.value) {
        q.value = "";
        run();
      }
    });
    var initial = new URLSearchParams(location.search).get("q");
    if (initial) q.value = initial;
    run();
  }
})();
