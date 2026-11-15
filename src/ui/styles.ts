export const CSS = `
.pz-reader, .pz-dock { color: var(--b3-theme-on-background); font-size: 14px; }
.pz-reader { position: relative; height: 100%; display: flex; flex-direction: column; background: var(--b3-theme-background); transition:box-shadow .16s ease; container-type:inline-size; }
.pz-reader.is-workspace-active { box-shadow:inset 3px 0 0 var(--b3-theme-primary); }
.pz-toolbar { display: flex; align-items: center; flex-wrap: nowrap; overflow:hidden; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--b3-border-color); flex: 0 0 auto; min-height: 40px; position: relative; z-index: 7; background: var(--b3-theme-background); }
.pz-toolbar .pz-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 80px; }
.pz-reader-active-dot { display:none; width:7px; height:7px; border-radius:50%; background:var(--b3-theme-primary); flex:0 0 auto; }
.pz-compact-meta { display:none; flex:0 0 auto; font-size:11px; color:var(--b3-theme-on-surface-variant); white-space:nowrap; }
.pz-reader.is-workspace-inactive .pz-topbar { min-height:28px; padding:3px 8px; gap:5px; cursor:pointer; }
.pz-reader.is-workspace-inactive .pz-topbar:not(.pz-shared-toolbar) > :not(.pz-reader-active-dot):not(.pz-title):not(.pz-compact-meta) { display:none !important; }
.pz-reader.is-workspace-inactive .pz-compact-meta { display:inline; }
.pz-reader.is-workspace-active .pz-reader-active-dot { display:inline-block; }
/* Non-host reader: a stable one-line tab caption; the full color toolbar stays on the host. */
.pz-reader .pz-topbar.pz-compact-toolbar { min-height:28px !important; max-height:28px !important; padding:3px 8px !important; gap:5px !important; cursor:pointer; }
.pz-reader .pz-topbar.pz-compact-toolbar > :not(.pz-reader-active-dot):not(.pz-title):not(.pz-compact-meta) { display:none !important; }
.pz-reader .pz-topbar.pz-compact-toolbar > .pz-title { display:block !important; }
.pz-reader .pz-topbar.pz-compact-toolbar > .pz-compact-meta { display:inline !important; }
.pz-reader.is-workspace-inactive .pz-topbar.pz-shared-toolbar { min-height:40px; padding:6px 10px; gap:6px; cursor:default; }
.pz-reader.is-workspace-inactive .pz-topbar.pz-shared-toolbar > * { display:inline-flex !important; }
.pz-reader.is-workspace-inactive .pz-topbar.pz-shared-toolbar > .pz-title { display:block !important; }
.pz-reader.is-workspace-inactive .pz-topbar.pz-shared-toolbar > .pz-sep { display:block !important; }
.pz-reader.is-workspace-inactive .pz-topbar.pz-shared-toolbar > .pz-compact-meta { display:none !important; }
.pz-topbar.pz-shared-toolbar { border-bottom-color:var(--b3-theme-primary); box-shadow:0 1px 0 color-mix(in srgb,var(--b3-theme-primary) 35%,transparent); }
.pz-topbar.pz-shared-toolbar .pz-title::before { content:"当前 PDF · "; color:var(--b3-theme-primary); font-weight:500; }
.pz-topbar:not(.pz-host-caption) { display:flex !important; visibility:visible !important; opacity:1 !important; transform:none !important; pointer-events:auto !important; flex:0 0 40px; min-height:40px; max-height:40px; position:relative !important; top:0; }
.pz-topbar.pz-shared-toolbar { display:flex !important; visibility:visible !important; opacity:1 !important; pointer-events:auto !important; flex:0 0 40px !important; min-height:40px !important; max-height:40px !important; overflow:hidden; }
.pz-topbar.pz-host-caption { display:none !important; }
.pz-topbar.pz-host-caption > :not(.pz-reader-active-dot):not(.pz-title):not(.pz-compact-meta) { display:none !important; }
.pz-topbar.pz-host-caption > .pz-title { display:block !important; }
.pz-topbar.pz-host-caption > .pz-compact-meta { display:inline !important; }
.pz-toolbar button, .pz-bottombar button, .pz-dock button, .pz-float button { border: 1px solid var(--b3-border-color); background: var(--b3-theme-surface); color: var(--b3-theme-on-surface); border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 13px; }
.pz-toolbar button:hover, .pz-bottombar button:hover, .pz-dock button:hover, .pz-float button:hover { background: var(--b3-theme-surface-lighter); }
.pz-toolbar button:disabled, .pz-bottombar button:disabled { opacity: .45; cursor: default; }
.pz-page-input { width: 48px; text-align: center; border: 1px solid var(--b3-border-color); background: var(--b3-theme-surface); color: var(--b3-theme-on-surface); border-radius: 6px; padding: 2px 4px; }
.pz-sep { width: 1px; height: 18px; background: var(--b3-border-color); margin: 0 2px; }
.pz-body { flex: 1; min-height: 0; display: flex; position: relative; overflow: hidden; }
.pz-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position:relative; }
.pz-pages { flex: 1; min-width: 0; min-height: 0; overflow: auto; background: #4b4f56; padding: 18px 12px; scroll-behavior: auto; overflow-anchor: none; }
.pz-bottombar { display:flex; align-items:center; flex-wrap:nowrap; white-space:nowrap; gap:6px; padding:5px 8px; border:1px solid var(--b3-border-color); border-radius:8px; background:color-mix(in srgb,var(--b3-theme-background) 94%,transparent); box-shadow:0 3px 14px rgba(0,0,0,.20); position:absolute; z-index:7; left:50%; bottom:9px; max-width:calc(100% - 20px); overflow:hidden; transform:translate(-50%,8px); opacity:0; pointer-events:none; transition:opacity .16s ease,transform .16s ease; }
.pz-reader.is-workspace-active .pz-main:hover .pz-bottombar,
.pz-reader.is-workspace-active .pz-bottombar:focus-within { opacity:1; transform:translate(-50%,0); pointer-events:auto; }
.pz-reader.is-workspace-inactive .pz-bottombar { display:none; }
.pz-view-mode { display:inline-flex; align-items:center; gap:4px; max-width:92px; }
.pz-view-mode [data-role="view-mode-label"] { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* Overlay drawer: opening outline/panel must never resize or reflow PDF pages. */
.pz-side { display: none; position: absolute; inset: 0 auto 0 0; z-index: 30; width: min(340px, 82%); overflow: auto; background: var(--b3-theme-surface); padding: 10px; border-right: 1px solid var(--b3-border-color); box-shadow: 8px 0 24px rgba(0,0,0,.28); }
.pz-side.is-open { display: block; }
.pz-side-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: 12px; color: var(--b3-theme-on-surface-variant); }
.pz-side-close { border: 1px solid var(--b3-border-color); background: var(--b3-theme-background); color: var(--b3-theme-on-surface); border-radius: 5px; width: 22px; height: 22px; cursor: pointer; line-height: 1; }
img[data-src*="#pz="], img[src*="#pz="] { cursor: pointer; outline: 0 !important; border: 0 !important; box-shadow: none !important; }
.pz-return-target { animation: pz-target-pulse 1s ease-in-out 2; }
@keyframes pz-target-pulse { 50% { opacity: .35; } }
.pz-shot-caption { margin-left: 6px; font-size: 12px; color: var(--b3-theme-on-surface); }
/* PDF++-style backlink callout: pastel title band, white excerpt body, no full tint. */
.protyle-wysiwyg :is(.bq,[data-type="NodeCallout"])[custom-pz-callout="true"] {
  --pz-callout-rgb: 255, 208, 0;
  --pz-callout-title-color: #6f81ef;
  --pz-callout-band-alpha: .28;
  --pz-callout-body-bg: color-mix(in srgb, var(--b3-theme-background) 94%, rgb(var(--pz-callout-rgb)) 6%);
  margin: 12px 0; padding: 0 !important; overflow: hidden;
  border: 1px solid rgba(var(--pz-callout-rgb), .55); border-radius: 8px;
  background: var(--pz-callout-body-bg) !important; background-image: none !important;
  color: var(--b3-theme-on-background) !important;
  -webkit-text-fill-color: var(--b3-theme-on-background) !important;
  box-shadow: 0 1px 3px rgba(0,0,0,.07);
}
.protyle-wysiwyg :is(.bq,[data-type="NodeCallout"])[custom-pz-callout="true"][custom-pz-color="red"] { --pz-callout-rgb: 234, 82, 82; --pz-callout-band-alpha: .42; }
.protyle-wysiwyg :is(.bq,[data-type="NodeCallout"])[custom-pz-callout="true"][custom-pz-color="blue"] { --pz-callout-rgb: 8, 109, 221; --pz-callout-band-alpha: .26; }
.protyle-wysiwyg :is(.bq,[data-type="NodeCallout"])[custom-pz-callout="true"][custom-pz-color="purple"] { --pz-callout-rgb: 187, 97, 229; --pz-callout-band-alpha: .40; }
.protyle-wysiwyg :is(.bq,[data-type="NodeCallout"])[custom-pz-callout="true"][custom-pz-color="none"] { --pz-callout-rgb: 130, 130, 130; --pz-callout-band-alpha: .18; }
.protyle-wysiwyg :is(.bq,[data-type="NodeCallout"])[custom-pz-callout="true"]::before,
.protyle-wysiwyg :is(.bq,[data-type="NodeCallout"])[custom-pz-callout="true"]::after {
  content: none !important; background: transparent !important; background-image: none !important;
}
.protyle-wysiwyg :is(.bq,[data-type="NodeCallout"])[custom-pz-callout="true"] > div { padding: 0 !important; }
.protyle-wysiwyg :is(.bq,[data-type="NodeCallout"])[custom-pz-callout="true"] > .p,
.protyle-wysiwyg :is(.bq,[data-type="NodeCallout"])[custom-pz-callout="true"] > div > .p {
  margin: 0 !important; padding: 10px 14px !important; min-height: 20px;
  border: 0 !important; background: var(--pz-callout-body-bg) !important; background-image: none !important;
  color: var(--b3-theme-on-background) !important; -webkit-text-fill-color: var(--b3-theme-on-background) !important;
}
/* Title band: the first paragraph contains a linked "🔗 p.N" label. */
.protyle-wysiwyg .bq[custom-pz-callout="true"] > .p:first-of-type,
.protyle-wysiwyg .bq[custom-pz-callout="true"] > div > .p:first-child {
  padding: 7px 14px !important;
  color: var(--pz-callout-title-color) !important;
  -webkit-text-fill-color: var(--pz-callout-title-color) !important;
  background: rgba(var(--pz-callout-rgb), var(--pz-callout-band-alpha)) !important;
  background-image: none !important;
  border-bottom: 1px solid rgba(var(--pz-callout-rgb), .42) !important;
  border-radius: 8px 8px 0 0;
  font-size: .92em; font-weight: 400;
}
/* The chain glyph is outside the link and stays white like PDF++. */
.protyle-wysiwyg .bq[custom-pz-callout="true"] > .p:first-of-type::before,
.protyle-wysiwyg .bq[custom-pz-callout="true"] > div > .p:first-child::before {
  content: "🔗 "; color: #fff !important; -webkit-text-fill-color: #fff !important; font-weight: 400;
}
/* Body: keep the excerpt on a clean background, not a tinted card. */
.protyle-wysiwyg :is(.bq,[data-type="NodeCallout"])[custom-pz-callout="true"] > .p:not(:first-of-type),
.protyle-wysiwyg :is(.bq,[data-type="NodeCallout"])[custom-pz-callout="true"] > div > .p:not(:first-child),
.protyle-wysiwyg [data-type="NodeCallout"][custom-pz-callout="true"] :is(.callout__content,.callout-content),
.protyle-wysiwyg [data-type="NodeCallout"][custom-pz-callout="true"] :is(.callout__content,.callout-content) > .p {
  background: var(--pz-callout-body-bg) !important; background-image: none !important;
  color: var(--b3-theme-on-background) !important; -webkit-text-fill-color: var(--b3-theme-on-background) !important;
}
.protyle-wysiwyg :is(.bq,[data-type="NodeCallout"])[custom-pz-callout="true"] > .p:not(:first-of-type) *,
.protyle-wysiwyg :is(.bq,[data-type="NodeCallout"])[custom-pz-callout="true"] > div > .p:not(:first-child) *,
.protyle-wysiwyg [data-type="NodeCallout"][custom-pz-callout="true"] :is(.callout__content,.callout-content) * {
  color: inherit !important; -webkit-text-fill-color: inherit !important;
}
.protyle-wysiwyg .bq[custom-pz-callout="true"] > .p:first-of-type :is(a,[data-type="a"]),
.protyle-wysiwyg .bq[custom-pz-callout="true"] > div > .p:first-child :is(a,[data-type="a"]) {
  color: var(--pz-callout-title-color) !important;
  -webkit-text-fill-color: var(--pz-callout-title-color) !important;
  text-decoration: underline; text-underline-offset: 2px;
}
/* Native SiYuan NodeCallout (created by > [!PDF|color]): title band + white body. */
.protyle-wysiwyg [data-type="NodeCallout"][custom-pz-callout="true"] > .callout-info {
  padding: 0 !important; margin: 0 !important;
  background: rgba(var(--pz-callout-rgb), var(--pz-callout-band-alpha)) !important;
  background-image: none !important;
  border-bottom: 1px solid rgba(var(--pz-callout-rgb), .42) !important;
  border-radius: 8px 8px 0 0;
}
.protyle-wysiwyg [data-type="NodeCallout"][custom-pz-callout="true"] .callout-icon {
  display: none !important;
}
.protyle-wysiwyg [data-type="NodeCallout"][custom-pz-callout="true"] .callout-title::before {
  content: "🔗 "; font-weight: 400;
  color: #fff !important; -webkit-text-fill-color: #fff !important;
}
.protyle-wysiwyg [data-type="NodeCallout"][custom-pz-callout="true"] .callout-title {
  display: block; padding: 7px 14px !important; margin: 0 !important;
  color: var(--pz-callout-title-color) !important;
  -webkit-text-fill-color: var(--pz-callout-title-color) !important;
  font-size: .92em; font-weight: 400; line-height: 1.35;
}
.protyle-wysiwyg [data-type="NodeCallout"][custom-pz-callout="true"] .callout-title :is(a,[data-type="a"]) {
  color: var(--pz-callout-title-color) !important;
  -webkit-text-fill-color: var(--pz-callout-title-color) !important;
  text-decoration: underline; text-underline-offset: 2px;
}
.protyle-wysiwyg [data-type="NodeCallout"][custom-pz-callout="true"] > .callout-content {
  padding: 0 !important; margin: 0 !important;
  background: var(--pz-callout-body-bg) !important; background-image: none !important;
  color: var(--b3-theme-on-background) !important;
  -webkit-text-fill-color: var(--b3-theme-on-background) !important;
}
.protyle-wysiwyg [data-type="NodeCallout"][custom-pz-callout="true"] > .callout-content > .p {
  margin: 0 !important; padding: 10px 14px !important; border: 0 !important;
  background: var(--pz-callout-body-bg) !important;
  color: var(--b3-theme-on-background) !important;
  -webkit-text-fill-color: var(--b3-theme-on-background) !important;
}
.protyle-wysiwyg [data-type="NodeCallout"][custom-pz-callout="true"] > .callout-content * {
  color: inherit !important; -webkit-text-fill-color: inherit !important;
}
.protyle-wysiwyg [data-type="NodeCallout"][custom-pz-callout="true"] > .callout-content .p,
.protyle-wysiwyg [data-type="NodeCallout"][custom-pz-callout="true"] > .callout-content .p > div {
  font-weight: 400 !important; font-style: normal !important; font-family: inherit !important;
}
/* Index table column visibility toggled by the in-document filter bar. */
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols] { table-layout: auto !important; }
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="1"] col:nth-child(1),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="1"] th:nth-child(1),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="1"] td:nth-child(1) { display: none !important; }
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="2"] col:nth-child(2),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="2"] th:nth-child(2),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="2"] td:nth-child(2) { display: none !important; }
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="3"] col:nth-child(3),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="3"] th:nth-child(3),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="3"] td:nth-child(3) { display: none !important; }
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="4"] col:nth-child(4),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="4"] th:nth-child(4),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="4"] td:nth-child(4) { display: none !important; }
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="5"] col:nth-child(5),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="5"] th:nth-child(5),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="5"] td:nth-child(5) { display: none !important; }
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="6"] col:nth-child(6),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="6"] th:nth-child(6),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="6"] td:nth-child(6) { display: none !important; }
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="7"] col:nth-child(7),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="7"] th:nth-child(7),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="7"] td:nth-child(7) { display: none !important; }
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="8"] col:nth-child(8),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="8"] th:nth-child(8),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="8"] td:nth-child(8) { display: none !important; }
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="9"] col:nth-child(9),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="9"] th:nth-child(9),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="9"] td:nth-child(9) { display: none !important; }
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="10"] col:nth-child(10),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="10"] th:nth-child(10),
.protyle-wysiwyg [data-type="NodeTable"][custom-ai-hidden-cols~="10"] td:nth-child(10) { display: none !important; }
.pz-page { position: relative; margin: 0 auto 18px; background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.35); overflow: hidden; }
.pz-canvas { position: absolute; inset: 0; display: block; }
.pz-text-layer { position: absolute; inset: 0; overflow: hidden; line-height: 1; text-align: initial; text-size-adjust: none; forced-color-adjust: none; transform-origin: 0 0; z-index: 2; }
.pz-text-layer :is(span, br) { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; user-select: text; }
.pz-text-layer .markedContent { display: contents; }
.pz-text-layer ::selection { background: transparent; color: transparent; }
.pz-live-selection { position: fixed; inset: 0; z-index: 5000; pointer-events: none; }
.pz-live-selection-rect { position: absolute; border-radius: 2px; background: rgba(0, 100, 255, .25); }
.pz-overlay { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
.pz-highlight { position: absolute; border-radius: 2px; mix-blend-mode: multiply; pointer-events: auto; cursor: context-menu; }
.pz-page-label { position: absolute; right: 6px; bottom: 4px; z-index: 4; font-size: 11px; color: rgba(0,0,0,.45); background: rgba(255,255,255,.65); padding: 0 4px; border-radius: 3px; pointer-events: none; }
.pz-side h3 { margin: 4px 0 10px; font-size: 14px; }
.pz-side .pz-empty { color: var(--b3-theme-on-surface-variant); font-size: 12px; line-height: 1.6; }
.pz-ann-card { border: 1px solid var(--b3-border-color); border-radius: 8px; padding: 8px; margin-bottom: 8px; background: var(--b3-theme-background); }
.pz-ann-card .pz-ann-text { font-size: 12px; line-height: 1.5; margin-bottom: 6px; }
.pz-ann-card .pz-ann-meta { font-size: 11px; color: var(--b3-theme-on-surface-variant); margin-bottom: 6px; }
.pz-ann-card .pz-ann-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.pz-ann-card .pz-ann-actions button { font-size: 12px; padding: 2px 6px; }
.pz-ann-card .pz-ann-translation { font-size: 12px; line-height: 1.5; margin-bottom: 6px; padding: 6px 8px; border-left: 2px solid var(--b3-theme-primary); background: var(--b3-theme-surface-lighter); color: var(--b3-theme-on-surface-variant); }
.pz-translation-popup { position: fixed; z-index: 99998; width: min(380px, calc(100vw - 24px)); max-height: min(70vh, 520px); display: flex; flex-direction: column; background: var(--b3-theme-background); border: 1px solid var(--b3-border-color); border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.28); overflow: hidden; }
.pz-translation-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--b3-border-color); font-size: 12px; }
.pz-translation-head span { color: var(--b3-theme-on-surface-variant); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pz-translation-close { margin-left: auto; border: 0; background: transparent; color: var(--b3-theme-on-surface); font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px; }
.pz-translation-body { overflow: auto; padding: 8px 10px; }
.pz-translation-source { font-size: 12px; line-height: 1.55; color: var(--b3-theme-on-surface-variant); padding-bottom: 8px; margin-bottom: 8px; border-bottom: 1px dashed var(--b3-border-color); white-space: pre-wrap; }
.pz-translation-result { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.pz-translation-result.is-loading { color: var(--b3-theme-on-surface-variant); }
.pz-translation-result.is-error { color: var(--b3-theme-error); }
.pz-translation-actions { display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; padding: 8px 10px; border-top: 1px solid var(--b3-border-color); }
.pz-translation-actions button { font-size: 12px; padding: 3px 8px; border: 1px solid var(--b3-border-color); border-radius: 6px; background: var(--b3-theme-surface); color: var(--b3-theme-on-surface); cursor: pointer; }
.pz-translation-actions button:hover { background: var(--b3-theme-surface-lighter); }
.pz-qa-panel { position: relative; z-index: 1000; flex: 0 0 360px; width: 360px; height: 100%; display: flex; flex-direction: column; min-height: 0; overflow: hidden; border-left: 1px solid var(--b3-border-color); background: var(--b3-theme-background); }
.pz-qa-panel[hidden] { display: none; }
.pz-qa-resizer { position: absolute; z-index: 3; left: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; }
.pz-qa-resizer:hover { background: color-mix(in srgb, var(--b3-theme-primary) 30%, transparent); }
.pz-qa-panel.is-floating .pz-qa-resizer { display: none; }
.pz-qa-panel.is-floating { position: absolute; z-index: 1000; left: 30px; top: 30px; right: auto; bottom: auto; width: 380px; height: 560px; max-width: calc(100% - 16px); max-height: calc(100% - 16px); border: 1px solid var(--b3-border-color); border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
.pz-qa-resize-handle { display: none; position: absolute; z-index: 12; }
.pz-qa-panel.is-floating .pz-qa-resize-handle { display: block; }
.pz-qa-resize-handle.is-n { top: 0; left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
.pz-qa-resize-handle.is-s { bottom: 0; left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
.pz-qa-resize-handle.is-e { right: 0; top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }
.pz-qa-resize-handle.is-w { left: 0; top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }
.pz-qa-resize-handle.is-ne { right: 0; top: 0; width: 14px; height: 14px; cursor: nesw-resize; }
.pz-qa-resize-handle.is-nw { left: 0; top: 0; width: 14px; height: 14px; cursor: nwse-resize; }
.pz-qa-resize-handle.is-se { right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; }
.pz-qa-resize-handle.is-sw { left: 0; bottom: 0; width: 14px; height: 14px; cursor: nesw-resize; }
.pz-qa-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--b3-border-color); cursor: default; }
.pz-qa-panel.is-floating .pz-qa-head { cursor: move; }
.pz-qa-head > div:first-child { display: flex; flex-direction: column; min-width: 0; }
.pz-qa-head strong { font-size: 13px; }
.pz-qa-head small { color: var(--b3-theme-on-surface-variant); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pz-qa-session-list { position: absolute; z-index: 8; left: 8px; right: 8px; top: 44px; bottom: 8px; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--b3-border-color); border-radius: 8px; background: var(--b3-theme-background); box-shadow: 0 8px 24px rgba(0,0,0,.2); }
.pz-qa-session-list[hidden] { display: none; }
.pz-qa-session-list.is-drawer { position: absolute; left: auto; top: 0; bottom: 0; width: 270px; max-width: 45%; border-radius: 8px 0 0 8px; }
.pz-qa-sessions-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-bottom: 1px solid var(--b3-border-color); font-size: 12px; }
.pz-qa-sessions-head-actions { display: flex; align-items: center; gap: 5px; }
.pz-qa-sessions-head-actions button { border: 0; background: transparent; color: var(--b3-theme-on-surface); cursor: pointer; font-size: 11px; padding: 1px 3px; }
.pz-qa-sessions-head-actions button:first-child:not(:last-child) { color: var(--b3-theme-error, #d9534f); }
.pz-qa-session-group { padding: 7px 12px 3px; color: var(--b3-theme-on-surface-variant); font-size: 10px; }
.pz-qa-session-card.is-selected { border-color: var(--b3-theme-primary); background: color-mix(in srgb, var(--b3-theme-primary) 10%, var(--b3-theme-background)); }
.pz-qa-session-check { margin-right: 5px; color: var(--b3-theme-primary); }
.pz-qa-session-rename { width: 100%; box-sizing: border-box; padding: 2px 4px; border: 1px solid var(--b3-theme-primary); border-radius: 4px; background: var(--b3-theme-background); color: var(--b3-theme-on-background); font-size: 12px; }
.pz-qa-session-empty { padding: 24px 10px; text-align: center; color: var(--b3-theme-on-surface-variant); font-size: 12px; }
.pz-qa-sessions-head button { border: 0; background: transparent; color: var(--b3-theme-on-surface); cursor: pointer; font-size: 14px; }
.pz-qa-session-new { margin: 7px 8px 4px; padding: 5px; border: 1px dashed var(--b3-border-color); border-radius: 5px; background: transparent; color: var(--b3-theme-primary); cursor: pointer; font-size: 12px; }
.pz-qa-session-card { margin: 4px 7px; padding: 6px 7px; border: 1px solid transparent; border-radius: 6px; background: var(--b3-theme-surface); }
.pz-qa-session-card.is-active { border-color: var(--b3-theme-primary); }
.pz-qa-session-main { display: flex; flex-direction: column; width: 100%; gap: 2px; padding: 0; border: 0; background: transparent; color: var(--b3-theme-on-surface); text-align: left; cursor: pointer; }
.pz-qa-session-main strong { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pz-qa-session-main small { font-size: 10px; color: var(--b3-theme-on-surface-variant); }
.pz-qa-session-actions { display: flex; gap: 5px; justify-content: flex-end; margin-top: 3px; opacity: 0; transition: opacity .12s; }
.pz-qa-session-card:hover .pz-qa-session-actions { opacity: 1; }
.pz-qa-session-actions button { border: 0; background: transparent; color: var(--b3-theme-on-surface-variant); cursor: pointer; font-size: 10px; }
.pz-qa-session-actions button:hover { color: var(--b3-theme-primary); }
.pz-qa-context-menu { position: fixed; z-index: 1000020; min-width: 150px; padding: 5px; border: 1px solid var(--b3-border-color); border-radius: 8px; background: var(--b3-theme-background); box-shadow: 0 8px 24px rgba(0,0,0,.24); }
.pz-qa-context-menu button { display: block; width: 100%; padding: 6px 9px; border: 0; border-radius: 5px; background: transparent; color: var(--b3-theme-on-surface); text-align: left; font-size: 12px; cursor: pointer; }
.pz-qa-context-menu button:hover { background: var(--b3-theme-surface-lighter); }
.pz-qa-context-menu button.is-danger { color: var(--b3-theme-error, #d9534f); }
.pz-qa-text-menu { min-width: 130px; }
.pz-qa-turn-rail { position: absolute; z-index: 5; right: 4px; left: auto; top: 54px; bottom: 132px; width: 18px; display: flex; flex-direction: column; justify-content: center; align-items: flex-end; gap: 6px; pointer-events: auto; padding: 2px 3px 2px 0; }
.pz-qa-turn-rail[hidden] { display: none; }
.pz-qa-turn-marker { position: relative; z-index: 1; flex: 0 0 auto; width: 12px; height: 2px; padding: 0; border: 0; border-radius: 1px; background: var(--b3-theme-on-surface); cursor: pointer; pointer-events: auto; opacity: .42; transition: width .12s, height .12s, opacity .12s, background .12s; }
.pz-qa-turn-marker:hover, .pz-qa-turn-marker.is-active { width: 18px; height: 3px; opacity: 1; background: var(--b3-theme-on-background); }
.pz-qa-turn-marker::after { content: attr(data-preview); position: absolute; z-index: 20; right: 18px; left: auto; top: 50%; transform: translateY(-50%); width: 230px; max-height: 90px; overflow: hidden; padding: 7px 8px; border: 1px solid var(--b3-border-color); border-radius: 6px; background: var(--b3-theme-background); color: var(--b3-theme-on-surface); box-shadow: 0 6px 20px rgba(0,0,0,.22); font-size: 11px; line-height: 1.45; white-space: normal; opacity: 0; visibility: hidden; pointer-events: none; transition: opacity .12s; }
.pz-qa-turn-marker:hover::after { opacity: 1; visibility: visible; }
.pz-qa-head-actions { display: flex; gap: 4px; }
.pz-qa-head-actions button { border: 0; background: transparent; color: var(--b3-theme-on-surface); cursor: pointer; font-size: 12px; padding: 2px 4px; }
.pz-qa-messages { flex: 1; min-height: 0; overflow: auto; padding: 10px 28px 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.pz-qa-empty { color: var(--b3-theme-on-surface-variant); font-size: 12px; line-height: 1.6; padding: 20px 6px; text-align: center; }
.pz-qa-message { max-width: 92%; padding: 8px 10px; border-radius: 9px; font-size: 13px; line-height: 1.6; }
.pz-qa-message.is-user { align-self: flex-end; background: var(--b3-theme-primary); color: #fff; }
.pz-qa-message.is-assistant { align-self: flex-start; background: var(--b3-theme-surface); color: var(--b3-theme-on-background); }
.pz-qa-text { white-space: pre-wrap; word-break: break-word; user-select: text; cursor: text; }
.pz-qa-message.is-assistant .pz-qa-text { white-space: normal; }
.pz-qa-text > :first-child { margin-top: 0; }
.pz-qa-text > :last-child { margin-bottom: 0; }
.pz-qa-text p { margin: 4px 0; }
.pz-qa-text a { color: var(--b3-theme-primary); text-decoration: none; }
.pz-qa-text a:hover { text-decoration: underline; }
.pz-qa-text u { text-decoration: none; }
.pz-qa-text h1, .pz-qa-text h2, .pz-qa-text h3, .pz-qa-text h4 { color: var(--b3-theme-on-background); }
.pz-qa-text ul, .pz-qa-text ol { margin: 4px 0; padding-left: 20px; }
.pz-qa-text li { margin: 2px 0; }
.pz-qa-text h1, .pz-qa-text h2, .pz-qa-text h3, .pz-qa-text h4 { margin: 8px 0 4px; line-height: 1.35; }
.pz-qa-text h1 { font-size: 16px; }
.pz-qa-text h2 { font-size: 15px; }
.pz-qa-text h3, .pz-qa-text h4 { font-size: 14px; }
.pz-qa-text code { padding: 1px 4px; border-radius: 3px; background: var(--b3-theme-surface-lighter); font-family: monospace; font-size: .92em; }
.pz-qa-text pre { margin: 6px 0; padding: 7px 8px; overflow: auto; border-radius: 5px; background: var(--b3-theme-surface-lighter); }
.pz-qa-text pre code { padding: 0; background: transparent; }
.pz-qa-text blockquote { margin: 5px 0; padding-left: 8px; border-left: 2px solid var(--b3-border-color); color: var(--b3-theme-on-surface-variant); }
.pz-qa-text table { border-collapse: collapse; margin: 6px 0; }
.pz-qa-text th, .pz-qa-text td { border: 1px solid var(--b3-border-color); padding: 3px 6px; }
.pz-qa-text .katex, .pz-qa-text [data-type="inline-math"], .pz-qa-text [data-type="math-block"] { font-size: 1.02em; }
.pz-qa-sources { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; font-size: 11px; color: var(--b3-theme-on-surface-variant); }
.pz-qa-message.is-user .pz-qa-sources { color: rgba(255,255,255,.8); }
.pz-qa-sources a { color: var(--b3-theme-primary); margin-right: 4px; }
.pz-qa-message-actions { display: flex; gap: 5px; margin-top: 6px; }
.pz-qa-message-actions button { border: 1px solid var(--b3-border-color); border-radius: 5px; background: var(--b3-theme-background); color: var(--b3-theme-on-surface); font-size: 11px; padding: 2px 6px; cursor: pointer; }
.pz-qa-message-files { margin-top: 4px; font-size: 11px; opacity: .78; }
.pz-qa-message.is-jump-highlight { outline: 2px solid var(--b3-theme-primary); outline-offset: 2px; }
.pz-qa-jump-menu { position: absolute; z-index: 6; left: 10px; right: 10px; top: 42px; max-height: 70%; display: flex; flex-direction: column; border: 1px solid var(--b3-border-color); border-radius: 8px; background: var(--b3-theme-background); box-shadow: 0 10px 28px rgba(0,0,0,.24); overflow: hidden; }
.pz-qa-jump-title { padding: 8px 10px; font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--b3-border-color); }
.pz-qa-jump-list { overflow: auto; padding: 5px; }
.pz-qa-jump-item { display: flex; flex-direction: column; width: 100%; gap: 2px; text-align: left; padding: 6px 7px; border: 0; border-radius: 5px; background: transparent; color: var(--b3-theme-on-surface); cursor: pointer; }
.pz-qa-jump-item:hover { background: var(--b3-theme-surface-lighter); }
.pz-qa-jump-item strong { color: var(--b3-theme-primary); font-size: 11px; }
.pz-qa-jump-item span { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pz-qa-jump-item small { font-size: 10px; color: var(--b3-theme-on-surface-variant); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pz-qa-jump-empty { padding: 15px 8px; font-size: 12px; color: var(--b3-theme-on-surface-variant); text-align: center; }
.pz-qa-jump-close { margin: 5px 10px 8px; align-self: flex-end; border: 0; background: transparent; color: var(--b3-theme-primary); cursor: pointer; font-size: 12px; }
.pz-qa-loading { color: var(--b3-theme-on-surface-variant); font-style: italic; }
.pz-qa-attachments { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 10px; }
.pz-qa-attachment-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 2px 6px; border-radius: 5px; background: var(--b3-theme-surface); font-size: 11px; }
.pz-qa-attachment-chip button { border: 0; background: transparent; color: var(--b3-theme-on-surface-variant); cursor: pointer; }
.pz-qa-composer { padding: 8px 10px 10px; border-top: 1px solid var(--b3-border-color); }
.pz-qa-composer textarea { width: 100%; min-height: 58px; max-height: 150px; resize: vertical; box-sizing: border-box; border: 1px solid var(--b3-border-color); border-radius: 6px; background: var(--b3-theme-surface); color: var(--b3-theme-on-surface); padding: 6px 8px; font-size: 13px; }
.pz-qa-composer-actions { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.pz-qa-composer-actions select { min-width: 0; flex: 1; font-size: 11px; }
.pz-qa-composer-actions button, .pz-qa-composer-actions select { height: 28px; border: 1px solid var(--b3-border-color); border-radius: 5px; background: var(--b3-theme-surface); color: var(--b3-theme-on-surface); font-size: 12px; padding: 0 7px; box-sizing: border-box; }
.pz-qa-composer-actions button { cursor: pointer; }
.pz-qa-composer-actions button:hover { background: var(--b3-theme-surface-lighter); }
.pz-qa-composer-actions button.pz-primary { background: var(--b3-theme-primary); color: #fff; border-color: transparent; }
[custom-qa-block="true"] { border: 1px solid var(--b3-border-color) !important; border-left: 1px solid var(--b3-border-color) !important; border-radius: 8px !important; background: color-mix(in srgb, var(--b3-theme-background) 92%, var(--b3-theme-primary) 8%) !important; padding: 9px 12px !important; }
[custom-qa-block="true"] > .p:first-child [data-type="strong"] { color: var(--b3-theme-primary) !important; }
[custom-qa-block="true"] > .p:nth-of-type(2) [data-type="strong"] { color: #3b82f6 !important; }
[custom-qa-block="true"] > .p:nth-of-type(4) [data-type="strong"] { color: #16a34a !important; }
.pz-qa-preview { margin-top: 10px; padding: 10px 12px; border: 1px solid #d7dcef; border-radius: 8px; background: #f7f8fd; font-size: 13px; line-height: 1.6; }
.pz-qa-preview-title { margin-bottom: 6px; font-weight: 700; color: #4f63d2; }
.pz-qa-preview-q { margin-bottom: 6px; color: #2563eb; }
.pz-qa-preview-a { color: #15803d; }
.pz-qa-preview strong { margin-right: 6px; }
.pz-settings-shell { display: flex; height: 600px; max-height: 72vh; min-height: 0; }
.pz-settings-nav { width: 168px; flex: 0 0 168px; display: flex; flex-direction: column; gap: 3px; padding: 12px 8px; overflow: auto; border-right: 1px solid var(--b3-border-color); background: var(--b3-theme-surface); }
.pz-settings-nav button { display: block; width: 100%; text-align: left; padding: 8px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--b3-theme-on-surface-variant); cursor: pointer; font-size: 13px; }
.pz-settings-nav button:hover { background: var(--b3-theme-surface-lighter); color: var(--b3-theme-on-surface); }
.pz-settings-nav button.is-active { background: var(--b3-theme-primary); color: #fff; }
.pz-settings-pages { flex: 1; min-width: 0; height: 100%; overflow: auto; padding: 14px 18px; scrollbar-gutter: stable; }
.pz-settings-page { display: none; }
.pz-settings-page.is-active { display: block; }
.pz-pdf2zh-hud { position: fixed; right: 18px; bottom: 24px; z-index: 99999; display: flex; align-items: flex-end; justify-content: flex-end; pointer-events: none; font-size: 12px; }
.pz-pdf2zh-hud > * { pointer-events: auto; }
.pz-pdf2zh-ring { --pz-progress: 0; width: 38px; height: 38px; border-radius: 50%; border: 0; padding: 0; cursor: pointer; color: var(--b3-theme-on-background); background: conic-gradient(var(--b3-theme-primary) calc(var(--pz-progress) * 1%), color-mix(in srgb, var(--b3-theme-primary) 16%, transparent) 0); position: relative; opacity: .68; filter: drop-shadow(0 2px 7px rgba(0,0,0,.2)); }
.pz-pdf2zh-ring::before { content: ""; position: absolute; inset: 4px; border-radius: 50%; background: color-mix(in srgb, var(--b3-theme-background) 82%, transparent); }
.pz-pdf2zh-ring span { position: relative; z-index: 1; font-size: 9px; font-weight: 600; }
.pz-pdf2zh-hud.is-indeterminate .pz-pdf2zh-ring { background: conic-gradient(from 0deg, var(--b3-theme-primary) 0 28%, color-mix(in srgb, var(--b3-theme-primary) 16%, transparent) 28% 100%); animation: pz-pdf2zh-spin 1.1s linear infinite; }
.pz-pdf2zh-hud[data-state="success"] .pz-pdf2zh-ring { background: #3fbf7f; opacity: 1; }
.pz-pdf2zh-hud[data-state="error"] .pz-pdf2zh-ring { background: var(--b3-theme-error); opacity: 1; }
.pz-pdf2zh-hud[data-state="error"] .pz-pdf2zh-ring span { color: #fff; }
.pz-pdf2zh-panel { width: min(420px, calc(100vw - 44px)); max-height: 45vh; margin-right: 8px; padding: 8px 10px; overflow: auto; border: 1px solid var(--b3-border-color); border-radius: 8px; background: color-mix(in srgb, var(--b3-theme-background) 94%, transparent); box-shadow: 0 8px 24px rgba(0,0,0,.22); }
.pz-pdf2zh-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.pz-pdf2zh-panel-head button { border: 0; background: transparent; color: var(--b3-theme-on-surface); cursor: pointer; font-size: 18px; line-height: 1; }
.pz-pdf2zh-panel-status { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
.pz-pdf2zh-panel-log { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--b3-border-color); max-height: 25vh; overflow: auto; white-space: pre-wrap; word-break: break-word; color: var(--b3-theme-on-surface-variant); font-size: 11px; }
@keyframes pz-pdf2zh-spin { to { transform: rotate(360deg); } }
.pz-float { position: fixed; z-index: 99999; display: flex; align-items: center; flex-wrap: wrap; max-width: min(560px, 92vw); gap: 5px; background: var(--b3-theme-surface); border: 1px solid var(--b3-border-color); box-shadow: 0 4px 18px rgba(0,0,0,.25); border-radius: 8px; padding: 6px; }
.pz-float .pz-format-select { max-width: 118px; font-size: 11px; border: 1px solid var(--b3-border-color); border-radius: 5px; background: var(--b3-theme-background); color: var(--b3-theme-on-surface); padding: 2px; }
.pz-float .pz-swatch { width: 18px; height: 18px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
.pz-float .pz-swatch.is-active { border-color: var(--b3-theme-on-background); }
.pz-float button.pz-primary { background: var(--b3-theme-primary); color: #fff; border-color: transparent; }
.pz-edit-menu { position: fixed; z-index: 100000; display:flex; align-items:center; gap:6px; padding:7px; border:1px solid var(--b3-border-color); border-radius:10px; background:var(--b3-theme-surface); box-shadow:0 6px 24px rgba(0,0,0,.28); }
.pz-edit-menu button { display:grid; place-items:center; border:0; background:transparent; cursor:pointer; }
.pz-edit-menu .pz-edit-swatch { width:24px; height:24px; padding:0; border-radius:50%; background:var(--pz-edit-color); box-shadow:inset 0 0 0 1px rgba(0,0,0,.16); }
.pz-edit-menu .pz-edit-swatch.is-none { background:linear-gradient(135deg,transparent 44%,#999 45%,#999 55%,transparent 56%); border:1px solid var(--b3-border-color); }
.pz-edit-menu .pz-edit-swatch.is-active { outline:2px solid var(--b3-theme-primary); outline-offset:2px; }
.pz-edit-menu .is-danger { width:26px; height:26px; margin-left:3px; padding:4px; border-left:1px solid var(--b3-border-color); border-radius:0 5px 5px 0; color:var(--b3-theme-error); }
.pz-edit-menu .is-danger svg { width:18px; height:18px; }
.pz-edit-menu button:hover { filter:brightness(.92); background-color:var(--b3-list-hover); }
.pz-flash { animation: pzFlash 1.8s ease-out; }
@keyframes pzFlash { 0% { box-shadow: 0 0 0 3px rgba(255, 210, 0, .95); } 100% { box-shadow: 0 0 0 18px rgba(255, 210, 0, 0); } }
.pz-dock { height: 100%; display: flex; flex-direction: column; padding: 10px; gap: 9px; overflow: hidden; box-sizing: border-box; }
.pz-dock h2 { margin: 0 0 2px; font-size: 16px; }
.pz-dock-head { display:flex; align-items:flex-start; justify-content:space-between; padding-bottom: 7px; border-bottom: 1px solid var(--b3-border-color); }
.pz-head-settings { width:28px; height:28px; padding:0 !important; border:0 !important; background:transparent !important; font-size:16px !important; }
.pz-dock-actions { gap: 5px !important; }
.pz-dock-actions button { flex: 1 1 calc(33.333% - 5px); white-space:nowrap; padding-inline:5px !important; }
.pz-dock-tabs { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:2px; padding:3px; border-radius:8px; background:var(--b3-theme-surface); }
.pz-dock-tabs button { min-width:0; border:0 !important; background:transparent !important; padding:6px 2px !important; color:var(--b3-theme-on-surface-variant); font-size:12px !important; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pz-dock-tabs button span { margin-left:2px; font-size:10px; opacity:.7; }
.pz-dock-tabs button.is-active { background:var(--b3-theme-background) !important; color:var(--b3-theme-primary); box-shadow:0 1px 4px rgba(0,0,0,.12); font-weight:600; }
.pz-dock-view { flex:1; min-height:0; display:flex; flex-direction:column; gap:8px; overflow:hidden; }
.pz-view-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.pz-view-heading > div { min-width:0; display:flex; flex-direction:column; }
.pz-view-heading strong { font-size:13px; }
.pz-view-heading small { color:var(--b3-theme-on-surface-variant); font-size:10px; }
.pz-view-heading > button, .pz-view-heading-actions button { flex:0 0 auto; font-size:11px !important; padding:3px 7px !important; }
.pz-view-heading > .pz-view-heading-actions { display:flex; flex-direction:row; align-items:center; gap:5px; flex:0 0 auto; }
.pz-dock-runtime { font-size: 12px; color: var(--b3-theme-on-surface-variant); }
.pz-dock-runtime summary { cursor: pointer; }
.pz-dock-filters { display: flex; flex-direction: column; gap: 6px; }
.pz-count { display: inline-flex; min-width: 20px; justify-content: center; border-radius: 10px; padding: 0 6px; background: var(--b3-theme-surface-lighter); }
.pz-pagination { display: flex; justify-content: center; align-items: center; gap: 10px; font-size: 12px; }
.pz-pagination button:disabled { opacity: .4; }
.pz-dock .pz-muted { color: var(--b3-theme-on-surface-variant); font-size: 12px; line-height: 1.5; }
.pz-dock .pz-status { border-radius: 6px; padding: 6px 8px; font-size: 12px; line-height: 1.5; }
.pz-dock .pz-status.ok { background: rgba(60, 180, 100, .16); }
.pz-dock .pz-status.err { background: rgba(220, 80, 80, .16); }
.pz-dock .pz-row { display: flex; gap: 8px; flex-wrap: wrap; }
.pz-dock .pz-list { display: flex; flex-direction: column; gap: 5px; min-height:0; overflow:auto; padding-right:2px; }
.pz-dock .pz-list-item { flex:0 0 auto; text-align: left; border: 1px solid var(--b3-border-color); border-radius: 7px; padding: 7px 9px; cursor: pointer; background: var(--b3-theme-background); }
.pz-dock .pz-list-item:hover { border-color: var(--b3-theme-primary); }
.pz-dock .pz-list-item .pz-item-title { display:flex; align-items:flex-start; gap:5px; font-size: 12px; line-height: 1.35; }
.pz-dock .pz-list-item .pz-item-meta { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size: 10px; color: var(--b3-theme-on-surface-variant); margin-top: 3px; }
.pz-dock .pz-list-item.is-current { border-color:var(--b3-theme-primary); background:color-mix(in srgb,var(--b3-theme-primary) 8%,var(--b3-theme-background)); }
.pz-dock .pz-list-item.is-pinned { box-shadow: inset 2px 0 0 var(--b3-theme-primary); }
.pz-pin-badge { display:inline-block; flex:0 0 auto; margin-right:4px; font-size:10px; vertical-align:1px; }
.pz-dock-context-menu { position:fixed; z-index:1000030; min-width:180px; padding:5px; border:1px solid var(--b3-border-color); border-radius:8px; background:var(--b3-theme-background); box-shadow:0 8px 24px rgba(0,0,0,.24); }
.pz-dock-context-menu button { display:block; width:100%; padding:6px 9px; border:0; border-radius:5px; background:transparent; color:var(--b3-theme-on-surface); text-align:left; font-size:12px; cursor:pointer; }
.pz-dock-context-menu button:hover:not(:disabled) { background:var(--b3-theme-surface-lighter); }
.pz-dock-context-menu button:disabled { opacity:.4; cursor:default; }
.pz-dock-context-menu button.is-danger { color:var(--b3-theme-error, #d9534f); }
.pz-dock-context-entry { position:relative; }
.pz-dock-context-menu button.has-submenu::after { content:"›"; float:right; margin-left:18px; }
.pz-dock-context-submenu { display:none; position:absolute; left:calc(100% - 2px); top:-5px; min-width:230px; padding:5px; border:1px solid var(--b3-border-color); border-radius:8px; background:var(--b3-theme-background); box-shadow:0 8px 24px rgba(0,0,0,.24); }
.pz-dock-context-entry.is-open > .pz-dock-context-submenu { display:block; }
.pz-current-badge { flex:0 0 auto; margin-left:auto; border-radius:8px; padding:1px 5px; background:var(--b3-theme-primary); color:var(--b3-theme-on-primary); font-size:9px; font-weight:500; }
.pz-zotero-list .pz-list-item .pz-item-title { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.pz-dock-empty { display:flex; flex-direction:column; align-items:center; gap:7px; margin:auto 8px; padding:24px 12px; text-align:center; color:var(--b3-theme-on-surface-variant); }
.pz-dock-empty strong { color:var(--b3-theme-on-background); font-size:13px; }
.pz-dock-empty span { font-size:11px; line-height:1.5; }
.pz-dock .pz-section-title { font-size: 12px; font-weight: 600; margin-top: 6px; color: var(--b3-theme-on-surface-variant); }
.pz-empty-reader { padding: 40px; text-align: center; color: var(--b3-theme-on-surface-variant); }

.pz-search-wrap { position: relative; display: flex; align-items: center; min-width:80px; flex:1 1 140px; }
.pz-search-input { width:100%; min-width:80px; max-width:140px; border: 1px solid var(--b3-border-color); background: var(--b3-theme-surface); color: var(--b3-theme-on-surface); border-radius: 6px; padding: 3px 6px; font-size: 13px; }
.pz-search-count { position: absolute; right: 6px; font-size: 11px; color: var(--b3-theme-on-surface-variant); pointer-events: none; }
.pz-toolbar button.is-active { background: var(--b3-theme-primary); color: #fff; border-color: transparent; }
.pz-links { position: absolute; inset: 0; z-index: 5; pointer-events: none; }
.pz-link-box { position: absolute; padding: 0; margin: 0; border: 0; background: rgba(0, 120, 255, 0.06); pointer-events: auto; cursor: pointer; border-radius: 2px; }
.pz-link-box:hover { background: rgba(0, 120, 255, 0.22); outline: 1px solid rgba(0, 120, 255, 0.55); }
.pz-search-layer { position: absolute; inset: 0; z-index: 4; pointer-events: none; }
.pz-search-hit { position: absolute; background: rgba(255, 214, 0, 0.45); border-radius: 2px; pointer-events: none; }
.pz-search-hit.is-active { background: rgba(255, 140, 0, 0.7); box-shadow: 0 0 0 1px rgba(255, 100, 0, 0.8); }
.pz-side-tabs { display: flex; gap: 3px; margin-bottom: 8px; flex-wrap: wrap; }
.pz-side-tabs button { font-size: 12px; padding: 2px 6px; border: 1px solid var(--b3-border-color); border-radius: 5px; background: var(--b3-theme-background); cursor: pointer; }
.pz-side-tabs button.is-active { background: var(--b3-theme-primary); color: #fff; border-color: transparent; }
.pz-outline-item, .pz-search-item { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 12px; line-height: 1.4; color: var(--b3-theme-on-background); }
.pz-outline-item:hover, .pz-search-item:hover { background: var(--b3-theme-surface-lighter); }
.pz-search-item.is-active { background: var(--b3-theme-primary); color: #fff; }
.pz-outline-page, .pz-search-page { float: right; font-size: 10px; color: var(--b3-theme-on-surface-variant); }
.pz-search-item.is-active .pz-search-page { color: #fff; }
.pz-backlink-card { border: 1px solid var(--b3-border-color); border-radius: 8px; padding: 8px; margin-bottom: 8px; background: var(--b3-theme-background); }
.pz-backlink-text { font-size: 12px; line-height: 1.45; margin-bottom: 5px; }
.pz-note-link { font-size: 11px; padding: 2px 6px; }
.pz-preview { position: fixed; z-index: 999999; display: none; width: 300px; max-width: 40vw; background: var(--b3-theme-surface); border: 1px solid var(--b3-border-color); border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,.28); padding: 8px; pointer-events: none; }
.pz-preview-title { font-size: 12px; font-weight: 600; margin-bottom: 5px; color: var(--b3-theme-on-surface); }
.pz-preview-text { font-size: 12px; line-height: 1.55; color: var(--b3-theme-on-background); max-height: 160px; overflow: hidden; }
.pz-preview-meta { font-size: 11px; color: var(--b3-theme-on-surface-variant); margin-top: 5px; }
.pz-preview-loading { font-size: 12px; color: var(--b3-theme-on-surface-variant); padding: 20px 0; text-align: center; }
.pz-preview-page { display: block; width: 100%; height: auto; margin-top: 4px; border-radius: 3px; }
.pz-preview-url { font-size: 11px; word-break: break-all; color: var(--b3-theme-on-surface-variant); }
.pz-pages.pz-shot-mode, .pz-pages.pz-rect-mode { cursor: crosshair; }
.pz-rect-btn { border-style: dashed !important; min-width: 30px; }
.pz-formatbar { display: flex; align-items: center; flex-wrap:nowrap; min-width:0; gap: 4px; }
.pz-page-placeholder { display:flex; align-items:center; justify-content:center; background:#fff; color:#777; }
.pz-page-loading { font-size:12px; opacity:.72; }
@container (max-width: 760px) {
  .pz-topbar { gap:3px; padding-inline:6px; }
  .pz-format-state { display:none; }
  .pz-format-trigger { max-width:36px; }
  .pz-bottombar { gap:3px; }
  .pz-bottombar button { padding-inline:6px; }
}
@container (max-width: 560px) {
  .pz-bottombar .pz-search-wrap, .pz-bottombar .pz-sep { display:none; }
  .pz-bottombar button { padding-inline:5px; }
  .pz-page-input { width:38px; }
}
.pz-tool-icon, .pz-format-trigger { height:28px; display:inline-flex; align-items:center; justify-content:center; gap:4px; padding:3px 6px !important; }
.pz-tool-icon { width:30px; }
.pz-tool-icon svg, .pz-format-trigger svg { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.pz-format-trigger { max-width:128px; }
.pz-format-state { max-width:82px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color:var(--b3-theme-on-surface-variant); }
.pz-format-caret { font-size:11px; line-height:1; color:var(--b3-theme-on-surface-variant); }
.pz-format-trigger:hover .pz-format-state, .pz-format-trigger:hover .pz-format-caret { color:inherit; }
.pz-format-color { width: 19px; height: 19px; border-radius: 50%; border: 2px solid rgba(0,0,0,.25) !important; background: var(--pz-color) !important; cursor: pointer; padding: 0 !important; }
.pz-format-color.is-none { background: transparent !important; }
.pz-format-color.is-none::after { content: ""; display: block; width: 15px; border-top: 2px solid #888; transform: rotate(-45deg); }
.pz-format-color.is-active { border-color: transparent !important; box-shadow: 0 0 0 2px var(--b3-theme-background); transform: scale(1.15); }
.pz-chevron { min-width: 28px; padding: 2px 4px !important; }
.pz-edit-format { min-width: 28px; padding: 2px 5px !important; }
.pz-format-menu { position: fixed; z-index: 1000000; min-width: 190px; padding: 5px; border: 1px solid var(--b3-border-color); border-radius: 7px; background: var(--b3-theme-surface); box-shadow: 0 8px 26px rgba(0,0,0,.28); }
.pz-format-menu button { display: grid; grid-template-columns: 20px 1fr; width: 100%; border: 0; border-radius: 5px; padding: 6px 8px; text-align: left; color: var(--b3-theme-on-surface); background: transparent; cursor: pointer; }
.pz-format-menu button:hover { background: var(--b3-theme-surface-lighter); }
.pz-format-menu button.is-active { color: var(--b3-theme-primary); }
.pz-selection-menu, .pz-selection-submenu { position:fixed; z-index:1000001; min-width:190px; padding:5px; border:1px solid var(--b3-border-color); border-radius:8px; background:var(--b3-theme-surface); box-shadow:0 8px 28px rgba(0,0,0,.25); }
.pz-selection-submenu { display:none; position:absolute; left:calc(100% - 3px); top:-5px; }
.pz-selection-row { position:relative; display:grid; grid-template-columns:18px 1fr; align-items:center; gap:5px; min-height:28px; padding:1px 8px; border-radius:5px; color:var(--b3-theme-on-surface); white-space:nowrap; cursor:default; box-sizing:border-box; }
.pz-selection-row:not(.is-heading):hover { background:var(--b3-list-hover); }
.pz-selection-row.has-submenu::after { content:"›"; position:absolute; right:8px; color:var(--b3-theme-on-surface-variant); }
.pz-selection-row.has-submenu:hover > .pz-selection-submenu { display:block; }
.pz-selection-menu.is-leftward .pz-selection-submenu { left:auto; right:calc(100% - 3px); }
.pz-selection-row.is-current::before { content:"✓"; position:absolute; right:25px; color:var(--b3-theme-on-surface); }
.pz-selection-row.is-leaf.is-current::before { right:8px; }
.pz-selection-row.is-heading { opacity:.55; border-bottom:1px solid var(--b3-border-color); margin-bottom:3px; }
.pz-selection-row.is-action { cursor:pointer; }
.pz-selection-dot { width:12px; height:12px; border-radius:50%; background:var(--pz-menu-color); box-shadow:inset 0 0 0 1px rgba(0,0,0,.08); }
.pz-selection-dot[style*="transparent"] { background:transparent; border:1px solid var(--b3-border-color); }
.pz-selection-icon { width:12px; }
.pz-selection-separator { height:1px; background:var(--b3-border-color); margin:4px 2px; }
.pz-shot-mode .pz-text-layer, .pz-shot-mode .pz-links, .pz-shot-mode .pz-overlay { pointer-events: none; }
.pz-shot-box { position: absolute; z-index: 20; border: 2px dashed var(--pz-selection-color, #ffd000); background: transparent; pointer-events: none; }
.pz-screenshot-region { position: absolute; pointer-events: auto; cursor: pointer; mix-blend-mode: multiply; border: 0; }
.pz-screenshot-region.is-locating { animation: pz-region-locate .7s ease-in-out 2; }
@keyframes pz-region-locate { 50% { opacity: .35; } }

.pz-citation-dialog { display: flex; flex-direction: column; gap: 8px; max-height: 62vh; }
.pz-citation-search-row { flex: 0 0 auto; }
.pz-citation-results { flex: 1 1 auto; min-height: 120px; max-height: 260px; overflow: auto; border: 1px solid var(--b3-border-color); border-radius: 6px; padding: 4px; }
.pz-pdf-action-menu { position:fixed; z-index:1000030; min-width:250px; padding:5px; border:1px solid var(--b3-border-color); border-radius:8px; background:var(--b3-theme-background); box-shadow:0 8px 24px rgba(0,0,0,.24); }
.pz-pdf-action-menu button { display:block; width:100%; padding:7px 10px; border:0; border-radius:5px; background:transparent; color:var(--b3-theme-on-surface); text-align:left; font-size:12px; cursor:pointer; }
.pz-pdf-action-menu button:hover { background:var(--b3-theme-surface-lighter); }
.pz-pdf-action-separator { height:1px; margin:5px 4px; background:var(--b3-border-color); }
.pz-template-preview { max-height: 28vh; overflow:auto; margin-top:8px; padding:8px; border:1px dashed var(--b3-border-color); border-radius:6px; background:var(--b3-theme-background); }
.pz-template-preview-content { font-size:12px; line-height:1.5; }
.pz-template-preview-content table { border-collapse:collapse; width:100%; }
.pz-template-preview-content td { border:1px solid var(--b3-border-color); padding:4px; }
.pz-matrix-dialog { max-height: 70vh; overflow: hidden; }
.pz-matrix-toolbar { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-bottom:6px; }
.pz-matrix-toolbar .b3-select, .pz-matrix-toolbar .b3-text-field { width:auto; height:30px; }
.pz-matrix-scroll { max-height:60vh; overflow:auto; border:1px solid var(--b3-border-color); border-radius:6px; }
.pz-matrix-table { border-collapse:separate; border-spacing:0; font-size:11px; min-width:100%; }
.pz-matrix-table th { position:sticky; top:0; z-index:1; background:var(--b3-theme-surface); border-bottom:1px solid var(--b3-border-color); border-right:1px solid var(--b3-border-color); padding:5px 6px; text-align:left; white-space:nowrap; }
.pz-matrix-table td { border-bottom:1px solid var(--b3-border-color); border-right:1px solid var(--b3-border-color); padding:3px 5px; vertical-align:top; min-width:80px; }
.pz-matrix-table tr:nth-child(even) td { background:var(--b3-theme-surface-lighter); }
.pz-matrix-index { width:36px; text-align:center !important; color:var(--b3-theme-on-surface-variant); }
.pz-matrix-readonly { min-height:24px; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pz-matrix-cell { width:100%; min-width:80px; box-sizing:border-box; font-size:11px; }
textarea.pz-matrix-cell { min-width:180px; resize:vertical; }
.pz-matrix-delete { border:0; background:transparent; color:var(--b3-theme-error, #d9534f); cursor:pointer; font-size:15px; }
.pz-matrix-row-fields { display:grid; grid-template-columns:1fr 1fr; gap:8px; max-height:55vh; overflow:auto; }
.pz-matrix-row-field { display:flex; flex-direction:column; gap:3px; font-size:12px; }
.pz-matrix-row-field:has(textarea) { grid-column:1 / -1; }
.pz-matrix-detail { border:1px solid var(--b3-border-color); background:var(--b3-theme-background); color:var(--b3-theme-on-surface); border-radius:4px; cursor:pointer; font-size:10px; padding:1px 4px; white-space:nowrap; }
.pz-matrix-group-row td { background:var(--b3-theme-surface) !important; font-weight:600; color:var(--b3-theme-on-surface); position:sticky; left:0; }
.pz-matrix-note { border:1px solid var(--b3-border-color); background:var(--b3-theme-background); color:var(--b3-theme-on-surface); border-radius:4px; cursor:pointer; font-size:10px; padding:1px 4px; white-space:nowrap; }
.pz-ocr-history { max-height: 60vh; overflow: auto; }
.pz-ocr-history-item { display:flex; gap:10px; justify-content:space-between; padding:8px; border-bottom:1px solid var(--b3-border-color); }
.pz-ocr-history-main { min-width:0; flex:1; }
.pz-ocr-history-title { font-size:12px; font-weight:600; }
.pz-ocr-history-preview { margin-top:3px; font-size:11px; color:var(--b3-theme-on-surface-variant); white-space:pre-wrap; word-break:break-word; max-height:60px; overflow:hidden; }
.pz-ocr-history-actions { display:flex; flex-wrap:wrap; gap:4px; align-content:flex-start; flex:0 0 190px; }
.pz-ocr-history-actions button { font-size:11px; padding:2px 6px; border:1px solid var(--b3-border-color); border-radius:4px; background:var(--b3-theme-background); color:var(--b3-theme-on-surface); cursor:pointer; }
.pz-ocr-history-actions button.is-danger { color:var(--b3-theme-error, #d9534f); }
.pz-ocr-preview-head { display:flex; gap:10px; margin-bottom:8px; font-size:12px; color:var(--b3-theme-on-surface-variant); }
.pz-style-picker-list { margin-top: 8px; max-height: 58vh; overflow: auto; border-top: 1px solid var(--b3-border-color); }
.pz-style-picker-hint { padding: 8px 6px 4px; font-size: 11px; }
.pz-style-option { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; padding: 7px 6px; border: 0; border-bottom: 1px solid var(--b3-border-color); background: transparent; color: var(--b3-theme-on-surface); text-align: left; cursor: pointer; }
.pz-style-option:hover, .pz-style-option.is-current { background: var(--b3-theme-surface-lighter); }
.pz-style-option > span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pz-style-option strong { font-size: 12px; }
.pz-style-option small { font-size: 10px; color: var(--b3-theme-on-surface-variant); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pz-style-option b { color: var(--b3-theme-primary); }
.pz-citation-result { display: flex; gap: 8px; align-items: flex-start; padding: 5px 7px; border-radius: 4px; cursor: pointer; }
.pz-citation-result:hover { background: var(--b3-theme-surface-lighter); }
.pz-citation-result-main { display: flex; flex-direction: column; gap: 2px; line-height: 1.35; }
.pz-citation-result-main small { color: var(--b3-theme-on-surface-variant); font-size: 11px; }
.pz-citation-form { display: flex; flex-direction: column; gap: 8px; }
.pz-citation-selected { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 28px; }
.pz-citation-selected-title { font-size: 12px; color: var(--b3-theme-on-surface-variant); width: 100%; }
.pz-citation-chip { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--b3-theme-surface-lighter); border-radius: 10px; padding: 2px 8px; font-size: 11px; }
`;
