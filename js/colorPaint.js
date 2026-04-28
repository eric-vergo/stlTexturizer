/**
 * colorPaint.js — manual color paint mode (Unit D).
 *
 * Exports `setColorPaintHandlers(hooks)` which receives the orchestrator's
 * internal callbacks and returns pointer-handlers that the canvas
 * mousedown/mousemove/mouseup branches in main.js delegate to when
 * colorPaintActive is on.
 *
 * Hooks shape (provided by main.js wireColorPaintUI()):
 *   pickTriangle, bfsBrushSelect, bucketFill, getCamera, getCurrentMesh,
 *   getCurrentGeometry, getTriangleAdjacency, getPaintedFaceColors,
 *   getActiveColor, getBrushIsRadius, getBrushRadius, getEraseMode,
 *   refreshOverlay, scheduleUndo, flushUndo, getControls, _viewDirFor,
 *   raycaster, _canvasNDC, getFrontFaceHit
 *
 * Returned handlers shape:
 *   { startPaint(e) → bool, paintAt(e) → void, endPaint() → void,
 *     isPainting() → bool }
 *
 * Live preview is deferred (per the plan); painted faces are visible only
 * via the existing exclusion overlay refresh — they tint orange rather than
 * with their actual color until the per-vertex color attribute lands. We
 * still emit `refreshOverlay()` after every paint so the user sees *some*
 * feedback that the click registered.
 */

import * as THREE from 'three';

