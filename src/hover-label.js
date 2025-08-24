(() => {
  // Create the label once
  const label = document.createElement('div');
  label.id = 'hover-tag-label';
  document.documentElement.appendChild(label);

  let raf = null;
  let lastText = '';
  let pending = null;

  const clamp = (val, min, max) => Math.min(Math.max(val, min), max);
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1'));

  function findElementFromEvent(e) {
    // Prefer composedPath for Shadow DOM; fall back to target
    if (typeof e.composedPath === 'function') {
      const path = e.composedPath();
      for (const node of path) {
        if (node && node.nodeType === Node.ELEMENT_NODE) return node;
      }
    }
    return e.target && e.target.nodeType === Node.ELEMENT_NODE ? e.target : null;
  }

  function isUniqueInRoot(root, selector, el) {
    try {
      const list = root.querySelectorAll(selector);
      return list.length === 1 && list[0] === el;
    } catch {
      return false;
    }
  }

  function bestIdentifier(el) {
    const root = el.getRootNode && el.getRootNode() instanceof ShadowRoot
      ? el.getRootNode()
      : document;

    // 1) Prefer ID (verify uniqueness just in case)
    const id = el.getAttribute('id');
    if (id) {
      const sel = `#${esc(id)}`;
      if (isUniqueInRoot(root, sel, el)) return sel;
    }

    // 2) data-automationid (exact match)
    const da = el.getAttribute('data-automationid');
    if (da) {
      const sel = `[data-automationid="${CSS && CSS.escape ? CSS.escape(da) : da.replace(/"/g, '\\"')}"]`;
      if (isUniqueInRoot(root, sel, el)) return sel;
    }

    // 3) Any single unique class token (choose shortest unique)
    const classAttr = el.getAttribute('class');
    if (classAttr) {
      const tokens = [...new Set(classAttr.trim().split(/\s+/).filter(Boolean))].sort((a, b) => a.length - b.length);
      for (const c of tokens) {
        const sel = `.${esc(c)}`;
        if (isUniqueInRoot(root, sel, el)) return sel;
      }
    }

    // 4) If nothing unique, omit identifier
    return '';
  }

  function formatLabel(el) {
    const tag = (el.tagName || '').toLowerCase();
    if (!tag) return '';
    const ident = bestIdentifier(el);
    if (ident) {
      // Clean up display (drop attribute quotes for readability when safe)
      return `<${tag}${ident.startsWith('[') ? ident : ident.replace(/^([#.])/, '$1')}>`;
    }
    return `<${tag}>`;
  }

  function update(e) {
    pending = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const evt = pending;
      pending = null;

      const el = findElementFromEvent(evt);
      if (!el || el === label) return;

      const text = formatLabel(el);
      if (!text) return;

      if (text !== lastText) {
        label.textContent = text;
        lastText = text;
      }

      // Position near cursor, then keep within viewport
      const padding = 8;
      const offsetX = 12, offsetY = 14;

      label.classList.add('visible');
      const { innerWidth: vw, innerHeight: vh } = window;
      const rect = label.getBoundingClientRect();

      let x = evt.clientX + offsetX;
      let y = evt.clientY + offsetY;

      if (x + rect.width + padding > vw) x = evt.clientX - rect.width - offsetX;
      if (y + rect.height + padding > vh) y = evt.clientY - rect.height - offsetY;

      x = clamp(x, 4, vw - rect.width - 4);
      y = clamp(y, 4, vh - rect.height - 4);

      label.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    });
  }

  function onVisibility() {
    if (document.hidden) {
      label.classList.remove('visible');
    }
  }

  window.addEventListener('mousemove', update, { passive: true });
  window.addEventListener('mouseover', update, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);

  // Re-attach if removed
  const obs = new MutationObserver(() => {
    if (!document.documentElement.contains(label)) {
      document.documentElement.appendChild(label);
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();





// === Firefind DOM Panel (mini DOM tree overlay) ===
(() => {
  const LS_KEY = '__firefind_dom_panel_visible';

  // Create panel
  const panel = document.createElement('div');
  panel.id = 'firefind-dom-panel';
  panel.innerHTML = `
    <div class="ff-header">
      <div>DOM tree (hovered)</div>
      <div class="ff-pin" title="Toggle (Ctrl+Shift+D)">📌</div>
    </div>
    <div class="ff-tree" role="list" aria-label="Ancestor elements"></div>
  `;
  document.documentElement.appendChild(panel);

  const tree = panel.querySelector('.ff-tree');
  const pin  = panel.querySelector('.ff-pin');

  // Outline ring for clicked nodes
  const ring = document.createElement('div');
  ring.id = 'firefind-outline-ring';
  document.documentElement.appendChild(ring);

  // Util: safe CSS escape
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1'));

  // Util: label for a node like: div#id.cls1.cls2
  function labelFor(el) {
    if (!el || el.nodeType !== 1) return String(el?.nodeName || '');
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${esc(el.id)}` : '';
    const cls = (el.classList && el.classList.length)
      ? '.' + [...el.classList].slice(0, 3).map(esc).join('.') // cap to 3 classes
      : '';
    return `${tag}${id}${cls}`;
  }

  // Build ancestors up to <html> and across shadow boundaries where possible
  function getAncestors(el) {
    const list = [];
    let cur = el;
    const max = 20; // keep it tidy
    let steps = 0;

    while (cur && steps++ < max) {
      list.push(cur);
      if (cur === document.documentElement) break;

      // Walk out of shadow roots if needed
      if (cur.parentNode) {
        cur = cur.parentNode.nodeType === 11 && cur.parentNode.host ? cur.parentNode.host : cur.parentElement;
      } else {
        cur = null;
      }
    }
    return list.reverse();
  }

  let currentEl = null;

  // Render the breadcrumb nodes
  function render(hoveredEl) {
    currentEl = hoveredEl;
    if (!panel.classList.contains('visible')) return;

    const ancestors = getAncestors(hoveredEl);
    tree.innerHTML = ''; // rebuild simple + fast

    ancestors.forEach((node, idx) => {
      const item = document.createElement('div');
      item.className = 'ff-node' + (idx === ancestors.length - 1 ? ' ff-current' : '');
      item.textContent = labelFor(node);
      item.setAttribute('role', 'listitem');
      item.title = 'Click to outline element';
      item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        outline(node);
      });
      tree.appendChild(item);

      if (idx < ancestors.length - 1) {
        const sep = document.createElement('div');
        sep.className = 'ff-sep';
        sep.textContent = '›';
        sep.style.opacity = '0.6';
        sep.style.alignSelf = 'center';
        tree.appendChild(sep);
      }
    });
  }

  // Draw an outline ring over a node
  function outline(el) {
    try {
      const r = el.getBoundingClientRect();
      ring.style.transform = `translate(${Math.max(0, r.left + window.scrollX)}px, ${Math.max(0, r.top + window.scrollY)}px)`;
      ring.style.width  = Math.max(0, r.width) + 'px';
      ring.style.height = Math.max(0, r.height) + 'px';
    } catch {
      ring.style.transform = 'translate(-9999px,-9999px)';
      ring.style.width = ring.style.height = '0';
    }
  }

  // Hide outline when moving mouse again (unless you click again)
  function clearOutlineSoon() {
    // small grace period keeps UI snappy without being sticky
    setTimeout(() => {
      ring.style.transform = 'translate(-9999px,-9999px)';
    }, 800);
  }

  // Wire up to your existing hover logic:
  // We listen on both 'mousemove' and 'mouseover' so updates feel immediate.
  function onMove(e) {
    const el = e.composedPath ? e.composedPath()[0] : e.target;
    if (!(el instanceof Element)) return;
    render(el);
    clearOutlineSoon();
  }

  // Toggle via keyboard or pin click
  function togglePanel() {
    const next = !panel.classList.contains('visible');
    panel.classList.toggle('visible', next);
    localStorage.setItem(LS_KEY, next ? '1' : '0');
    if (next && currentEl) render(currentEl);
  }

  pin.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanel();
  });

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.code === 'KeyD' || e.key?.toLowerCase() === 'd')) {
      e.preventDefault();
      togglePanel();
    }
  }, { passive: false });

  // Restore last state
  if (localStorage.getItem(LS_KEY) === '1') {
    panel.classList.add('visible');
  }

  // Listen for movement (same events you already use in your script)
  window.addEventListener('mousemove', onMove, { passive: true });
  window.addEventListener('mouseover', onMove, { passive: true });

  // If panel or ring are ever removed, reattach
  new MutationObserver(() => {
    if (!document.documentElement.contains(panel)) {
      document.documentElement.appendChild(panel);
    }
    if (!document.documentElement.contains(ring)) {
      document.documentElement.appendChild(ring);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();

// === Firefind: Optional "border on hover when overlay open" ===
(() => {
  const LS_KEY = '__firefind_border_on_overlay';
  const panel = document.getElementById('firefind-dom-panel') || (() => {
    // If your script creates the panel elsewhere, we wait for it to appear.
    const p = document.createElement('div');
    p.id = 'firefind-dom-panel';
    p.style.display = 'none';
    document.documentElement.appendChild(p);
    return p;
  })();

  // Insert a small toggle chip into the header (or create header if missing)
  function ensureHeader() {
    let header = panel.querySelector('.ff-header');
    if (!header) {
      header = document.createElement('div');
      header.className = 'ff-header';
      header.textContent = 'DOM tree (hovered)';
      panel.prepend(header);
    }
    let toggle = header.querySelector('.ff-toggle[data-key="border"]');
    if (!toggle) {
      toggle = document.createElement('div');
      toggle.className = 'ff-toggle';
      toggle.dataset.key = 'border';
      toggle.title = 'Show border on hovered element when overlay is open';
      header.appendChild(toggle);
    }
    return header;
  }

  const header = ensureHeader();
  const toggle = header.querySelector('.ff-toggle[data-key="border"]');

  // state
  let enableBorder = localStorage.getItem(LS_KEY) === '1';
  let lastBordered = null;

  function renderToggle() {
    toggle.textContent = enableBorder ? 'Border: On' : 'Border: Off';
    toggle.classList.toggle('active', enableBorder);
  }
  renderToggle();

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    enableBorder = !enableBorder;
    localStorage.setItem(LS_KEY, enableBorder ? '1' : '0');
    if (!enableBorder) clearBorder();
    renderToggle();
  });

  function clearBorder() {
    if (lastBordered && lastBordered.isConnected) {
      lastBordered.removeAttribute('data-firefind-border');
    }
    lastBordered = null;
  }

  // When the panel becomes hidden, remove any leftover border
  const mo = new MutationObserver(() => {
    const visible = panel.classList.contains('visible') || panel.style.display !== 'none';
    if (!visible) clearBorder();
  });
  mo.observe(panel, { attributes: true, attributeFilter: ['class', 'style'] });

  // Hook mouse moves to apply border when conditions are met
  function onMove(e) {
    const el = (e.composedPath && e.composedPath()[0]) || e.target;
    if (!(el instanceof Element)) return;

    const panelVisible = panel.classList.contains('visible') || panel.style.display !== 'none';
    if (!panelVisible || !enableBorder) {
      // If not active, ensure previous border is cleared
      clearBorder();
      return;
    }

    // avoid marking our own UI elements
    if (panel.contains(el)) return;

    if (lastBordered !== el) {
      clearBorder();
      // Don’t decorate <html>/<body> to avoid goofy outlines
      const tn = el.tagName;
      if (tn !== 'HTML' && tn !== 'BODY') {
        el.setAttribute('data-firefind-border', '');
        lastBordered = el;
      }
    }
  }

  window.addEventListener('mousemove', onMove, { passive: true });
  window.addEventListener('mouseover', onMove, { passive: true });

  // Also clear when leaving the document (optional)
  window.addEventListener('blur', clearBorder);
})();

