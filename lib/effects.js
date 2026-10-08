'use strict';
/*
 * The name effects an account can wear on its display name.
 *
 * This list is the single source of truth: the relay validates against it, the
 * client builds its pickers from it, and the visual definitions live in
 * public/style.css as `.fx-<name>`. Effects are cosmetic only — a rendering
 * hint carried in the fx map, never a permission and never near a key.
 *
 * `rainbow` is the original flair, kept as the first entry so existing
 * accounts migrate without a visible change.
 */
const EFFECTS = [
  'rainbow',        // smooth colour sweep across the letters
  'rgb',            // whole name cycles through the spectrum
  'rgb-letters',    // each letter cycles on its own offset
  'jump',           // letters hop in sequence
  'wave',           // smooth sine bob, staggered
  'shake',          // nervous jitter
  'pulse',          // smooth scale breathing
  'heartbeat',      // double-thump scale
  'glow',           // glow breathes around the letters
  'neon',           // cyan neon with irregular flicker
  'flicker',        // loose bulb flicker
  'blink',          // staggered hard blink
  'fade',           // letters fade through in sequence
  'float',          // slow independent drift
  'flip',           // each letter flips in 3D
  'spin',           // letters rotate in place
  'swing',          // letters swing from the top
  'bounce',         // bouncy landing with squash
  'typewriter',     // letters appear one by one, hold, repeat
  'glitch',         // RGB-split glitch hops
  'matrix',         // green code-rain shimmer
  'gold',           // golden shimmer
  'chrome',         // silver metallic shimmer
  'ice',            // frosted blue shimmer
  'fire',           // ember flicker rising
  'aurora',         // green-violet drifting light
  'hologram',       // iridescent shift with a lean
  'sparkle',        // twinkling
  'ghost',          // soft waft in and out of focus
  'warp',           // letters lean through a wave
];

const isValidFx = fx => fx === null || EFFECTS.includes(fx);

module.exports = { EFFECTS, isValidFx };
