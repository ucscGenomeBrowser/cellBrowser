// Click-to-zoom lightbox for documentation screenshots.
//
// The UI screenshots are shown scaled down to fit the page column, which makes
// their annotation callouts small. This lets a reader click any content image
// to see it full-size in an overlay, then click (or press Escape) to close.
//
// Pure vanilla JS, no dependencies, so it works on Read the Docs as a plain
// static file. Registered via html_js_files/html_css_files in conf.py.

(function () {
    "use strict";

    function init() {
        // Only make images inside the article body zoomable, and skip small
        // decorative images (logo, icons) by requiring a reasonable width.
        var imgs = document.querySelectorAll(".rst-content img");
        if (!imgs.length) {
            return;
        }

        var overlay = document.createElement("div");
        overlay.id = "cb-zoom-overlay";
        var big = document.createElement("img");
        overlay.appendChild(big);
        document.body.appendChild(overlay);

        function close() {
            overlay.classList.remove("cb-open");
            big.removeAttribute("src");
        }

        overlay.addEventListener("click", close);
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") {
                close();
            }
        });

        imgs.forEach(function (img) {
            // Heuristic: skip tiny images (logos, badges, inline icons).
            if (img.naturalWidth && img.naturalWidth < 300) {
                return;
            }

            // The RTD theme wraps every scaled image in an
            // <a class="image-reference" href="../_images/..."> that opens the
            // raw file. Suppress that navigation so a click shows our overlay
            // (or, for GIFs, does nothing) instead of leaving the page.
            var link = img.closest("a.image-reference");
            if (link) {
                link.addEventListener("click", function (e) {
                    e.preventDefault();
                });
            }

            // Skip animated GIFs: zooming them just restarts the animation in
            // an overlay, and they have no small callout text to enlarge.
            if (/\.gif(\?|$)/i.test(img.currentSrc || img.src)) {
                return;
            }

            img.classList.add("cb-zoomable");
            img.addEventListener("click", function (e) {
                e.preventDefault();
                big.src = img.currentSrc || img.src;
                overlay.classList.add("cb-open");
            });
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