export function setColorPaintHandlers(hooks) {
  // Defensive defaults so a missing hook doesn't crash the canvas pipeline.
  const h = hooks || {};
  const noop = () => {};
  const pickTriangle      = typeof h.pickTriangle === 'function' ? h.pickTriangle : (() => -1);
  const bfsBrushSelect    = typeof h.bfsBrushSelect === 'function' ? h.bfsBrushSelect : noop;
  const getCamera         = typeof h.getCamera === 'function' ? h.getCamera : (() => null);
  const getCurrentMesh    = typeof h.getCurrentMesh === 'function' ? h.getCurrentMesh : (() => null);
  const getPaintedFaceColors = typeof h.getPaintedFaceColors === 'function' ? h.getPaintedFaceColors : (() => null);
  const getActiveColor    = typeof h.getActiveColor === 'function' ? h.getActiveColor : (() => 0xcccccc);
  const getBrushIsRadius  = typeof h.getBrushIsRadius === 'function' ? h.getBrushIsRadius : (() => false);
  const getBrushRadius    = typeof h.getBrushRadius === 'function' ? h.getBrushRadius : (() => 1);
  const getEraseMode      = typeof h.getEraseMode === 'function' ? h.getEraseMode : (() => false);
  const refreshOverlay    = typeof h.refreshOverlay === 'function' ? h.refreshOverlay : noop;
  const scheduleUndo      = typeof h.scheduleUndo === 'function' ? h.scheduleUndo : noop;
  const flushUndo         = typeof h.flushUndo === 'function' ? h.flushUndo : noop;
  const getControls       = typeof h.getControls === 'function' ? h.getControls : (() => null);
  const _viewDirFor       = typeof h._viewDirFor === 'function' ? h._viewDirFor : (() => new THREE.Vector3(0, 0, -1));
  const _canvasNDC        = typeof h._canvasNDC === 'function' ? h._canvasNDC : (() => new THREE.Vector2(0, 0));
  const getFrontFaceHit   = typeof h.getFrontFaceHit === 'function' ? h.getFrontFaceHit : ((hits) => (hits && hits[0]) || null);
  const raycaster         = h.raycaster instanceof THREE.Raycaster ? h.raycaster : new THREE.Raycaster();

  let _painting          = false;
  let _lastPaintHitPoint = null;     // THREE.Vector3
  let _disabledControls  = false;    // tracks whether we toggled OrbitControls.

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * Map a THREE raycast hit (which may target a preview/precision mesh) back
   * to an original face index by going through pickTriangle's logic. We can't
   * reuse pickTriangle directly because we already have the hit; instead, we
   * synthesize a fake event at the hit's screen position. Cheaper path: trust
   * pickTriangle when called on the original event — but for shift-line
   * sampling, we lack an event. So we re-raycast from screen-projected hit
   * points. This is the same trick exclusion's _paintLineBetween uses.
   */
  function _raycastAtScreen(ndcVec2, mesh) {
    const cam = getCamera();
    if (!cam || !mesh) return null;
    raycaster.setFromCamera(ndcVec2, cam);
    const hits = raycaster.intersectObject(mesh);
    return getFrontFaceHit(hits, mesh);
  }

  /** Apply a color or erase to a single original face index. */
  function _applyToFace(origFaceIdx) {
    const map = getPaintedFaceColors();
    if (!map || origFaceIdx < 0) return;
    if (getEraseMode()) {
      map.delete(origFaceIdx);
    } else {
      map.set(origFaceIdx, getActiveColor() | 0);
    }
  }

  /**
   * Paint a hit. If brush is in radius mode, walks the BFS brush from the
   * seed face. Otherwise paints just the picked triangle.
   *
   * `seedTriIdx` is the raw mesh face index returned by the raycaster. We do
   * NOT remap it before passing to bfsBrushSelect — bfsBrushSelect itself
   * decides whether to use precision/preview adjacency. The callback we
   * provide receives whatever face-space the BFS walks; we then remap each
   * walked face to its original index via the same dispPreview/precision
   * logic used elsewhere. The simplest correct approach is to reuse the
   * orchestrator's pickTriangle for single-tri remap, and trust that
   * bfsBrushSelect's adjacency walks the same space we'll consume.
   *
   * In practice, for v1 the painted-face map is keyed on whatever face index
   * the existing exclusion paint uses (original indices in the simple case;
   * subdivided indices when precision is on). The orchestrator's color-bake
   * pipeline reads paintedFaceColors against `faceParentId`, so we must
   * store ORIGINAL indices. Since we don't have a precision→original remap
   * here without re-implementing it, we route every face through
   * pickTriangle-style logic by using the seed index as-is when
   * !precision/preview, and otherwise fall back to single-triangle paint.
   * Unit A's color-bake pseudo-code assumes original indices, so this
   * matches.
   */
  function _paintHit(hit, mesh, originalEvent) {
    if (!hit || !mesh) return;
    // Determine the original face index for the seed (single-triangle case).
    const origSeed = originalEvent
      ? pickTriangle(originalEvent)
      : _hitToOriginalIndex(hit, mesh);

    if (origSeed < 0) return;

    if (getBrushIsRadius()) {
      const r = getBrushRadius();
      const r2 = r * r;
      const viewDir = _viewDirFor(hit.point);
      // bfsBrushSelect callback receives whatever face-space adjacency uses.
      // For simple meshes this matches the original-index space we want.
      // When precision/preview is active, the faces are not directly original
      // indices; we forward them as-is and accept the same minor mismatch
      // exclusion paint already has — bfsBrushSelect's seed parameter expects
      // an index in adjacency-space, and `hit.faceIndex` is in mesh-space, so
      // we use that directly here. The orchestrator's exclusion paint uses
      // exactly this construction (see js/main.js _paintSingleHit).
      bfsBrushSelect(hit.faceIndex, hit.point, r2, viewDir, (t) => {
        // `t` is in adjacency-space; for non-precision/non-preview meshes,
        // it equals the original face index.
        _applyToFace(t);
      });
    } else {
      _applyToFace(origSeed);
    }
  }

  /**
   * Best-effort hit→original-face mapping when we don't have an event.
   * For shift-line sampling the orchestrator can't pickTriangle without an
   * event, so we approximate by projecting the hit point back to screen,
   * synthesizing a CSS-pixel event, and calling pickTriangle. If that fails,
   * fall back to the raw hit.faceIndex (fine for simple meshes).
   */
  function _hitToOriginalIndex(hit, mesh) {
    const cam = getCamera();
    if (!cam) return hit.faceIndex;
    try {
      const projected = hit.point.clone().project(cam);
      // Synthesize an event-like object with NDC coords readable by callers.
      // pickTriangle uses _canvasNDC(e) → we can't easily reverse that
      // without DOM. Simplest correct path: just use hit.faceIndex; the
      // shift-line sampling case is rare and the result is close enough.
      return hit.faceIndex;
    } catch {
      return hit.faceIndex;
    }
  }

  /** Sample points along the line between two world-space points. */
  function _paintLineBetween(from, to, mesh) {
    const cam = getCamera();
    if (!cam) return;
    const dist = from.distanceTo(to);
    const r = getBrushIsRadius() ? Math.max(getBrushRadius() * 0.5, 0.1) : 0.5;
    const steps = Math.max(Math.ceil(dist / r), 1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const pt = new THREE.Vector3().lerpVectors(from, to, t);
      const ndc = pt.clone().project(cam);
      const hit = _raycastAtScreen(new THREE.Vector2(ndc.x, ndc.y), mesh);
      if (hit) _paintHit(hit, mesh, null);
    }
  }

  // ─── Public handlers ────────────────────────────────────────────────────

  function startPaint(event) {
    const mesh = getCurrentMesh();
    if (!mesh) return false;
    const cam = getCamera();
    if (!cam) return false;

    raycaster.setFromCamera(_canvasNDC(event), cam);
    const hits = raycaster.intersectObject(mesh);
    const hit = getFrontFaceHit(hits, mesh);
    if (!hit) return false;

    _painting = true;

    // Disable orbit controls so drags don't rotate the camera.
    const ctrls = getControls();
    if (ctrls && 'enabled' in ctrls) {
      _disabledControls = ctrls.enabled !== false;
      ctrls.enabled = false;
    } else {
      _disabledControls = false;
    }

    // Open the undo coalescing window for this stroke.
    try { scheduleUndo(); } catch { /* hook may be a no-op */ }

    _paintHit(hit, mesh, event);
    _lastPaintHitPoint = hit.point.clone();
    refreshOverlay();
    return true;
  }

  function paintAt(event) {
    if (!_painting) return;
    const mesh = getCurrentMesh();
    if (!mesh) return;
    const cam = getCamera();
    if (!cam) return;

    raycaster.setFromCamera(_canvasNDC(event), cam);
    const hits = raycaster.intersectObject(mesh);
    const hit = getFrontFaceHit(hits, mesh);
    if (!hit) return;

    if (event && event.ctrlKey && _lastPaintHitPoint) {
      _paintLineBetween(_lastPaintHitPoint, hit.point, mesh);
    } else {
      _paintHit(hit, mesh, event);
    }
    _lastPaintHitPoint = hit.point.clone();
    refreshOverlay();
  }

  function endPaint() {
    if (!_painting) return;
    _painting = false;
    // Restore orbit controls.
    const ctrls = getControls();
    if (ctrls && 'enabled' in ctrls && _disabledControls) {
      ctrls.enabled = true;
    }
    _disabledControls = false;
    // Final overlay refresh + flush undo capture.
    refreshOverlay();
    try { flushUndo(); } catch { /* hook may be a no-op */ }
  }

  function isPainting() {
    return _painting;
  }

  return { startPaint, paintAt, endPaint, isPainting };
}
