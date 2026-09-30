/**
 * browser_gif: record what the agent does in a tab as an animated GIF
 * (Claude-in-Chrome gif_creator). While recording, the router captures a
 * downscaled frame after every page-changing action; export encodes the
 * frames (lib/gif-encoder.js) with a red ring where clicks landed. The MCP
 * server writes the file — the GIF bytes never go to the agent.
 */
import { resolveTab } from '../lib/page-exec.js';
import { encodeGif, drawMarker } from '../lib/gif-encoder.js';
import { handleScreenshot } from './tabs.js';

/** Tools after which a frame is captured. Reads (text/snapshot/find…) don't change the page. */
export const GIF_FRAME_TOOLS = new Set([
  'browser_navigate', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_hover',
  'browser_select', 'browser_click_text', 'browser_drag', 'browser_fill_form', 'browser_act', 'browser_upload_file',
  'browser_handle_dialog', 'browser_run_action', 'browser_evaluate', 'browser_wait',
]);

const MAX_FRAMES_CAP = 500;
/** Export travels in parts: the daemon's WebSocket frames are capped at 1 MB. */
export const GIF_PART_BYTES = 600_000;
/** tabId -> { frames, width, maxFrames, activate, recording, skipped, startedAt } */
const recordings = new Map();

export function isRecording(tabId) {
  const r = recordings.get(tabId);
  return !!(r && r.recording);
}

/** Capture one frame (after an action). Never throws: a failed frame is just skipped. */
export async function recordFrame(tabId, label, result) {
  const rec = recordings.get(tabId);
  if (!rec || !rec.recording) return;
  if (rec.frames.length >= rec.maxFrames) { rec.skipped++; return; }
  try {
    const tab = await chrome.tabs.get(tabId);
    // Hidden tabs don't paint; activating one flashes it for ~150 ms (like browser_screenshot).
    if (!tab.active && !rec.activate) { rec.skipped++; return; }
    const shot = await handleScreenshot({ tabId, format: 'jpeg', quality: 70, maxWidth: rec.width });
    if (!shot?.data) { rec.skipped++; return; }
    const f = shot.frame;
    const at = result && result.at && f && !f.page
      ? [(result.at.x - f.origin[0]) * f.scale, (result.at.y - f.origin[1]) * f.scale]
      : null;
    rec.frames.push({ data: shot.data, t: Date.now(), label, ...(at ? { at } : {}) });
  } catch {
    rec.skipped++;
  }
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function encodeRecording(rec) {
  const decoded = [];
  let W = 0;
  let H = 0;
  for (const fr of rec.frames) {
    const bmp = await createImageBitmap(new Blob([b64ToBytes(fr.data)], { type: 'image/jpeg' }));
    if (!W) { W = bmp.width; H = bmp.height; }
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, W, H);
    bmp.close?.();
    const rgba = ctx.getImageData(0, 0, W, H).data;
    if (fr.at) drawMarker(rgba, W, H, fr.at[0] * (W / (bmp.width || W)), fr.at[1] * (H / (bmp.height || H)));
    decoded.push({ rgba, t: fr.t });
  }
  const frames = decoded.map((d, i) => ({
    rgba: d.rgba,
    // Real pacing, clamped so the GIF is watchable: 0.4 s … 2.5 s, 1.5 s on the last frame.
    delayMs: i + 1 < decoded.length ? Math.min(2500, Math.max(400, decoded[i + 1].t - d.t)) : 1500,
  }));
  return { bytes: encodeGif(W, H, frames), width: W, height: H };
}

export async function handleGif(params) {
  const { tabId, action } = params;
  await resolveTab(tabId);
  switch (action) {
    case 'start': {
      const rec = {
        frames: [],
        width: Math.min(Math.max(Number(params.width) || 800, 200), 1600),
        maxFrames: Math.min(Math.max(Number(params.maxFrames) || 300, 1), MAX_FRAMES_CAP),
        activate: params.activate !== false,
        recording: true,
        skipped: 0,
        startedAt: Date.now(),
      };
      recordings.set(tabId, rec);
      await recordFrame(tabId, 'start', null); // the first frame: how the page looked
      return { success: true, recording: true, frames: rec.frames.length, width: rec.width, maxFrames: rec.maxFrames };
    }
    case 'frame': {
      const rec = recordings.get(tabId);
      if (!rec) throw new Error('Not recording this tab — call browser_gif action:"start" first.');
      const was = rec.recording;
      rec.recording = true;
      await recordFrame(tabId, 'frame', null);
      rec.recording = was;
      return { success: true, frames: rec.frames.length };
    }
    case 'stop': {
      const rec = recordings.get(tabId);
      if (!rec) throw new Error('Not recording this tab.');
      rec.recording = false;
      return { success: true, recording: false, frames: rec.frames.length, skipped: rec.skipped, seconds: Math.round((Date.now() - rec.startedAt) / 1000) };
    }
    case 'status': {
      const rec = recordings.get(tabId);
      return rec
        ? { success: true, recording: rec.recording, frames: rec.frames.length, skipped: rec.skipped }
        : { success: true, recording: false, frames: 0 };
    }
    case 'clear': {
      recordings.delete(tabId);
      return { success: true, cleared: true };
    }
    case 'export': {
      const rec = recordings.get(tabId);
      if (!rec || (rec.frames.length === 0 && !rec.encoded)) throw new Error('No frames recorded for this tab.');
      rec.recording = false;
      // Encode once (part 0), then hand the bytes out part by part.
      const part = Number.isInteger(params.part) && params.part > 0 ? params.part : 0;
      if (part === 0 || !rec.encoded) rec.encoded = await encodeRecording(rec);
      const { bytes, width, height } = rec.encoded;
      const parts = Math.max(1, Math.ceil(bytes.length / GIF_PART_BYTES));
      if (part >= parts) throw new Error(`part ${part} out of range (${parts} parts)`);
      const chunk = bytes.subarray(part * GIF_PART_BYTES, (part + 1) * GIF_PART_BYTES);
      const frames = rec.frames.length;
      if (part === parts - 1) {
        rec.encoded = null;
        if (params.clear !== false) recordings.delete(tabId);
      }
      return { success: true, frames, width, height, bytes: bytes.length, part, parts, gifBase64: bytesToB64(chunk) };
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/** Test hook. */
export function _recordings() { return recordings; }
